/**
 * Conversation history persisted to disk, with safe trimming.
 *
 * OWNER: brain agent. Rules:
 *  - store Anthropic MessageParam objects verbatim (assistant content arrays incl. thinking blocks)
 *  - trimming must never split a tool_use / tool_result pair and must keep the first message a 'user'
 *  - `view()` returns a flattened text view for the chat UI
 *
 * A "user turn" starts at a user message that is NOT a tool_result message and spans everything up to
 * the next such message (assistant messages, tool_result messages, mid-conversation system messages).
 * Trimming and compaction only ever remove whole turns from the front, so tool_use/tool_result pairs
 * stay together and the first message is always a plain user message.
 *
 * Privacy/cost: image blocks (screenshots in the user message, `take_screenshot` tool results) are kept
 * in memory only for the turn that attached them. `redactImages()` – called by the agent before a new
 * turn – replaces them with a text placeholder, and the file on disk is always written redacted, so
 * base64 screenshots are neither persisted nor re-sent with every later request.
 */
import fs from 'node:fs'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatMessageView } from '@shared/ipc'
import { createLogger } from '../log'

const log = createLogger('history')

const FILE_VERSION = 1
/** Marker used by compact(); exported so the agent/UI can recognise summary messages. */
export const SUMMARY_PREFIX = '[Summary of earlier conversation]'
/** Marker the agent appends to the user text for volatile context; `view()` hides it. */
export const CONTEXT_MARKER = '\n\n[Context]\n'
/** Text block that replaces an image block once its turn is over (and in the persisted file). */
export const IMAGE_PLACEHOLDER = '[Screenshot was attached]'
const VIEW_TOOL_INPUT_MAX = 200

export interface ConversationHistory {
  messages(): Anthropic.MessageParam[]
  append(message: Anthropic.MessageParam): void
  /** Keep at most `maxTurns` user turns (older ones are dropped or summarized). */
  trim(maxTurns: number): void
  /** Replace everything older than the last `keepTurns` turns with a summary text (as a user+assistant pair). */
  compact(summary: string, keepTurns: number): void
  /** Replace every image block (user messages and tool results) with `IMAGE_PLACEHOLDER`. Call before a new turn. */
  redactImages(): void
  clear(): void
  view(limit?: number): ChatMessageView[]
  /** Flush to disk. */
  save(): void
}

interface Entry {
  id: number
  at: number
  message: Anthropic.MessageParam
}

interface StoredEntry {
  at: number
  message: Anthropic.MessageParam
}

interface StoredFile {
  version: number
  entries: StoredEntry[]
}

/** A user message that carries tool results belongs to the assistant's tool loop, not to a new turn. */
export function isToolResultMessage(message: Anthropic.MessageParam): boolean {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool_result')
  )
}

/** True for messages that start a new user turn. */
export function startsTurn(message: Anthropic.MessageParam): boolean {
  return message.role === 'user' && !isToolResultMessage(message)
}

/** Indexes at which user turns start (messages before the first index are orphans). */
export function turnStartIndexes(messages: readonly Anthropic.MessageParam[]): number[] {
  const starts: number[] = []
  messages.forEach((message, index) => {
    if (startsTurn(message)) starts.push(index)
  })
  return starts
}

/** Number of user turns in a message list. */
export function countTurns(messages: readonly Anthropic.MessageParam[]): number {
  return turnStartIndexes(messages).length
}

/**
 * Copy of `message` with every image block replaced by a `IMAGE_PLACEHOLDER` text block – both
 * top-level blocks of a user message and the content of its tool_result blocks. Returns the same
 * object when nothing had to change (assistant messages, string content, no images).
 */
export function redactImageBlocks(message: Anthropic.MessageParam): Anthropic.MessageParam {
  if (message.role !== 'user' || typeof message.content === 'string') return message
  let changed = false
  const content = message.content.map((block) => {
    if (block.type === 'image') {
      changed = true
      return { type: 'text', text: IMAGE_PLACEHOLDER } as Anthropic.TextBlockParam
    }
    if (block.type === 'tool_result' && Array.isArray(block.content) && block.content.some((b) => b.type === 'image')) {
      changed = true
      const inner = block.content.map((b) => (b.type === 'image' ? ({ type: 'text', text: IMAGE_PLACEHOLDER } as Anthropic.TextBlockParam) : b))
      return { ...block, content: inner }
    }
    return block
  })
  return changed ? { ...message, content } : message
}

/** True when the message still carries an image block somewhere. */
export function hasImageBlocks(message: Anthropic.MessageParam): boolean {
  return redactImageBlocks(message) !== message
}

export function createHistory(filePath: string): ConversationHistory {
  let entries: Entry[] = []
  let nextId = 1
  let dirty = false

  load()

  function load(): void {
    entries = []
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch {
      return // no history yet
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      for (const stored of extractStoredEntries(parsed)) {
        entries.push({ id: nextId++, at: stored.at, message: stored.message })
      }
    } catch (err) {
      log.warn(`history file ${filePath} is corrupt – starting empty`, err instanceof Error ? err.message : err)
      entries = []
    }
    if (dropOrphans()) dirty = true
  }

  /** Remove leading messages that precede the first real user turn. Returns true when something was removed. */
  function dropOrphans(): boolean {
    const first = entries.findIndex((e) => startsTurn(e.message))
    if (first === 0) return false
    entries = first < 0 ? [] : entries.slice(first)
    return true
  }

  function write(): void {
    // Never persist base64 screenshots – the in-memory copy keeps them for the running turn only.
    const data: StoredFile = { version: FILE_VERSION, entries: entries.map(({ at, message }) => ({ at, message: redactImageBlocks(message) })) }
    const dir = path.dirname(filePath)
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
      fs.renameSync(tmp, filePath)
      dirty = false
    } catch (err) {
      log.error(`cannot write history file ${filePath}`, err)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  function trimTo(maxTurns: number): void {
    const starts = turnStartIndexes(entries.map((e) => e.message))
    const keep = Math.max(1, Math.floor(maxTurns))
    if (starts.length <= keep) {
      if (dropOrphans()) dirty = true
      return
    }
    const cut = starts[starts.length - keep] ?? 0
    entries = entries.slice(cut)
    dirty = true
  }

  return {
    messages() {
      return entries.map((e) => e.message)
    },

    append(message) {
      entries.push({ id: nextId++, at: Date.now(), message })
      dirty = true
    },

    trim(maxTurns) {
      const before = entries.length
      trimTo(maxTurns)
      if (entries.length !== before) {
        log.debug(`trimmed history ${before} → ${entries.length} messages (max ${maxTurns} turns)`)
        write()
      }
    },

    compact(summary, keepTurns) {
      const starts = turnStartIndexes(entries.map((e) => e.message))
      const keep = Math.max(0, Math.floor(keepTurns))
      if (starts.length <= keep) return
      const cut = keep === 0 ? entries.length : (starts[starts.length - keep] ?? entries.length)
      if (cut <= 0) return
      const text = summary.trim()
      const replacement: Entry[] = text
        ? [
            { id: nextId++, at: Date.now(), message: { role: 'user', content: `${SUMMARY_PREFIX}\n${text}` } },
            { id: nextId++, at: Date.now(), message: { role: 'assistant', content: 'Okay.' } },
          ]
        : []
      entries = [...replacement, ...entries.slice(cut)]
      log.debug(`compacted ${cut} messages into a summary, keeping ${keep} turns`)
      write()
    },

    redactImages() {
      let redacted = 0
      for (const entry of entries) {
        const next = redactImageBlocks(entry.message)
        if (next === entry.message) continue
        entry.message = next
        redacted++
      }
      if (redacted > 0) {
        dirty = true
        log.debug(`redacted image blocks in ${redacted} message(s)`)
      }
    },

    clear() {
      entries = []
      write()
    },

    view(limit) {
      const views: ChatMessageView[] = []
      for (const entry of entries) views.push(...flattenEntry(entry))
      if (limit !== undefined && limit >= 0 && views.length > limit) return views.slice(views.length - limit)
      return views
    },

    save() {
      if (dirty) write()
    },
  }
}

/** Accepts `{version, entries:[{at,message}]}` as well as a bare `{messages:[...]}` / `[...]` list. */
function extractStoredEntries(parsed: unknown): StoredEntry[] {
  let list: unknown[] = []
  if (Array.isArray(parsed)) list = parsed
  else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj['entries'])) list = obj['entries']
    else if (Array.isArray(obj['messages'])) list = obj['messages']
  }
  const out: StoredEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const candidate = (record['message'] ?? record) as unknown
    if (!isMessageParam(candidate)) continue
    const at = typeof record['at'] === 'number' ? record['at'] : 0
    out.push({ at, message: candidate })
  }
  return out
}

function isMessageParam(value: unknown): value is Anthropic.MessageParam {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  if (m['role'] !== 'user' && m['role'] !== 'assistant' && m['role'] !== 'system') return false
  const content = m['content']
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.every((b) => b && typeof b === 'object' && typeof (b as { type?: unknown }).type === 'string')
}

function flattenEntry(entry: Entry): ChatMessageView[] {
  const { message, at, id } = entry
  const out: ChatMessageView[] = []
  let sub = 0
  const push = (role: ChatMessageView['role'], text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    out.push({ id: sub === 0 ? String(id) : `${id}-${sub}`, role, text: trimmed, at })
    sub++
  }

  if (message.role === 'system') return out
  const role: 'user' | 'assistant' = message.role
  if (typeof message.content === 'string') {
    push(role, role === 'user' ? stripContext(message.content) : message.content)
    return out
  }

  let textBuffer: string[] = []
  const flushText = (): void => {
    if (textBuffer.length === 0) return
    const joined = textBuffer.join('\n')
    push(role, role === 'user' ? stripContext(joined) : joined)
    textBuffer = []
  }

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        textBuffer.push(block.text)
        break
      case 'image':
        textBuffer.push('[Screenshot]')
        break
      case 'tool_use':
        flushText()
        push('tool', `${block.name} ${compactJson(block.input)}`)
        break
      case 'tool_result':
        flushText()
        push('tool', `${block.is_error ? '[error] ' : ''}${toolResultText(block)}`)
        break
      default:
        break // thinking, redacted_thinking, server tool blocks, ... are not shown
    }
  }
  flushText()
  return out
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  if (block.content === undefined) return ''
  if (typeof block.content === 'string') return block.content
  return block.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[Bild]' : `[${b.type}]`))
    .join('\n')
}

function stripContext(text: string): string {
  const index = text.lastIndexOf(CONTEXT_MARKER)
  return index >= 0 ? text.slice(0, index) : text
}

function compactJson(value: unknown): string {
  let json: string
  try {
    json = JSON.stringify(value) ?? ''
  } catch {
    json = String(value)
  }
  return json.length > VIEW_TOOL_INPUT_MAX ? `${json.slice(0, VIEW_TOOL_INPUT_MAX)}…` : json
}
