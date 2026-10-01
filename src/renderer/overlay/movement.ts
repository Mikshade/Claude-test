/**
 * Pure movement model for the overlay character: resting position, cursor avoidance ("flee"),
 * user-initiated flights and a gentle idle bob.
 *
 * No DOM / Pixi / window access – every input (work area, size, cursor, time, randomness) is passed
 * in, so the whole module is unit-testable. All coordinates are CSS px in the overlay window's
 * coordinate system and positions are the character's TOP-LEFT corner.
 *
 * Usage (renderer/overlay/main.ts):
 *   const mover = createMovementController({ workArea, size: character.size, fleeRadius,
 *     fleeDurationMs, initial: anchorPosition(config.avatar.anchor, workArea, character.size) })
 *   on 'cursor:position' → mover.maybeFlee(cursor, now, blocked)
 *   every frame          → const { position, lean } = mover.update(now); character.setPosition(...); character.setFlightLean(lean)
 *
 * OWNER: renderer-core agent (reassigned).
 */
import type { AvatarConfig } from '@shared/config'
import type { Point, Rect } from '@shared/state'

export type Anchor = AvatarConfig['anchor']

export interface Size {
  width: number
  height: number
}

export const DEFAULT_MARGIN = 12
export const DEFAULT_COOLDOWN_MS = 900
export const DEFAULT_BOB_AMPLITUDE = 6
export const DEFAULT_BOB_PERIOD_MS = 3200
/** Random jitter (±px) added to each flee candidate's score and to the final landing position. */
export const FLEE_JITTER_PX = 40
/** Candidates closer than this × size.width to the current position are penalized (we want a visible flight). */
export const NEAR_FACTOR = 1.5
/** Score penalty for near candidates, in multiples of size.width. */
export const NEAR_PENALTY_FACTOR = 2
/** Small score bonus for candidates in the same vertical half – she prefers to stay low (or high) when it's a tie. */
export const SAME_HALF_BONUS = 60
/** Horizontal speed (px/ms) at which the flight lean saturates at ±1. */
export const LEAN_FULL_SPEED = 1.2

export interface MovementOptions {
  workArea: Rect
  size: Size
  /** Minimum distance to the work-area edges. Default 12. */
  margin?: number
  /** Cursor distance (px, to the nearest point of the character's rect) at which she flees. */
  fleeRadius: number
  /** Flight duration in ms (ease-out cubic). */
  fleeDurationMs: number
  /** Minimum pause after landing before the next flee. Default 900. */
  cooldownMs?: number
  /** Vertical idle bob amplitude in px (0 = off). Default 6. */
  idleBobAmplitude?: number
  /** Idle bob period in ms. Default 3200. */
  idleBobPeriodMs?: number
  /** Injectable randomness (0..1). Default Math.random. */
  random?: () => number
  /** Initial resting position. Default: bottom-right anchor. */
  initial?: Point
}

/** Tunables that can change at runtime (settings). */
export type MovementTuning = Partial<
  Pick<
    MovementOptions,
    'margin' | 'fleeRadius' | 'fleeDurationMs' | 'cooldownMs' | 'idleBobAmplitude' | 'idleBobPeriodMs'
  >
>

export interface MovementFrame {
  /** Where to draw the character this frame (top-left, includes the idle bob). */
  position: Point
  /** -1..1 from the horizontal velocity (negative = moving left). 0 while idle. */
  lean: number
  /** True while a flight is in progress. */
  moving: boolean
}

export interface MovementController {
  /** Logical top-left position: the resting position while idle (bob excluded), the in-flight position during a flight. */
  position(): Point
  /** Teleport (cancels any flight). The point is clamped into the work area. */
  setPosition(p: Point): void
  setWorkArea(rect: Rect): void
  setSize(size: Size): void
  /** Update runtime tunables (e.g. after an avoidance settings change). */
  configure(tuning: MovementTuning): void
  /** Call every frame with a monotonic timestamp (ms). */
  update(nowMs: number): MovementFrame
  /**
   * Starts a flee flight and returns true when: not blocked, not already flying, the cooldown has elapsed and the
   * cursor is within `fleeRadius` of the character's bounding box (distance to the nearest point of the rect).
   */
  maybeFlee(cursor: Point, nowMs: number, blocked: boolean): boolean
  /** User-initiated move (e.g. tray "fly somewhere else"); allowed any time, also mid-flight. */
  flyTo(target: Point, nowMs: number): void
  /** Bounding rect at the logical position (bob excluded). */
  bounds(): Rect
  isFlying(): boolean
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/** Clamp a top-left point so the whole character (plus margin) stays inside the work area. */
export function clampToWorkArea(p: Point, workArea: Rect, size: Size, margin = DEFAULT_MARGIN): Point {
  // If the character does not fit, the margin shrinks to 0 and she sits at the work-area origin.
  const marginX = Math.max(0, Math.min(margin, (workArea.width - size.width) / 2))
  const marginY = Math.max(0, Math.min(margin, (workArea.height - size.height) / 2))
  const minX = workArea.x + marginX
  const maxX = Math.max(minX, workArea.x + workArea.width - size.width - marginX)
  const minY = workArea.y + marginY
  const maxY = Math.max(minY, workArea.y + workArea.height - size.height - marginY)
  return { x: clamp(p.x, minX, maxX), y: clamp(p.y, minY, maxY) }
}

/** Top-left position for an anchor corner. */
export function anchorPosition(anchor: Anchor, workArea: Rect, size: Size, margin = DEFAULT_MARGIN): Point {
  const left = workArea.x + margin
  const top = workArea.y + margin
  const right = workArea.x + workArea.width - size.width - margin
  const bottom = workArea.y + workArea.height - size.height - margin
  const raw: Point =
    anchor === 'top-left'
      ? { x: left, y: top }
      : anchor === 'top-right'
        ? { x: right, y: top }
        : anchor === 'bottom-left'
          ? { x: left, y: bottom }
          : { x: right, y: bottom }
  return clampToWorkArea(raw, workArea, size, margin)
}

/** Distance from a point to the nearest point of a rect (0 when inside). */
export function rectDistance(p: Point, rect: Rect): number {
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width))
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height))
  return Math.hypot(dx, dy)
}

export function easeOutCubic(t: number): number {
  const u = 1 - t
  return 1 - u * u * u
}

/** d/dt of easeOutCubic – used to derive the flight velocity analytically. */
function easeOutCubicVelocity(t: number): number {
  const u = 1 - t
  return 3 * u * u
}

/**
 * Flee candidates: 4 corners, 4 edge midpoints, and the current position mirrored horizontally and
 * vertically around the work-area center – each clamped into the work area with margin.
 */
export function fleeCandidates(current: Point, workArea: Rect, size: Size, margin = DEFAULT_MARGIN): Point[] {
  const left = workArea.x + margin
  const top = workArea.y + margin
  const right = workArea.x + workArea.width - size.width - margin
  const bottom = workArea.y + workArea.height - size.height - margin
  const midX = workArea.x + (workArea.width - size.width) / 2
  const midY = workArea.y + (workArea.height - size.height) / 2
  const mirrorX = 2 * workArea.x + workArea.width - size.width - current.x
  const mirrorY = 2 * workArea.y + workArea.height - size.height - current.y
  const raw: Point[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: midX, y: top },
    { x: midX, y: bottom },
    { x: left, y: midY },
    { x: right, y: midY },
    { x: mirrorX, y: current.y },
    { x: current.x, y: mirrorY },
  ]
  return raw.map((c) => clampToWorkArea(c, workArea, size, margin))
}

/**
 * Pick where to flee to. Score per candidate = distance from the cursor to the candidate's rect
 * (higher is better) − penalty when the candidate is < NEAR_FACTOR × size.width from the current
 * position + SAME_HALF_BONUS when it stays in the same vertical half ± FLEE_JITTER_PX random jitter.
 * The winner gets a ±FLEE_JITTER_PX landing offset and is clamped – never outside the work area.
 */
export function pickFleeTarget(current: Point, cursor: Point, opts: MovementOptions): Point {
  const margin = opts.margin ?? DEFAULT_MARGIN
  const random = opts.random ?? Math.random
  const { workArea, size } = opts
  const nearRadius = NEAR_FACTOR * size.width
  const penalty = NEAR_PENALTY_FACTOR * size.width
  const centerY = workArea.y + workArea.height / 2
  const currentLow = current.y + size.height / 2 >= centerY

  let best: Point | null = null
  let bestScore = -Infinity
  for (const candidate of fleeCandidates(current, workArea, size, margin)) {
    const away = rectDistance(cursor, { x: candidate.x, y: candidate.y, width: size.width, height: size.height })
    const travel = Math.hypot(candidate.x - current.x, candidate.y - current.y)
    const sameHalf = candidate.y + size.height / 2 >= centerY === currentLow
    const jitter = (random() * 2 - 1) * FLEE_JITTER_PX
    const score = away - (travel < nearRadius ? penalty : 0) + (sameHalf ? SAME_HALF_BONUS : 0) + jitter
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  const chosen = best ?? current
  const landing: Point = {
    x: Math.round(chosen.x + (random() * 2 - 1) * FLEE_JITTER_PX),
    y: Math.round(chosen.y + (random() * 2 - 1) * FLEE_JITTER_PX),
  }
  return clampToWorkArea(landing, workArea, size, margin)
}

interface Flight {
  from: Point
  to: Point
  startMs: number
  durationMs: number
}

export function createMovementController(opts: MovementOptions): MovementController {
  let workArea: Rect = { ...opts.workArea }
  let size: Size = { ...opts.size }
  const tuning = {
    margin: opts.margin ?? DEFAULT_MARGIN,
    fleeRadius: opts.fleeRadius,
    fleeDurationMs: opts.fleeDurationMs,
    cooldownMs: opts.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    idleBobAmplitude: opts.idleBobAmplitude ?? DEFAULT_BOB_AMPLITUDE,
    idleBobPeriodMs: opts.idleBobPeriodMs ?? DEFAULT_BOB_PERIOD_MS,
  }
  const random = opts.random ?? Math.random

  /** Resting position (where she sits when idle; bob excluded). */
  let rest: Point = clampToWorkArea(
    opts.initial ?? anchorPosition('bottom-right', workArea, size, tuning.margin),
    workArea,
    size,
    tuning.margin,
  )
  /** Logical position: equals `rest` while idle, the interpolated position during a flight. */
  let current: Point = { ...rest }
  let flight: Flight | null = null
  /** When the last flight landed (or will land) – the cooldown counts from here. */
  let lastLandingMs = -Infinity
  /** Bob phase origin; reset on landing so the bob starts at 0 and the motion stays continuous. */
  let bobStartMs = 0

  function reclamp(): void {
    rest = clampToWorkArea(rest, workArea, size, tuning.margin)
    current = clampToWorkArea(current, workArea, size, tuning.margin)
    if (flight) {
      flight = {
        ...flight,
        from: clampToWorkArea(flight.from, workArea, size, tuning.margin),
        to: clampToWorkArea(flight.to, workArea, size, tuning.margin),
      }
    }
  }

  function startFlight(target: Point, nowMs: number): void {
    const to = clampToWorkArea(target, workArea, size, tuning.margin)
    const durationMs = Math.max(1, tuning.fleeDurationMs)
    flight = { from: { ...current }, to, startMs: nowMs, durationMs }
    lastLandingMs = nowMs + durationMs
  }

  function land(nowMs: number): void {
    if (!flight) return
    rest = { ...flight.to }
    current = { ...rest }
    flight = null
    bobStartMs = nowMs
  }

  /** Finish a flight whose time is up even if update() was not called for that frame. */
  function finishIfDone(nowMs: number): void {
    if (flight && nowMs >= flight.startMs + flight.durationMs) land(nowMs)
  }

  function bounds(): Rect {
    return { x: current.x, y: current.y, width: size.width, height: size.height }
  }

  return {
    position() {
      return { ...current }
    },

    setPosition(p) {
      flight = null
      lastLandingMs = -Infinity // a teleport is a hard reset: no cooldown pending
      rest = clampToWorkArea(p, workArea, size, tuning.margin)
      current = { ...rest }
    },

    setWorkArea(rect) {
      workArea = { ...rect }
      reclamp()
    },

    setSize(next) {
      size = { ...next }
      reclamp()
    },

    configure(patch) {
      if (patch.margin !== undefined) tuning.margin = patch.margin
      if (patch.fleeRadius !== undefined) tuning.fleeRadius = patch.fleeRadius
      if (patch.fleeDurationMs !== undefined) tuning.fleeDurationMs = patch.fleeDurationMs
      if (patch.cooldownMs !== undefined) tuning.cooldownMs = patch.cooldownMs
      if (patch.idleBobAmplitude !== undefined) tuning.idleBobAmplitude = patch.idleBobAmplitude
      if (patch.idleBobPeriodMs !== undefined) tuning.idleBobPeriodMs = patch.idleBobPeriodMs
      reclamp()
    },

    update(nowMs) {
      if (flight) {
        const t = clamp((nowMs - flight.startMs) / flight.durationMs, 0, 1)
        if (t >= 1) {
          land(nowMs)
          return { position: { ...current }, lean: 0, moving: false }
        }
        const eased = easeOutCubic(t)
        const dx = flight.to.x - flight.from.x
        const dy = flight.to.y - flight.from.y
        current = { x: flight.from.x + dx * eased, y: flight.from.y + dy * eased }
        const vx = (dx / flight.durationMs) * easeOutCubicVelocity(t) // px/ms
        return { position: { ...current }, lean: clamp(vx / LEAN_FULL_SPEED, -1, 1), moving: true }
      }
      const bob =
        tuning.idleBobAmplitude > 0 && tuning.idleBobPeriodMs > 0
          ? tuning.idleBobAmplitude * Math.sin(((nowMs - bobStartMs) / tuning.idleBobPeriodMs) * Math.PI * 2)
          : 0
      return { position: { x: rest.x, y: rest.y + bob }, lean: 0, moving: false }
    },

    maybeFlee(cursor, nowMs, blocked) {
      finishIfDone(nowMs)
      if (blocked || flight) return false
      if (nowMs < lastLandingMs + tuning.cooldownMs) return false
      if (rectDistance(cursor, bounds()) > tuning.fleeRadius) return false
      const target = pickFleeTarget(rest, cursor, {
        workArea,
        size,
        margin: tuning.margin,
        fleeRadius: tuning.fleeRadius,
        fleeDurationMs: tuning.fleeDurationMs,
        random,
      })
      // Nowhere to go (tiny work area): don't start a zero-length flight.
      if (Math.hypot(target.x - rest.x, target.y - rest.y) < 1) return false
      startFlight(target, nowMs)
      return true
    },

    flyTo(target, nowMs) {
      finishIfDone(nowMs)
      startFlight(target, nowMs)
    },

    bounds,

    isFlying() {
      return flight !== null
    },
  }
}
