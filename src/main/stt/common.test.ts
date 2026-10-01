import { describe, expect, it, vi } from 'vitest'
import type { RecordedAudio } from '@shared/ipc'
import type { Logger } from '../log'
import { audioBytes, audioFilename, defaultSleep, isRetryableStatus, resolveLanguage, statusOf, withSingleRetry } from './common'

const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const noSleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe('resolveLanguage', () => {
  it('prefers the per-call hint, falls back to the configured language, ignores empty strings', () => {
    expect(resolveLanguage('en', 'de')).toBe('en')
    expect(resolveLanguage(undefined, 'de')).toBe('de')
    expect(resolveLanguage('', 'de')).toBe('de')
    expect(resolveLanguage('  ', '')).toBeUndefined()
    expect(resolveLanguage(undefined, undefined)).toBeUndefined()
  })

  it('reduces BCP-47 tags to the primary subtag and rejects garbage', () => {
    expect(resolveLanguage('de-DE', '')).toBe('de')
    expect(resolveLanguage('EN_us', '')).toBe('en')
    expect(resolveLanguage('german', 'de')).toBeUndefined()
    expect(resolveLanguage('1', 'de')).toBeUndefined()
  })
})

describe('audioBytes / audioFilename', () => {
  it('wraps an ArrayBuffer and tolerates views', () => {
    const ab = new Uint8Array([1, 2, 3]).buffer
    expect(audioBytes({ data: ab, mimeType: 'audio/wav', durationMs: 1 })).toEqual(new Uint8Array([1, 2, 3]))
    const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3)
    const audio = { data: view as unknown as ArrayBuffer, mimeType: 'audio/wav', durationMs: 1 } satisfies RecordedAudio
    expect(audioBytes(audio)).toEqual(new Uint8Array([8, 7]))
    expect(audioBytes({ data: null as unknown as ArrayBuffer, mimeType: 'audio/wav', durationMs: 1 }).byteLength).toBe(0)
  })

  it('maps the mime type to a filename', () => {
    expect(audioFilename('audio/wav')).toBe('speech.wav')
    expect(audioFilename('audio/webm')).toBe('speech.webm')
  })
})

describe('withSingleRetry', () => {
  it('retries exactly once on 429/5xx after 400 ms and then succeeds', async () => {
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined)
    let calls = 0
    const out = await withSingleRetry(
      async () => {
        calls++
        if (calls === 1) throw statusError(503)
        return 'ok'
      },
      undefined,
      sleep,
      silentLog,
    )
    expect(out).toBe('ok')
    expect(calls).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]?.[0]).toBe(400)
  })

  it('gives up after the second failure and never retries non-retryable errors', async () => {
    let calls = 0
    await expect(
      withSingleRetry(
        async () => {
          calls++
          throw statusError(429)
        },
        undefined,
        noSleep,
        silentLog,
      ),
    ).rejects.toMatchObject({ status: 429 })
    expect(calls).toBe(2)

    calls = 0
    await expect(
      withSingleRetry(
        async () => {
          calls++
          throw statusError(400)
        },
        undefined,
        noSleep,
        silentLog,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(calls).toBe(1)

    await expect(
      withSingleRetry(
        async () => {
          throw new Error('ECONNREFUSED')
        },
        undefined,
        noSleep,
        silentLog,
      ),
    ).rejects.toThrow('ECONNREFUSED')
  })

  it('passes an AbortError through unchanged and rejects early on a pre-aborted signal', async () => {
    const original = new Error('The operation was aborted')
    original.name = 'AbortError'
    const fn = vi.fn(async () => {
      throw original
    })
    await expect(withSingleRetry(fn, undefined, noSleep, silentLog)).rejects.toBe(original)
    expect(fn).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    controller.abort()
    const neverCalled = vi.fn(async () => 'x')
    await expect(withSingleRetry(neverCalled, controller.signal, noSleep, silentLog)).rejects.toMatchObject({ name: 'AbortError' })
    expect(neverCalled).not.toHaveBeenCalled()
  })

  it('does not retry when the signal aborts during the delay', async () => {
    const controller = new AbortController()
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {
      controller.abort()
    })
    let calls = 0
    await expect(
      withSingleRetry(
        async () => {
          calls++
          throw statusError(500)
        },
        controller.signal,
        sleep,
        silentLog,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })

  it('statusOf / isRetryableStatus', () => {
    expect(statusOf(statusError(502))).toBe(502)
    expect(statusOf(new Error('x'))).toBeUndefined()
    expect(statusOf(null)).toBeUndefined()
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(404)).toBe(false)
    expect(isRetryableStatus(undefined)).toBe(false)
  })
})

describe('defaultSleep', () => {
  it('resolves after the delay and immediately when aborted', async () => {
    vi.useFakeTimers()
    try {
      let done = false
      const p = defaultSleep(1000).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(done).toBe(true)

      const controller = new AbortController()
      const p2 = defaultSleep(60_000, controller.signal)
      controller.abort()
      await p2

      const pre = new AbortController()
      pre.abort()
      await defaultSleep(60_000, pre.signal)
    } finally {
      vi.useRealTimers()
    }
  })
})
