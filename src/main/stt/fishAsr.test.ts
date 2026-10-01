import { describe, expect, it, vi } from 'vitest'
import { SttConfigSchema, type SttConfig } from '@shared/config'
import type { RecordedAudio } from '@shared/ipc'
import { createFishAsrStt, describeFishAsrError, FISH_ASR_MODEL, KEY_INVALID_MESSAGE, NO_CREDITS_MESSAGE } from './fishAsr'
import { NOTHING_RECOGNIZED_MESSAGE } from './common'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function cfg(overrides: Record<string, unknown> = {}): SttConfig {
  return SttConfigSchema.parse({ provider: 'fish-cloud', ...overrides })
}

function wav(bytes: number[] = [82, 73, 70, 70]): RecordedAudio {
  return { data: new Uint8Array(bytes).buffer, mimeType: 'audio/wav', durationMs: 1200 }
}

/** fetch mock that answers each call with the next queued response (last one repeats). */
function fetchSequence(...responses: Array<() => Response>): FetchMock {
  let i = 0
  return vi.fn<typeof fetch>(async () => {
    const make = responses[Math.min(i, responses.length - 1)]
    i++
    if (!make) throw new Error('no response queued')
    return make()
  })
}

const asrOk = (text: string, extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ text, duration: 1.2, segments: [], language_code: 'de', ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
const creditOk = () => new Response(JSON.stringify({ credit: '4.2', cumulative_top_up: '10' }), { status: 200 })
const httpError = (status: number, message = 'nope') => () => new Response(JSON.stringify({ message, status }), { status })

function callOf(fetchImpl: FetchMock, index = 0): { url: string; init: RequestInit; headers: Record<string, string>; form: FormData } {
  const call = fetchImpl.mock.calls[index]
  if (!call) throw new Error(`no fetch call #${index}`)
  const [url, init] = call
  return { url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string>, form: init?.body as FormData }
}

const noSleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)

describe('createFishAsrStt.transcribe', () => {
  it('posts multipart audio with auth + transcribe-1 model header and returns the trimmed transcript', async () => {
    const fetchImpl = fetchSequence(asrOk('  Hallo Welt  '))
    const client = createFishAsrStt(cfg({ language: 'de' }), ' key-123 ', { fetchImpl })
    expect(client.name).toBe('fish-cloud')
    const text = await client.transcribe(wav([1, 2, 3]))
    expect(text).toBe('Hallo Welt')

    const { url, init, headers, form } = callOf(fetchImpl)
    expect(url).toBe('https://api.fish.audio/v1/asr')
    expect(init.method).toBe('POST')
    expect(headers['Authorization']).toBe('Bearer key-123')
    expect(headers['model']).toBe(FISH_ASR_MODEL)
    expect(headers['model']).toBe('transcribe-1')
    expect(headers['Content-Type']).toBeUndefined() // boundary set by fetch
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('audio') as File
    expect(file.name).toBe('speech.wav')
    expect(file.type).toBe('audio/wav')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(form.get('language')).toBe('de')
    expect(form.get('ignore_timestamps')).toBe('true')
  })

  it('strips speaker/cue markers and collapses whitespace', async () => {
    const fetchImpl = fetchSequence(asrOk('<|speaker:0|> Hallo [laughter]   Welt <|speaker:1|>'))
    const text = await createFishAsrStt(cfg(), 'k', { fetchImpl }).transcribe(wav())
    expect(text).toBe('Hallo Welt')
  })

  it('returns an empty string when nothing was recognized or the response has no text', async () => {
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl: fetchSequence(asrOk('')) }).transcribe(wav())).toBe('')
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl: fetchSequence(asrOk('[silence]')) }).transcribe(wav())).toBe('')
    const noText = fetchSequence(() => new Response(JSON.stringify({ duration: 0, segments: [] }), { status: 200 }))
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl: noText }).transcribe(wav())).toBe('')
  })

  it('skips the request entirely for an empty recording', async () => {
    const fetchImpl = fetchSequence(asrOk('x'))
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl }).transcribe(wav([]))).toBe('')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses the per-call language hint over the configured one and omits the field when neither is set', async () => {
    const f1 = fetchSequence(asrOk('x'))
    await createFishAsrStt(cfg({ language: 'de' }), 'k', { fetchImpl: f1 }).transcribe(wav(), 'en-US')
    expect(callOf(f1).form.get('language')).toBe('en')

    const f2 = fetchSequence(asrOk('x'))
    await createFishAsrStt(cfg({ language: '' }), 'k', { fetchImpl: f2 }).transcribe(wav(), '')
    expect(callOf(f2).form.get('language')).toBeNull()
  })

  it('sends webm recordings with the matching filename and mime type', async () => {
    const fetchImpl = fetchSequence(asrOk('x'))
    await createFishAsrStt(cfg(), 'k', { fetchImpl }).transcribe({ data: new Uint8Array([1]).buffer, mimeType: 'audio/webm', durationMs: 10 })
    const file = callOf(fetchImpl).form.get('audio') as File
    expect(file.name).toBe('speech.webm')
    expect(file.type).toBe('audio/webm')
  })

  it('retries exactly once after 400 ms on 503, never on 400', async () => {
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)
    const f1 = fetchSequence(httpError(503, 'high load'), asrOk('Danach'))
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl: f1, sleep }).transcribe(wav())).toBe('Danach')
    expect(f1).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]?.[0]).toBe(400)

    const f2 = fetchSequence(httpError(429), httpError(429))
    await expect(createFishAsrStt(cfg(), 'k', { fetchImpl: f2, sleep }).transcribe(wav())).rejects.toMatchObject({ status: 429 })
    expect(f2).toHaveBeenCalledTimes(2)

    const f3 = fetchSequence(httpError(400, 'bad audio'), asrOk('x'))
    await expect(createFishAsrStt(cfg(), 'k', { fetchImpl: f3, sleep }).transcribe(wav())).rejects.toMatchObject({
      name: 'FishAudioHttpError',
      status: 400,
    })
    expect(f3).toHaveBeenCalledTimes(1)
  })

  it('passes the signal to fetch and lets an AbortError through unchanged', async () => {
    const aborted = new Error('The operation was aborted')
    aborted.name = 'AbortError'
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.signal?.aborted) throw aborted
      return asrOk('x')()
    })
    const client = createFishAsrStt(cfg(), 'k', { fetchImpl, sleep: noSleep })

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
    await expect(createFishAsrStt(cfg(), 'k', { fetchImpl: during, sleep: noSleep }).transcribe(wav())).rejects.toBe(aborted)
    expect(during).toHaveBeenCalledTimes(1)
  })
})

describe('createFishAsrStt.test', () => {
  it('checks the credit and reports it when no audio is given', async () => {
    const fetchImpl = fetchSequence(creditOk)
    const result = await createFishAsrStt(cfg(), 'k', { fetchImpl }).test()
    expect(result).toEqual({ ok: true, message: 'OK – Guthaben: 4.20 USD' })
    expect(callOf(fetchImpl).url).toContain('/wallet/self/api-credit')
    expect(callOf(fetchImpl).headers['Authorization']).toBe('Bearer k')
  })

  it('reports an invalid key on 401/403 and missing credit on 402', async () => {
    expect(await createFishAsrStt(cfg(), 'bad', { fetchImpl: fetchSequence(httpError(401, 'Invalid Token')) }).test()).toEqual({
      ok: false,
      message: KEY_INVALID_MESSAGE,
    })
    expect(await createFishAsrStt(cfg(), 'bad', { fetchImpl: fetchSequence(httpError(403)) }).test()).toEqual({
      ok: false,
      message: 'Fish Audio API-Key ungültig',
    })
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl: fetchSequence(httpError(402, 'no money')) }).test()).toEqual({
      ok: false,
      message: NO_CREDITS_MESSAGE,
    })
  })

  it('transcribes the sample after the credit check and quotes the result', async () => {
    const fetchImpl = fetchSequence(creditOk, asrOk('<|speaker:0|> Test eins zwei'))
    const result = await createFishAsrStt(cfg(), 'k', { fetchImpl }).test(wav())
    expect(result).toEqual({ ok: true, message: 'Erkannt: "Test eins zwei"' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(callOf(fetchImpl, 1).url).toBe('https://api.fish.audio/v1/asr')
  })

  it('flags an empty transcription and surfaces transcription errors', async () => {
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl: fetchSequence(creditOk, asrOk('')) }).test(wav())).toEqual({
      ok: false,
      message: NOTHING_RECOGNIZED_MESSAGE,
    })
    const failing = fetchSequence(creditOk, httpError(500, 'boom'), httpError(500, 'boom'))
    const result = await createFishAsrStt(cfg(), 'k', { fetchImpl: failing, sleep: noSleep }).test(wav())
    expect(result.ok).toBe(false)
    expect(result.message).toContain('HTTP 500')
  })

  it('reports network errors readably', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await createFishAsrStt(cfg(), 'k', { fetchImpl }).test()).toEqual({ ok: false, message: 'Fish Audio nicht erreichbar: fetch failed' })
  })
})

describe('describeFishAsrError', () => {
  it('maps aborts and unknown values', () => {
    const abort = new Error('x')
    abort.name = 'AbortError'
    expect(describeFishAsrError(abort)).toBe('Abgebrochen.')
    expect(describeFishAsrError('weird')).toBe('Fish Audio nicht erreichbar: weird')
  })
})
