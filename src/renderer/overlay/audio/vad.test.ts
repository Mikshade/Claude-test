import { describe, expect, it } from 'vitest'
import { INITIAL_NOISE_FLOOR, MIN_SPEECH_FRAMES, SPEECH_THRESHOLD, type Vad, type VadDecision, createVad } from './vad'

const FRAME_MS = 20
const SPEECH = 0.2
const QUIET = 0.002

/** Feed a sequence of frame RMS values at 20 ms intervals; returns the decisions and the time of the last frame. */
function run(vad: Vad, frames: number[], startMs = 0): { decisions: VadDecision[]; lastMs: number } {
  const decisions: VadDecision[] = []
  let now = startMs
  for (const value of frames) {
    decisions.push(vad.feed(value, now))
    now += FRAME_MS
  }
  return { decisions, lastMs: now - FRAME_MS }
}

function frames(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value)
}

function make(overrides: Partial<Parameters<typeof createVad>[0]> = {}): Vad {
  return createVad({ silenceTimeoutMs: 1400, maxRecordingMs: 30000, ...overrides })
}

describe('createVad', () => {
  it('keeps going through silence and stops at the hard cap without speech', () => {
    const vad = make({ maxRecordingMs: 1000 })
    vad.reset(0)
    const { decisions } = run(vad, frames(QUIET, 60))
    const first = decisions.indexOf('stop-max')
    expect(first).toBe(50) // frame at 1000 ms
    expect(decisions.slice(0, 50).every((d) => d === 'continue')).toBe(true)
    expect(vad.hadSpeech()).toBe(false)
  })

  it('stops exactly silenceTimeoutMs after the last speech frame', () => {
    const vad = make({ silenceTimeoutMs: 1400 })
    vad.reset(0)
    const speech = run(vad, frames(SPEECH, 50)) // 0..980 ms
    expect(speech.decisions.every((d) => d === 'continue')).toBe(true)
    expect(vad.hadSpeech()).toBe(true)
    const silence = run(vad, frames(QUIET, 100), speech.lastMs + FRAME_MS)
    const stopIndex = silence.decisions.indexOf('stop-silence')
    const stopMs = speech.lastMs + FRAME_MS + stopIndex * FRAME_MS
    expect(stopMs).toBe(speech.lastMs + 1400)
    expect(silence.decisions.slice(0, stopIndex).every((d) => d === 'continue')).toBe(true)
  })

  it('restarts the silence timer when speech resumes', () => {
    const vad = make({ silenceTimeoutMs: 1400 })
    vad.reset(0)
    run(vad, frames(SPEECH, 10)) // 0..180
    const pause = run(vad, frames(QUIET, 50), 200) // 200..1180 (< 1400 silence)
    expect(pause.decisions.every((d) => d === 'continue')).toBe(true)
    const more = run(vad, frames(SPEECH, 10), 1200) // 1200..1380
    expect(more.decisions.every((d) => d === 'continue')).toBe(true)
    const tail = run(vad, frames(QUIET, 100), 1400)
    const stopIndex = tail.decisions.indexOf('stop-silence')
    expect(1400 + stopIndex * FRAME_MS).toBe(1380 + 1400)
  })

  it('does not let the noise floor creep up during long speech', () => {
    const vad = make()
    vad.reset(0)
    run(vad, frames(SPEECH, 500)) // 10 s of continuous speech
    expect(vad.noiseFloor()).toBe(INITIAL_NOISE_FLOOR)
    expect(vad.threshold()).toBe(SPEECH_THRESHOLD)
    expect(vad.isSpeaking()).toBe(true)
  })

  it('adapts the noise floor on non-speech frames so steady background noise is not speech', () => {
    const vad = make()
    vad.reset(0)
    run(vad, frames(0.008, 400)) // fan noise below the absolute threshold
    expect(vad.noiseFloor()).toBeGreaterThan(0.0075)
    expect(vad.noiseFloor()).toBeLessThanOrEqual(0.008)
    expect(vad.threshold()).toBeCloseTo(0.024, 3)
    expect(vad.hadSpeech()).toBe(false)
    // A frame just above the absolute threshold is now still noise, a clearly louder one is speech.
    vad.feed(0.02, 8000)
    expect(vad.isSpeaking()).toBe(false)
    vad.feed(0.03, 8020)
    expect(vad.isSpeaking()).toBe(true)
  })

  it('drops the floor quickly when it gets quieter again', () => {
    const vad = make()
    vad.reset(0)
    run(vad, frames(0.008, 400))
    const noisy = vad.noiseFloor()
    run(vad, frames(0.001, 20), 8000)
    expect(vad.noiseFloor()).toBeLessThan(noisy / 4)
  })

  it('debounces isolated clicks: speech needs MIN_SPEECH_FRAMES consecutive frames', () => {
    const vad = make()
    vad.reset(0)
    run(vad, [QUIET, SPEECH, QUIET, QUIET, SPEECH, SPEECH, QUIET])
    expect(vad.hadSpeech()).toBe(false)
    run(vad, frames(SPEECH, MIN_SPEECH_FRAMES), 200)
    expect(vad.hadSpeech()).toBe(true)
  })

  it('never stops on silence when silenceTimeoutMs is 0 (manual stop only) but still honours the cap', () => {
    const vad = make({ silenceTimeoutMs: 0, maxRecordingMs: 5000 })
    vad.reset(0)
    run(vad, frames(SPEECH, 10))
    const { decisions } = run(vad, frames(QUIET, 300), 200)
    expect(decisions.includes('stop-silence')).toBe(false)
    expect(decisions.indexOf('stop-max')).toBe((5000 - 200) / FRAME_MS)
  })

  it('prefers the hard cap over the silence rule when both are due', () => {
    const vad = make({ silenceTimeoutMs: 100, maxRecordingMs: 300 })
    vad.reset(0)
    run(vad, frames(SPEECH, 5)) // 0..80
    // The next frame is at 300 ms: silence of 220 ms AND the cap.
    expect(vad.feed(QUIET, 300)).toBe('stop-max')
  })

  it('reset() forgets speech, the floor and the start time', () => {
    const vad = make({ maxRecordingMs: 1000 })
    vad.reset(0)
    run(vad, frames(SPEECH, 10))
    run(vad, frames(0.008, 100), 200)
    expect(vad.hadSpeech()).toBe(true)
    vad.reset(5000)
    expect(vad.hadSpeech()).toBe(false)
    expect(vad.noiseFloor()).toBe(INITIAL_NOISE_FLOOR)
    expect(vad.elapsedMs(5100)).toBe(100)
    expect(vad.feed(QUIET, 5990)).toBe('continue')
    expect(vad.feed(QUIET, 6000)).toBe('stop-max')
  })

  it('uses the injected clock when no timestamp is passed', () => {
    let now = 1000
    const vad = createVad({ silenceTimeoutMs: 200, maxRecordingMs: 0, now: () => now })
    vad.reset()
    for (let i = 0; i < 5; i++) {
      now += FRAME_MS
      vad.feed(SPEECH)
    }
    now += 199
    expect(vad.feed(QUIET)).toBe('continue')
    now += 1
    expect(vad.feed(QUIET)).toBe('stop-silence')
    expect(vad.elapsedMs()).toBe(300)
  })

  it('treats NaN / negative rms as silence', () => {
    const vad = make()
    vad.reset(0)
    run(vad, [Number.NaN, -1, Number.POSITIVE_INFINITY].map((v) => (Number.isFinite(v) ? v : Number.NaN)))
    expect(vad.hadSpeech()).toBe(false)
    expect(vad.noiseFloor()).toBeLessThan(INITIAL_NOISE_FLOOR)
  })
})
