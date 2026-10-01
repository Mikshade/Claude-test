/**
 * TTS factory + the speech pipeline that turns streamed sentences into ordered audio chunks.
 *
 * OWNER: tts agent. Files: fishCloud.ts, fishLocal.ts, pipeline.ts, index.ts.
 */
import type { TtsConfig } from '@shared/config'
import type { Emotion, SpeechChunk } from '@shared/state'
import type { TtsClient } from './types'

export type { SynthesizeOptions, TtsAudio, TtsClient } from './types'

/** Returns null when provider === 'none' or the provider is not configured yet. */
export function createTtsClient(_config: TtsConfig): TtsClient | null {
  throw new Error('not implemented: createTtsClient (src/main/tts/index.ts)')
}

export interface SpeechPipelineOptions {
  client: TtsClient
  turnId: string
  /** Called with chunks strictly in order of `seq`. */
  onChunk(chunk: SpeechChunk): void
  onError(error: Error, text: string): void
  /** How many sentences to synthesize concurrently (ordering is preserved). */
  concurrency?: number
  signal: AbortSignal
}

export interface SpeechPipeline {
  /** Queue a sentence; synthesis starts immediately. */
  push(text: string, emotion: Emotion): void
  /** No more sentences will be pushed; resolves when the last chunk was emitted (with `last: true`). */
  finish(): Promise<void>
  abort(): void
}

export function createSpeechPipeline(_options: SpeechPipelineOptions): SpeechPipeline {
  throw new Error('not implemented: createSpeechPipeline (src/main/tts/pipeline.ts)')
}
