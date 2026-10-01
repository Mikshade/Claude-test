/**
 * STT factory.
 *
 * OWNER: stt agent (shares the Fish Audio HTTP client helpers with the tts agent – see src/main/net/fishAudio.ts).
 * Files: fishAsr.ts, openaiCompatible.ts, index.ts.
 */
import type { SttConfig, TtsConfig } from '@shared/config'
import type { SttClient } from './types'

export type { SttClient } from './types'

/** Returns null when provider === 'none' or not configured. The fish-cloud key is read from tts.fishCloud.apiKey. */
export function createSttClient(_stt: SttConfig, _tts: TtsConfig): SttClient | null {
  throw new Error('not implemented: createSttClient (src/main/stt/index.ts)')
}
