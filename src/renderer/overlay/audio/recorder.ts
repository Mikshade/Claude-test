/**
 * Microphone recorder (AudioWorklet → 16 kHz mono 16-bit WAV) with energy VAD auto-stop.
 *
 * OWNER: audio agent. Contract: ./types.ts
 */
import type { Recorder, RecorderOptions } from './types'

export function createRecorder(_options: RecorderOptions): Recorder {
  throw new Error('not implemented: createRecorder (src/renderer/overlay/audio/recorder.ts)')
}
