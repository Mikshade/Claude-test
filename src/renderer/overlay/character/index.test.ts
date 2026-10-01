import { describe, expect, it } from 'vitest'
import { CORE_LOAD_TIMEOUT_MS, CUBISM_CORE_CDN, coreLoaded, planCharacter } from './index'

describe('planCharacter', () => {
  it('uses the fallback without a model', () => {
    expect(planCharacter(null, true)).toBe('fallback')
    expect(planCharacter(null, false)).toBe('fallback')
    expect(planCharacter('', true)).toBe('fallback')
  })

  it('goes straight to Live2D when the core global is present', () => {
    expect(planCharacter('flowy-model://model/Hiyori.model3.json', true)).toBe('live2d')
  })

  it('injects the core from the CDN when a model exists but the core is missing', () => {
    expect(planCharacter('flowy-model://model/Hiyori.model3.json', false)).toBe('inject-core')
  })
})

describe('core constants', () => {
  it('points at the official CDN with a sane timeout', () => {
    expect(CUBISM_CORE_CDN).toBe('https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js')
    expect(CORE_LOAD_TIMEOUT_MS).toBe(10_000)
  })

  it('coreLoaded is false outside a browser', () => {
    expect(coreLoaded()).toBe(false)
  })
})
