import { decode as msgpackDecode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import {
  FISH_CLOUD_BASE_URL,
  FishAudioHttpError,
  fishAsr,
  fishGetCredit,
  fishListVoices,
  fishLocalHealth,
  fishTts,
  isCloudBase,
  parseReferenceId,
  stripAsrMarkers,
} from './fishAudio'

function mockFetch(status: number, body: ConstructorParameters<typeof Response>[0], headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status, headers }))
}

describe('fishTts', () => {
  it('sends JSON with auth + model headers and returns the audio bytes', async () => {
    const fetchImpl = mockFetch(200, new Uint8Array([1, 2, 3]))
    const out = await fishTts(
      { baseUrl: FISH_CLOUD_BASE_URL, apiKey: 'k', model: 's2.1-pro-free', fetchImpl },
      { text: 'Hallo', reference_id: 'abc', format: 'mp3', latency: 'balanced', prosody: undefined },
    )
    expect(new Uint8Array(out)).toEqual(new Uint8Array([1, 2, 3]))
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://api.fish.audio/v1/tts')
    const headers = init!.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer k')
    expect(headers['model']).toBe('s2.1-pro-free')
    expect(headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(init!.body as string)
    expect(body).toEqual({ text: 'Hallo', reference_id: 'abc', format: 'mp3', latency: 'balanced' })
  })

  it('switches to msgpack when inline references are present', async () => {
    const fetchImpl = mockFetch(200, new Uint8Array([9]))
    await fishTts(
      { baseUrl: 'http://127.0.0.1:8080/', fetchImpl },
      { text: 'Hi', references: [{ audio: new Uint8Array([5, 6]), text: 'sample' }], format: 'wav' },
    )
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:8080/v1/tts')
    const headers = init!.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/msgpack')
    expect(headers['Authorization']).toBeUndefined()
    const decoded = msgpackDecode(new Uint8Array(init!.body as ArrayBuffer)) as { references: Array<{ audio: Uint8Array }> }
    expect(decoded.references[0]!.audio).toEqual(new Uint8Array([5, 6]))
  })

  it('throws a typed error with the JSON message on failure', async () => {
    const fetchImpl = mockFetch(401, JSON.stringify({ message: 'Invalid Token', status: 401 }))
    await expect(fishTts({ baseUrl: FISH_CLOUD_BASE_URL, apiKey: 'bad', fetchImpl }, { text: 'x' })).rejects.toMatchObject({
      name: 'FishAudioHttpError',
      status: 401,
      isAuth: true,
      message: expect.stringContaining('Invalid Token'),
    })
    expect(new FishAudioHttpError(402, 'no money').isOutOfCredits).toBe(true)
    expect(new FishAudioHttpError(503, '').isRetryable).toBe(true)
  })
})

describe('fishAsr', () => {
  it('posts multipart with the audio file and returns the transcript', async () => {
    const fetchImpl = mockFetch(200, JSON.stringify({ text: 'Hallo Welt', duration: 1.2, segments: [], language_code: 'de' }), {
      'content-type': 'application/json',
    })
    const result = await fishAsr({ baseUrl: FISH_CLOUD_BASE_URL, apiKey: 'k', model: 'transcribe-1', fetchImpl }, new Uint8Array([1, 2]), {
      language: 'de',
    })
    expect(result.text).toBe('Hallo Welt')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('https://api.fish.audio/v1/asr')
    const form = init!.body as FormData
    expect(form.get('language')).toBe('de')
    expect(form.get('ignore_timestamps')).toBe('true')
    expect((form.get('audio') as File).name).toBe('speech.wav')
    const headers = init!.headers as Record<string, string>
    expect(headers['model']).toBe('transcribe-1')
    expect(headers['Content-Type']).toBeUndefined() // boundary is set by fetch
  })
})

describe('voices / credit / health', () => {
  it('encodes repeated query params for arrays', async () => {
    const fetchImpl = mockFetch(200, JSON.stringify({ total: 0, items: [] }))
    await fishListVoices({ baseUrl: FISH_CLOUD_BASE_URL, apiKey: 'k', fetchImpl }, { language: ['de', 'en'], title: 'anime', page_size: 20 })
    const url = String(fetchImpl.mock.calls[0]![0])
    expect(url.startsWith('https://api.fish.audio/model?')).toBe(true)
    expect(url).toContain('language=de')
    expect(url).toContain('language=en')
    expect(url).toContain('title=anime')
    expect(url).toContain('page_size=20')
  })

  it('reads the credit', async () => {
    const fetchImpl = mockFetch(200, JSON.stringify({ credit: '4.20', cumulative_top_up: '10' }))
    const c = await fishGetCredit({ baseUrl: FISH_CLOUD_BASE_URL, apiKey: 'k', fetchImpl })
    expect(c.credit).toBe('4.20')
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/wallet/self/api-credit')
  })

  it('health reports up/authError', async () => {
    expect(await fishLocalHealth({ baseUrl: 'http://127.0.0.1:8080', fetchImpl: mockFetch(200, JSON.stringify({ status: 'ok' })) })).toEqual({ up: true, authError: false })
    expect(await fishLocalHealth({ baseUrl: 'http://127.0.0.1:8080', fetchImpl: mockFetch(401, 'Invalid token') })).toEqual({ up: true, authError: true })
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await fishLocalHealth({ baseUrl: 'http://127.0.0.1:8080', fetchImpl: failing })).toEqual({ up: false, authError: false })
  })
})

describe('helpers', () => {
  it('parseReferenceId accepts ids and URLs', () => {
    expect(parseReferenceId('9a9cf47702da476aa4629e2506d4a857')).toBe('9a9cf47702da476aa4629e2506d4a857')
    expect(parseReferenceId('https://fish.audio/m/9A9CF47702DA476AA4629E2506D4A857/')).toBe('9a9cf47702da476aa4629e2506d4a857')
    expect(parseReferenceId('nope')).toBeNull()
  })
  it('stripAsrMarkers removes speaker and cue markers', () => {
    expect(stripAsrMarkers('<|speaker:0|> Hallo [laughter] Welt')).toBe('Hallo Welt')
  })
  it('isCloudBase', () => {
    expect(isCloudBase('https://api.fish.audio')).toBe(true)
    expect(isCloudBase('https://api.fish.audio/')).toBe(true)
    expect(isCloudBase('http://127.0.0.1:8080')).toBe(false)
  })
})
