/**
 * OpenAI-compatible speech-to-text: POST {baseUrl}/audio/transcriptions (multipart) as implemented by
 * OpenAI (whisper-1, gpt-4o-transcribe), Groq, faster-whisper-server, whisper.cpp server, LocalAI, …
 *
 * - `baseUrl` is normalised to end with `/v1` (no trailing slash); pasting the full endpoint also works.
 * - Multipart fields: file (filename speech.wav|speech.webm), model, language (only when set), response_format=json.
 * - `Authorization: Bearer` only when an API key is configured – local servers usually need none.
 * - Non-JSON/HTML error bodies become a readable Error (status + first 200 chars).
 * - One retry on 429/5xx, abort via AbortSignal, AbortError passes through unchanged.
 */
import type { SttConfig } from '@shared/config'
import type { RecordedAudio, TestResult } from '@shared/ipc'
import { createLogger } from '../log'
import { toArrayBuffer } from '../net/fishAudio'
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

const log = createLogger('stt:openai')

export const ERROR_SNIPPET_LENGTH = 200
export const KEY_INVALID_MESSAGE = 'STT API-Key ungültig'
export const ENDPOINT_OK_MESSAGE = 'Endpoint erreichbar'
export const ENDPOINT_OK_NO_MODELS_MESSAGE = 'Endpoint erreichbar (keine /models-Liste)'

/** Error for a non-2xx answer from the transcription endpoint; `message` already includes status + snippet. */
export class SttHttpError extends Error {
  constructor(
    readonly status: number,
    readonly snippet: string,
  ) {
    super(`HTTP ${status}${snippet ? `: ${snippet}` : ''}`)
    this.name = 'SttHttpError'
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
}

export interface OpenAiCompatibleDeps {
  fetchImpl?: typeof fetch
  sleep?: SleepFn
}

/**
 * 'https://api.openai.com' | 'https://api.openai.com/v1' | 'http://localhost:8000/v1/' → '…/v1'.
 * A pasted endpoint ('…/v1/audio/transcriptions', '…/v1/models') is reduced to its base. Empty input → ''.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (!url) return ''
  url = url.replace(/\/audio\/transcriptions$/i, '').replace(/\/models$/i, '').replace(/\/+$/, '')
  if (!/\/v1$/i.test(url)) url += '/v1'
  return url
}

/** Readable excerpt of an error body: JSON `error.message` / `message` / `detail` when present, else text sans HTML tags. */
export function errorSnippet(body: string): string {
  const text = body.trim()
  if (!text) return ''
  try {
    const json = JSON.parse(text) as unknown
    const message = extractMessage(json)
    if (message) return message.slice(0, ERROR_SNIPPET_LENGTH)
  } catch {
    /* not JSON */
  }
  return text
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_SNIPPET_LENGTH)
}

function extractMessage(json: unknown): string | null {
  if (typeof json === 'string') return json
  if (typeof json !== 'object' || json === null) return null
  const obj = json as Record<string, unknown>
  for (const key of ['error', 'message', 'detail']) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'object' && value !== null) {
      const nested = extractMessage(value)
      if (nested) return nested
    }
  }
  return null
}

/** Human-readable German message for a failed call. */
export function describeOpenAiError(err: unknown): string {
  if (err instanceof SttHttpError) {
    if (err.isAuth) return KEY_INVALID_MESSAGE
    return `STT-Server Fehler (${err.message})`
  }
  if (isAbortError(err)) return ABORTED_MESSAGE
  return `STT-Server nicht erreichbar: ${toError(err).message}`
}

export function createOpenAiCompatibleStt(stt: SttConfig, deps: OpenAiCompatibleDeps = {}): SttClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const cfg = stt.openaiCompatible
  const baseUrl = normalizeBaseUrl(cfg.baseUrl)
  const apiKey = cfg.apiKey.trim()
  const model = cfg.model.trim() || 'whisper-1'

  function headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
    return h
  }

  async function request(audio: RecordedAudio, bytes: Uint8Array, language: string | undefined, signal?: AbortSignal): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([toArrayBuffer(bytes)], { type: audio.mimeType }), audioFilename(audio.mimeType))
    form.append('model', model)
    if (language) form.append('language', language)
    form.append('response_format', 'json')
    const res = await fetchImpl(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers: headers(), body: form, signal })
    const body = await res.text().catch(() => '')
    if (!res.ok) throw new SttHttpError(res.status, errorSnippet(body))
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      throw new Error(`STT-Server antwortete nicht mit JSON (HTTP ${res.status}): ${errorSnippet(body) || '(leer)'}`)
    }
    const text = (json as { text?: unknown } | null)?.text
    return typeof text === 'string' ? text.trim() : ''
  }

  async function transcribe(audio: RecordedAudio, languageHint?: string, signal?: AbortSignal): Promise<string> {
    const bytes = audioBytes(audio)
    if (bytes.byteLength === 0) {
      log.warn('empty recording – skipping transcription request')
      return ''
    }
    const language = resolveLanguage(languageHint, stt.language)
    const text = await withSingleRetry(() => request(audio, bytes, language, signal), signal, sleep, log)
    log.debug(`transcribed ${bytes.byteLength} bytes (${Math.round(audio.durationMs)} ms) → ${text.length} chars`)
    return text
  }

  async function test(audio?: RecordedAudio): Promise<TestResult> {
    if (audio) {
      try {
        const text = await transcribe(audio)
        if (!text) return { ok: false, message: NOTHING_RECOGNIZED_MESSAGE }
        return { ok: true, message: recognizedMessage(text) }
      } catch (err) {
        log.warn('test transcription failed', toError(err).message)
        return { ok: false, message: describeOpenAiError(err) }
      }
    }
    try {
      const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', headers: headers() })
      if (res.ok) return { ok: true, message: ENDPOINT_OK_MESSAGE }
      if (res.status === 404 || res.status === 405) return { ok: true, message: ENDPOINT_OK_NO_MODELS_MESSAGE }
      const snippet = errorSnippet(await res.text().catch(() => ''))
      return { ok: false, message: describeOpenAiError(new SttHttpError(res.status, snippet)) }
    } catch (err) {
      log.warn('endpoint check failed', toError(err).message)
      return { ok: false, message: describeOpenAiError(err) }
    }
  }

  return { name: 'openai-compatible', transcribe, test }
}
