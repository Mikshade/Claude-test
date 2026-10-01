import { describe, expect, it } from 'vitest'
import { LANGUAGES } from '@shared/config'
import { BUBBLE_STRINGS, t } from './strings'

describe('bubble strings', () => {
  it('defines every language from the config schema', () => {
    for (const lang of LANGUAGES) expect(BUBBLE_STRINGS[lang]).toBeDefined()
  })

  it('has the same keys in German and English', () => {
    const de = Object.keys(BUBBLE_STRINGS.de).sort()
    const en = Object.keys(BUBBLE_STRINGS.en).sort()
    expect(en).toEqual(de)
  })

  it('has no empty strings', () => {
    for (const lang of LANGUAGES) {
      for (const [key, value] of Object.entries(BUBBLE_STRINGS[lang])) {
        expect(value.trim().length, `${lang}.${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('t() returns the requested language', () => {
    expect(t('listening', 'de')).toBe('Hört zu')
    expect(t('listening', 'en')).toBe('Listening')
    expect(t('yes', 'de')).toBe('Ja')
    expect(t('no', 'en')).toBe('No')
  })

  it('t() falls back to German for an unknown language', () => {
    expect(t('thinking', 'fr' as never)).toBe(BUBBLE_STRINGS.de.thinking)
  })
})
