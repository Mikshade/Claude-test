/**
 * TTS factory + the speech pipeline that turns streamed sentences into ordered audio chunks.
 *
 * OWNER: tts agent. Files: cues.ts, common.ts, fishCloud.ts, fishLocal.ts, pipeline.ts, index.ts.
 */
import type { TtsConfig } from '@shared/config'
import { createLogger } from '../log'
import { createFishCloudTts, type FishCloudDeps } from './fishCloud'
import { createFishLocalTts, type FishLocalDeps } from './fishLocal'
import type { TtsClient } from './types'

export type { SynthesizeOptions, TtsAudio, TtsClient } from './types'
export { createSpeechPipeline, DEFAULT_CONCURRENCY } from './pipeline'
export type { SpeechPipeline, SpeechPipelineOptions } from './pipeline'
export { cueFor, cueStyleForCloudModel } from './cues'
export type { CueStyle } from './cues'
export { createFishCloudTts } from './fishCloud'
export type { FishCloudDeps } from './fishCloud'
export { createFishLocalTts } from './fishLocal'
export type { FishLocalDeps } from './fishLocal'

const log = createLogger('tts')

/** Optional test hooks (fetch/readFile/sleep injection); production callers pass nothing. */
export type TtsClientDeps = FishCloudDeps & FishLocalDeps

/**
 * Returns null when provider === 'none' or the provider is not configured yet
 * (fish-cloud without an API key). fish-local always returns a client – the server may be down,
 * in which case synthesize()/test() report a clear message.
 */
export function createTtsClient(config: TtsConfig, deps: TtsClientDeps = {}): TtsClient | null {
  switch (config.provider) {
    case 'none':
      return null
    case 'fish-cloud':
      if (!config.fishCloud.apiKey.trim()) {
        log.warn('fish-cloud selected but no API key configured – TTS disabled')
        return null
      }
      return createFishCloudTts(config, deps)
    case 'fish-local':
      return createFishLocalTts(config, deps)
    default:
      log.warn(`unknown TTS provider ${String(config.provider)} – TTS disabled`)
      return null
  }
}
