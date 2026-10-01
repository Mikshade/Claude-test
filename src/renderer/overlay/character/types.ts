/**
 * Character view contract – implemented by Live2DCharacter (pixi-live2d-display) and
 * FallbackCharacter (procedural canvas drawing when no model / Cubism Core is available).
 *
 * All coordinates are CSS pixels in the overlay window's coordinate system.
 */
import type { CompanionState, Emotion, Rect } from '@shared/state'

export interface CharacterView {
  /** Load assets; resolves when the first frame can be drawn. */
  load(): Promise<void>
  /** The DOM element to position (canvas wrapper). Its size is `height` × aspect. */
  readonly element: HTMLElement
  /** Rendered size in CSS px. */
  readonly size: { width: number; height: number }
  setEmotion(emotion: Emotion): void
  setState(state: CompanionState): void
  /** 0..1 mouth openness driven by the audio analyser while speaking. */
  setMouthOpen(value: number): void
  /** Look toward a point (window coords). */
  lookAt(x: number, y: number): void
  /** Hit test in window coords (true when the point is on the character's body). */
  hitTest(x: number, y: number): boolean
  /** Bounding rect in window coords (uses current position). */
  bounds(): Rect
  /** Called by the movement controller every frame with the new top-left position. */
  setPosition(x: number, y: number): void
  /** Visual tilt/squash during flight (-1..1 lean). */
  setFlightLean(lean: number): void
  setMirror(mirror: boolean): void
  setOpacity(alpha: number): void
  dispose(): void
}
