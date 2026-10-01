import { describe, expect, it } from 'vitest'
import { acceptedByEnv, helpText, isAffirmative, parseSetupArgs, pickLanguage, STRINGS, translator } from './lib/cli.mjs'

describe('parseSetupArgs', () => {
  it('defaults: Hiyori, interactive, not forced, no language', () => {
    expect(parseSetupArgs([])).toEqual({
      help: false,
      yes: false,
      force: false,
      skipCore: false,
      skipModel: false,
      model: 'Hiyori',
      lang: undefined,
    })
  })

  it('parses long and short flags, normalises the model name', () => {
    expect(parseSetupArgs(['--yes', '--force', '--model', 'haru', '--lang', 'EN', '--skip-core', '--skip-model'])).toEqual({
      help: false,
      yes: true,
      force: true,
      skipCore: true,
      skipModel: true,
      model: 'Haru',
      lang: 'en',
    })
    expect(parseSetupArgs(['-y', '-f', '-m', 'mao'])).toMatchObject({ yes: true, force: true, model: 'Mao' })
    expect(parseSetupArgs(['--model=natori'])).toMatchObject({ model: 'Natori' })
    expect(parseSetupArgs(['-h'])).toMatchObject({ help: true })
  })

  it('rejects unknown options, models and languages with readable messages', () => {
    expect(() => parseSetupArgs(['--model', 'Shizuku'])).toThrow(/Unknown --model "Shizuku".*Hiyori, Haru, Mao, Natori/)
    expect(() => parseSetupArgs(['--lang', 'fr'])).toThrow(/Unknown --lang/)
    expect(() => parseSetupArgs(['--bogus'])).toThrow(/bogus/)
    expect(() => parseSetupArgs(['positional'])).toThrow()
  })
})

describe('pickLanguage', () => {
  it('explicit > FLOWY_LANG > locale > de', () => {
    expect(pickLanguage('en', { FLOWY_LANG: 'de', LANG: 'de_DE.UTF-8' })).toBe('en')
    expect(pickLanguage(undefined, { FLOWY_LANG: 'en', LANG: 'de_DE.UTF-8' })).toBe('en')
    expect(pickLanguage(undefined, { FLOWY_LANG: 'xx', LANG: 'en_US.UTF-8' })).toBe('en')
    expect(pickLanguage(undefined, { LC_ALL: 'en_GB' })).toBe('en')
    expect(pickLanguage(undefined, { LANG: 'de_DE.UTF-8' })).toBe('de')
    expect(pickLanguage(undefined, { LANG: 'C.UTF-8' })).toBe('de')
    expect(pickLanguage(undefined, {})).toBe('de')
  })
})

describe('consent helpers', () => {
  it('acceptedByEnv accepts 1/true/yes only', () => {
    expect(acceptedByEnv({ FLOWY_ACCEPT_LIVE2D: '1' })).toBe(true)
    expect(acceptedByEnv({ FLOWY_ACCEPT_LIVE2D: 'TRUE' })).toBe(true)
    expect(acceptedByEnv({ FLOWY_ACCEPT_LIVE2D: 'yes' })).toBe(true)
    expect(acceptedByEnv({ FLOWY_ACCEPT_LIVE2D: '0' })).toBe(false)
    expect(acceptedByEnv({ FLOWY_ACCEPT_LIVE2D: '' })).toBe(false)
    expect(acceptedByEnv({})).toBe(false)
  })

  it('isAffirmative accepts y/yes/j/ja and defaults to no', () => {
    for (const a of ['y', 'Y', ' yes ', 'j', 'Ja']) expect(isAffirmative(a)).toBe(true)
    for (const a of ['', 'n', 'no', 'nein', 'maybe', 'yess']) expect(isAffirmative(a)).toBe(false)
  })
})

describe('i18n', () => {
  it('both tables have the same keys', () => {
    expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.de).sort())
  })

  it('translator interpolates variables, joins multi-line entries and defaults to German', () => {
    const de = translator('de')
    const en = translator('en')
    expect(de('question')).toBe('Akzeptierst du beide Lizenzen? [y/N] ')
    expect(en('question')).toBe('Do you accept both licenses? [y/N] ')
    expect(de('modelHeading', { model: 'Hiyori' })).toBe('2) Beispielmodell "Hiyori" (Live2D Free Material License)')
    expect(en('modelDone', { downloaded: 3, skipped: 15, size: '1.2 MB' })).toBe('Model done: 3 downloaded, 15 skipped (1.2 MB)')
    expect(de('coreBody')).toContain('\n')
    expect(de('coreDone', { path: 'x' })).toBe('Cubism Core gespeichert: x ({size})')
  })

  it('helpText documents the options and models', () => {
    const help = helpText()
    expect(help).toContain('--yes')
    expect(help).toContain('--model')
    expect(help).toContain('Hiyori | Haru | Mao | Natori')
    expect(help).toContain('--force')
    expect(help).toContain('FLOWY_ACCEPT_LIVE2D')
  })
})
