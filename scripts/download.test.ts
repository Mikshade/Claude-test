import { describe, expect, it, vi } from 'vitest'
import { DownloadError, fetchBytes, fetchWithFallback, formatBytes, isRetryableStatus, runPool } from './lib/download.mjs'

const noSleep = async (): Promise<void> => undefined

function responseWith(status: number, body: Uint8Array = new Uint8Array([1, 2, 3])): Response {
  return new Response(status === 204 ? null : body, { status })
}

describe('fetchBytes', () => {
  it('returns the body bytes on 200', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => responseWith(200, new Uint8Array([9, 8])))
    const bytes = await fetchBytes('https://x/a', { fetchImpl, sleep: noSleep })
    expect(Array.from(bytes)).toEqual([9, 8])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(init?.redirect).toBe('follow')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not retry a 404 and exposes the status', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => responseWith(404))
    await expect(fetchBytes('https://x/missing', { fetchImpl, sleep: noSleep })).rejects.toMatchObject({
      name: 'DownloadError',
      status: 404,
      url: 'https://x/missing',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries network errors and 5xx with backoff, then succeeds', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined)
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(responseWith(503))
      .mockResolvedValueOnce(responseWith(200))
    const bytes = await fetchBytes('https://x/flaky', { fetchImpl, sleep, retries: 2, retryDelayMs: 100 })
    expect(bytes.byteLength).toBe(3)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200])
  })

  it('gives up after the configured retries and reports the last error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => responseWith(500))
    await expect(fetchBytes('https://x/down', { fetchImpl, sleep: noSleep, retries: 1 })).rejects.toThrow(/HTTP 500/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('aborts via the timeout signal', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }),
    )
    await expect(fetchBytes('https://x/slow', { fetchImpl, sleep: noSleep, retries: 0, timeoutMs: 5 })).rejects.toThrow(/timeout/)
  })

  it('isRetryableStatus', () => {
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(408)).toBe(true)
    expect(isRetryableStatus(404)).toBe(false)
    expect(isRetryableStatus(403)).toBe(false)
    expect(isRetryableStatus(200)).toBe(false)
  })
})

describe('fetchWithFallback', () => {
  it('uses the first URL when it works', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => responseWith(200))
    const result = await fetchWithFallback(['https://cdn/a', 'https://raw/a'], { fetchImpl, sleep: noSleep })
    expect(result.url).toBe('https://cdn/a')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the next URL after a 404 on the first', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => responseWith(String(url).startsWith('https://cdn') ? 404 : 200))
    const result = await fetchWithFallback(['https://cdn/a', 'https://raw/a'], { fetchImpl, sleep: noSleep })
    expect(result.url).toBe('https://raw/a')
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual(['https://cdn/a', 'https://raw/a'])
  })

  it('reports every failed source when all fail', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => responseWith(404))
    const promise = fetchWithFallback(['https://cdn/a', 'https://raw/a'], { fetchImpl, sleep: noSleep })
    await expect(promise).rejects.toBeInstanceOf(DownloadError)
    await expect(promise).rejects.toThrow(/all sources failed:[\s\S]*cdn\/a[\s\S]*raw\/a/)
  })

  it('rejects an empty URL list', async () => {
    await expect(fetchWithFallback([])).rejects.toThrow(/no URLs/)
  })
})

describe('runPool', () => {
  it('keeps result order and never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const results = await runPool([5, 1, 4, 2, 3, 0], 2, async (ms, index) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, ms))
      inFlight--
      return `${index}:${ms}`
    })
    expect(results).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0'])
    expect(peak).toBe(2)
  })

  it('stops scheduling new items after a failure and rethrows it', async () => {
    const started: number[] = []
    const promise = runPool([1, 2, 3, 4, 5, 6], 1, async (n) => {
      started.push(n)
      if (n === 2) throw new Error('boom')
      return n
    })
    await expect(promise).rejects.toThrow('boom')
    expect(started).toEqual([1, 2])
  })

  it('handles an empty list', async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([])
  })
})

describe('formatBytes', () => {
  it('formats B / KB / MB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(12_600)).toBe('12.3 KB')
    expect(formatBytes(5_138_022)).toBe('4.9 MB')
    expect(formatBytes(-1)).toBe('? B')
    expect(formatBytes(Number.NaN)).toBe('? B')
  })
})
