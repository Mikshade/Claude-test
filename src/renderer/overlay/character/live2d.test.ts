import { describe, expect, it } from 'vitest'
import { DEFAULT_LIP_SYNC_IDS, MOUTH_SMOOTHING, nextMouthValue } from './live2d'

describe('nextMouthValue', () => {
  it('moves half way toward the target each frame and stays within 0..1', () => {
    expect(nextMouthValue(0, 1)).toBeCloseTo(MOUTH_SMOOTHING)
    expect(nextMouthValue(0.5, 1)).toBeCloseTo(0.75)
    expect(nextMouthValue(0.5, 5)).toBeCloseTo(0.75) // target clamped to 1
    expect(nextMouthValue(1, -3)).toBeCloseTo(0.5)
  })

  it('snaps to exactly 0 once almost closed so idle motions regain the mouth', () => {
    let v = 1
    for (let i = 0; i < 20; i++) v = nextMouthValue(v, 0)
    expect(v).toBe(0)
    expect(nextMouthValue(0.001, 0)).toBe(0)
    expect(nextMouthValue(0.01, 0)).toBeGreaterThan(0)
  })

  it('exposes the ParamMouthOpenY fallback id', () => {
    expect(DEFAULT_LIP_SYNC_IDS).toEqual(['ParamMouthOpenY'])
  })
})
