import { decode as msgpackDecode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import { TtsConfigSchema, type TtsConfig } from '@shared/config'
import type { FishVoiceModel } from '../net/fishAudio'
import { createFishCloudTts, KEY_INVALID_MESSAGE, NO_CREDITS_MESSAGE, toVoiceInfos } from './fishCloud'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function cfg(overrides: Record<string, unknown> = {}, cloud: Record<string, unknown> = {}): TtsConfig {
  return TtsConfigSchema.parse({
    provider: 'fish-cloud',
    fishCloud: { apiKey: 'key-123', model: 's2.1-pro-free', ...cloud },
    ...overrides,
  })
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

const audioOk = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
const jsonOk = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })
const httpError = (status: number, message = 'nope') => () => new Response(JSON.stringify({ message, status }), { status })

function callOf(fetchImpl: FetchMock, index = 0): { url: string; init: RequestInit; headers: Record<string, string> } {
  const call = fetchImpl.mock.calls[index]
  if (!call) throw new Error(`no fetch call #${index}`)
  const [url, init] = call
  return { url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> }
}

function jsonBody(fetchImpl: FetchMock, index = 0): Record<string, unknown> {
  return JSON.parse(callOf(fetchImpl, index).init.body as string) as Record<string, unknown>
}

describe('createFishCloudTts.synthesize', () => {
  it('sends the documented request shape (headers + body) and returns mp3 audio', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const client = createFishCloudTts(cfg({ speed: 1.25 }, { referenceId: '9a9cf47702da476aa4629e2506d4a857', format: 'mp3', latency: 'low' }), {
      fetchImpl,
    })
    const out = await client.synthesize('Hallo Welt.')
    expect(out.format).toBe('mp3')
    expect(out.sampleRate).toBeUndefined()
    expect(new Uint8Array(out.data)).toEqual(new Uint8Array([1, 2, 3]))

    const { url, init, headers } = callOf(fetchImpl)
    expect(url).toBe('https://api.fish.audio/v1/tts')
    expect(init.method).toBe('POST')
    expect(headers['Authorization']).toBe('Bearer key-123')
    expect(headers['model']).toBe('s2.1-pro-free')
    expect(headers['Content-Type']).toBe('application/json')
    expect(jsonBody(fetchImpl)).toEqual({
      text: 'Hallo Welt.',
      reference_id: '9a9cf47702da476aa4629e2506d4a857',
      format: 'mp3',
      latency: 'low',
      chunk_length: 150,
      min_chunk_length: 30,
      normalize: true,
      prosody: { speed: 1.25, volume: 0 },
      mp3_bitrate: 128,
    })
  })

  it('accepts a fish.audio URL as reference and sends null when empty', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const client = createFishCloudTts(cfg({}, { referenceId: 'https://fish.audio/m/9A9CF47702DA476AA4629E2506D4A857/' }), { fetchImpl })
    await client.synthesize('Test.')
    expect(jsonBody(fetchImpl)['reference_id']).toBe('9a9cf47702da476aa4629e2506d4a857')

    const fetch2 = fetchSequence(audioOk)
    await createFishCloudTts(cfg({}, { referenceId: '  ' }), { fetchImpl: fetch2 }).synthesize('Test.')
    expect(jsonBody(fetch2)['reference_id']).toBeNull()
  })

  it('requests pcm at 24 kHz and reports the sample rate', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const client = createFishCloudTts(cfg({}, { format: 'pcm' }), { fetchImpl })
    const out = await client.synthesize('Test.')
    expect(out.format).toBe('pcm')
    expect(out.sampleRate).toBe(24000)
    const body = jsonBody(fetchImpl)
    expect(body['format']).toBe('pcm')
    expect(body['sample_rate']).toBe(24000)
    expect(body['mp3_bitrate']).toBeUndefined()
  })

  it('prefixes the S2 cue once when emotionCues is on, S1 style for the s1 model, nothing when off', async () => {
    const f1 = fetchSequence(audioOk)
    await createFishCloudTts(cfg(), { fetchImpl: f1 }).synthesize('Super!', { emotion: 'excited' })
    expect(jsonBody(f1)['text']).toBe('[excited] Super!')

    const f2 = fetchSequence(audioOk)
    await createFishCloudTts(cfg({}, { model: 's1' }), { fetchImpl: f2 }).synthesize('Super!', { emotion: 'shy' })
    expect(jsonBody(f2)['text']).toBe('(soft tone) Super!')

    const f3 = fetchSequence(audioOk)
    await createFishCloudTts(cfg({ emotionCues: false }), { fetchImpl: f3 }).synthesize('Super!', { emotion: 'excited' })
    expect(jsonBody(f3)['text']).toBe('Super!')

    const f4 = fetchSequence(audioOk)
    await createFishCloudTts(cfg(), { fetchImpl: f4 }).synthesize('Okay.', { emotion: 'neutral' })
    expect(jsonBody(f4)['text']).toBe('Okay.')
  })

  it('cleans markdown / markers and rejects with "empty" without calling the API', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const client = createFishCloudTts(cfg(), { fetchImpl })
    await client.synthesize('**Fett** und `code` [[happy]] siehe [Link](https://x.y/z)')
    expect(jsonBody(fetchImpl)['text']).toBe('Fett und code siehe Link')

    await expect(client.synthesize('[[happy]]   ')).rejects.toThrow('empty')
    await expect(client.synthesize('')).rejects.toThrow('empty')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sends inline clone references via msgpack instead of reference_id, reading the file once', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const readFile = vi.fn(async () => new Uint8Array([7, 8, 9]))
    const client = createFishCloudTts(
      cfg({}, { referenceId: '9a9cf47702da476aa4629e2506d4a857', cloneSample: { audioPath: 'C:\\voice.wav', transcript: 'Hallo ich bin Yui.' } }),
      { fetchImpl, readFile },
    )
    await client.synthesize('Eins.')
    await client.synthesize('Zwei.')
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledWith('C:\\voice.wav')

    const { headers, init } = callOf(fetchImpl)
    expect(headers['Content-Type']).toBe('application/msgpack')
    const decoded = msgpackDecode(new Uint8Array(init.body as ArrayBuffer)) as Record<string, unknown>
    expect(decoded['references']).toEqual([{ audio: new Uint8Array([7, 8, 9]), text: 'Hallo ich bin Yui.' }])
    expect(decoded['reference_id']).toBeUndefined()
    expect(decoded['format']).toBe('mp3')
    expect(decoded['prosody']).toEqual({ speed: 1, volume: 0 })
  })

  it('falls back to reference_id when the clone sample is unreadable', async () => {
    const fetchImpl = fetchSequence(audioOk)
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    const client = createFishCloudTts(cfg({}, { referenceId: 'abc', cloneSample: { audioPath: '/missing.wav', transcript: 'x' } }), {
      fetchImpl,
      readFile,
    })
    await client.synthesize('Eins.')
    await client.synthesize('Zwei.')
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(callOf(fetchImpl).headers['Content-Type']).toBe('application/json')
    expect(jsonBody(fetchImpl)['reference_id']).toBe('abc')
  })

  it('retries exactly once after 400 ms on 503/429, never on 400', async () => {
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)
    const f1 = fetchSequence(httpError(503, 'high load'), audioOk)
    const out = await createFishCloudTts(cfg(), { fetchImpl: f1, sleep }).synthesize('Test.')
    expect(new Uint8Array(out.data)).toEqual(new Uint8Array([1, 2, 3]))
    expect(f1).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]?.[0]).toBe(400)

    const f2 = fetchSequence(httpError(429), httpError(429))
    await expect(createFishCloudTts(cfg(), { fetchImpl: f2, sleep }).synthesize('Test.')).rejects.toMatchObject({ status: 429 })
    expect(f2).toHaveBeenCalledTimes(2)

    const f3 = fetchSequence(httpError(400, 'bad reference'), audioOk)
    await expect(createFishCloudTts(cfg(), { fetchImpl: f3, sleep }).synthesize('Test.')).rejects.toMatchObject({ status: 400 })
    expect(f3).toHaveBeenCalledTimes(1)
  })

  it('passes the signal to fetch and rejects with an AbortError', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      if (init?.signal?.aborted) throw err
      return audioOk()
    })
    const client = createFishCloudTts(cfg(), { fetchImpl })
    const controller = new AbortController()
    controller.abort()
    await expect(client.synthesize('Test.', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()

    const live = new AbortController()
    const slow = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    const p = createFishCloudTts(cfg(), { fetchImpl: slow }).synthesize('Test.', { signal: live.signal })
    await new Promise((resolve) => setImmediate(resolve)) // let the request reach fetch
    expect(slow).toHaveBeenCalledTimes(1)
    expect(slow.mock.calls[0]?.[1]?.signal).toBe(live.signal)
    live.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('createFishCloudTts.test', () => {
  it('checks the credit first and reports a bad key', async () => {
    const fetchImpl = fetchSequence(httpError(401, 'Invalid Token'))
    const result = await createFishCloudTts(cfg(), { fetchImpl }).test('Hallo')
    expect(result).toEqual({ ok: false, message: KEY_INVALID_MESSAGE })
    expect(callOf(fetchImpl).url).toContain('/wallet/self/api-credit')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const forbidden = fetchSequence(httpError(403))
    expect((await createFishCloudTts(cfg(), { fetchImpl: forbidden }).test('Hallo')).message).toBe(KEY_INVALID_MESSAGE)
  })

  it('reports missing credits (402)', async () => {
    const fetchImpl = fetchSequence(httpError(402, 'Insufficient credits'))
    const result = await createFishCloudTts(cfg(), { fetchImpl }).test('Hallo')
    expect(result).toEqual({ ok: false, message: NO_CREDITS_MESSAGE })
  })

  it('synthesizes the sample and returns the credit on success', async () => {
    const fetchImpl = fetchSequence(jsonOk({ credit: '4.2', cumulative_top_up: '10' }), audioOk)
    const result = await createFishCloudTts(cfg(), { fetchImpl }).test('Hallo!')
    expect(result.ok).toBe(true)
    expect(result.message).toBe('OK – Guthaben: 4.20 USD')
    expect(result.audio?.format).toBe('mp3')
    expect(new Uint8Array(result.audio!.data)).toEqual(new Uint8Array([1, 2, 3]))
    expect(jsonBody(fetchImpl, 1)['text']).toBe('Hallo!')
  })

  it('reports a failing sample synthesis', async () => {
    const fetchImpl = fetchSequence(jsonOk({ credit: '1', cumulative_top_up: '1' }), httpError(400, 'reference not found'))
    const result = await createFishCloudTts(cfg(), { fetchImpl }).test('Hallo')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('400')
    expect(result.message).toContain('reference not found')
  })
})

const voice = (over: Partial<FishVoiceModel> = {}): FishVoiceModel => ({
  _id: '9a9cf47702da476aa4629e2506d4a857',
  type: 'tts',
  title: 'Hannah',
  description: 'warm',
  cover_image: 'https://img/x.png',
  state: 'trained',
  tags: ['anime'],
  languages: ['de', 'en'],
  visibility: 'public',
  samples: [{ title: 's', text: 't', task_id: 'x', audio: 'https://cdn/sample.mp3' }],
  author: { _id: 'u', nickname: 'Fish', avatar: '' },
  like_count: 3,
  task_count: 1234,
  ...over,
})

describe('createFishCloudTts.searchVoices', () => {
  it('maps and filters a title search', async () => {
    const items = [
      voice(),
      voice({ _id: 'svc', type: 'svc' }),
      voice({ _id: 'training', state: 'training' }),
      voice({ _id: 'bare', samples: [], cover_image: '', title: 'Bare' }),
    ]
    const fetchImpl = fetchSequence(jsonOk({ total: 4, items }))
    const client = createFishCloudTts(cfg(), { fetchImpl })
    const result = await client.searchVoices!('  anime  ')
    const url = new URL(callOf(fetchImpl).url)
    expect(url.origin + url.pathname).toBe('https://api.fish.audio/model')
    expect(url.searchParams.get('title')).toBe('anime')
    expect(url.searchParams.get('sort_by')).toBe('task_count')
    expect(url.searchParams.get('page_size')).toBe('30')
    expect(callOf(fetchImpl).headers['Authorization']).toBe('Bearer key-123')

    expect(result.map((v) => v.id)).toEqual(['9a9cf47702da476aa4629e2506d4a857', 'bare'])
    expect(result[0]).toEqual({
      id: '9a9cf47702da476aa4629e2506d4a857',
      title: 'Hannah',
      description: 'warm',
      languages: ['de', 'en'],
      tags: ['anime'],
      author: 'Fish',
      sampleUrl: 'https://cdn/sample.mp3',
      coverImage: 'https://img/x.png',
      popularity: 1234,
    })
    expect(result[1]?.sampleUrl).toBeUndefined()
    expect(result[1]?.coverImage).toBeUndefined()
  })

  it('omits the title filter for an empty query', async () => {
    const fetchImpl = fetchSequence(jsonOk({ total: 0, items: [] }))
    await createFishCloudTts(cfg(), { fetchImpl }).searchVoices!('')
    expect(new URL(callOf(fetchImpl).url).searchParams.has('title')).toBe(false)
  })

  it('looks up a pasted id / URL directly and returns [] for 404', async () => {
    const fetchImpl = fetchSequence(jsonOk(voice()))
    const result = await createFishCloudTts(cfg(), { fetchImpl }).searchVoices!('https://fish.audio/m/9a9cf47702da476aa4629e2506d4a857')
    expect(callOf(fetchImpl).url).toBe('https://api.fish.audio/model/9a9cf47702da476aa4629e2506d4a857')
    expect(result).toHaveLength(1)
    expect(result[0]?.title).toBe('Hannah')

    const missing = fetchSequence(httpError(404, 'not found'))
    expect(await createFishCloudTts(cfg(), { fetchImpl: missing }).searchVoices!('9a9cf47702da476aa4629e2506d4a857')).toEqual([])

    const unauthorized = fetchSequence(httpError(401))
    await expect(createFishCloudTts(cfg(), { fetchImpl: unauthorized }).searchVoices!('9a9cf47702da476aa4629e2506d4a857')).rejects.toMatchObject({
      status: 401,
    })
  })

  it('toVoiceInfos tolerates missing optional fields', () => {
    const partial = { _id: 'p', type: 'tts', state: 'trained' } as unknown as FishVoiceModel
    expect(toVoiceInfos([partial])).toEqual([{ id: 'p', title: '', description: '', languages: [], tags: [], author: '', popularity: 0 }])
  })
})
