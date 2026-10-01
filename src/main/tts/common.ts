/**
 * Helpers shared by the Fish TTS providers: text preparation, abort normalisation and the single retry.
 */
import type { Emotion } from '@shared/state'
import { cleanForSpeech } from '@shared/text'
import type { Logger } from '../log'
import { FishAudioHttpError } from '../net/fishAudio'
import { applyCue, type CueStyle } from './cues'

/** Delay before the one retry on a retryable (429/5xx) Fish HTTP error. */
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

/** The error every provider rejects with after an abort (name === 'AbortError'). */
export function abortError(): Error {
  const err = new Error('TTS request aborted')
  err.name = 'AbortError'
  return err
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * cleanForSpeech + optional delivery cue (one prefix per synthesize call).
 * Throws Error('empty') when nothing speakable remains – callers must not hit the API then.
 */
export function prepareText(text: string, emotion: Emotion | undefined, style: CueStyle, cuesEnabled: boolean): string {
  const cleaned = cleanForSpeech(text)
  if (!cleaned) throw new Error('empty')
  return applyCue(cleaned, emotion, style, cuesEnabled)
}

/**
 * Run `fn`, retrying exactly once after RETRY_DELAY_MS when it failed with a retryable Fish HTTP error
 * (429 / 5xx). Any other error is rethrown as is; an abort always surfaces as an 'AbortError'.
 */
export async function withSingleRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  sleep: SleepFn,
  log: Logger,
): Promise<T> {
  if (signal?.aborted) throw abortError()
  try {
    return await fn()
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw abortError()
    if (!(err instanceof FishAudioHttpError) || !err.isRetryable) throw err
    log.warn(`HTTP ${err.status} – retrying once in ${RETRY_DELAY_MS} ms`)
    await sleep(RETRY_DELAY_MS, signal)
    if (signal?.aborted) throw abortError()
    try {
      return await fn()
    } catch (retryErr) {
      if (signal?.aborted || isAbortError(retryErr)) throw abortError()
      throw retryErr
    }
  }
}
