import { decode as msgpackDecode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import { TtsConfigSchema, type TtsConfig } from '@shared/config'
import {
  clampChunkLength,
  createFishLocalTts,
  isValidLocalReferenceId,
  LOCAL_KEY_INVALID_MESSAGE,
  normalizeLocalFormat,
  referenceIdInvalidMessage,
  serverUnreachableMessage,
} from './fishLocal'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function cfg(overrides: Record<string, unknown> = {}, local: Record<string, unknown> = {}): TtsConfig {
  return TtsConfigSchema.parse({ provider: 'fish-local', fishLocal: { ...local }, ...overrides })
}

function fetchSequence(...responses: Array<() => Response | Promise<Response>>): FetchMock {
  let i = 0
  return vi.fn<typeof fetch>(async () => {
    const make = responses[Math.min(i, responses.length - 1)]
    i++
    if (!make) throw new Error('no response queued')
    return make()
  })
}

const audioOk = () => new Response(new Uint8Array([4, 5]), { status: 200 })
const healthOk = () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
const httpError = (status: number, message = 'nope') => () => new Response(JSON.stringify({ message, status }), { status })
const connectionRefused = (): Promise<Response> => Promise.reject(new TypeError('fetch failed: ECONNREFUSED'))

function callOf(fetchImpl: FetchMock, index = 0): { url: string; init: RequestInit; headers: Record<string, string> } {
  const call = fetchImpl.mock.calls[index]
  if (!call) throw new Error(`no fetch call #${index}`)
  const [url, init] = call
  return { url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> }
}

function jsonBody(fetchImpl: FetchMock, index = 0): Record<string, unknown> {
  return JSON.parse(callOf(fetchImpl, index).init.body as string) as Record<string, unknown>
}

describe('helpers', () => {
  it('clampChunkLength yields an int in 100..300 (default 200)', () => {
    expect(clampChunkLength(undefined)).toBe(200)
    expect(clampChunkLength(Number.NaN)).toBe(200)
    expect(clampChunkLength(50)).toBe(100)
    expect(clampChunkLength(999)).toBe(300)
    expect(clampChunkLength(150.6)).toBe(151)
    expect(clampChunkLength(200)).toBe(200)
  })

  it('normalizeLocalFormat only allows wav|mp3', () => {
    expect(normalizeLocalFormat('wav')).toBe('wav')
    expect(normalizeLocalFormat('mp3')).toBe('mp3')
    expect(normalizeLocalFormat('pcm')).toBe('wav')
    expect(normalizeLocalFormat('opus')).toBe('wav')
  })
})

describe('createFishLocalTts.synthesize', () => {
  it('sends a clean local body (no latency/prosody/sample_rate), no auth header without key', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const client = createFishLocalTts(cfg({ speed: 1.5 }, { baseUrl: 'http://127.0.0.1:8080/', referenceId: 'mika' }), { fetchImpl })
    const out = await client.synthesize('Hallo Welt.')
    expect(out).toEqual({ data: expect.any(ArrayBuffer), format: 'wav' })
    expect(new Uint8Array(out.data)).toEqual(new Uint8Array([4, 5]))

    const { url, headers } = callOf(fetchImpl)
    expect(url).toBe('http://127.0.0.1:8080/v1/tts')
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['model']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
    expect(jsonBody(fetchImpl)).toEqual({
      text: 'Hallo Welt.',
      reference_id: 'mika',
      format: 'wav',
      chunk_length: 200,
      temperature: 0.8,
      top_p: 0.8,
      repetition_penalty: 1.1,
      normalize: true,
      streaming: false,
    })
  })

  it('sends the bearer header when an api key is set, mp3 when configured, null reference when empty', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const client = createFishLocalTts(cfg({}, { apiKey: 'local-secret', format: 'mp3' }), { fetchImpl })
    const out = await client.synthesize('Test.')
    expect(out.format).toBe('mp3')
    expect(callOf(fetchImpl).headers['Authorization']).toBe('Bearer local-secret')
    const body = jsonBody(fetchImpl)
    expect(body['format']).toBe('mp3')
    expect(body['reference_id']).toBeNull()
  })

  it('forces wav for formats the server cannot write and clamps chunk_length to an int in 100..300', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const broken = cfg()
    ;(broken.fishLocal as { format: string }).format = 'pcm'
    const out = await createFishLocalTts(broken, { fetchImpl, chunkLength: 1000 }).synthesize('Test.')
    expect(out.format).toBe('wav')
    expect(jsonBody(fetchImpl)['format']).toBe('wav')
    expect(jsonBody(fetchImpl)['chunk_length']).toBe(300)

    const f2 = fetchSequence(audioOk)
    await createFishLocalTts(cfg(), { fetchImpl: f2, chunkLength: 12.4 }).synthesize('Test.')
    expect(jsonBody(f2)['chunk_length']).toBe(100)
  })

  it('uses S1-style parentheses cues (local model is S1-mini) and respects emotionCues', async () => {
    const f1 = fetchSequence(audioOk)
    await createFishLocalTts(cfg(), { fetchImpl: f1 }).synthesize('Juhu!', { emotion: 'happy' })
    expect(jsonBody(f1)['text']).toBe('(happy) Juhu!')

    const f2 = fetchSequence(audioOk)
    await createFishLocalTts(cfg({ emotionCues: false }), { fetchImpl: f2 }).synthesize('Juhu!', { emotion: 'happy' })
    expect(jsonBody(f2)['text']).toBe('Juhu!')
  })

  it('rejects with "empty" before calling the server', async () => {
    const fetchImpl = fetchSequence(audioOk)
    await expect(createFishLocalTts(cfg(), { fetchImpl }).synthesize(' [[sad]] ')).rejects.toThrow('empty')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends inline clone references via msgpack with use_memory_cache on', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const readFile = vi.fn(async () => new Uint8Array([1, 1, 2, 3]))
    const client = createFishLocalTts(cfg({}, { referenceId: 'mika', cloneSample: { audioPath: '/tmp/yui.wav', transcript: 'Ich bin Yui.' } }), {
      fetchImpl,
      readFile,
    })
    await client.synthesize('Eins.')
    await client.synthesize('Zwei.')
    expect(readFile).toHaveBeenCalledTimes(1)
    const { headers, init } = callOf(fetchImpl)
    expect(headers['Content-Type']).toBe('application/msgpack')
    const decoded = msgpackDecode(new Uint8Array(init.body as ArrayBuffer)) as Record<string, unknown>
    expect(decoded['references']).toEqual([{ audio: new Uint8Array([1, 1, 2, 3]), text: 'Ich bin Yui.' }])
    expect(decoded['use_memory_cache']).toBe('on')
    expect(decoded['reference_id']).toBeUndefined()
    expect(decoded['latency']).toBeUndefined()
    expect(decoded['prosody']).toBeUndefined()
    expect(decoded['streaming']).toBe(false)
  })

  it('rejects with a clear message when the server is down (no retry on network errors)', async () => {
    const fetchImpl = fetchSequence(connectionRefused)
    const client = createFishLocalTts(cfg({}, { baseUrl: 'http://127.0.0.1:9999' }), { fetchImpl, sleep: async () => undefined })
    await expect(client.synthesize('Test.')).rejects.toThrow(serverUnreachableMessage('http://127.0.0.1:9999'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('maps 401 to the key message and retries once on 5xx', async () => {
    const unauthorized = fetchSequence(httpError(401, 'Invalid token'))
    await expect(createFishLocalTts(cfg(), { fetchImpl: unauthorized }).synthesize('Test.')).rejects.toThrow(LOCAL_KEY_INVALID_MESSAGE)

    const sleep = vi.fn(async () => undefined)
    const flaky = fetchSequence(httpError(500, 'Failed to generate speech'), audioOk)
    const out = await createFishLocalTts(cfg(), { fetchImpl: flaky, sleep }).synthesize('Test.')
    expect(new Uint8Array(out.data)).toEqual(new Uint8Array([4, 5]))
    expect(flaky).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(400, undefined)
  })

  it('rejects with an AbortError when aborted', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    const p = createFishLocalTts(cfg(), { fetchImpl }).synthesize('Test.', { signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('createFishLocalTts.test', () => {
  it('reports an unreachable server with the base url', async () => {
    const fetchImpl = fetchSequence(connectionRefused)
    const result = await createFishLocalTts(cfg({}, { baseUrl: 'http://localhost:8080' }), { fetchImpl }).test('Hallo')
    expect(result).toEqual({
      ok: false,
      message: 'Fish Speech Server nicht erreichbar unter http://localhost:8080 – läuft `tools/api_server.py`?',
    })
    expect(callOf(fetchImpl).url).toBe('http://localhost:8080/v1/health')
  })

  it('reports a wrong api key', async () => {
    const fetchImpl = fetchSequence(httpError(401, 'Invalid token'))
    const result = await createFishLocalTts(cfg({}, { apiKey: 'wrong' }), { fetchImpl }).test('Hallo')
    expect(result).toEqual({ ok: false, message: LOCAL_KEY_INVALID_MESSAGE })
  })

  it('synthesizes the sample when the server is up', async () => {
    const fetchImpl = fetchSequence(healthOk, audioOk)
    const result = await createFishLocalTts(cfg(), { fetchImpl }).test('Hallo!')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('http://127.0.0.1:8080')
    expect(result.audio?.format).toBe('wav')
    expect(new Uint8Array(result.audio!.data)).toEqual(new Uint8Array([4, 5]))
    expect(callOf(fetchImpl, 1).url).toBe('http://127.0.0.1:8080/v1/tts')
  })

  it('reports a failing sample synthesis', async () => {
    const fetchImpl = fetchSequence(healthOk, httpError(500, 'Failed to generate speech'), httpError(500, 'Failed to generate speech'))
    const result = await createFishLocalTts(cfg(), { fetchImpl, sleep: async () => undefined }).test('Hallo')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Failed to generate speech')
  })
})

describe('reference_id validation (path traversal guard for the local server)', () => {
  it('accepts plain folder names and rejects anything path-like', () => {
    expect(isValidLocalReferenceId('mika')).toBe(true)
    expect(isValidLocalReferenceId('My Voice_01-b')).toBe(true)
    expect(isValidLocalReferenceId('../../etc')).toBe(false)
    expect(isValidLocalReferenceId('a/b')).toBe(false)
    expect(isValidLocalReferenceId('a\\b')).toBe(false)
    expect(isValidLocalReferenceId('voice.wav')).toBe(false)
    expect(isValidLocalReferenceId('')).toBe(false)
  })

  it('never sends an invalid reference_id to the server', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const client = createFishLocalTts(cfg({}, { referenceId: '../../secret' }), { fetchImpl })
    await expect(client.synthesize('Hallo.')).rejects.toThrow(referenceIdInvalidMessage('../../secret'))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('test() reports the invalid id instead of synthesizing', async () => {
    const fetchImpl = fetchSequence(healthOk)
    const result = await createFishLocalTts(cfg({}, { referenceId: 'a/b' }), { fetchImpl }).test('Hallo')
    expect(result).toEqual({ ok: false, message: referenceIdInvalidMessage('a/b') })
    expect(fetchImpl).toHaveBeenCalledTimes(1) // only the health check
  })
})
