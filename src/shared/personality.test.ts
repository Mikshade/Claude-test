import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseConfig } from './config'
import { buildSystemPrompt, describePermissions, PRESETS, presetById } from './personality'

const base = {
  permissions: DEFAULT_CONFIG.permissions,
  toolNames: ['run_powershell', 'take_screenshot'],
  platform: 'Windows',
}

describe('buildSystemPrompt', () => {
  it('mentions name, language, preset and tools', () => {
    const c = parseConfig({ character: { name: 'Aiko', preset: 'tsundere', language: 'en' } })
    const p = buildSystemPrompt({ ...base, character: c.character })
    expect(p).toContain('You are Aiko')
    expect(p).toContain('Always answer in English')
    expect(p).toContain(presetById('tsundere').core.slice(0, 20))
    expect(p).toContain('run_powershell')
    expect(p).toContain('[[happy]]')
  })

  it('is stable (no timestamps) so it can be prompt-cached', () => {
    const c = parseConfig({})
    const a = buildSystemPrompt({ ...base, character: c.character })
    const b = buildSystemPrompt({ ...base, character: c.character })
    expect(a).toBe(b)
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('uses du/Sie for German', () => {
    const du = parseConfig({ character: { language: 'de', formOfAddress: 'du' } }).character
    const sie = parseConfig({ character: { language: 'de', formOfAddress: 'Sie' } }).character
    expect(buildSystemPrompt({ ...base, character: du })).toContain('"du"')
    expect(buildSystemPrompt({ ...base, character: sie })).toContain('"Sie"')
  })

  it('includes the custom prompt', () => {
    const c = parseConfig({ character: { customPrompt: 'Sie liebt Katzen.' } }).character
    expect(buildSystemPrompt({ ...base, character: c })).toContain('Sie liebt Katzen.')
  })

  it('every preset has titles in both languages', () => {
    for (const p of PRESETS) {
      expect(p.title.de).toBeTruthy()
      expect(p.title.en).toBeTruthy()
    }
  })
})

describe('describePermissions', () => {
  it('describes read-only and disabled categories', () => {
    const text = describePermissions({ ...DEFAULT_CONFIG.permissions, level: 'read-only', allowWeb: false })
    expect(text).toContain('only read')
    expect(text).toContain('web access')
  })
})
