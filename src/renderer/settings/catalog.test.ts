import { describe, expect, it } from 'vitest'
import { FISH_CLOUD_MODELS } from '@shared/config'
import { formatSeconds, hourLabel, isKnownLlmModel, LLM_MODELS, matchSttPreset, parseFishReferenceId, STT_PRESETS, TTS_CLOUD_MODELS } from './catalog'
import { STRINGS } from './i18n'

describe('catalog tables', () => {
  it('lists every Fish cloud model from the config schema exactly once', () => {
    expect(TTS_CLOUD_MODELS.map((m) => m.id).sort()).toEqual([...FISH_CLOUD_MODELS].sort())
    expect(TTS_CLOUD_MODELS[0]?.id).toBe('s2.1-pro-free')
  })
  it('all description keys exist in the string tables', () => {
    for (const m of [...TTS_CLOUD_MODELS, ...LLM_MODELS]) expect(STRINGS.de[m.descriptionKey]).toBeTruthy()
    for (const p of STT_PRESETS) expect(STRINGS.en[p.labelKey]).toBeTruthy()
  })
  it('knows the default LLM model', () => {
    expect(isKnownLlmModel('claude-opus-5-5')).toBe(true)
    expect(isKnownLlmModel('claude-3-opus')).toBe(false)
  })
  it('matches STT presets by base url', () => {
    expect(matchSttPreset('https://api.groq.com/openai/v1/')?.id).toBe('groq')
    expect(matchSttPreset('HTTPS://API.OPENAI.COM/v1')?.id).toBe('openai')
    expect(matchSttPreset('http://localhost:9999/v1')).toBeNull()
  })
})

describe('parseFishReferenceId', () => {
  it('accepts ids, page links and modelId query links', () => {
    expect(parseFishReferenceId('9A9CF47702DA476AA4629E2506D4A857')).toBe('9a9cf47702da476aa4629e2506d4a857')
    expect(parseFishReferenceId(' https://fish.audio/m/9a9cf47702da476aa4629e2506d4a857 ')).toBe('9a9cf47702da476aa4629e2506d4a857')
    expect(parseFishReferenceId('https://fish.audio/text-to-speech/?modelId=9a9cf47702da476aa4629e2506d4a857')).toBe('9a9cf47702da476aa4629e2506d4a857')
    expect(parseFishReferenceId('')).toBe('')
    expect(parseFishReferenceId('Hannah')).toBeNull()
    expect(parseFishReferenceId('9a9cf477')).toBeNull()
  })
})

describe('formatters', () => {
  it('hourLabel pads', () => {
    expect(hourLabel(8)).toBe('08:00')
    expect(hourLabel(23)).toBe('23:00')
  })
  it('formatSeconds localises the decimal separator', () => {
    expect(formatSeconds(1400, 'de')).toBe('1,4 s')
    expect(formatSeconds(1400, 'en')).toBe('1.4 s')
    expect(formatSeconds(30000, 'de')).toBe('30 s')
    expect(formatSeconds(0, 'en')).toBe('0 s')
  })
})
