/**
 * Helpers shared by the STT providers: audio byte access, language hints, abort normalisation and the
 * single retry on 429/5xx. Intentionally independent of src/main/tts/* so the modules evolve separately.
 */
import type { RecordedAudio } from '@shared/ipc'
import type { Logger } from '../log'

/** Delay before the one retry on a retryable (429/5xx) HTTP error. */
export const RETRY_DELAY_MS = 400

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

/** setTimeout-based sleep that returns early when `signal` aborts. */
export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

/** The error a provider rejects with when the signal was already aborted before any request went out. */
export function abortError(): Error {
  const err = new Error('STT request aborted')
  err.name = 'AbortError'
  return err
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/** HTTP status carried by an error object (FishAudioHttpError, SttHttpError, …) or undefined. */
export function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

export function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && (status === 429 || status >= 500)
}

/**
 * Run `fn`, retrying exactly once after RETRY_DELAY_MS when it failed with a 429/5xx HTTP error
 * (detected through the error's numeric `status`). Any other error is rethrown as is; an AbortError
 * (by name) passes through unchanged so callers can distinguish user interruption from failures.
 */
export async function withSingleRetry<T>(fn: () => Promise<T>, signal: AbortSignal | undefined, sleep: SleepFn, log: Logger): Promise<T> {
  if (signal?.aborted) throw abortError()
  try {
    return await fn()
  } catch (err) {
    if (isAbortError(err)) throw err
    if (signal?.aborted) throw abortError()
    const status = statusOf(err)
    if (!isRetryableStatus(status)) throw err
    log.warn(`HTTP ${status} – retrying once in ${RETRY_DELAY_MS} ms`)
    await sleep(RETRY_DELAY_MS, signal)
    if (signal?.aborted) throw abortError()
    return fn()
  }
}

/**
 * The language hint to send: the per-call hint wins over the configured default; empty strings are
 * ignored. Reduced to the ISO 639-1 primary subtag ('de-DE' → 'de'); anything that is not 2–3 letters
 * yields undefined (= let the recognizer auto-detect).
 */
export function resolveLanguage(hint: string | undefined, configured: string | undefined): string | undefined {
  for (const candidate of [hint, configured]) {
    const primary = (candidate ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
    if (primary) return /^[a-z]{2,3}$/.test(primary) ? primary : undefined
  }
  return undefined
}

/** RecordedAudio.data arrives as an ArrayBuffer over IPC; tolerate views (Buffer/Uint8Array) as well. */
export function audioBytes(audio: RecordedAudio): Uint8Array {
  const data: unknown = audio.data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new Uint8Array(0)
}

export function audioFilename(mimeType: RecordedAudio['mimeType']): 'speech.wav' | 'speech.webm' {
  return mimeType === 'audio/webm' ? 'speech.webm' : 'speech.wav'
}

/** Quote a recognized transcript for the settings test result. */
export function recognizedMessage(text: string): string {
  return `Erkannt: "${text}"`
}

export const NOTHING_RECOGNIZED_MESSAGE = 'Verbindung OK, aber keine Sprache erkannt – bitte erneut aufnehmen.'
export const ABORTED_MESSAGE = 'Abgebrochen.'
