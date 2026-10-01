import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, mergeConfig, parseConfig, redactConfig, SECRET_PATHS } from './config'

describe('config schema', () => {
  it('produces complete defaults from an empty object', () => {
    const c = parseConfig({})
    expect(c.setupCompleted).toBe(false)
    expect(c.character.name).toBe('Yui')
    expect(c.llm.model).toBe('claude-opus-5-5')
    expect(c.avatar.avoidance.radius).toBe(170)
    expect(c.hotkeys.pushToTalk).toContain('Space')
  })

  it('fills missing nested defaults when loading a partial file', () => {
    const c = parseConfig({ character: { name: 'Aiko' }, tts: { provider: 'fish-local' } })
    expect(c.character.name).toBe('Aiko')
    expect(c.character.traits.warmth).toBe(70)
    expect(c.tts.provider).toBe('fish-local')
    expect(c.tts.fishLocal.baseUrl).toBe('http://127.0.0.1:8080')
  })

  it('rejects invalid values', () => {
    expect(() => parseConfig({ character: { name: '' } })).toThrow()
    expect(() => parseConfig({ permissions: { level: 'god' } })).toThrow()
  })

  it('mergeConfig deep-merges objects and replaces primitives', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { character: { traits: { sass: 99 } }, autostart: true })
    expect(merged.character.traits.sass).toBe(99)
    expect(merged.character.traits.warmth).toBe(70)
    expect(merged.autostart).toBe(true)
    expect(DEFAULT_CONFIG.autostart).toBe(false) // not mutated
  })

  it('redactConfig masks every secret path', () => {
    const c = parseConfig({
      llm: { apiKey: 'sk-ant-1234567890' },
      tts: { fishCloud: { apiKey: 'fishkey12345' } },
      stt: { openaiCompatible: { apiKey: 'abc' } },
    })
    const r = redactConfig(c)
    expect(r.llm.apiKey).not.toContain('1234567890')
    expect(r.llm.apiKey).toMatch(/…/)
    expect(r.tts.fishCloud.apiKey).toMatch(/…/)
    expect(r.stt.openaiCompatible.apiKey).toBe('••••')
    expect(SECRET_PATHS).toHaveLength(4)
  })
})
