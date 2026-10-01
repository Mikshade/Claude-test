/**
 * STT factory.
 *
 * OWNER: stt agent (shares the Fish Audio HTTP client helpers with the tts agent – see src/main/net/fishAudio.ts).
 * Files: common.ts, fishAsr.ts, openaiCompatible.ts, index.ts.
 */
import type { SttConfig, TtsConfig } from '@shared/config'
import { createLogger } from '../log'
import { createFishAsrStt, type FishAsrDeps } from './fishAsr'
import { createOpenAiCompatibleStt, normalizeBaseUrl, type OpenAiCompatibleDeps } from './openaiCompatible'
import type { SttClient } from './types'

export type { SttClient } from './types'
export { createFishAsrStt, describeFishAsrError, FISH_ASR_MODEL } from './fishAsr'
export type { FishAsrDeps } from './fishAsr'
export { createOpenAiCompatibleStt, describeOpenAiError, normalizeBaseUrl, SttHttpError } from './openaiCompatible'
export type { OpenAiCompatibleDeps } from './openaiCompatible'
export { resolveLanguage } from './common'
export type { SleepFn } from './common'

const log = createLogger('stt')

/** Optional test hooks (fetch/sleep injection); production callers pass nothing. */
export type SttClientDeps = FishAsrDeps & OpenAiCompatibleDeps

/**
 * Returns null when provider === 'none' or not configured. The fish-cloud key is read from tts.fishCloud.apiKey.
 * openai-compatible returns a client whenever a base URL is set – the server may be down, in which case
 * transcribe()/test() report a clear message.
 */
export function createSttClient(stt: SttConfig, tts: TtsConfig, deps: SttClientDeps = {}): SttClient | null {
  switch (stt.provider) {
    case 'none':
      return null
    case 'fish-cloud': {
      const apiKey = tts.fishCloud.apiKey.trim()
      if (!apiKey) {
        log.warn('fish-cloud selected but no Fish Audio API key configured (tts.fishCloud.apiKey) – STT disabled')
        return null
      }
      return createFishAsrStt(stt, apiKey, deps)
    }
    case 'openai-compatible': {
      if (!normalizeBaseUrl(stt.openaiCompatible.baseUrl)) {
        log.warn('openai-compatible selected but no base URL configured – STT disabled')
        return null
      }
      return createOpenAiCompatibleStt(stt, deps)
    }
    default:
      log.warn(`unknown STT provider ${String(stt.provider)} – STT disabled`)
      return null
  }
}
