import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type DeepPartial, type FlowyConfig, mergeConfig } from '@shared/config'
import { STRINGS } from './i18n'
import { collectWarnings, warningsFor } from './validation'

function config(patch: DeepPartial<FlowyConfig> = {}): FlowyConfig {
  return mergeConfig(structuredClone(DEFAULT_CONFIG), patch)
}

const complete: DeepPartial<FlowyConfig> = {
  llm: { apiKey: 'sk-ant-x' },
  tts: { fishCloud: { apiKey: 'fish', referenceId: '9a9cf47702da476aa4629e2506d4a857' } },
}

describe('collectWarnings', () => {
  it('is empty for a complete configuration', () => {
    expect(collectWarnings(config(complete))).toEqual([])
  })

  it('flags the fresh default config: no keys anywhere', () => {
    const keys = collectWarnings(config()).map((w) => `${w.page}:${w.key}:${w.severity}`)
    expect(keys).toEqual(['brain:warn.llmKeyMissing:error', 'voice:warn.ttsKeyMissing:error', 'ears:warn.sttNeedsFishKey:error'])
  })

  it('flags an empty name and a missing voice id as a hint', () => {
    const w = collectWarnings(config({ ...complete, character: { name: '  ' }, tts: { fishCloud: { apiKey: 'fish', referenceId: '' } } }))
    expect(w).toContainEqual({ page: 'character', key: 'warn.nameEmpty', severity: 'error' })
    expect(w).toContainEqual({ page: 'voice', key: 'warn.noVoice', severity: 'hint' })
  })

  it('does not require fish keys when the providers are off or local', () => {
    const w = collectWarnings(config({ llm: { apiKey: 'k' }, tts: { provider: 'none' }, stt: { provider: 'none' } }))
    expect(w).toEqual([])
    const local = collectWarnings(config({ llm: { apiKey: 'k' }, tts: { provider: 'fish-local' }, stt: { provider: 'openai-compatible' } }))
    expect(local.map((x) => x.key)).toEqual(['warn.sttOpenaiKeyMissing'])
  })

  it('hints at a missing push-to-talk hotkey only when STT is enabled', () => {
    expect(collectWarnings(config({ ...complete, hotkeys: { pushToTalk: '' } })).map((w) => w.key)).toEqual(['warn.noPushToTalk'])
    expect(collectWarnings(config({ ...complete, hotkeys: { pushToTalk: '' }, stt: { provider: 'none' } }))).toEqual([])
  })

  it('warningsFor filters by page and every key is translatable', () => {
    const all = collectWarnings(config({ character: { name: '' } }))
    expect(warningsFor(config({ character: { name: '' } }), 'character').map((w) => w.key)).toEqual(['warn.nameEmpty'])
    for (const w of all) {
      expect(STRINGS.de[w.key]).toBeTruthy()
      expect(STRINGS.en[w.key]).toBeTruthy()
    }
  })
})
