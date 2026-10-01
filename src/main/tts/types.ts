/**
 * Text-to-speech provider contract.
 */
import type { TestResult, VoiceInfo } from '@shared/ipc'
import type { Emotion } from '@shared/state'

export interface TtsAudio {
  data: ArrayBuffer
  format: 'wav' | 'mp3' | 'pcm'
  /** Required when format === 'pcm' (16-bit signed LE mono). */
  sampleRate?: number
}

export interface SynthesizeOptions {
  /** Emotion of this sentence; providers may turn it into delivery cues. */
  emotion?: Emotion
  signal?: AbortSignal
}

export interface TtsClient {
  readonly name: string
  synthesize(text: string, options?: SynthesizeOptions): Promise<TtsAudio>
  /** Quick check that credentials/server work; may synthesize a short sample. */
  test(sampleText: string): Promise<TestResult>
  /** Search voices (cloud providers). Optional. */
  searchVoices?(query: string): Promise<VoiceInfo[]>
}
