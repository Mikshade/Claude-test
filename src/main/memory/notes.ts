/**
 * Long-term memory: small JSON list of notes the brain stores with the `remember` tool and recalls
 * with `recall` (simple keyword scoring – no embeddings). A compact digest of recent notes is
 * injected into each turn's context.
 *
 * Persistence: `<userData>/memory.json` written atomically (tmp + rename) on every mutation;
 * a missing or corrupt file starts an empty store (a warning is logged, nothing throws).
 *
 * OWNER: tools agent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { shortId } from '@shared/text'
import { createLogger } from '../log'

const log = createLogger('notes')

export interface Note {
  id: string
  text: string
  tags: string[]
  createdAt: number
}

export interface NotesStore {
  add(text: string, tags?: string[]): Note
  remove(id: string): boolean
  search(query: string, limit?: number): Note[]
  all(): Note[]
  /** Short text block (<= ~1500 chars) summarizing the most relevant/recent notes. */
  digest(): string
}

/** Oldest notes are dropped beyond this count. */
export const MAX_NOTES = 500
/** A single note is truncated to this many characters. */
export const MAX_NOTE_CHARS = 2000
export const DEFAULT_SEARCH_LIMIT = 10
/** The digest covers the most recent N notes … */
export const DIGEST_NOTES = 15
/** … and is capped at this many characters in total. */
export const DIGEST_MAX_CHARS = 1500
const FILE_VERSION = 1
/** Weight of the recency rank in the search score (small: it only breaks ties between equal keyword hits). */
const RECENCY_WEIGHT = 0.001

interface StoredFile {
  version: number
  notes: Note[]
}

/** Lowercase, split on anything that is not a letter or digit, drop tokens shorter than 2 chars. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2)
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of tags ?? []) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().toLowerCase()
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

function normalizeText(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > MAX_NOTE_CHARS ? `${trimmed.slice(0, MAX_NOTE_CHARS - 1)}…` : trimmed
}

function cloneNote(note: Note): Note {
  return { ...note, tags: [...note.tags] }
}

/**
 * Score a note for a query: number of distinct query tokens that appear in the note's text or tags.
 * A token "appears" when it equals a note token, or (3+ chars) when it is a substring of the lowercased
 * text/tags – so "kaffee" also hits "Kaffeemaschine" and "katze" hits "Katzen".
 */
export function scoreNote(note: Note, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0
  const haystack = `${note.text} ${note.tags.join(' ')}`.toLowerCase()
  const noteTokens = new Set(tokenize(haystack))
  let hits = 0
  for (const token of queryTokens) {
    if (noteTokens.has(token) || (token.length >= 3 && haystack.includes(token))) hits++
  }
  return hits
}

export function createNotesStore(filePath: string): NotesStore {
  /** Oldest first. */
  let notes: Note[] = []

  load()

  function load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch {
      return // no notes yet
    }
    try {
      notes = extractNotes(JSON.parse(raw) as unknown)
    } catch (err) {
      log.warn(`notes file ${filePath} is corrupt – starting empty`, err instanceof Error ? err.message : err)
      notes = []
    }
    notes.sort((a, b) => a.createdAt - b.createdAt)
    if (notes.length > MAX_NOTES) {
      notes = notes.slice(notes.length - MAX_NOTES)
      write()
    }
  }

  function write(): void {
    const data: StoredFile = { version: FILE_VERSION, notes }
    const dir = path.dirname(filePath)
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(tmp, filePath)
    } catch (err) {
      log.error(`cannot write notes file ${filePath}`, err)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  function newId(): string {
    let id = shortId('n')
    while (notes.some((n) => n.id === id)) id = shortId('n')
    return id
  }

  return {
    add(text, tags) {
      const cleanText = normalizeText(text ?? '')
      if (!cleanText) throw new Error('note text is empty')
      const cleanTags = normalizeTags(tags)
      // Remembering the same thing twice refreshes the existing note instead of duplicating it.
      const existingIndex = notes.findIndex((n) => n.text.toLowerCase() === cleanText.toLowerCase())
      let note: Note
      if (existingIndex >= 0) {
        const existing = notes[existingIndex]!
        notes.splice(existingIndex, 1)
        note = { ...existing, tags: normalizeTags([...existing.tags, ...cleanTags]), createdAt: Date.now() }
      } else {
        note = { id: newId(), text: cleanText, tags: cleanTags, createdAt: Date.now() }
      }
      notes.push(note)
      if (notes.length > MAX_NOTES) {
        const dropped = notes.length - MAX_NOTES
        notes = notes.slice(dropped)
        log.debug(`dropped ${dropped} oldest note(s) (max ${MAX_NOTES})`)
      }
      write()
      return cloneNote(note)
    },

    remove(id) {
      const index = notes.findIndex((n) => n.id === id)
      if (index < 0) return false
      notes.splice(index, 1)
      write()
      return true
    },

    search(query, limit = DEFAULT_SEARCH_LIMIT) {
      const queryTokens = [...new Set(tokenize(query ?? ''))]
      if (queryTokens.length === 0) return []
      const scored: { note: Note; score: number }[] = []
      notes.forEach((note, rank) => {
        const hits = scoreNote(note, queryTokens)
        if (hits > 0) scored.push({ note, score: hits + RECENCY_WEIGHT * rank })
      })
      scored.sort((a, b) => b.score - a.score)
      const max = Math.max(0, Math.floor(limit))
      return scored.slice(0, max).map((s) => cloneNote(s.note))
    },

    all() {
      return notes.map(cloneNote)
    },

    digest() {
      const recent = notes.slice(-DIGEST_NOTES).reverse()
      const lines: string[] = []
      let length = 0
      for (const note of recent) {
        const line = `- ${note.text}`
        const separator = lines.length > 0 ? 1 : 0
        if (length + separator + line.length <= DIGEST_MAX_CHARS) {
          lines.push(line)
          length += separator + line.length
          continue
        }
        const room = DIGEST_MAX_CHARS - length - separator - 1 // keep 1 char for the ellipsis
        if (room > 2) lines.push(`${line.slice(0, room)}…`)
        break
      }
      return lines.join('\n')
    },
  }
}

/** Accepts `{version, notes:[...]}` as well as a bare `[...]` list; skips malformed entries. */
function extractNotes(parsed: unknown): Note[] {
  let list: unknown[] = []
  if (Array.isArray(parsed)) list = parsed
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['notes'])) {
    list = (parsed as Record<string, unknown>)['notes'] as unknown[]
  }
  const out: Note[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = record['id']
    const text = record['text']
    if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim() || seen.has(id)) continue
    const rawTags = record['tags']
    const tags = Array.isArray(rawTags) ? normalizeTags(rawTags.filter((t): t is string => typeof t === 'string')) : []
    const rawCreated = record['createdAt']
    const createdAt = typeof rawCreated === 'number' && Number.isFinite(rawCreated) ? rawCreated : 0
    seen.add(id)
    out.push({ id, text: normalizeText(text), tags, createdAt })
  }
  return out
}
