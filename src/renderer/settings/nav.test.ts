import { describe, expect, it } from 'vitest'
import { nextStep, PAGE_IDS, parseHash, prevStep, routeHash, WIZARD_STEPS, wizardIndex } from './nav'

describe('parseHash', () => {
  it('opens the wizard on first run and the default tab afterwards', () => {
    expect(parseHash('', false)).toEqual({ mode: 'wizard', step: 'welcome' })
    expect(parseHash('#', false)).toEqual({ mode: 'wizard', step: 'welcome' })
    expect(parseHash('', true)).toEqual({ mode: 'tabs', page: 'character' })
  })
  it('parses pages and wizard steps', () => {
    expect(parseHash('#voice', true)).toEqual({ mode: 'tabs', page: 'voice' })
    expect(parseHash('#wizard', true)).toEqual({ mode: 'wizard', step: 'welcome' })
    expect(parseHash('#wizard/ears', true)).toEqual({ mode: 'wizard', step: 'ears' })
    expect(parseHash('#wizard/nonsense', true)).toEqual({ mode: 'wizard', step: 'welcome' })
    expect(parseHash('#nonsense', true)).toEqual({ mode: 'tabs', page: 'character' })
    expect(parseHash('#%20about%20', true)).toEqual({ mode: 'tabs', page: 'about' })
  })
  it('round-trips through routeHash', () => {
    for (const page of PAGE_IDS) expect(parseHash(routeHash({ mode: 'tabs', page }), true)).toEqual({ mode: 'tabs', page })
    for (const step of WIZARD_STEPS) expect(parseHash(routeHash({ mode: 'wizard', step }), true)).toEqual({ mode: 'wizard', step })
    expect(routeHash({ mode: 'wizard', step: 'welcome' })).toBe('#wizard')
    expect(routeHash({ mode: 'wizard', step: 'brain' })).toBe('#wizard/brain')
  })
})

describe('wizard steps', () => {
  it('walks forward and back', () => {
    expect(wizardIndex('welcome')).toBe(0)
    expect(nextStep('welcome')).toBe('character')
    expect(prevStep('welcome')).toBeNull()
    expect(nextStep('finish')).toBeNull()
    expect(prevStep('finish')).toBe('permissions')
    expect(WIZARD_STEPS[0]).toBe('welcome')
    expect(WIZARD_STEPS[WIZARD_STEPS.length - 1]).toBe('finish')
  })
})
