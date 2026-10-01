import { describe, expect, it, vi } from 'vitest'
import { SttConfigSchema, TtsConfigSchema, type SttConfig, type TtsConfig } from '@shared/config'
import type { RecordedAudio } from '@shared/ipc'
import { createSttClient, FISH_ASR_MODEL } from './index'

function stt(overrides: Record<string, unknown> = {}): SttConfig {
  return SttConfigSchema.parse(overrides)
}

function tts(apiKey = ''): TtsConfig {
  return TtsConfigSchema.parse({ fishCloud: { apiKey } })
}

const wav: RecordedAudio = { data: new Uint8Array([1, 2]).buffer, mimeType: 'audio/wav', durationMs: 100 }

describe('createSttClient', () => {
  it('returns null for provider none', () => {
    expect(createSttClient(stt({ provider: 'none' }), tts('key'))).toBeNull()
  })

  it('returns null for fish-cloud without a Fish Audio key, a client otherwise', async () => {
    expect(createSttClient(stt({ provider: 'fish-cloud' }), tts(''))).toBeNull()
    expect(createSttClient(stt({ provider: 'fish-cloud' }), tts('   '))).toBeNull()

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text: 'Hi', duration: 1, segments: [] }), { status: 200 }))
    const client = createSttClient(stt({ provider: 'fish-cloud' }), tts('fish-key'), { fetchImpl })
    expect(client?.name).toBe('fish-cloud')
    expect(await client?.transcribe(wav)).toBe('Hi')
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer fish-key')
    expect(headers['model']).toBe(FISH_ASR_MODEL)
  })

  it('returns an openai-compatible client regardless of the fish key, null without a base URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ text: 'Yo' }), { status: 200 }))
    const client = createSttClient(stt({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://localhost:8000', apiKey: '' } }), tts(''), {
      fetchImpl,
    })
    expect(client?.name).toBe('openai-compatible')
    expect(await client?.transcribe(wav)).toBe('Yo')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://localhost:8000/v1/audio/transcriptions')

    // The schema requires a URL, so bypass it to exercise the guard.
    const broken = { ...stt({ provider: 'openai-compatible' }), openaiCompatible: { baseUrl: '  ', apiKey: '', model: 'whisper-1' } }
    expect(createSttClient(broken, tts(''))).toBeNull()
  })

  it('returns null for an unknown provider instead of throwing', () => {
    const weird = { ...stt(), provider: 'nope' as SttConfig['provider'] }
    expect(createSttClient(weird, tts('k'))).toBeNull()
  })
})
