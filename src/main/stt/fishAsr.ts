/**
 * Fish Audio cloud ASR provider (POST https://api.fish.audio/v1/asr) on top of src/main/net/fishAudio.ts.
 *
 * - The API key is shared with the TTS provider (tts.fishCloud.apiKey); the model is the `model` HTTP
 *   header ('transcribe-1' – single speaker, no cue markers; markers are stripped anyway).
 * - Multipart body: `audio` file (wav/webm bytes straight from the renderer), optional `language`,
 *   `ignore_timestamps=true` (lowest latency for short push-to-talk clips).
 * - One retry on 429/5xx, abort via AbortSignal, AbortError passes through unchanged.
 */
import type { SttConfig } from '@shared/config'
import type { RecordedAudio, TestResult } from '@shared/ipc'
import { createLogger } from '../log'
import { FISH_CLOUD_BASE_URL, FishAudioHttpError, fishAsr, fishGetCredit, stripAsrMarkers, type FishClientOptions } from '../net/fishAudio'
import {
  ABORTED_MESSAGE,
  audioBytes,
  audioFilename,
  defaultSleep,
  isAbortError,
  NOTHING_RECOGNIZED_MESSAGE,
  recognizedMessage,
  resolveLanguage,
  toError,
  withSingleRetry,
  type SleepFn,
} from './common'
import type { SttClient } from './types'

const log = createLogger('stt:fish')

/** General-purpose single-speaker model; 'transcribe-1-pro' would add speaker/emotion markers. */
export const FISH_ASR_MODEL = 'transcribe-1'

export const KEY_INVALID_MESSAGE = 'Fish Audio API-Key ungültig'
export const NO_CREDITS_MESSAGE = 'Fish Audio Guthaben aufgebraucht – bitte unter fish.audio/app/developers/billing aufladen'

export interface FishAsrDeps {
  fetchImpl?: typeof fetch
  sleep?: SleepFn
}

/** Human-readable German message for a failed Fish ASR call. */
export function describeFishAsrError(err: unknown): string {
  if (err instanceof FishAudioHttpError) {
    if (err.isAuth) return KEY_INVALID_MESSAGE
    if (err.isOutOfCredits) return NO_CREDITS_MESSAGE
    return `Fish Audio Fehler (HTTP ${err.status}): ${err.message}`
  }
  if (isAbortError(err)) return ABORTED_MESSAGE
  return `Fish Audio nicht erreichbar: ${toError(err).message}`
}

/**
 * @param stt   STT section (language hint).
 * @param apiKey Fish Audio cloud key (from tts.fishCloud.apiKey) – must be non-empty.
 */
export function createFishAsrStt(stt: SttConfig, apiKey: string, deps: FishAsrDeps = {}): SttClient {
  const opts: FishClientOptions = {
    baseUrl: FISH_CLOUD_BASE_URL,
    apiKey: apiKey.trim(),
    model: FISH_ASR_MODEL,
    fetchImpl: deps.fetchImpl,
  }
  const sleep = deps.sleep ?? defaultSleep

  async function transcribe(audio: RecordedAudio, languageHint?: string, signal?: AbortSignal): Promise<string> {
    const bytes = audioBytes(audio)
    if (bytes.byteLength === 0) {
      log.warn('empty recording – skipping ASR request')
      return ''
    }
    const language = resolveLanguage(languageHint, stt.language)
    const result = await withSingleRetry(
      () =>
        fishAsr(
          opts,
          bytes,
          { language, ignoreTimestamps: true, mimeType: audio.mimeType, filename: audioFilename(audio.mimeType) },
          signal,
        ),
      signal,
      sleep,
      log,
    )
    const text = stripAsrMarkers(typeof result?.text === 'string' ? result.text : '')
    log.debug(`transcribed ${bytes.byteLength} bytes (${Math.round(audio.durationMs)} ms) → ${text.length} chars`)
    return text
  }

  async function test(audio?: RecordedAudio): Promise<TestResult> {
    let credit: string
    try {
      credit = (await fishGetCredit(opts)).credit
    } catch (err) {
      log.warn('credit check failed', toError(err).message)
      return { ok: false, message: describeFishAsrError(err) }
    }
    if (!audio) return { ok: true, message: `OK – Guthaben: ${formatCredit(credit)} USD` }
    try {
      const text = await transcribe(audio)
      if (!text) return { ok: false, message: NOTHING_RECOGNIZED_MESSAGE }
      return { ok: true, message: recognizedMessage(text) }
    } catch (err) {
      log.warn('test transcription failed', toError(err).message)
      return { ok: false, message: describeFishAsrError(err) }
    }
  }

  return { name: 'fish-cloud', transcribe, test }
}

function formatCredit(credit: string): string {
  const n = Number(credit)
  return Number.isFinite(n) ? n.toFixed(2) : credit
}
