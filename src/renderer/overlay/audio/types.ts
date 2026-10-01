/**
 * Renderer audio contracts (implemented by the audio agent in recorder.ts / player.ts).
 */
import type { RecordedAudio } from '@shared/ipc'
import type { SpeechChunk } from '@shared/state'

export interface RecorderOptions {
  /** Preferred microphone device id ('' = default). */
  deviceId: string
  /** Auto-stop after this much trailing silence once speech was heard (0 = never). */
  silenceTimeoutMs: number
  /** Hard cap for one recording. */
  maxRecordingMs: number
  /** 0..1 input level for the UI meter, ~20 Hz. */
  onLevel?(level: number): void
  /** Called when the recorder stopped by itself (silence or max duration). */
  onAutoStop?(audio: RecordedAudio | null): void
}

export interface Recorder {
  /** Request the mic (prompts once), start capturing. Rejects with a readable Error on failure. */
  start(): Promise<void>
  /** Stop and return the recording as 16 kHz mono 16-bit WAV, or null when nothing usable was captured. */
  stop(): Promise<RecordedAudio | null>
  /** Stop without producing a result. */
  cancel(): void
  isRecording(): boolean
  setOptions(options: Partial<Pick<RecorderOptions, 'deviceId' | 'silenceTimeoutMs' | 'maxRecordingMs'>>): void
  dispose(): void
}

export interface PlayerOptions {
  /** 0..1 */
  volume: number
  /** Output device id ('' = default); applied with AudioContext.setSinkId when available. */
  outputDeviceId: string
  /** Smoothed mouth openness 0..1, called every animation frame while something plays (0 when idle). */
  onMouth(value: number): void
  /** A chunk started playing (for subtitles). */
  onChunkStart?(chunk: SpeechChunk): void
  /** All chunks of the turn finished (or playback was stopped). */
  onTurnFinished(turnId: string, stopped: boolean): void
  onError?(error: Error, chunk: SpeechChunk): void
}

export interface Player {
  /** Queue a chunk; chunks of a turn must arrive in seq order. A chunk with byteLength 0 and last=true ends the turn. */
  enqueue(chunk: SpeechChunk): void
  /** Stop everything immediately (fires onTurnFinished(turnId, true) for the active turn). */
  stop(): void
  isPlaying(): boolean
  setVolume(volume: number): void
  setOutputDevice(deviceId: string): Promise<void>
  /** Current turn id or null. */
  currentTurn(): string | null
  dispose(): void
}

