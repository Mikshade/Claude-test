import { describe, expect, it, vi } from 'vitest'
import { SttConfigSchema, type SttConfig } from '@shared/config'
import type { RecordedAudio } from '@shared/ipc'
import { NOTHING_RECOGNIZED_MESSAGE } from './common'
import {
  createOpenAiCompatibleStt,
  describeOpenAiError,
  ENDPOINT_OK_MESSAGE,
  ENDPOINT_OK_NO_MODELS_MESSAGE,
  errorSnippet,
  KEY_INVALID_MESSAGE,
  normalizeBaseUrl,
  SttHttpError,
} from './openaiCompatible'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function cfg(openai: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): SttConfig {
  return SttConfigSchema.parse({
    provider: 'openai-compatible',
    openaiCompatible: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'whisper-1', ...openai },
    ...overrides,
  })
}

function wav(bytes: number[] = [82, 73, 70, 70]): RecordedAudio {
  return { data: new Uint8Array(bytes).buffer, mimeType: 'audio/wav', durationMs: 900 }
}

function fetchSequence(...responses: Array<() => Response>): FetchMock {
  let i = 0
  return vi.fn<typeof fetch>(async () => {
    const make = responses[Math.min(i, responses.length - 1)]
    i++
    if (!make) throw new Error('no response queued')
    return make()
  })
}

const jsonOk = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const status = (code: number, body = '', headers: Record<string, string> = {}) => () => new Response(body, { status: code, headers })

function callOf(fetchImpl: FetchMock, index = 0): { url: string; init: RequestInit; headers: Record<string, string>; form: FormData } {
  const call = fetchImpl.mock.calls[index]
  if (!call) throw new Error(`no fetch call #${index}`)
  const [url, init] = call
  return { url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string>, form: init?.body as FormData }
}

const noSleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)

describe('normalizeBaseUrl', () => {
  it('accepts the three documented variants', () => {
    expect(normalizeBaseUrl('https://api.openai.com')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('http://localhost:8000/v1/')).toBe('http://localhost:8000/v1')
  })

  it('handles whitespace, prefixed paths, pasted endpoints and empty input', () => {
    expect(normalizeBaseUrl('  https://api.groq.com/openai  ')).toBe('https://api.groq.com/openai/v1')
    expect(normalizeBaseUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:9000/v1/audio/transcriptions')).toBe('http://127.0.0.1:9000/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:9000/audio/transcriptions/')).toBe('http://127.0.0.1:9000/v1')
    expect(normalizeBaseUrl('http://127.0.0.1:9000/v1/models')).toBe('http://127.0.0.1:9000/v1')
    expect(normalizeBaseUrl('http://host//')).toBe('http://host/v1')
    expect(normalizeBaseUrl('')).toBe('')
    expect(normalizeBaseUrl('   ')).toBe('')
  })
})

describe('createOpenAiCompatibleStt.transcribe', () => {
  it('posts the documented multipart form to {base}/audio/transcriptions with a bearer token', async () => {
    const fetchImpl = fetchSequence(jsonOk({ text: '  Hallo Welt ' }))
    const client = createOpenAiCompatibleStt(cfg({ baseUrl: 'https://api.openai.com' }, { language: 'de' }), { fetchImpl })
    expect(client.name).toBe('openai-compatible')
    expect(await client.transcribe(wav([1, 2, 3]))).toBe('Hallo Welt')

    const { url, init, headers, form } = callOf(fetchImpl)
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBeUndefined() // multipart boundary set by fetch
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('file') as File
    expect(file.name).toBe('speech.wav')
    expect(file.type).toBe('audio/wav')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('language')).toBe('de')
    expect(form.get('response_format')).toBe('json')
  })

  it('normalizes each base URL variant to the same endpoint', async () => {
    for (const baseUrl of ['https://api.openai.com', 'https://api.openai.com/v1', 'https://api.openai.com/v1/']) {
      const fetchImpl = fetchSequence(jsonOk({ text: 'x' }))
      await createOpenAiCompatibleStt(cfg({ baseUrl }), { fetchImpl }).transcribe(wav())
      expect(callOf(fetchImpl).url).toBe('https://api.openai.com/v1/audio/transcriptions')
    }
    const local = fetchSequence(jsonOk({ text: 'x' }))
    await createOpenAiCompatibleStt(cfg({ baseUrl: 'http://localhost:8000/v1/' }), { fetchImpl: local }).transcribe(wav())
    expect(callOf(local).url).toBe('http://localhost:8000/v1/audio/transcriptions')
  })

  it('sends no Authorization header when the key is empty (local servers)', async () => {
    const fetchImpl = fetchSequence(jsonOk({ text: 'x' }))
    await createOpenAiCompatibleStt(cfg({ baseUrl: 'http://localhost:8000', apiKey: '   ' }), { fetchImpl }).transcribe(wav())
    expect(callOf(fetchImpl).headers['Authorization']).toBeUndefined()
  })

  it('adds the language field only when a hint or configured language is set', async () => {
    const none = fetchSequence(jsonOk({ text: 'x' }))
    await createOpenAiCompatibleStt(cfg({}, { language: '' }), { fetchImpl: none }).transcribe(wav())
    expect(callOf(none).form.has('language')).toBe(false)

    const hinted = fetchSequence(jsonOk({ text: 'x' }))
    await createOpenAiCompatibleStt(cfg({}, { language: 'de' }), { fetchImpl: hinted }).transcribe(wav(), 'en-GB')
    expect(callOf(hinted).form.get('language')).toBe('en')

    const configured = fetchSequence(jsonOk({ text: 'x' }))
    await createOpenAiCompatibleStt(cfg({}, { language: 'en' }), { fetchImpl: configured }).transcribe(wav(), '')
    expect(callOf(configured).form.get('language')).toBe('en')
  })

  it('uses the configured model, falls back to whisper-1 when blank, and names webm files correctly', async () => {
    const fetchImpl = fetchSequence(jsonOk({ text: 'x' }))
    await createOpenAiCompatibleStt(cfg({ model: 'gpt-4o-transcribe' }), { fetchImpl }).transcribe({
      data: new Uint8Array([1]).buffer,
      mimeType: 'audio/webm',
      durationMs: 10,
    })
    expect(callOf(fetchImpl).form.get('model')).toBe('gpt-4o-transcribe')
    const file = callOf(fetchImpl).form.get('file') as File
    expect(file.name).toBe('speech.webm')
    expect(file.type).toBe('audio/webm')

    const blank = fetchSequence(jsonOk({ text: 'x' }))
    await createOpenAiCompatibleStt(cfg({ model: '  ' }), { fetchImpl: blank }).transcribe(wav())
    expect(callOf(blank).form.get('model')).toBe('whisper-1')
  })

  it('returns an empty string for empty/missing text and skips empty recordings', async () => {
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl: fetchSequence(jsonOk({ text: '   ' })) }).transcribe(wav())).toBe('')
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl: fetchSequence(jsonOk({})) }).transcribe(wav())).toBe('')
    const fetchImpl = fetchSequence(jsonOk({ text: 'x' }))
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl }).transcribe(wav([]))).toBe('')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('turns JSON, HTML and plain-text error bodies into a readable error with status + snippet', async () => {
    const json = fetchSequence(status(400, JSON.stringify({ error: { message: 'Unsupported file format', type: 'invalid_request_error' } })))
    await expect(createOpenAiCompatibleStt(cfg(), { fetchImpl: json }).transcribe(wav())).rejects.toMatchObject({
      name: 'SttHttpError',
      status: 400,
      message: 'HTTP 400: Unsupported file format',
    })

    const html = fetchSequence(status(404, '<!doctype html><html><head><title>Not Found</title></head><body><h1>Not Found</h1><p>No route</p></body></html>'))
    await expect(createOpenAiCompatibleStt(cfg(), { fetchImpl: html }).transcribe(wav())).rejects.toMatchObject({
      status: 404,
      message: 'HTTP 404: Not Found Not Found No route',
    })

    const long = fetchSequence(status(502, 'x'.repeat(500)))
    const err = await createOpenAiCompatibleStt(cfg(), { fetchImpl: long, sleep: noSleep }).transcribe(wav()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SttHttpError)
    expect((err as SttHttpError).snippet).toHaveLength(200)
    expect((err as SttHttpError).message).toBe(`HTTP 502: ${'x'.repeat(200)}`)

    const empty = fetchSequence(status(500))
    await expect(createOpenAiCompatibleStt(cfg(), { fetchImpl: empty, sleep: noSleep }).transcribe(wav())).rejects.toThrow('HTTP 500')
  })

  it('rejects readably when a 200 answer is not JSON', async () => {
    const fetchImpl = fetchSequence(status(200, '<html>proxy login</html>'))
    await expect(createOpenAiCompatibleStt(cfg(), { fetchImpl }).transcribe(wav())).rejects.toThrow(
      'STT-Server antwortete nicht mit JSON (HTTP 200): proxy login',
    )
  })

  it('retries exactly once after 400 ms on 503/429, never on 4xx', async () => {
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)
    const f1 = fetchSequence(status(503, 'overloaded'), jsonOk({ text: 'Danach' }))
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl: f1, sleep }).transcribe(wav())).toBe('Danach')
    expect(f1).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]?.[0]).toBe(400)

    const f2 = fetchSequence(status(429, 'slow down'), status(429, 'slow down'))
    await expect(createOpenAiCompatibleStt(cfg(), { fetchImpl: f2, sleep }).transcribe(wav())).rejects.toMatchObject({ status: 429 })
    expect(f2).toHaveBeenCalledTimes(2)

    const f3 = fetchSequence(status(401, 'bad key'), jsonOk({ text: 'x' }))
    await expect(createOpenAiCompatibleStt(cfg(), { fetchImpl: f3, sleep }).transcribe(wav())).rejects.toMatchObject({ status: 401, isAuth: true })
    expect(f3).toHaveBeenCalledTimes(1)
  })

  it('passes the signal to fetch and lets an AbortError through unchanged', async () => {
    const aborted = new Error('The operation was aborted')
    aborted.name = 'AbortError'
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.signal?.aborted) throw aborted
      return jsonOk({ text: 'x' })()
    })
    const client = createOpenAiCompatibleStt(cfg(), { fetchImpl, sleep: noSleep })

    const live = new AbortController()
    await client.transcribe(wav(), undefined, live.signal)
    expect(callOf(fetchImpl).init.signal).toBe(live.signal)

    const pre = new AbortController()
    pre.abort()
    await expect(client.transcribe(wav(), undefined, pre.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const during = vi.fn<typeof fetch>(async () => {
      throw aborted
    })
    await expect(createOpenAiCompatibleStt(cfg(), { fetchImpl: during, sleep: noSleep }).transcribe(wav())).rejects.toBe(aborted)
    expect(during).toHaveBeenCalledTimes(1)
  })
})

describe('createOpenAiCompatibleStt.test', () => {
  it('transcribes the sample when audio is given', async () => {
    const fetchImpl = fetchSequence(jsonOk({ text: 'Test eins zwei' }))
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl }).test(wav())).toEqual({ ok: true, message: 'Erkannt: "Test eins zwei"' })
    expect(callOf(fetchImpl).url).toBe('https://api.openai.com/v1/audio/transcriptions')

    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl: fetchSequence(jsonOk({ text: '' })) }).test(wav())).toEqual({
      ok: false,
      message: NOTHING_RECOGNIZED_MESSAGE,
    })
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl: fetchSequence(status(401, 'nope')) }).test(wav())).toEqual({
      ok: false,
      message: KEY_INVALID_MESSAGE,
    })
  })

  it('probes GET {base}/models without audio', async () => {
    const ok = fetchSequence(jsonOk({ data: [] }))
    expect(await createOpenAiCompatibleStt(cfg({ baseUrl: 'http://localhost:8000' }), { fetchImpl: ok }).test()).toEqual({
      ok: true,
      message: ENDPOINT_OK_MESSAGE,
    })
    const { url, init, headers } = callOf(ok)
    expect(url).toBe('http://localhost:8000/v1/models')
    expect(init.method).toBe('GET')
    expect(headers['Authorization']).toBe('Bearer sk-test')

    const noKey = fetchSequence(jsonOk({ data: [] }))
    await createOpenAiCompatibleStt(cfg({ apiKey: '' }), { fetchImpl: noKey }).test()
    expect(callOf(noKey).headers['Authorization']).toBeUndefined()
  })

  it('treats 404/405 on /models as reachable, 401 as a bad key, other statuses as failures', async () => {
    for (const code of [404, 405]) {
      expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl: fetchSequence(status(code, '<h1>nope</h1>')) }).test()).toEqual({
        ok: true,
        message: ENDPOINT_OK_NO_MODELS_MESSAGE,
      })
    }
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl: fetchSequence(status(401, '{"error":{"message":"bad"}}')) }).test()).toEqual({
      ok: false,
      message: KEY_INVALID_MESSAGE,
    })
    const other = await createOpenAiCompatibleStt(cfg(), { fetchImpl: fetchSequence(status(500, 'kaputt')) }).test()
    expect(other).toEqual({ ok: false, message: 'STT-Server Fehler (HTTP 500: kaputt)' })
  })

  it('reports network errors as ok:false', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl }).test()).toEqual({ ok: false, message: 'STT-Server nicht erreichbar: fetch failed' })
    expect(await createOpenAiCompatibleStt(cfg(), { fetchImpl }).test(wav())).toEqual({
      ok: false,
      message: 'STT-Server nicht erreichbar: fetch failed',
    })
  })
})

describe('errorSnippet / describeOpenAiError', () => {
  it('extracts messages from common JSON shapes and strips HTML', () => {
    expect(errorSnippet('{"error":{"message":"Invalid API key"}}')).toBe('Invalid API key')
    expect(errorSnippet('{"error":"plain"}')).toBe('plain')
    expect(errorSnippet('{"message":"m"}')).toBe('m')
    expect(errorSnippet('{"detail":"Not Found"}')).toBe('Not Found')
    expect(errorSnippet('{"detail":[{"msg":"x"}]}')).toBe('{"detail":[{"msg":"x"}]}')
    expect(errorSnippet('"quoted"')).toBe('quoted')
    expect(errorSnippet('<style>a{}</style><script>x()</script><p>Bad   Gateway</p>')).toBe('Bad Gateway')
    expect(errorSnippet('   ')).toBe('')
  })

  it('maps aborts and unknown values', () => {
    const abort = new Error('x')
    abort.name = 'AbortError'
    expect(describeOpenAiError(abort)).toBe('Abgebrochen.')
    expect(describeOpenAiError('weird')).toBe('STT-Server nicht erreichbar: weird')
    expect(describeOpenAiError(new SttHttpError(403, 'forbidden'))).toBe(KEY_INVALID_MESSAGE)
  })
})
