import { describe, expect, it } from 'vitest'
import { getLanguage, setLanguage, STRINGS, t, tl } from './i18n'

describe('settings i18n', () => {
  it('de and en define exactly the same keys', () => {
    const de = Object.keys(STRINGS.de).sort()
    const en = Object.keys(STRINGS.en).sort()
    expect(en).toEqual(de)
    expect(de.length).toBeGreaterThan(100)
  })

  it('has no empty strings', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const [key, value] of Object.entries(STRINGS[lang])) {
        expect(value.trim(), `${lang}:${key}`).not.toBe('')
      }
    }
  })

  it('uses the same placeholders in both languages', () => {
    const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(STRINGS.de) as Array<keyof typeof STRINGS.de>) {
      expect(placeholders(STRINGS.en[key]), key).toEqual(placeholders(STRINGS.de[key]))
    }
  })

  it('translates in the current language with substitution', () => {
    setLanguage('de')
    expect(getLanguage()).toBe('de')
    expect(t('common.next')).toBe('Weiter')
    expect(t('wizard.progress', { current: 2, total: 7 })).toBe('Schritt 2 von 7')
    setLanguage('en')
    expect(t('common.next')).toBe('Next')
    expect(t('wizard.progress', { current: 2, total: 7 })).toBe('Step 2 of 7')
    expect(tl('common.back', 'de')).toBe('Zurück')
    setLanguage('de')
  })

  it('falls back to German for unknown languages', () => {
    setLanguage('xx' as never)
    expect(getLanguage()).toBe('de')
    expect(t('common.back')).toBe('Zurück')
  })
})
