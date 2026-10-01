/**
 * Energy voice-activity detector for push-to-talk auto-stop.
 *
 * Feed it one RMS value per ~20 ms frame together with a timestamp; it answers whether to keep
 * recording, stop because the user went quiet after speaking, or stop because the hard cap was hit.
 *
 * A frame counts as speech when rms > max(noiseFloor * NOISE_RATIO, SPEECH_THRESHOLD). The noise
 * floor adapts ONLY on non-speech frames (fast down, slow up, capped): tracking it on every frame
 * makes long sentences raise the floor until speech is no longer detected and the silence timer
 * fires in the middle of a sentence.
 *
 * OWNER: audio agent. Pure – unit-tested in vad.test.ts.
 */

export type VadDecision = 'continue' | 'stop-silence' | 'stop-max'

export interface VadOptions {
  /** Stop after this much continuous non-speech once speech was heard (0 = never auto-stop on silence). */
  silenceTimeoutMs: number
  /** Hard cap on the whole recording in ms (0 = none). */
  maxRecordingMs: number
  /** Clock used when feed()/reset() get no explicit timestamp. Default performance.now (Date.now in Node). */
  now?: () => number
  /** Absolute RMS below which a frame is never speech. Default SPEECH_THRESHOLD (≈ -38 dBFS). */
  threshold?: number
  /** A frame is speech when rms > noiseFloor * noiseRatio. Default NOISE_RATIO. */
  noiseRatio?: number
  /** Consecutive speech frames before "speech was heard" (debounces clicks). Default MIN_SPEECH_FRAMES. */
  minSpeechFrames?: number
}

export interface Vad {
  /** Classify one frame. `nowMs` defaults to the configured clock. */
  feed(rms: number, nowMs?: number): VadDecision
  /** Forget everything (new recording). `nowMs` becomes the recording start. */
  reset(nowMs?: number): void
  /** True once at least `minSpeechFrames` consecutive speech frames were seen in this recording. */
  hadSpeech(): boolean
  /** Whether the most recent frame was classified as speech. */
  isSpeaking(): boolean
  /** Current adaptive noise floor (RMS). */
  noiseFloor(): number
  /** Current effective speech threshold (RMS). */
  threshold(): number
  /** Milliseconds since reset()/first frame. */
  elapsedMs(nowMs?: number): number
}

export const SPEECH_THRESHOLD = 0.012
export const NOISE_RATIO = 3
export const MIN_SPEECH_FRAMES = 3
export const INITIAL_NOISE_FLOOR = 0.004
export const MAX_NOISE_FLOOR = 0.05
/** Floor adaptation: falls fast (towards quieter frames) and rises slowly (towards louder non-speech). */
export const FLOOR_DOWN_ALPHA = 0.2
export const FLOOR_UP_ALPHA = 0.02

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function createVad(options: VadOptions): Vad {
  const now = options.now ?? defaultNow
  const threshold = options.threshold ?? SPEECH_THRESHOLD
  const noiseRatio = options.noiseRatio ?? NOISE_RATIO
  const minSpeechFrames = Math.max(1, options.minSpeechFrames ?? MIN_SPEECH_FRAMES)

  let startedAt: number | null = null
  let lastSpeechAt = 0
  let heardSpeech = false
  let speechRun = 0
  let speaking = false
  let floor = INITIAL_NOISE_FLOOR

  function reset(nowMs = now()): void {
    startedAt = nowMs
    lastSpeechAt = 0
    heardSpeech = false
    speechRun = 0
    speaking = false
    floor = INITIAL_NOISE_FLOOR
  }

  function effectiveThreshold(): number {
    return Math.max(threshold, floor * noiseRatio)
  }

  function feed(rms: number, nowMs = now()): VadDecision {
    if (startedAt === null) startedAt = nowMs
    const level = Number.isFinite(rms) && rms > 0 ? rms : 0
    speaking = level > effectiveThreshold()

    if (speaking) {
      speechRun++
      if (speechRun >= minSpeechFrames) {
        heardSpeech = true
        lastSpeechAt = nowMs
      }
    } else {
      speechRun = 0
      // Adapt the floor on non-speech frames only.
      const alpha = level < floor ? FLOOR_DOWN_ALPHA : FLOOR_UP_ALPHA
      floor = Math.min(MAX_NOISE_FLOOR, floor * (1 - alpha) + level * alpha)
    }

    const elapsed = nowMs - startedAt
    if (options.maxRecordingMs > 0 && elapsed >= options.maxRecordingMs) return 'stop-max'
    if (heardSpeech && options.silenceTimeoutMs > 0 && nowMs - lastSpeechAt >= options.silenceTimeoutMs) {
      return 'stop-silence'
    }
    return 'continue'
  }

  return {
    feed,
    reset,
    hadSpeech: () => heardSpeech,
    isSpeaking: () => speaking,
    noiseFloor: () => floor,
    threshold: effectiveThreshold,
    elapsedMs: (nowMs = now()) => (startedAt === null ? 0 : nowMs - startedAt),
  }
}
