/**
 * The brain: an Anthropic Messages API streaming loop with tool use.
 *
 * OWNER: brain agent. Must follow the `claude-api` skill (typescript/claude-api/tool-use.md
 * "Streaming Manual Loop"): client.messages.stream(), finalMessage(), tool_result blocks for ALL
 * tool_use blocks in ONE user message, is_error on failures, stop on refusal/max_tokens, append
 * response.content verbatim to history (keeps thinking blocks), prompt caching on system + tools.
 *
 * Refusal fallback: when `llm.refusalFallback` is on, requests go through `client.beta.messages.stream`
 * with `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'` (the installed SDK types expose
 * both). If the API rejects that request with a 400 before streaming anything, the turn is retried once
 * without the beta and the fallback stays off until the config changes.
 */
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { FlowyConfig } from '@shared/config'
import { type Emotion, isEmotion } from '@shared/state'
import { createLogger } from '../log'
import { CONTEXT_MARKER, type ConversationHistory } from './history'
import type { AnyTool, ToolContent, ToolContext } from './tools/types'

const log = createLogger('brain')

export const MAX_TOKENS = 8192
/** Tool result text longer than this is truncated (per text block) before it goes to the model. */
export const TOOL_RESULT_TEXT_CAP = 30_000
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const EMPTY_RESULT = '(no output)'

export interface TurnInput {
  turnId: string
  /** What the user said/typed (already transcribed). */
  text: string
  /** Optional screenshot (JPEG/PNG) to attach for screen awareness. */
  screenshot?: { mediaType: 'image/png' | 'image/jpeg'; base64: string }
  /** Volatile context appended to the user message (time, active window, ...). Never in the system prompt. */
  context?: Record<string, string>
  source: 'voice' | 'text' | 'proactive'
}

export interface AgentCallbacks {
  /** Streamed assistant text (may contain [[emotion]] markers). */
  onText(delta: string): void
  onToolCall(name: string, summary: string): void
  onToolResult(name: string, ok: boolean): void
  onEmotion?(emotion: Emotion): void
}

export interface AgentResult {
  /** Full assistant text of the final message (markers included). */
  text: string
  stopReason: string
  aborted: boolean
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

export interface AgentOptions {
  config: FlowyConfig
  history: ConversationHistory
  tools: AnyTool[]
  /** Builds a ToolContext for a run (confirm/progress wiring is the orchestrator's job). */
  toolContextFactory(signal: AbortSignal, callbacks: AgentCallbacks): ToolContext
  /** Stable system prompt (built by shared/personality.ts). */
  systemPrompt: string
  /** Test seam: build the Anthropic client (defaults to `new Anthropic({ apiKey })`). */
  createClient?: (apiKey: string) => import('@anthropic-ai/sdk').default
}

export interface Agent {
  run(input: TurnInput, callbacks: AgentCallbacks, signal: AbortSignal): Promise<AgentResult>
  /** Cheap connectivity/auth check used by the settings page. */
  test(): Promise<{ ok: boolean; message: string }>
  /** Swap config/tools/system prompt without losing history. */
  update(options: Partial<Omit<AgentOptions, 'history'>>): void
}

/** Content blocks as returned by either API namespace (the beta one adds e.g. `fallback` blocks). */
type AnyBlock = Anthropic.ContentBlock | Anthropic.Beta.BetaContentBlock
type ToolUseLike = Extract<AnyBlock, { type: 'tool_use' }>

/** The subset of a streamed message the loop needs – satisfied by both Message and BetaMessage. */
interface StreamedMessage {
  content: AnyBlock[]
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null }
}

/** The subset of MessageStream / BetaMessageStream the loop uses (keeps the test fake minimal). */
export interface TextStream {
  on(event: 'text', listener: (delta: string) => void): unknown
  finalMessage(): Promise<StreamedMessage>
}

type StreamOutcome = { ok: true; message: StreamedMessage } | { ok: false; partial: string }

type ToolResultContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

export function createAgent(options: AgentOptions): Agent {
  const history = options.history
  let config = options.config
  let systemPrompt = options.systemPrompt
  let toolContextFactory = options.toolContextFactory
  let createClient = options.createClient
  let client: Anthropic | null = null
  let clientKey: string | null = null
  let toolMap = new Map<string, AnyTool>()
  let apiTools: Anthropic.Tool[] = []
  /** Set when the API rejected the server-side fallback beta; reset by update(). */
  let fallbackUnavailable = false

  setTools(options.tools)

  function setTools(tools: AnyTool[]): void {
    const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    toolMap = new Map()
    for (const tool of sorted) {
      if (toolMap.has(tool.name)) log.warn(`duplicate tool name ${tool.name} – keeping the first definition`)
      else toolMap.set(tool.name, tool)
    }
    apiTools = [...toolMap.values()].map(toAnthropicTool)
    const last = apiTools[apiTools.length - 1]
    if (last) last.cache_control = { type: 'ephemeral' }
  }

  function getClient(): Anthropic {
    const apiKey = config.llm.apiKey
    if (client && clientKey === apiKey) return client
    if (!apiKey && !createClient && !process.env['ANTHROPIC_API_KEY']) throw new Error('Kein API-Key konfiguriert')
    client = createClient ? createClient(apiKey) : new Anthropic({ apiKey: apiKey || undefined })
    clientKey = apiKey
    return client
  }

  function useFallback(): boolean {
    return config.llm.refusalFallback && !fallbackUnavailable
  }

  /** Request parameters shared by the beta and the non-beta namespace (both accept this shape). */
  function buildParams(messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming {
    const { model, effort } = config.llm
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { effort },
      // Automatic breakpoint on the growing conversation tail (the explicit ones above cover tools + system).
      cache_control: { type: 'ephemeral' },
    }
    if (apiTools.length > 0) params.tools = apiTools
    if (supportsAdaptiveThinking(model)) params.thinking = { type: 'adaptive' }
    return params
  }

  function openStream(messages: Anthropic.MessageParam[], signal: AbortSignal, withFallback: boolean): TextStream {
    const api = getClient()
    if (withFallback) {
      const base = buildParams(messages)
      const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        ...base,
        messages: base.messages as Anthropic.Beta.BetaMessageParam[],
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      }
      return api.beta.messages.stream(params, { signal })
    }
    return api.messages.stream(buildParams(stripBetaBlocks(messages)), { signal })
  }

  /** One streamed model call. Resolves with the final message, or with the partial text when aborted. */
  async function streamOnce(signal: AbortSignal, onText: (delta: string) => void): Promise<StreamOutcome> {
    let partial = ''
    const attempt = async (withFallback: boolean): Promise<StreamedMessage> => {
      const stream = openStream(history.messages(), signal, withFallback)
      stream.on('text', (delta) => {
        partial += delta
        onText(delta)
      })
      return stream.finalMessage()
    }
    const withFallback = useFallback()
    try {
      return { ok: true, message: await attempt(withFallback) }
    } catch (err) {
      if (isAbort(err, signal)) return { ok: false, partial }
      if (withFallback && err instanceof Anthropic.BadRequestError && partial === '') {
        log.warn(`server-side refusal fallback rejected by the API – retrying without it: ${err.message}`)
        fallbackUnavailable = true
        try {
          return { ok: true, message: await attempt(false) }
        } catch (retryErr) {
          if (isAbort(retryErr, signal)) return { ok: false, partial }
          throw mapApiError(retryErr)
        }
      }
      throw mapApiError(err)
    }
  }

  async function executeToolUse(
    block: ToolUseLike,
    ctx: ToolContext,
    callbacks: AgentCallbacks,
    signal: AbortSignal,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const name = block.name
    const fail = (text: string): Anthropic.ToolResultBlockParam => {
      callbacks.onToolResult(name, false)
      return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: text }
    }
    const tool = toolMap.get(name)
    if (!tool) {
      callbacks.onToolCall(name, name)
      return fail(`Unknown tool: ${name}`)
    }
    const parsed = tool.inputSchema.safeParse(block.input)
    if (!parsed.success) {
      callbacks.onToolCall(name, name)
      return fail(`Invalid input for ${name}:\n${formatIssues(parsed.error)}`)
    }
    callbacks.onToolCall(name, summarize(tool, parsed.data))
    try {
      const result = await raceAbort(tool.execute(parsed.data, ctx), signal)
      const ok = !result.isError
      callbacks.onToolResult(name, ok)
      const out: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: block.id, content: toResultContent(result.content) }
      if (!ok) out.is_error = true
      return out
    } catch (err) {
      if (signal.aborted) return fail('interrupted')
      log.warn(`tool ${name} failed`, err instanceof Error ? err.message : err)
      return fail(errorMessage(err))
    }
  }

  async function run(input: TurnInput, callbacks: AgentCallbacks, signal: AbortSignal): Promise<AgentResult> {
    const llm = config.llm
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    const emotions = createEmotionScanner(callbacks.onEmotion?.bind(callbacks))
    const onText = (delta: string): void => {
      emotions.push(delta)
      callbacks.onText(delta)
    }
    const ctx = toolContextFactory(signal, callbacks)
    getClient() // fail early (missing key) before touching the history
    history.append(buildUserMessage(input))
    let text = ''
    try {
      for (let iteration = 1; iteration <= llm.maxToolIterations; iteration++) {
        history.trim(llm.maxHistoryTurns)
        log.debug(`turn ${input.turnId} iteration ${iteration} model=${llm.model} messages=${history.messages().length}`)
        const outcome = await streamOnce(signal, onText)
        if (!outcome.ok) {
          if (outcome.partial) history.append({ role: 'assistant', content: [{ type: 'text', text: outcome.partial }] })
          log.info(`turn ${input.turnId} aborted mid-stream`)
          return { text: outcome.partial, stopReason: 'aborted', aborted: true, usage }
        }
        const message = outcome.message
        addUsage(usage, message.usage)
        text = textOf(message.content)
        history.append({ role: 'assistant', content: toParamContent(message.content) })
        const toolUses = message.content.filter(isToolUse)
        const stop = message.stop_reason ?? 'end_turn'

        if (signal.aborted) {
          if (toolUses.length > 0) history.append(toolResultsMessage(toolUses.map((b) => errorResult(b.id, 'interrupted'))))
          return { text, stopReason: 'aborted', aborted: true, usage }
        }
        if (stop === 'tool_use' && toolUses.length > 0) {
          const results = await Promise.all(toolUses.map((b) => executeToolUse(b, ctx, callbacks, signal)))
          history.append(toolResultsMessage(results))
          if (signal.aborted) return { text, stopReason: 'aborted', aborted: true, usage }
          continue
        }
        if (toolUses.length > 0) {
          // refusal / max_tokens / anything else that left tool_use blocks behind: never execute those
          // (their input may be truncated) but keep the history consistent for the next request.
          history.append(toolResultsMessage(toolUses.map((b) => errorResult(b.id, `not executed (stop_reason: ${stop})`))))
        }
        if (stop === 'pause_turn') continue
        if (stop === 'refusal') {
          log.info(`turn ${input.turnId}: model refused`)
          return { text: '', stopReason: 'refusal', aborted: false, usage }
        }
        if (stop === 'max_tokens') log.warn(`turn ${input.turnId}: response truncated at max_tokens`)
        return { text, stopReason: stop, aborted: false, usage }
      }
      log.warn(`turn ${input.turnId}: tool iteration limit (${llm.maxToolIterations}) reached`)
      return { text, stopReason: 'max_iterations', aborted: false, usage }
    } finally {
      history.save()
      log.debug(`turn ${input.turnId} usage`, usage)
    }
  }

  async function test(): Promise<{ ok: boolean; message: string }> {
    const model = config.llm.model
    try {
      await getClient().models.retrieve(model)
      return { ok: true, message: `Verbindung OK (${model})` }
    } catch (err) {
      return { ok: false, message: mapApiError(err).message }
    }
  }

  function update(next: Partial<Omit<AgentOptions, 'history'>>): void {
    if (next.config) {
      if (next.config.llm.apiKey !== config.llm.apiKey) client = null
      config = next.config
      fallbackUnavailable = false
    }
    if (next.tools) setTools(next.tools)
    if (next.systemPrompt !== undefined) systemPrompt = next.systemPrompt
    if (next.toolContextFactory) toolContextFactory = next.toolContextFactory
    if (next.createClient !== undefined) {
      createClient = next.createClient
      client = null
    }
  }

  return { run, test, update }
}

// ---------------------------------------------------------------------------------------------
// Helpers (pure; exported for tests)

/** Adaptive thinking is unsupported on Haiku and Claude 3 models – omit `thinking` there. */
export function supportsAdaptiveThinking(model: string): boolean {
  const id = model.toLowerCase()
  return !id.includes('haiku') && !id.includes('claude-3')
}

/** Convert a zod tool into an Anthropic tool definition (JSON schema without `$schema`, always type object). */
export function toAnthropicTool(tool: AnyTool): Anthropic.Tool {
  let schema: Record<string, unknown>
  try {
    schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  } catch (err) {
    log.warn(`cannot convert schema of tool ${tool.name} to JSON schema`, err instanceof Error ? err.message : err)
    schema = {}
  }
  const { $schema: _ignored, type: _type, ...rest } = schema
  return { name: tool.name, description: tool.description, input_schema: { ...rest, type: 'object' } }
}

/** Build the user message for a turn: [image] + text (+ "[Context]" lines). */
export function buildUserMessage(input: TurnInput): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = []
  if (input.screenshot) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: input.screenshot.mediaType, data: input.screenshot.base64 },
    })
  }
  let text = input.text
  const contextEntries = Object.entries(input.context ?? {})
  if (contextEntries.length > 0) {
    text += CONTEXT_MARKER + contextEntries.map(([key, value]) => `${key}: ${value}`).join('\n')
  }
  content.push({ type: 'text', text: text.trim() ? text : '(continue)' })
  return { role: 'user', content }
}

/** Map SDK errors to short user-facing messages (typed checks, never string matching). */
export function mapApiError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new Error('API-Key ungültig')
  if (err instanceof Anthropic.RateLimitError) return new Error('Rate-Limit erreicht')
  if (err instanceof Anthropic.APIConnectionError) return new Error('Keine Verbindung zur Anthropic API')
  if (err instanceof Anthropic.NotFoundError) return new Error(`Modell nicht gefunden (${err.message})`)
  if (err instanceof Anthropic.APIError) {
    // The SDK already prefixes its message with the status ("500 overloaded") – avoid repeating it.
    const prefix = err.status !== undefined ? `${err.status} ` : ''
    const detail = prefix && err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message
    return new Error(`Anthropic API ${err.status ?? 'Fehler'}: ${detail}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/** Convert tool output into tool_result content (text capped, images as base64 blocks). */
export function toResultContent(content: ToolContent): ToolResultContent {
  if (typeof content === 'string') return capText(content) || EMPTY_RESULT
  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = []
  for (const part of content) {
    if (part.type === 'text') {
      const text = capText(part.text)
      if (text) blocks.push({ type: 'text', text })
    } else {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.base64 } })
    }
  }
  return blocks.length > 0 ? blocks : EMPTY_RESULT
}

export function capText(text: string, max = TOOL_RESULT_TEXT_CAP): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated, ${text.length - max} characters omitted]`
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

function summarize(tool: AnyTool, input: unknown): string {
  try {
    return tool.summarize?.(input) ?? tool.name
  } catch {
    return tool.name
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err)
}

function isToolUse(block: AnyBlock): block is ToolUseLike {
  return block.type === 'tool_use'
}

function textOf(blocks: AnyBlock[]): string {
  let text = ''
  for (const block of blocks) if (block.type === 'text') text += block.text
  return text
}

/** Response blocks are echoed back verbatim; beta-only blocks (e.g. `fallback`) ride along as data. */
function toParamContent(blocks: AnyBlock[]): Anthropic.ContentBlockParam[] {
  return blocks as unknown as Anthropic.ContentBlockParam[]
}

/** The non-beta endpoint does not know `fallback` blocks a previous beta request may have stored. */
function stripBetaBlocks(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string') return message
    const content = message.content.filter((block) => (block.type as string) !== 'fallback')
    return content.length === message.content.length ? message : { ...message, content }
  })
}

function toolResultsMessage(results: Anthropic.ToolResultBlockParam[]): Anthropic.MessageParam {
  return { role: 'user', content: results }
}

function errorResult(toolUseId: string, text: string): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: text }
}

function addUsage(total: AgentResult['usage'], usage: StreamedMessage['usage']): void {
  total.inputTokens += usage.input_tokens ?? 0
  total.outputTokens += usage.output_tokens ?? 0
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (err instanceof Anthropic.APIUserAbortError) return true
  return err instanceof Error && err.name === 'AbortError'
}

function abortError(): Error {
  return Object.assign(new Error('interrupted'), { name: 'AbortError' })
}

/** Reject as soon as the signal fires, even if the tool ignores it (the tool keeps running detached). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Detects complete `[[emotion]]` markers in the streamed text and reports them. */
function createEmotionScanner(onEmotion?: (emotion: Emotion) => void): { push(delta: string): void } {
  let buffer = ''
  return {
    push(delta) {
      if (!onEmotion) return
      buffer += delta
      const re = /\[\[([^\]]*)\]\]/g
      let last = 0
      let match: RegExpExecArray | null
      while ((match = re.exec(buffer)) !== null) {
        const name = (match[1] ?? '').trim().toLowerCase()
        if (isEmotion(name)) onEmotion(name)
        last = re.lastIndex
      }
      buffer = buffer.slice(last)
      const open = buffer.lastIndexOf('[[')
      buffer = open >= 0 ? buffer.slice(open) : ''
    },
  }
}
