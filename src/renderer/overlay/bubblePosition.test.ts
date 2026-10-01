import { describe, expect, it } from 'vitest'
import type { Rect } from '@shared/state'
import {
  BUBBLE_GAP,
  type BubblePlacement,
  chooseSide,
  DEFAULT_BUBBLE_MARGIN,
  HEAD_FRACTION,
  pickBubblePosition,
  TAIL_CORNER_CLEARANCE,
  TAIL_INSET,
} from './bubblePosition'

const workArea: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const character = { width: 300, height: 480 }
const bubble = { width: 380, height: 140 }
const margin = DEFAULT_BUBBLE_MARGIN

function characterAt(x: number, y: number): Rect {
  return { x, y, ...character }
}

function corner(which: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left', area: Rect = workArea): Rect {
  const left = area.x + margin
  const top = area.y + margin
  const right = area.x + area.width - character.width - margin
  const bottom = area.y + area.height - character.height - margin
  switch (which) {
    case 'top-left':
      return characterAt(left, top)
    case 'top-right':
      return characterAt(right, top)
    case 'bottom-left':
      return characterAt(left, bottom)
    default:
      return characterAt(right, bottom)
  }
}

function inside(p: BubblePlacement, size = bubble, area: Rect = workArea, m = margin): boolean {
  return (
    p.x >= area.x + m &&
    p.y >= area.y + m &&
    p.x + size.width <= area.x + area.width - m &&
    p.y + size.height <= area.y + area.height - m
  )
}

function overlaps(p: BubblePlacement, rect: Rect, size = bubble): boolean {
  return p.x < rect.x + rect.width && p.x + size.width > rect.x && p.y < rect.y + rect.height && p.y + size.height > rect.y
}

function headY(rect: Rect): number {
  return rect.y + rect.height * HEAD_FRACTION
}

describe('chooseSide', () => {
  it('takes the horizontal side with more room when it fits', () => {
    expect(chooseSide({ left: 500, right: 20, top: 900 }, false)).toBe('left')
    expect(chooseSide({ left: 20, right: 500, top: 900 }, true)).toBe('right')
  })

  it('breaks horizontal ties with preferLeft', () => {
    expect(chooseSide({ left: 100, right: 100, top: 0 }, true)).toBe('left')
    expect(chooseSide({ left: 100, right: 100, top: 0 }, false)).toBe('right')
  })

  it('falls back to the top when neither side fits but the top does', () => {
    expect(chooseSide({ left: -10, right: -40, top: 5 }, false)).toBe('top')
  })

  it('picks the least overflow when nothing fits', () => {
    expect(chooseSide({ left: -10, right: -40, top: -300 }, false)).toBe('left')
    expect(chooseSide({ left: -200, right: -400, top: -30 }, false)).toBe('top')
  })
})

describe('pickBubblePosition – corners', () => {
  it('bottom-right character (default anchor): bubble on her left, tail at her head', () => {
    const rect = corner('bottom-right')
    const p = pickBubblePosition(rect, bubble, workArea)
    expect(p.side).toBe('left')
    expect(p.x).toBe(rect.x - BUBBLE_GAP - bubble.width)
    expect(p.y).toBe(Math.round(headY(rect) - TAIL_INSET))
    expect(p.y + p.tailOffset).toBeCloseTo(headY(rect), 0)
    expect(inside(p)).toBe(true)
    expect(overlaps(p, rect)).toBe(false)
  })

  it('bottom-left character: bubble on her right', () => {
    const rect = corner('bottom-left')
    const p = pickBubblePosition(rect, bubble, workArea)
    expect(p.side).toBe('right')
    expect(p.x).toBe(rect.x + rect.width + BUBBLE_GAP)
    expect(p.y + p.tailOffset).toBeCloseTo(headY(rect), 0)
    expect(inside(p)).toBe(true)
    expect(overlaps(p, rect)).toBe(false)
  })

  it('top-left character: bubble on her right, tail at her head', () => {
    const rect = corner('top-left')
    const p = pickBubblePosition(rect, bubble, workArea)
    expect(p.side).toBe('right')
    expect(p.y).toBe(Math.round(headY(rect) - TAIL_INSET))
    expect(p.y + p.tailOffset).toBeCloseTo(headY(rect), 0)
    expect(p.tailOffset).toBeGreaterThanOrEqual(TAIL_CORNER_CLEARANCE)
    expect(inside(p)).toBe(true)
  })

  it('a head right at the top edge: bubble pushed down to the margin, tail kept off the corner', () => {
    const rect: Rect = { x: 12, y: 0, width: 300, height: 80 } // headY ≈ 21 → y would be negative
    const p = pickBubblePosition(rect, bubble, workArea)
    expect(p.side).toBe('right')
    expect(p.y).toBe(margin)
    expect(p.tailOffset).toBe(TAIL_CORNER_CLEARANCE)
    expect(inside(p)).toBe(true)
  })

  it('top-right character: bubble on her left', () => {
    const rect = corner('top-right')
    const p = pickBubblePosition(rect, bubble, workArea)
    expect(p.side).toBe('left')
    expect(p.x).toBe(rect.x - BUBBLE_GAP - bubble.width)
    expect(inside(p)).toBe(true)
    expect(overlaps(p, rect)).toBe(false)
  })
})

describe('pickBubblePosition – edges and centre', () => {
  it('centred character: the side is chosen by the tie-break (she is at the centre → left)', () => {
    const rect = characterAt((workArea.width - character.width) / 2, (workArea.height - character.height) / 2)
    const p = pickBubblePosition(rect, bubble, workArea)
    expect(p.side).toBe('left')
    expect(inside(p)).toBe(true)
    expect(overlaps(p, rect)).toBe(false)
  })

  it('slightly left of centre → right side (more room there)', () => {
    const rect = characterAt(700, 300)
    expect(pickBubblePosition(rect, bubble, workArea).side).toBe('right')
    const rightish = characterAt(900, 300)
    expect(pickBubblePosition(rightish, bubble, workArea).side).toBe('left')
  })

  it('character on the bottom edge: side bubble, fully inside', () => {
    const rect = characterAt(800, workArea.height - character.height)
    const p = pickBubblePosition(rect, bubble, workArea)
    expect(p.side === 'left' || p.side === 'right').toBe(true)
    expect(inside(p)).toBe(true)
  })

  it('a tall bubble next to a character at the bottom is pushed up and the tail follows the head', () => {
    const rect = corner('bottom-right')
    const tall = { width: 380, height: 420 }
    const p = pickBubblePosition(rect, tall, workArea)
    expect(p.side).toBe('left')
    expect(inside(p, tall)).toBe(true)
    expect(p.y).toBe(workArea.height - tall.height - margin)
    expect(p.y + p.tailOffset).toBeCloseTo(headY(rect), 0)
    expect(p.tailOffset).toBeLessThanOrEqual(tall.height - TAIL_CORNER_CLEARANCE)
  })

  it('keeps the tail off the rounded corners', () => {
    const rect = characterAt(100, 5) // head almost at the top edge
    const p = pickBubblePosition(rect, { width: 300, height: 60 }, workArea)
    expect(p.tailOffset).toBeGreaterThanOrEqual(TAIL_CORNER_CLEARANCE)
    expect(p.tailOffset).toBeLessThanOrEqual(60 - TAIL_CORNER_CLEARANCE)
  })
})

describe('pickBubblePosition – top placement and clamping', () => {
  it('uses the top when neither side has room', () => {
    const narrow: Rect = { x: 0, y: 0, width: 900, height: 1000 }
    const rect = characterAt(300, 500) // 300 px free on both sides < 380 + gap + margin
    const p = pickBubblePosition(rect, bubble, narrow)
    expect(p.side).toBe('top')
    expect(p.y).toBe(rect.y - BUBBLE_GAP - bubble.height)
    expect(p.x).toBe(Math.round(rect.x + rect.width / 2 - bubble.width / 2))
    expect(p.x + p.tailOffset).toBeCloseTo(rect.x + rect.width / 2, 0)
    expect(inside(p, bubble, narrow)).toBe(true)
    expect(overlaps(p, rect)).toBe(false)
  })

  it('clamps a top bubble horizontally and keeps the tail pointing at her', () => {
    const narrow: Rect = { x: 0, y: 0, width: 500, height: 1000 }
    const rect = characterAt(0, 500) // centre x = 150 → centred bubble would start at -40
    const p = pickBubblePosition(rect, bubble, narrow)
    expect(p.side).toBe('top')
    expect(p.x).toBe(margin)
    expect(p.y).toBe(rect.y - BUBBLE_GAP - bubble.height)
    expect(p.x + p.tailOffset).toBeCloseTo(rect.x + rect.width / 2, 0)
    expect(inside(p, bubble, narrow)).toBe(true)
  })

  it('never leaves a tiny work area even when nothing fits', () => {
    const tiny: Rect = { x: 0, y: 0, width: 500, height: 520 }
    for (const rect of [characterAt(100, 20), characterAt(0, 0), characterAt(200, 40)]) {
      const p = pickBubblePosition(rect, bubble, tiny)
      expect(p.x).toBeGreaterThanOrEqual(margin)
      expect(p.y).toBeGreaterThanOrEqual(margin)
      expect(p.x + bubble.width).toBeLessThanOrEqual(tiny.width - margin)
      expect(p.y + bubble.height).toBeLessThanOrEqual(tiny.height - margin)
    }
  })

  it('pins to the top-left margin when the bubble is larger than the work area', () => {
    const minuscule: Rect = { x: 0, y: 0, width: 300, height: 100 }
    const p = pickBubblePosition(characterAt(0, 0), bubble, minuscule)
    expect(p.x).toBe(margin)
    expect(p.y).toBe(margin)
  })

  it('respects a work area that does not start at the origin (secondary display)', () => {
    const area: Rect = { x: 1920, y: 100, width: 1280, height: 700 }
    const rect = corner('bottom-right', area)
    const p = pickBubblePosition(rect, bubble, area)
    expect(p.side).toBe('left')
    expect(inside(p, bubble, area)).toBe(true)
    expect(p.x).toBe(rect.x - BUBBLE_GAP - bubble.width)
    const topLeft = corner('top-left', area)
    const q = pickBubblePosition(topLeft, bubble, area)
    expect(q.side).toBe('right')
    expect(q.x).toBe(topLeft.x + topLeft.width + BUBBLE_GAP)
    expect(q.y).toBe(Math.round(headY(topLeft) - TAIL_INSET))
    expect(inside(q, bubble, area)).toBe(true)
    const short: Rect = { x: area.x + 12, y: area.y, width: 300, height: 80 }
    expect(pickBubblePosition(short, bubble, area).y).toBe(area.y + margin)
  })

  it('honours a custom margin', () => {
    const rect: Rect = { x: 40, y: 0, width: 300, height: 80 }
    const p = pickBubblePosition(rect, bubble, workArea, 40)
    expect(p.y).toBe(40)
    expect(p.x).toBe(rect.x + rect.width + BUBBLE_GAP)
    expect(inside(p, bubble, workArea, 40)).toBe(true)
    const bottomRight = corner('bottom-right')
    const q = pickBubblePosition(bottomRight, { width: 380, height: 600 }, workArea, 40)
    expect(q.y).toBe(workArea.height - 600 - 40)
  })

  it('returns integers', () => {
    const rect = characterAt(333.3, 211.7)
    const p = pickBubblePosition(rect, { width: 311.2, height: 97.9 }, workArea)
    for (const v of [p.x, p.y, p.tailOffset]) expect(Number.isInteger(v)).toBe(true)
  })

  it('tolerates a zero-size bubble (not measured yet)', () => {
    const p = pickBubblePosition(corner('bottom-right'), { width: 0, height: 0 }, workArea)
    expect(p.side).toBe('left')
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.tailOffset)).toBe(true)
  })
})
