import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig, type FlowyConfig } from '@shared/config'
import {
  buildUserMessage,
  capText,
  createAgent,
  FALLBACK_BETA,
  mapApiError,
  MAX_TOKENS,
  supportsAdaptiveThinking,
  toAnthropicTool,
  TOOL_RESULT_TEXT_CAP,
  type AgentCallbacks,
  type AgentOptions,
  type TextStream,
} from './agent'
import { createHistory, IMAGE_PLACEHOLDER, type ConversationHistory } from './history'
import type { AnyTool, ToolContext, ToolDefinition } from './tools/types'

// ---------------------------------------------------------------------------------------------
// Fake Anthropic client

interface FakeResponse {
  content: Anthropic.ContentBlock[]
  stopReason?: Anthropic.StopReason
  /** Text deltas to stream before resolving (defaults to the text blocks' text in one delta each). */
  deltas?: string[]
  /** Throw this instead of resolving. */
  error?: unknown
  usage?: Partial<Anthropic.Usage>
}

interface Recorded {
  namespace: 'messages' | 'beta'
  params: Record<string, unknown>
  signal: AbortSignal | undefined
}

interface FakeClient {
  client: Anthropic
  calls: Recorded[]
  responses: FakeResponse[]
  retrieve: ReturnType<typeof vi.fn>
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function makeMessage(r: FakeResponse): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: r.content,
    stop_reason: r.stopReason ?? 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      ...r.usage,
    },
  }
}

function fakeStream(r: FakeResponse, signal: AbortSignal | undefined): TextStream {
  const listeners: Array<(delta: string) => void> = []
  const deltas = r.deltas ?? r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text)
  const abortError = (): Error => new Anthropic.APIUserAbortError()
  return {
    on(event, listener) {
      if (event === 'text') listeners.push(listener)
      return this
    },
    async finalMessage() {
      for (const delta of deltas) {
        await tick()
        if (signal?.aborted) throw abortError()
        for (const l of listeners) l(delta)
      }
      await tick()
      if (signal?.aborted) throw abortError()
      if (r.error !== undefined) throw r.error
      return makeMessage(r)
    },
  }
}

function fakeClient(responses: FakeResponse[]): FakeClient {
  const calls: Recorded[] = []
  const queue = [...responses]
  const streamFor =
    (namespace: Recorded['namespace']) =>
    (params: Record<string, unknown>, options?: { signal?: AbortSignal }): TextStream => {
      calls.push({ namespace, params, signal: options?.signal })
      const next = queue.shift()
      if (!next) throw new Error('fake client: no more scripted responses')
      return fakeStream(next, options?.signal)
    }
  const retrieve = vi.fn(async () => ({ id: 'claude-opus-5-5' }))
  const client = {
    messages: { stream: streamFor('messages') },
    beta: { messages: { stream: streamFor('beta') } },
    models: { retrieve },
  } as unknown as Anthropic
  return { client, calls, responses: queue, retrieve }
}

// ---------------------------------------------------------------------------------------------
// Fixtures

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null })
const toolUse = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
})

function defineTool<S extends z.ZodTypeAny>(def: Partial<ToolDefinition<S>> & Pick<ToolDefinition<S>, 'name' | 'inputSchema' | 'execute'>): AnyTool {
  return {
    description: `${def.name} tool`,
    category: 'system',
    destructive: false,
    readOnly: true,
    ...def,
  } as AnyTool
}

function makeConfig(patch: Partial<FlowyConfig['llm']> = {}): FlowyConfig {
  return parseConfig({ llm: { apiKey: 'sk-test', ...patch } })
}

function callbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks & { deltas: string[]; toolCalls: string[][]; toolResults: Array<[string, boolean]> } {
  const deltas: string[] = []
  const toolCalls: string[][] = []
  const toolResults: Array<[string, boolean]> = []
  return {
    deltas,
    toolCalls,
    toolResults,
    onText: (d) => deltas.push(d),
    onToolCall: (name, summary) => toolCalls.push([name, summary]),
    onToolResult: (name, ok) => toolResults.push([name, ok]),
    ...overrides,
  }
}

let dir: string
let history: ConversationHistory
let historyFile: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-agent-'))
  historyFile = path.join(dir, 'history.json')
  history = createHistory(historyFile)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function build(responses: FakeResponse[], opts: Partial<AgentOptions> = {}): { agent: ReturnType<typeof createAgent>; fake: FakeClient; config: FlowyConfig } {
  const fake = fakeClient(responses)
  const config = opts.config ?? makeConfig()
  const agent = createAgent({
    config,
    history,
    tools: [],
    systemPrompt: 'Du bist Yui.',
    toolContextFactory: (signal) => ({ config, signal, confirm: async () => true, progress: () => undefined }) satisfies ToolContext,
    createClient: () => fake.client,
    ...opts,
  })
  return { agent, fake, config }
}

const input = (t: string, extra: Partial<Parameters<ReturnType<typeof createAgent>['run']>[0]> = {}) => ({
  turnId: 't1',
  text: t,
  source: 'text' as const,
  ...extra,
})

// ---------------------------------------------------------------------------------------------

describe('plain text turn', () => {
  it('streams deltas, returns the final text and stores user + assistant verbatim', async () => {
    const { agent, fake } = build([
      { content: [{ type: 'thinking', thinking: 't', signature: 's' }, text('[[happy]] Hallo '), text('Welt!')], deltas: ['[[hap', 'py]] Hallo ', 'Welt!'] },
    ])
    const emotions: string[] = []
    const cb = callbacks({ onEmotion: (e) => emotions.push(e) })
    const result = await agent.run(input('Hi'), cb, new AbortController().signal)

    expect(result).toEqual({
      text: '[[happy]] Hallo Welt!',
      stopReason: 'end_turn',
      aborted: false,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    })
    expect(cb.deltas.join('')).toBe('[[happy]] Hallo Welt!')
    expect(emotions).toEqual(['happy'])
    expect(history.messages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: fake.responses.length === 0 ? [{ type: 'thinking', thinking: 't', signature: 's' }, text('[[happy]] Hallo '), text('Welt!')] : [] },
    ])
    // persisted at the end of the turn
    expect(createHistory(historyFile).messages()).toEqual(history.messages())
  })

  it('sends model, max_tokens, cached system prompt, adaptive thinking, effort and the fallback beta', async () => {
    const { agent, fake } = build([{ content: [text('ok')] }], { config: makeConfig({ effort: 'high' }) })
    await agent.run(input('Hi'), callbacks(), new AbortController().signal)
    const call = fake.calls[0]!
    expect(call.namespace).toBe('beta')
    expect(call.params['model']).toBe('claude-opus-5-5')
    expect(call.params['max_tokens']).toBe(MAX_TOKENS)
    expect(call.params['system']).toEqual([{ type: 'text', text: 'Du bist Yui.', cache_control: { type: 'ephemeral' } }])
    expect(call.params['thinking']).toEqual({ type: 'adaptive' })
    expect(call.params['output_config']).toEqual({ effort: 'high' })
    expect(call.params['betas']).toEqual([FALLBACK_BETA])
    expect(call.params['fallbacks']).toBe('default')
    expect(call.params['tools']).toBeUndefined()
    expect(call.params['stream']).toBeUndefined()
    expect(call.signal).toBeInstanceOf(AbortSignal)
  })

  it('uses the non-beta namespace without fallbacks when refusalFallback is off and omits thinking for haiku', async () => {
    const { agent, fake } = build([{ content: [text('ok')] }], { config: makeConfig({ refusalFallback: false, model: 'claude-haiku-4-5' }) })
    await agent.run(input('Hi'), callbacks(), new AbortController().signal)
    const call = fake.calls[0]!
    expect(call.namespace).toBe('messages')
    expect(call.params['betas']).toBeUndefined()
    expect(call.params['fallbacks']).toBeUndefined()
    expect(call.params['thinking']).toBeUndefined()
    expect(supportsAdaptiveThinking('claude-3-5-sonnet')).toBe(false)
    expect(supportsAdaptiveThinking('claude-opus-5-5')).toBe(true)
  })

  it('puts screenshot + context into the user message (never into the system prompt)', async () => {
    const { agent, fake } = build([{ content: [text('ok')] }])
    await agent.run(
      input('Was siehst du?', { screenshot: { mediaType: 'image/jpeg', base64: 'QUJD' }, context: { active_window: 'Editor', time: '12:00' } }),
      callbacks(),
      new AbortController().signal,
    )
    const messages = fake.calls[0]!.params['messages'] as Anthropic.MessageParam[]
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        { type: 'text', text: 'Was siehst du?\n\n[Context]\nactive_window: Editor\ntime: 12:00' },
      ],
    })
    expect(fake.calls[0]!.params['system']).toEqual([{ type: 'text', text: 'Du bist Yui.', cache_control: { type: 'ephemeral' } }])
    expect(buildUserMessage({ turnId: 'x', text: '   ', source: 'proactive' })).toEqual({ role: 'user', content: [{ type: 'text', text: '(continue)' }] })
  })

  it('keeps the text on max_tokens and continues on pause_turn', async () => {
    const { agent, fake } = build([{ content: [text('erst ')], stopReason: 'pause_turn' }, { content: [text('dann')], stopReason: 'max_tokens' }])
    const result = await agent.run(input('Hi'), callbacks(), new AbortController().signal)
    expect(fake.calls).toHaveLength(2)
    expect(result.stopReason).toBe('max_tokens')
    expect(result.text).toBe('dann')
    expect(result.usage.inputTokens).toBe(20)
    expect(history.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  it('returns an empty text on refusal and never runs tools of a refused message', async () => {
    const execute = vi.fn(async () => ({ content: 'x' }))
    const tool = defineTool({ name: 'echo', inputSchema: z.object({ v: z.string() }), execute })
    const { agent } = build([{ content: [text('Ich '), toolUse('tu1', 'echo', { v: 'a' })], stopReason: 'refusal' }], { tools: [tool] })
    const result = await agent.run(input('Hi'), callbacks(), new AbortController().signal)
    expect(result).toMatchObject({ text: '', stopReason: 'refusal', aborted: false })
    expect(execute).not.toHaveBeenCalled()
    const last = history.messages().at(-1)!
    expect(last.role).toBe('user')
    expect(last.content).toEqual([{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'not executed (stop_reason: refusal)' }])
  })
})

describe('tools', () => {
  it('converts zod schemas to Anthropic tools (sorted by name, $schema stripped, cache_control on the last one)', async () => {
    const b = defineTool({ name: 'b_tool', inputSchema: z.object({ q: z.string().describe('query'), n: z.number().int().optional() }), execute: async () => ({ content: '' }) })
    const a = defineTool({ name: 'a_tool', inputSchema: z.object({}), execute: async () => ({ content: '' }) })
    const { agent, fake } = build([{ content: [text('ok')] }], { tools: [b, a] })
    await agent.run(input('Hi'), callbacks(), new AbortController().signal)
    const tools = fake.calls[0]!.params['tools'] as Anthropic.Tool[]
    expect(tools.map((t) => t.name)).toEqual(['a_tool', 'b_tool'])
    expect(tools[0]!.cache_control).toBeUndefined()
    expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(tools[1]!.input_schema).toMatchObject({ type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: ['q'] })
    expect('$schema' in tools[1]!.input_schema).toBe(false)
    expect(tools[1]!.strict).toBeUndefined()
    expect(tools[1]!.description).toBe('b_tool tool')
    // unrepresentable types do not throw
    expect(toAnthropicTool(defineTool({ name: 'd', inputSchema: z.object({ when: z.date() }), execute: async () => ({ content: '' }) })).input_schema.type).toBe('object')
  })

  it('runs all tool_use blocks concurrently and answers with ONE user message in tool_use order', async () => {
    let started = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = defineTool({
      name: 'slow',
      inputSchema: z.object({ id: z.string() }),
      summarize: (i) => `slow ${i.id}`,
      execute: async (i) => {
        started++
        await gate
        return { content: `slow:${i.id}` }
      },
    })
    const fast = defineTool({
      name: 'fast',
      inputSchema: z.object({ id: z.string() }),
      execute: async (i) => {
        started++
        if (started === 2) release() // both are running before either finishes
        return { content: [{ type: 'text', text: `fast:${i.id}` }, { type: 'image', mediaType: 'image/png', base64: 'AAAA' }] }
      },
    })
    const { agent, fake } = build(
      [
        { content: [text('Moment…'), toolUse('s1', 'slow', { id: '1' }), toolUse('f1', 'fast', { id: '2' })], stopReason: 'tool_use' },
        { content: [text('Fertig!')], usage: { input_tokens: 100, cache_read_input_tokens: null } },
      ],
      { tools: [slow, fast] },
    )
    const cb = callbacks()
    const result = await agent.run(input('go'), cb, new AbortController().signal)

    expect(result.text).toBe('Fertig!')
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 110, outputTokens: 10, cacheReadTokens: 3 })
    expect(cb.deltas.join('')).toBe('Moment…Fertig!')
    expect(cb.toolCalls).toEqual([
      ['slow', 'slow 1'],
      ['fast', 'fast'],
    ])
    expect(cb.toolResults).toEqual(expect.arrayContaining([['slow', true], ['fast', true]]))

    const m = history.messages()
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(m[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 's1', content: 'slow:1' },
      {
        type: 'tool_result',
        tool_use_id: 'f1',
        content: [
          { type: 'text', text: 'fast:2' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ])
    // second request carries the full loop
    const sent = fake.calls[1]!.params['messages'] as Anthropic.MessageParam[]
    expect(sent).toHaveLength(3)
    expect(sent[1]!.content).toEqual([text('Moment…'), toolUse('s1', 'slow', { id: '1' }), toolUse('f1', 'fast', { id: '2' })])
  })

  it('reports invalid input, unknown tools, thrown errors and isError results as is_error', async () => {
    const strict = defineTool({ name: 'strict', inputSchema: z.object({ n: z.number() }), execute: async () => ({ content: 'never' }) })
    const thrower = defineTool({ name: 'thrower', inputSchema: z.object({}), execute: async () => { throw new Error('kaputt') } })
    const soft = defineTool({ name: 'soft', inputSchema: z.object({}), execute: async () => ({ content: '', isError: true }) })
    const { agent } = build(
      [
        {
          content: [
            toolUse('a', 'strict', { n: 'nope' }),
            toolUse('b', 'ghost', {}),
            toolUse('c', 'thrower', {}),
            toolUse('d', 'soft', {}),
          ],
          stopReason: 'tool_use',
        },
        { content: [text('ok')] },
      ],
      { tools: [strict, thrower, soft] },
    )
    const cb = callbacks()
    await agent.run(input('go'), cb, new AbortController().signal)
    const results = history.messages()[2]!.content as Anthropic.ToolResultBlockParam[]
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b', 'c', 'd'])
    expect(results.every((r) => r.is_error === true)).toBe(true)
    expect(results[0]!.content).toContain('Invalid input for strict')
    expect(results[0]!.content).toContain('- n:')
    expect(results[1]!.content).toBe('Unknown tool: ghost')
    expect(results[2]!.content).toBe('kaputt')
    expect(results[3]!.content).toBe('(no output)')
    expect(cb.toolResults).toEqual([
      ['strict', false],
      ['ghost', false],
      ['thrower', false],
      ['soft', false],
    ])
    expect(cb.toolCalls.map(([n]) => n)).toEqual(['strict', 'ghost', 'thrower', 'soft'])
  })

  it('caps long text results', () => {
    const long = 'x'.repeat(TOOL_RESULT_TEXT_CAP + 1000)
    const capped = capText(long)
    expect(capped.length).toBeLessThan(long.length)
    expect(capped.startsWith('x'.repeat(TOOL_RESULT_TEXT_CAP))).toBe(true)
    expect(capped.slice(TOOL_RESULT_TEXT_CAP)).toBe('\n…[truncated, 1000 characters omitted]')
    expect(capText('short')).toBe('short')
  })

  it('stops after maxToolIterations', async () => {
    const loop = defineTool({ name: 'loop', inputSchema: z.object({}), execute: async () => ({ content: 'again' }) })
    const responses: FakeResponse[] = Array.from({ length: 5 }, (_, i) => ({ content: [toolUse(`u${i}`, 'loop', {})], stopReason: 'tool_use' as const }))
    const { agent, fake } = build(responses, { tools: [loop], config: makeConfig({ maxToolIterations: 2 }) })
    const result = await agent.run(input('go'), callbacks(), new AbortController().signal)
    expect(fake.calls).toHaveLength(2)
    expect(result.stopReason).toBe('max_iterations')
    expect(history.messages().at(-1)!.role).toBe('user') // tool_results present, nothing dangling
  })
})

describe('abort', () => {
  it('keeps the partial text in history when aborted mid-stream', async () => {
    const controller = new AbortController()
    const { agent } = build([{ content: [text('Hallo Welt, wie geht es dir?')], deltas: ['Hallo ', 'Welt', ', wie geht es dir?'] }])
    const cb = callbacks({ onText: (d) => { if (d === 'Welt') controller.abort() } })
    const result = await agent.run(input('Hi'), cb, controller.signal)
    expect(result).toEqual({ text: 'Hallo Welt', stopReason: 'aborted', aborted: true, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } })
    expect(history.messages()).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hallo Welt' }] },
    ])
    expect(createHistory(historyFile).messages()).toEqual(history.messages())
  })

  it('appends nothing when aborted before any text arrived', async () => {
    const controller = new AbortController()
    const { agent } = build([{ content: [text('…')], deltas: ['a', 'b'] }])
    controller.abort()
    const result = await agent.run(input('Hi'), callbacks(), controller.signal)
    expect(result.aborted).toBe(true)
    expect(history.messages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }])
  })

  it('answers running tools with "interrupted" so no tool_use is left dangling', async () => {
    const controller = new AbortController()
    const never = defineTool({ name: 'never', inputSchema: z.object({}), execute: () => new Promise(() => undefined) })
    const quick = defineTool({ name: 'quick', inputSchema: z.object({}), execute: async () => ({ content: 'done' }) })
    const { agent, fake } = build([{ content: [toolUse('n1', 'never', {}), toolUse('q1', 'quick', {})], stopReason: 'tool_use' }], { tools: [never, quick] })
    const cb = callbacks({ onToolCall: (name) => { if (name === 'quick') setTimeout(() => controller.abort(), 5) } })
    const result = await agent.run(input('go'), cb, controller.signal)
    expect(result).toMatchObject({ stopReason: 'aborted', aborted: true })
    expect(fake.calls).toHaveLength(1)
    const m = history.messages()
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
    expect(m[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'n1', is_error: true, content: 'interrupted' },
      { type: 'tool_result', tool_use_id: 'q1', content: 'done' },
    ])
  })
})

describe('errors', () => {
  const api = (Cls: new (...args: never[]) => Error, status: number, msg: string): Error =>
    new (Cls as unknown as new (s: number, e: undefined, m: string, h: undefined) => Error)(status, undefined, msg, undefined)

  it('maps SDK error classes to German messages', () => {
    expect(mapApiError(api(Anthropic.AuthenticationError, 401, 'bad key')).message).toBe('API-Key ungültig')
    expect(mapApiError(api(Anthropic.RateLimitError, 429, 'slow down')).message).toBe('Rate-Limit erreicht')
    expect(mapApiError(new Anthropic.APIConnectionError({})).message).toBe('Keine Verbindung zur Anthropic API')
    expect(mapApiError(new Anthropic.APIConnectionTimeoutError()).message).toBe('Keine Verbindung zur Anthropic API')
    expect(mapApiError(api(Anthropic.NotFoundError, 404, 'model: nope')).message).toContain('Modell nicht gefunden')
    expect(mapApiError(api(Anthropic.InternalServerError, 500, 'overloaded')).message).toBe('Anthropic API 500: overloaded')
    expect(mapApiError('weird').message).toBe('weird')
  })

  it('throws the mapped error from run() and still persists the user message', async () => {
    const { agent } = build([{ content: [], error: api(Anthropic.AuthenticationError, 401, 'nope') }])
    await expect(agent.run(input('Hi'), callbacks(), new AbortController().signal)).rejects.toThrow('API-Key ungültig')
    expect(createHistory(historyFile).messages()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }])
  })

  it('retries once without the fallback beta when the API rejects it with 400, then stays off', async () => {
    const { agent, fake } = build([
      { content: [], error: api(Anthropic.BadRequestError, 400, 'fallbacks not supported') },
      { content: [text('ohne beta')] },
      { content: [text('immer noch ohne')] },
    ])
    const result = await agent.run(input('Hi'), callbacks(), new AbortController().signal)
    expect(result.text).toBe('ohne beta')
    expect(fake.calls.map((c) => c.namespace)).toEqual(['beta', 'messages'])
    await agent.run(input('Nochmal'), callbacks(), new AbortController().signal)
    expect(fake.calls.map((c) => c.namespace)).toEqual(['beta', 'messages', 'messages'])
  })

  it('refuses to run without an API key', async () => {
    const config = makeConfig({ apiKey: '' })
    const savedEnv = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      const agent = createAgent({
        config,
        history,
        tools: [],
        systemPrompt: 'x',
        toolContextFactory: () => ({ config, signal: new AbortController().signal, confirm: async () => false, progress: () => undefined }),
      })
      await expect(agent.run(input('Hi'), callbacks(), new AbortController().signal)).rejects.toThrow('Kein API-Key konfiguriert')
      expect(history.messages()).toEqual([])
      expect(await agent.test()).toEqual({ ok: false, message: 'Kein API-Key konfiguriert' })
    } finally {
      if (savedEnv !== undefined) process.env['ANTHROPIC_API_KEY'] = savedEnv
    }
  })
})

describe('test() and update()', () => {
  it('test() retrieves the model and reports success or the mapped error', async () => {
    const { agent, fake } = build([])
    expect(await agent.test()).toEqual({ ok: true, message: 'Verbindung OK (claude-opus-5-5)' })
    expect(fake.retrieve).toHaveBeenCalledWith('claude-opus-5-5')
    fake.retrieve.mockRejectedValueOnce(new Anthropic.APIConnectionError({}))
    expect(await agent.test()).toEqual({ ok: false, message: 'Keine Verbindung zur Anthropic API' })
  })

  it('update() swaps config/tools/system prompt and rebuilds the client only when the key changed', async () => {
    const first = fakeClient([{ content: [text('1')] }, { content: [text('2')] }])
    const second = fakeClient([{ content: [text('3')] }])
    const createClient = vi.fn(() => first.client)
    const { agent } = build([], { createClient })
    await agent.run(input('a'), callbacks(), new AbortController().signal)
    expect(createClient).toHaveBeenCalledTimes(1)

    agent.update({ config: makeConfig({ model: 'claude-sonnet-5', effort: 'medium' }), systemPrompt: 'Neu.', tools: [defineTool({ name: 'z', inputSchema: z.object({}), execute: async () => ({ content: '' }) })] })
    await agent.run(input('b'), callbacks(), new AbortController().signal)
    expect(createClient).toHaveBeenCalledTimes(1) // same key → same client
    const call = first.calls[1]!
    expect(call.params['model']).toBe('claude-sonnet-5')
    expect(call.params['output_config']).toEqual({ effort: 'medium' })
    expect(call.params['system']).toEqual([{ type: 'text', text: 'Neu.', cache_control: { type: 'ephemeral' } }])
    expect((call.params['tools'] as Anthropic.Tool[]).map((t) => t.name)).toEqual(['z'])

    createClient.mockReturnValue(second.client)
    agent.update({ config: makeConfig({ apiKey: 'sk-other' }) })
    await agent.run(input('c'), callbacks(), new AbortController().signal)
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenLastCalledWith('sk-other')
    expect(second.calls).toHaveLength(1)
  })

  it('trims the history before each request so old turns fall off without splitting pairs', async () => {
    const config = makeConfig({ maxHistoryTurns: 4 })
    const responses: FakeResponse[] = Array.from({ length: 6 }, (_, i) => ({ content: [text(`r${i}`)] }))
    const { agent, fake } = build(responses, { config })
    for (let i = 0; i < 6; i++) await agent.run(input(`u${i}`), callbacks(), new AbortController().signal)
    const sent = fake.calls[5]!.params['messages'] as Anthropic.MessageParam[]
    expect(sent).toHaveLength(7) // 3 complete old turns + the new user message
    expect(sent[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'u2' }] })
    expect(history.messages()).toHaveLength(8)
  })

  it('sends a screenshot only with the turn that took it: later requests and the file get a placeholder', async () => {
    const { agent, fake } = build([{ content: [text('Ein Editor.')] }, { content: [text('Okay.')] }])
    await agent.run(input('Was siehst du?', { screenshot: { mediaType: 'image/jpeg', base64: 'QUJD' } }), callbacks(), new AbortController().signal)
    const first = fake.calls[0]!.params['messages'] as Anthropic.MessageParam[]
    expect((first[0]!.content as Anthropic.ContentBlockParam[])[0]).toMatchObject({ type: 'image' })
    const onDisk = fs.readFileSync(historyFile, 'utf8')
    expect(onDisk).not.toContain('QUJD')
    expect(onDisk).toContain(IMAGE_PLACEHOLDER)

    await agent.run(input('Und jetzt?', { turnId: 't2' }), callbacks(), new AbortController().signal)
    const second = fake.calls[1]!.params['messages'] as Anthropic.MessageParam[]
    expect(second).toHaveLength(3)
    expect(second[0]).toEqual({ role: 'user', content: [{ type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: 'Was siehst du?' }] })
    expect(JSON.stringify(second)).not.toContain('QUJD')
    expect(JSON.stringify(history.messages())).not.toContain('QUJD')
  })
})
