/**
 * Pure placement math for the speech bubble: which side of the character it goes on, where exactly,
 * and where its tail has to point. All coordinates are CSS px in the overlay window's coordinate
 * system; positions are the bubble's TOP-LEFT corner.
 *
 * No DOM access – unit-tested in bubblePosition.test.ts. OWNER: renderer-ui agent.
 */
import type { Rect } from '@shared/state'

export type BubbleSide = 'left' | 'right' | 'top'

export interface BubbleSize {
  width: number
  height: number
}

export interface BubblePlacement {
  /** Top-left of the bubble (window coords, integers). */
  x: number
  y: number
  /** Which side of the character the bubble sits on; the tail is on the opposite edge of the bubble. */
  side: BubbleSide
  /** Where the tail sits along its edge: px from the bubble's top (left/right) or from its left (top). */
  tailOffset: number
}

export const DEFAULT_BUBBLE_MARGIN = 12
/** Distance between the character's bounding box and the bubble (room for the tail). */
export const BUBBLE_GAP = 16
/** The tail points at the character's head: this fraction of her height, measured from the top. */
export const HEAD_FRACTION = 0.26
/** Preferred distance of the tail from the bubble's top edge for side placements. */
export const TAIL_INSET = 30
/** The tail never gets closer than this to a bubble corner, so it always sits on a straight edge. */
export const TAIL_CORNER_CLEARANCE = 22

export type SideExcess = Record<BubbleSide, number>

function clampRange(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return value < lo ? lo : value > hi ? hi : value
}

/**
 * Side selection. `excess` is free space minus required space per side (negative = does not fit).
 * Left/right are preferred (a speech bubble beside the face): the horizontal side with more room wins
 * when it fits (ties go to `preferLeft`), then the top, and when nothing fits the side that overflows
 * least – the position is clamped into the work area afterwards anyway.
 */
export function chooseSide(excess: SideExcess, preferLeft: boolean): BubbleSide {
  const horizontal: BubbleSide =
    excess.left === excess.right ? (preferLeft ? 'left' : 'right') : excess.left > excess.right ? 'left' : 'right'
  if (excess[horizontal] >= 0) return horizontal
  if (excess.top >= 0) return 'top'
  return excess.top > excess[horizontal] ? 'top' : horizontal
}

/**
 * Place a bubble of `bubbleSize` next to `characterRect` inside `workArea`.
 * - Side bubbles align their tail with the character's head (HEAD_FRACTION of her height) and grow
 *   downwards while text streams in, so the first lines stay put.
 * - Top bubbles are centred over her and the tail points at her horizontal centre.
 * - The result never leaves the work area (minus `margin`); when the bubble is larger than the work
 *   area it is pinned to the top-left margin.
 */
export function pickBubblePosition(
  characterRect: Rect,
  bubbleSize: BubbleSize,
  workArea: Rect,
  margin = DEFAULT_BUBBLE_MARGIN,
): BubblePlacement {
  const w = Math.max(0, bubbleSize.width)
  const h = Math.max(0, bubbleSize.height)
  const waRight = workArea.x + workArea.width
  const waBottom = workArea.y + workArea.height
  const charRight = characterRect.x + characterRect.width

  const excess: SideExcess = {
    left: characterRect.x - workArea.x - (w + BUBBLE_GAP + margin),
    right: waRight - charRight - (w + BUBBLE_GAP + margin),
    top: characterRect.y - workArea.y - (h + BUBBLE_GAP + margin),
  }
  const characterCenterX = characterRect.x + characterRect.width / 2
  const workAreaCenterX = workArea.x + workArea.width / 2
  const side = chooseSide(excess, characterCenterX >= workAreaCenterX)

  const minX = workArea.x + margin
  const maxX = waRight - w - margin
  const minY = workArea.y + margin
  const maxY = waBottom - h - margin

  if (side === 'top') {
    const x = clampRange(characterCenterX - w / 2, minX, maxX)
    const y = clampRange(characterRect.y - BUBBLE_GAP - h, minY, maxY)
    const tailOffset = w < 2 * TAIL_CORNER_CLEARANCE ? w / 2 : clampRange(characterCenterX - x, TAIL_CORNER_CLEARANCE, w - TAIL_CORNER_CLEARANCE)
    return { x: Math.round(x), y: Math.round(y), side, tailOffset: Math.round(tailOffset) }
  }

  const headY = characterRect.y + characterRect.height * HEAD_FRACTION
  const rawX = side === 'left' ? characterRect.x - BUBBLE_GAP - w : charRight + BUBBLE_GAP
  const x = clampRange(rawX, minX, maxX)
  const y = clampRange(headY - TAIL_INSET, minY, maxY)
  const tailOffset = h < 2 * TAIL_CORNER_CLEARANCE ? h / 2 : clampRange(headY - y, TAIL_CORNER_CLEARANCE, h - TAIL_CORNER_CLEARANCE)
  return { x: Math.round(x), y: Math.round(y), side, tailOffset: Math.round(tailOffset) }
}
