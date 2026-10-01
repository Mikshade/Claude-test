/**
 * Pure geometry helpers shared by the character views (Live2D + fallback): coordinate conversion,
 * bounding-box hit testing, look-at normalisation and the CSS flight transform.
 *
 * No DOM access – everything is unit-tested in hitTest.test.ts.
 */
import type { CompanionState, Point, Rect } from '@shared/state'

/** Fraction of each side removed from the bounding box before a hit test (transparent margins). */
export const HIT_SHRINK = 0.12
/** Maximum tilt (degrees) at full flight lean. */
export const LEAN_MAX_DEG = 10
/** Horizontal stretch / vertical squash at full lean. */
export const LEAN_SQUASH = 0.06

export interface Size {
  width: number
  height: number
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/** Shrink a rect by `fraction` of its width/height on every side (0.12 → 76 % of the size remains). */
export function shrinkRect(rect: Rect, fraction: number): Rect {
  const f = clamp(fraction, 0, 0.5)
  const dx = rect.width * f
  const dy = rect.height * f
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width - 2 * dx, height: rect.height - 2 * dy }
}

export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height
}

/** Bounding-box hit test with the transparent margin removed. */
export function hitBoundingBox(x: number, y: number, rect: Rect, shrink = HIT_SHRINK): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return pointInRect(x, y, shrinkRect(rect, shrink))
}

/** Window coordinates → coordinates local to the character wrapper at `origin` (its top-left). */
export function toLocal(x: number, y: number, origin: Point): Point {
  return { x: x - origin.x, y: y - origin.y }
}

export interface FocusOptions {
  /** The model is drawn mirrored (scale.x < 0): model-space x is flipped. */
  mirror?: boolean
  /** Current companion state – listening leans further toward the cursor, thinking glances up. */
  state?: CompanionState
}

/**
 * Normalised look-at vector in [-1, 1] for a point in wrapper-local coordinates. `x` > 0 looks to the
 * screen right, `y` > 0 looks UP (Live2D convention: ParamAngleY/EyeBallY positive = up).
 * The "eyes" are assumed at ~35 % of the height, so a cursor at eye level gives y ≈ 0.
 */
export function normalizedFocus(localX: number, localY: number, size: Size, opts: FocusOptions = {}): Point {
  if (size.width <= 0 || size.height <= 0) return { x: 0, y: 0 }
  const eyeY = size.height * 0.35
  let x = clamp((localX - size.width / 2) / (size.width * 0.9), -1, 1)
  let y = clamp(-(localY - eyeY) / (size.height * 0.75), -1, 1)
  if (opts.state === 'listening') {
    x = clamp(x * 1.3, -1, 1)
    y = clamp(y * 1.3, -1, 1)
  } else if (opts.state === 'thinking') {
    x = x * 0.4
    y = clamp(y * 0.3 + 0.55, -1, 1)
  }
  if (opts.mirror) x = -x
  return { x: round3(x), y: round3(y) }
}

export interface FlightTransform {
  rotateDeg: number
  scaleX: number
  scaleY: number
}

/** Tilt in the flight direction plus a subtle stretch/squash, both proportional to the lean (-1..1). */
export function flightTransform(lean: number, maxDeg = LEAN_MAX_DEG, squash = LEAN_SQUASH): FlightTransform {
  const l = Number.isFinite(lean) ? clamp(lean, -1, 1) : 0
  const a = Math.abs(l)
  return { rotateDeg: round3(l * maxDeg), scaleX: round3(1 + a * squash), scaleY: round3(1 - a * squash) }
}

/**
 * CSS transform for the character wrapper: GPU translate to the top-left position plus the flight
 * tilt. Intended with `transform-origin: 50% 100%` so she pivots around her feet.
 */
export function composeTransform(x: number, y: number, lean: number): string {
  const t = flightTransform(lean)
  const base = `translate3d(${round2(x)}px, ${round2(y)}px, 0)`
  if (t.rotateDeg === 0 && t.scaleX === 1 && t.scaleY === 1) return base
  return `${base} rotate(${t.rotateDeg}deg) scale(${t.scaleX}, ${t.scaleY})`
}

/** Model scale so the model's canvas height equals `targetHeight`; width follows the aspect ratio. */
export function fitToHeight(modelWidth: number, modelHeight: number, targetHeight: number): { scale: number; size: Size } {
  if (modelHeight <= 0 || modelWidth <= 0 || targetHeight <= 0) return { scale: 1, size: { width: 1, height: 1 } }
  const scale = targetHeight / modelHeight
  return { scale, size: { width: Math.max(1, Math.ceil(modelWidth * scale)), height: Math.round(targetHeight) } }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r // normalise -0
}
