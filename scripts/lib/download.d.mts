export class DownloadError extends Error {
  constructor(message: string, info: { url: string; status?: number; cause?: unknown })
  readonly url: string
  readonly status: number | undefined
}

export interface FetchOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export function isRetryableStatus(status: number): boolean
export function fetchBytes(url: string, options?: FetchOptions): Promise<Uint8Array>
export function fetchWithFallback(urls: string[], options?: FetchOptions): Promise<{ bytes: Uint8Array; url: string }>
export function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]>
export function formatBytes(bytes: number): string
