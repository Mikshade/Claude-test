import { describe, expect, it } from 'vitest'
import type { Point, Rect } from '@shared/state'
import {
  anchorPosition,
  clampToWorkArea,
  createMovementController,
  DEFAULT_MARGIN,
  easeOutCubic,
  fleeCandidates,
  FLEE_JITTER_PX,
  type MovementOptions,
  pickFleeTarget,
  rectDistance,
} from './movement'

const workArea: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const size = { width: 300, height: 480 }
const margin = DEFAULT_MARGIN

const noJitter = (): number => 0.5

function options(overrides: Partial<MovementOptions> = {}): MovementOptions {
  return { workArea, size, fleeRadius: 170, fleeDurationMs: 650, random: noJitter, ...overrides }
}

function inside(p: Point, area: Rect = workArea): boolean {
  return (
    p.x >= area.x &&
    p.y >= area.y &&
    p.x + size.width <= area.x + area.width &&
    p.y + size.height <= area.y + area.height
  )
}

/** Deterministic pseudo-random sequence for tests. */
function sequence(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]!
}

describe('anchorPosition', () => {
  it('places the character in each corner with the margin', () => {
    expect(anchorPosition('bottom-right', workArea, size, margin)).toEqual({ x: 1920 - 300 - 12, y: 1040 - 480 - 12 })
    expect(anchorPosition('bottom-left', workArea, size, margin)).toEqual({ x: 12, y: 1040 - 480 - 12 })
    expect(anchorPosition('top-right', workArea, size, margin)).toEqual({ x: 1920 - 300 - 12, y: 12 })
    expect(anchorPosition('top-left', workArea, size, margin)).toEqual({ x: 12, y: 12 })
  })

  it('respects a work area that does not start at the origin (secondary display)', () => {
    const area: Rect = { x: 1920, y: 100, width: 1280, height: 700 }
    expect(anchorPosition('top-left', area, size, 20)).toEqual({ x: 1940, y: 120 })
    expect(anchorPosition('bottom-right', area, size, 20)).toEqual({ x: 1920 + 1280 - 300 - 20, y: 100 + 700 - 480 - 20 })
  })

  it('never leaves the work area even when the character barely fits', () => {
    const tiny: Rect = { x: 0, y: 0, width: 310, height: 490 }
    for (const anchor of ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const) {
      expect(inside(anchorPosition(anchor, tiny, size, margin), tiny)).toBe(true)
    }
  })
})

describe('helpers', () => {
  it('clampToWorkArea keeps the whole character inside', () => {
    expect(clampToWorkArea({ x: -500, y: -500 }, workArea, size, margin)).toEqual({ x: 12, y: 12 })
    expect(clampToWorkArea({ x: 5000, y: 5000 }, workArea, size, margin)).toEqual({ x: 1608, y: 548 })
    expect(clampToWorkArea({ x: 400, y: 300 }, workArea, size, margin)).toEqual({ x: 400, y: 300 })
  })

  it('rectDistance measures to the nearest edge/corner and is 0 inside', () => {
    const rect: Rect = { x: 100, y: 100, width: 200, height: 100 }
    expect(rectDistance({ x: 150, y: 150 }, rect)).toBe(0)
    expect(rectDistance({ x: 50, y: 150 }, rect)).toBe(50)
    expect(rectDistance({ x: 150, y: 250 }, rect)).toBe(50)
    expect(rectDistance({ x: 340, y: 230 }, rect)).toBeCloseTo(50)
  })

  it('easeOutCubic starts at 0, ends at 1, and decelerates', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })

  it('fleeCandidates are all inside the work area', () => {
    for (const c of fleeCandidates({ x: 1608, y: 548 }, workArea, size, margin)) expect(inside(c)).toBe(true)
    expect(fleeCandidates({ x: 1608, y: 548 }, workArea, size, margin)).toHaveLength(10)
  })
})

describe('pickFleeTarget', () => {
  const current = anchorPosition('bottom-right', workArea, size, margin)

  it('increases the distance to the cursor', () => {
    const cursor: Point = { x: current.x - 60, y: current.y + 200 }
    const target = pickFleeTarget(current, cursor, options())
    const before = rectDistance(cursor, { ...current, ...size })
    const after = rectDistance(cursor, { ...target, ...size })
    expect(after).toBeGreaterThan(before + 500)
    expect(inside(target)).toBe(true)
  })

  it('flies to the far side when the cursor approaches from the left', () => {
    const cursor: Point = { x: current.x - 100, y: current.y + 240 }
    const target = pickFleeTarget(current, cursor, options())
    expect(target.x).toBeLessThan(workArea.width / 2)
  })

  it('stays in bounds for extreme jitter values', () => {
    for (const random of [() => 0, () => 1, () => 0.999, sequence([0, 1, 1, 0, 0.3, 0.9])]) {
      for (const start of [current, { x: 12, y: 12 }, { x: 800, y: 300 }]) {
        const target = pickFleeTarget(start, { x: start.x + 150, y: start.y + 240 }, options({ random }))
        expect(inside(target)).toBe(true)
        expect(Number.isInteger(target.x) && Number.isInteger(target.y)).toBe(true)
      }
    }
  })

  it('jitters the landing position via the injected random source', () => {
    const cursor: Point = { x: current.x - 60, y: current.y + 200 }
    const a = pickFleeTarget(current, cursor, options({ random: noJitter }))
    const b = pickFleeTarget(current, cursor, options({ random: () => 0.75 }))
    expect(a).not.toEqual(b)
    expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(FLEE_JITTER_PX)
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(FLEE_JITTER_PX)
  })

  it('penalizes targets close to the current position (visible flight)', () => {
    // Cursor far below-right of a top-left character: the top-left corner itself is the farthest
    // candidate from the cursor but must lose because it is (almost) where she already is.
    const start = { x: 40, y: 40 }
    const cursor: Point = { x: start.x + 60, y: start.y + size.height + 100 }
    const target = pickFleeTarget(start, cursor, options())
    expect(Math.hypot(target.x - start.x, target.y - start.y)).toBeGreaterThan(1.5 * size.width)
  })

  it('returns a point inside a tiny work area', () => {
    const tiny: Rect = { x: 0, y: 0, width: 320, height: 500 }
    const target = pickFleeTarget({ x: 10, y: 10 }, { x: 5, y: 5 }, options({ workArea: tiny }))
    expect(inside(target, tiny)).toBe(true)
  })
})

describe('createMovementController', () => {
  it('starts at the given initial position (clamped) and reports bounds without bob', () => {
    const mover = createMovementController(options({ initial: { x: -100, y: 200 } }))
    expect(mover.position()).toEqual({ x: 12, y: 200 })
    expect(mover.bounds()).toEqual({ x: 12, y: 200, width: 300, height: 480 })
    expect(mover.isFlying()).toBe(false)
  })

  it('defaults to the bottom-right anchor', () => {
    const mover = createMovementController(options())
    expect(mover.position()).toEqual(anchorPosition('bottom-right', workArea, size, margin))
  })

  it('bobs vertically while idle and never horizontally', () => {
    const mover = createMovementController(
      options({ initial: { x: 500, y: 300 }, idleBobAmplitude: 6, idleBobPeriodMs: 1000 }),
    )
    expect(mover.update(0).position).toEqual({ x: 500, y: 300 })
    const quarter = mover.update(250)
    expect(quarter.position.x).toBe(500)
    expect(quarter.position.y).toBeCloseTo(306)
    expect(quarter.moving).toBe(false)
    expect(quarter.lean).toBe(0)
    expect(mover.update(750).position.y).toBeCloseTo(294)
    // bounds/position ignore the bob
    expect(mover.position()).toEqual({ x: 500, y: 300 })
  })

  it('flyTo interpolates with ease-out and reaches the target exactly at duration end', () => {
    const mover = createMovementController(
      options({ initial: { x: 100, y: 100 }, fleeDurationMs: 600, idleBobAmplitude: 0 }),
    )
    mover.flyTo({ x: 1000, y: 400 }, 1000)
    expect(mover.isFlying()).toBe(true)
    const start = mover.update(1000)
    expect(start.position).toEqual({ x: 100, y: 100 })
    expect(start.moving).toBe(true)
    const half = mover.update(1300)
    // ease-out: more than half of the way after half of the time
    expect(half.position.x).toBeGreaterThan(550)
    expect(half.position.x).toBeLessThan(1000)
    expect(half.position.y).toBeCloseTo(100 + 300 * easeOutCubic(0.5))
    const end = mover.update(1600)
    expect(end.position).toEqual({ x: 1000, y: 400 })
    expect(end.moving).toBe(false)
    expect(end.lean).toBe(0)
    expect(mover.isFlying()).toBe(false)
    expect(mover.position()).toEqual({ x: 1000, y: 400 })
    // afterwards idle (bob disabled here) stays put
    expect(mover.update(5000).position).toEqual({ x: 1000, y: 400 })
  })

  it('does not apply the bob during flight and restarts it at 0 on landing', () => {
    const mover = createMovementController(
      options({ initial: { x: 100, y: 100 }, fleeDurationMs: 400, idleBobAmplitude: 10, idleBobPeriodMs: 800 }),
    )
    mover.flyTo({ x: 100, y: 100 }, 0) // zero-length flight: any bob would show up as a y offset
    expect(mover.update(200).position).toEqual({ x: 100, y: 100 })
    expect(mover.update(400).position).toEqual({ x: 100, y: 100 })
    // landed at t=400 → bob phase restarts there: at +200 (quarter period) the bob peaks
    expect(mover.update(600).position.y).toBeCloseTo(110)
  })

  it('lean follows the horizontal direction and fades out', () => {
    const right = createMovementController(options({ initial: { x: 100, y: 100 }, fleeDurationMs: 650 }))
    right.flyTo({ x: 1500, y: 100 }, 0)
    const early = right.update(10)
    expect(early.lean).toBeGreaterThan(0)
    expect(early.lean).toBeLessThanOrEqual(1)
    const late = right.update(600)
    expect(late.lean).toBeGreaterThan(0)
    expect(late.lean).toBeLessThan(early.lean)

    const left = createMovementController(options({ initial: { x: 1500, y: 100 }, fleeDurationMs: 650 }))
    left.flyTo({ x: 100, y: 100 }, 0)
    expect(left.update(10).lean).toBeLessThan(0)
    expect(left.update(10).lean).toBeGreaterThanOrEqual(-1)

    const vertical = createMovementController(options({ initial: { x: 100, y: 100 }, fleeDurationMs: 650 }))
    vertical.flyTo({ x: 100, y: 500 }, 0)
    expect(vertical.update(10).lean).toBe(0)
  })

  it('flyTo clamps the target into the work area', () => {
    const mover = createMovementController(options({ initial: { x: 100, y: 100 }, fleeDurationMs: 100 }))
    mover.flyTo({ x: 99999, y: -99999 }, 0)
    expect(mover.update(100).position).toEqual({ x: 1608, y: 12 })
  })

  describe('maybeFlee', () => {
    const initial = anchorPosition('bottom-right', workArea, size, margin) // 1608, 548
    const near: Point = { x: initial.x - 100, y: initial.y + 200 } // 100 px left of her body

    it('flees when the cursor is within the radius of the rect (not the center)', () => {
      const mover = createMovementController(options({ initial, fleeRadius: 170 }))
      // 100 px from the left edge, but ~ 1 bodywidth + from the center
      expect(rectDistance(near, mover.bounds())).toBe(100)
      expect(Math.hypot(near.x - (initial.x + 150), near.y - (initial.y + 240))).toBeGreaterThan(170)
      expect(mover.maybeFlee(near, 1000, false)).toBe(true)
      expect(mover.isFlying()).toBe(true)
      const landed = mover.update(1000 + 650).position
      expect(rectDistance(near, { ...landed, ...size })).toBeGreaterThan(170)
    })

    it('ignores a cursor outside the radius', () => {
      const mover = createMovementController(options({ initial, fleeRadius: 170 }))
      expect(mover.maybeFlee({ x: initial.x - 171, y: initial.y + 200 }, 1000, false)).toBe(false)
      expect(mover.maybeFlee({ x: initial.x - 170, y: initial.y + 200 }, 1000, false)).toBe(true)
    })

    it('does nothing while blocked', () => {
      const mover = createMovementController(options({ initial }))
      expect(mover.maybeFlee(near, 1000, true)).toBe(false)
      expect(mover.isFlying()).toBe(false)
      expect(mover.maybeFlee(near, 1001, false)).toBe(true)
    })

    it('does not re-trigger during a flight or before the cooldown has elapsed', () => {
      const mover = createMovementController(options({ initial, fleeDurationMs: 650, cooldownMs: 900 }))
      expect(mover.maybeFlee(near, 1000, false)).toBe(true)
      // mid-flight
      mover.update(1300)
      expect(mover.maybeFlee(mover.position(), 1300, false)).toBe(false)
      // landed at 1650; cooldown until 2550 – a cursor right on top of her must not trigger
      mover.update(1650)
      expect(mover.isFlying()).toBe(false)
      const onTop = { x: mover.position().x + 10, y: mover.position().y + 10 }
      expect(mover.maybeFlee(onTop, 2000, false)).toBe(false)
      expect(mover.maybeFlee(onTop, 2549, false)).toBe(false)
      expect(mover.maybeFlee(onTop, 2550, false)).toBe(true)
    })

    it('finishes an elapsed flight even when update() was not called meanwhile', () => {
      const mover = createMovementController(options({ initial, fleeDurationMs: 650, cooldownMs: 0 }))
      expect(mover.maybeFlee(near, 0, false)).toBe(true)
      expect(mover.isFlying()).toBe(true)
      const pos = mover.position()
      const cursor = { x: pos.x, y: pos.y } // irrelevant: far from the landing spot
      expect(mover.maybeFlee(cursor, 10_000, false)).toBe(false)
      expect(mover.isFlying()).toBe(false)
      expect(mover.position()).not.toEqual(initial)
    })

    it('does not start a flight when there is nowhere to go', () => {
      const tiny: Rect = { x: 0, y: 0, width: 300, height: 480 }
      const mover = createMovementController(options({ workArea: tiny, initial: { x: 0, y: 0 } }))
      expect(mover.maybeFlee({ x: 10, y: 10 }, 0, false)).toBe(false)
      expect(mover.isFlying()).toBe(false)
    })
  })

  it('setWorkArea / setSize re-clamp the position and bounds', () => {
    const mover = createMovementController(options({ initial: { x: 1608, y: 548 } }))
    mover.setWorkArea({ x: 0, y: 0, width: 1280, height: 720 })
    expect(mover.position()).toEqual({ x: 1280 - 300 - 12, y: 720 - 480 - 12 })
    mover.setSize({ width: 400, height: 600 })
    expect(mover.bounds()).toEqual({ x: 1280 - 400 - 12, y: 720 - 600 - 12, width: 400, height: 600 })
    expect(mover.update(0).position).toEqual({ x: 868, y: 108 })
  })

  it('setPosition cancels a flight and configure() updates the tunables', () => {
    const mover = createMovementController(options({ initial: { x: 100, y: 100 }, fleeRadius: 50 }))
    mover.flyTo({ x: 900, y: 100 }, 0)
    mover.setPosition({ x: 600, y: 300 })
    expect(mover.isFlying()).toBe(false)
    expect(mover.update(100).position.x).toBe(600)
    expect(mover.maybeFlee({ x: 500, y: 400 }, 200, false)).toBe(false) // 100 px away > radius 50
    mover.configure({ fleeRadius: 150 })
    expect(mover.maybeFlee({ x: 500, y: 400 }, 200, false)).toBe(true)
  })
})
