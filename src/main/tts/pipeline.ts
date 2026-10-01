/**
 * Ordered speech pipeline: sentences go in as the brain streams them, synthesis runs with bounded
 * concurrency, and `speech:chunk`s come out strictly in push order (seq 0, 1, 2, …).
 *
 * - A failed sentence is reported via onError and skipped; emitted seq numbers stay contiguous.
 * - finish() resolves once the final chunk was emitted. The final chunk carries `last: true`; when the
 *   last sentence failed, was already emitted before finish() was called, or nothing was pushed, a
 *   terminal empty chunk (0 bytes, format 'wav', text '', last: true) is emitted so the renderer always
 *   sees the end of the turn.
 * - abort() cancels in-flight requests and makes finish() resolve immediately without emitting anything else.
 */
import type { Emotion, SpeechChunk } from '@shared/state'
import { cleanForSpeech } from '@shared/text'
import { createLogger } from '../log'
import { isAbortError, toError } from './common'
import type { TtsAudio, TtsClient } from './types'

const log = createLogger('tts:pipeline')

export const DEFAULT_CONCURRENCY = 2

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

type JobStatus = 'pending' | 'running' | 'done' | 'failed'

interface Job {
  text: string
  emotion: Emotion
  status: JobStatus
  audio: TtsAudio | null
}

export function createSpeechPipeline(options: SpeechPipelineOptions): SpeechPipeline {
  const { client, turnId, signal } = options
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
  const controller = new AbortController()
  const jobs: Job[] = []
  let inFlight = 0
  let nextToStart = 0
  let nextToEmit = 0
  let emittedCount = 0
  let lastEmittedWasLast = false
  let finishing = false
  let aborted = false
  let finishPromise: Promise<void> | null = null
  let resolveFinish: (() => void) | null = null

  function emit(chunk: SpeechChunk): void {
    try {
      options.onChunk(chunk)
    } catch (err) {
      log.error('onChunk threw', toError(err).message)
    }
  }

  function reportError(err: unknown, text: string): void {
    try {
      options.onError(toError(err), text)
    } catch (handlerErr) {
      log.error('onError threw', toError(handlerErr).message)
    }
  }

  function pump(): void {
    while (!aborted && inFlight < concurrency && nextToStart < jobs.length) {
      const job = jobs[nextToStart++]
      if (job) start(job)
    }
  }

  function start(job: Job): void {
    job.status = 'running'
    inFlight++
    client
      .synthesize(job.text, { emotion: job.emotion, signal: controller.signal })
      .then(
        (audio) => {
          job.audio = audio
          job.status = 'done'
        },
        (err: unknown) => {
          job.status = 'failed'
          if (aborted || isAbortError(err)) return
          const error = toError(err)
          if (error.message === 'empty') return // nothing speakable – skip silently
          log.warn(`sentence failed: ${error.message}`)
          reportError(error, job.text)
        },
      )
      .then(() => {
        inFlight--
        if (aborted) return
        flush()
        pump()
        settle()
      })
  }

  /** Emit every settled job at the head of the queue, in order; stop at the first one still in flight. */
  function flush(): void {
    while (nextToEmit < jobs.length) {
      const job = jobs[nextToEmit]
      if (!job || job.status === 'pending' || job.status === 'running') return
      nextToEmit++
      if (job.status !== 'done' || !job.audio) continue
      const last = finishing && nextToEmit === jobs.length
      const chunk: SpeechChunk = {
        turnId,
        seq: emittedCount++,
        text: job.text,
        emotion: job.emotion,
        audio: job.audio.data,
        format: job.audio.format,
        last,
      }
      if (job.audio.sampleRate !== undefined) chunk.sampleRate = job.audio.sampleRate
      lastEmittedWasLast = last
      emit(chunk)
    }
  }

  function emitTerminal(): void {
    lastEmittedWasLast = true
    emit({ turnId, seq: emittedCount++, text: '', emotion: 'neutral', audio: new ArrayBuffer(0), format: 'wav', last: true })
  }

  function resolveNow(): void {
    const resolve = resolveFinish
    resolveFinish = null
    resolve?.()
  }

  /** After finish(): once everything is settled, make sure a `last: true` chunk went out, then resolve. */
  function settle(): void {
    if (!finishing || !resolveFinish || aborted) return
    if (nextToEmit < jobs.length) return
    if (!lastEmittedWasLast) emitTerminal()
    resolveNow()
  }

  function push(text: string, emotion: Emotion): void {
    if (aborted) return
    if (finishing) {
      log.warn('push() after finish() ignored')
      return
    }
    if (!cleanForSpeech(text)) return
    jobs.push({ text, emotion, status: 'pending', audio: null })
    pump()
  }

  function finish(): Promise<void> {
    if (!finishPromise) {
      finishing = true
      finishPromise = new Promise<void>((resolve) => {
        resolveFinish = resolve
      })
      if (aborted) resolveNow()
      else {
        flush()
        settle()
      }
    }
    return finishPromise
  }

  function abort(): void {
    if (aborted) return
    aborted = true
    signal.removeEventListener('abort', abort)
    controller.abort()
    resolveNow()
  }

  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })

  return { push, finish, abort }
}
