/**
 * Small download helpers for the setup scripts: fetch with timeout + retry, URL fallback chains and a
 * bounded-concurrency pool. `fetchImpl` is injectable so the logic is unit-tested without a network.
 */

export class DownloadError extends Error {
  /**
   * @param {string} message
   * @param {{ url: string, status?: number, cause?: unknown }} info
   */
  constructor(message, info) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause })
    this.name = 'DownloadError'
    this.url = info.url
    this.status = info.status
  }
}

/**
 * @typedef {object} FetchOptions
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs] Per-attempt timeout (default 60 s).
 * @property {number} [retries] Extra attempts after a network error / 5xx / 429 (default 2).
 * @property {number} [retryDelayMs] Base delay between attempts, doubled each time (default 500 ms).
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/** @type {(ms: number) => Promise<void>} */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * HTTP status codes worth another attempt on the same URL. 404/403 etc. are final for that URL.
 * @param {number} status
 */
export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

/**
 * GET `url` and return its bytes. Retries on network errors and retryable statuses; a 4xx (other than
 * 408/429) throws immediately with `status` set so callers can fall back to another URL.
 * @param {string} url
 * @param {FetchOptions} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchBytes(url, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 60_000, retries = 2, retryDelayMs = 500, sleep = defaultSleep } = options
  /** @type {unknown} */
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
      if (!res.ok) {
        lastError = new DownloadError(`HTTP ${res.status} for ${url}`, { url, status: res.status })
        if (!isRetryableStatus(res.status)) throw lastError
        continue
      }
      return new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      if (err instanceof DownloadError) {
        if (!isRetryableStatus(err.status ?? 0)) throw err
        lastError = err
        continue
      }
      lastError = new DownloadError(`${describe(err)} (${url})`, { url, cause: err })
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new DownloadError(`download failed: ${url}`, { url })
}

/**
 * Try each URL in turn (with `fetchBytes` retries per URL) and return the first that succeeds.
 * @param {string[]} urls
 * @param {FetchOptions} [options]
 * @returns {Promise<{ bytes: Uint8Array, url: string }>}
 */
export async function fetchWithFallback(urls, options = {}) {
  if (urls.length === 0) throw new Error('fetchWithFallback: no URLs given')
  /** @type {Error[]} */
  const errors = []
  for (const url of urls) {
    try {
      return { bytes: await fetchBytes(url, options), url }
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)))
    }
  }
  const summary = errors.map((e) => `  - ${e.message}`).join('\n')
  throw new DownloadError(`all sources failed:\n${summary}`, { url: urls[0] ?? '', cause: errors[errors.length - 1] })
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Results keep the input order; the first
 * rejection aborts the pool (remaining items are not started) and is rethrown.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function runPool(items, limit, worker) {
  const size = Math.max(1, Math.min(limit, items.length))
  /** @type {R[]} */
  const results = new Array(items.length)
  let next = 0
  let failed = false
  const lanes = Array.from({ length: size }, async () => {
    while (!failed) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await worker(/** @type {T} */ (items[index]), index)
      } catch (err) {
        failed = true
        throw err
      }
    }
  })
  await Promise.all(lanes)
  return results
}

/**
 * Human-readable size: 999 B, 12.3 KB, 4.9 MB.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '? B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** @param {unknown} err */
function describe(err) {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'timeout'
    const cause = /** @type {{ cause?: { code?: string, message?: string } }} */ (err).cause
    if (cause && typeof cause === 'object' && (cause.code || cause.message)) return `${err.message}: ${cause.code ?? cause.message}`
    return err.message
  }
  return String(err)
}
