import { describe, expect, it } from 'vitest'
import type { Rect } from '@shared/state'
import {
  clamp,
  composeTransform,
  fitToHeight,
  flightTransform,
  HIT_SHRINK,
  hitBoundingBox,
  LEAN_MAX_DEG,
  LEAN_SQUASH,
  normalizedFocus,
  pointInRect,
  shrinkRect,
  toLocal,
} from './hitTest'

const rect: Rect = { x: 100, y: 200, width: 300, height: 480 }

describe('shrinkRect / pointInRect', () => {
  it('removes the fraction from every side', () => {
    expect(shrinkRect(rect, 0.12)).toEqual({ x: 136, y: 257.6, width: 228, height: 364.8 })
  })

  it('never inverts the rect', () => {
    const r = shrinkRect(rect, 0.9)
    expect(r.width).toBe(0)
    expect(r.height).toBe(0)
    expect(r.x).toBe(250)
  })

  it('pointInRect is inclusive at the edges', () => {
    expect(pointInRect(100, 200, rect)).toBe(true)
    expect(pointInRect(400, 680, rect)).toBe(true)
    expect(pointInRect(400.1, 680, rect)).toBe(false)
    expect(pointInRect(99, 300, rect)).toBe(false)
  })
})

describe('hitBoundingBox', () => {
  it('hits the center and misses the transparent margin', () => {
    expect(hitBoundingBox(250, 440, rect)).toBe(true)
    expect(hitBoundingBox(105, 205, rect)).toBe(false) // inside the rect but in the 12 % margin
    expect(hitBoundingBox(136, 258, rect)).toBe(true) // just inside the shrunk box
    expect(HIT_SHRINK).toBeCloseTo(0.12)
  })

  it('misses points outside and non-finite input', () => {
    expect(hitBoundingBox(0, 0, rect)).toBe(false)
    expect(hitBoundingBox(Number.NaN, 300, rect)).toBe(false)
    expect(hitBoundingBox(250, Number.POSITIVE_INFINITY, rect)).toBe(false)
  })
})

describe('toLocal', () => {
  it('subtracts the wrapper origin', () => {
    expect(toLocal(150, 260, { x: 100, y: 200 })).toEqual({ x: 50, y: 60 })
  })
})

describe('normalizedFocus', () => {
  const size = { width: 300, height: 480 }

  it('looks straight ahead at the eye line center', () => {
    expect(normalizedFocus(150, 480 * 0.35, size)).toEqual({ x: 0, y: 0 })
  })

  it('looks right/up for points right of and above the eyes and clamps far away points', () => {
    const f = normalizedFocus(5000, -5000, size)
    expect(f).toEqual({ x: 1, y: 1 })
    const g = normalizedFocus(-5000, 5000, size)
    expect(g).toEqual({ x: -1, y: -1 })
  })

  it('is proportional for nearby points', () => {
    const f = normalizedFocus(150 + 27, 480 * 0.35, size) // 27 px right = 10 % of 0.9*width
    expect(f.x).toBeCloseTo(0.1, 2)
    expect(f.y).toBe(0)
  })

  it('flips x when mirrored', () => {
    const f = normalizedFocus(300, 100, size)
    const m = normalizedFocus(300, 100, size, { mirror: true })
    expect(m.x).toBeCloseTo(-f.x)
    expect(m.y).toBeCloseTo(f.y)
  })

  it('leans further while listening and glances up while thinking', () => {
    const idle = normalizedFocus(220, 168, size, { state: 'idle' })
    const listening = normalizedFocus(220, 168, size, { state: 'listening' })
    const thinking = normalizedFocus(220, 168, size, { state: 'thinking' })
    expect(Math.abs(listening.x)).toBeGreaterThan(Math.abs(idle.x))
    expect(thinking.y).toBeGreaterThan(0.5)
    expect(Math.abs(thinking.x)).toBeLessThan(Math.abs(idle.x))
  })

  it('returns zero for a degenerate size', () => {
    expect(normalizedFocus(10, 10, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('flightTransform / composeTransform', () => {
  it('is the identity at rest', () => {
    expect(flightTransform(0)).toEqual({ rotateDeg: 0, scaleX: 1, scaleY: 1 })
    expect(composeTransform(10, 20.456, 0)).toBe('translate3d(10px, 20.46px, 0)')
  })

  it('tilts up to ±10° and squashes proportionally', () => {
    expect(flightTransform(1)).toEqual({ rotateDeg: LEAN_MAX_DEG, scaleX: 1 + LEAN_SQUASH, scaleY: 1 - LEAN_SQUASH })
    expect(flightTransform(-0.5)).toEqual({ rotateDeg: -5, scaleX: 1.03, scaleY: 0.97 })
    expect(flightTransform(7).rotateDeg).toBe(LEAN_MAX_DEG) // clamped
    expect(flightTransform(Number.NaN)).toEqual({ rotateDeg: 0, scaleX: 1, scaleY: 1 })
  })

  it('composes translate + rotate + scale in flight', () => {
    expect(composeTransform(0, 0, 1)).toBe('translate3d(0px, 0px, 0) rotate(10deg) scale(1.06, 0.94)')
  })
})

describe('fitToHeight', () => {
  it('scales to the target height and ceils the width', () => {
    const fit = fitToHeight(1000, 2000, 480)
    expect(fit.scale).toBeCloseTo(0.24)
    expect(fit.size).toEqual({ width: 240, height: 480 })
    expect(fitToHeight(1001, 2000, 480).size.width).toBe(241)
  })

  it('tolerates degenerate input', () => {
    expect(fitToHeight(0, 0, 480)).toEqual({ scale: 1, size: { width: 1, height: 1 } })
  })
})

describe('clamp', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })
})
