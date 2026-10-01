/**
 * Web search providers: DuckDuckGo HTML scraping (zero-config, best effort) and the Brave Search API.
 */
import type { WebConfig } from '@shared/config'
import { createLogger } from '../../log'
import { type MiniDocument, parseDocument } from './webExtract'

const log = createLogger('tools:search')

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchOptions {
  fetchFn: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export const SEARCH_BLOCKED_MESSAGE = 'Suche vorübergehend blockiert – Brave Search API-Key in den Einstellungen hinterlegen'
export const NO_BRAVE_KEY_MESSAGE = 'Kein Brave Search API-Key konfiguriert – in den Einstellungen hinterlegen oder DuckDuckGo wählen.'
export const DEFAULT_SEARCH_TIMEOUT_MS = 10_000
export const MAX_SEARCH_RESULTS = 8
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
export const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'
export const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'
export const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'

/** DuckDuckGo wraps targets in `//duckduckgo.com/l/?uddg=<encoded url>&rd=1`. */
export function resolveDuckDuckGoUrl(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href)
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }
  if (href.startsWith('//')) return `https:${href}`
  return href
}

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

export function stripTags(html: string): string {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return clean(text)
}

function isAdUrl(url: string): boolean {
  return /duckduckgo\.com\/y\.js|ad_provider=|bing\.com\/aclick/i.test(url)
}

/** Parses both the html.duckduckgo.com and the lite.duckduckgo.com markup (tolerant of changes). */
export function parseDuckDuckGoHtml(html: string, max = MAX_SEARCH_RESULTS): SearchResult[] {
  const out: SearchResult[] = []
  const seen = new Set<string>()
  const push = (title: string, href: string, snippet: string): void => {
    const url = resolveDuckDuckGoUrl(href)
    if (!/^https?:\/\//i.test(url) || isAdUrl(url) || seen.has(url) || !title) return
    seen.add(url)
    out.push({ title, url, snippet })
  }
  let document: MiniDocument
  try {
    document = parseDocument(html)
  } catch {
    return out
  }
  // html.duckduckgo.com: <div class="result"> … <a class="result__a" href> … <a class="result__snippet">
  for (const anchor of Array.from(document.querySelectorAll('a.result__a'))) {
    const container = anchor.closest('.result')
    if (container?.classList.contains('result--ad')) continue
    push(clean(anchor.textContent), anchor.getAttribute('href') ?? '', clean(container?.querySelector('.result__snippet')?.textContent))
    if (out.length >= max) return out
  }
  // lite.duckduckgo.com: table rows with <a class="result-link"> and <td class="result-snippet">
  for (const anchor of Array.from(document.querySelectorAll('a.result-link'))) {
    const row = anchor.closest('tr')
    const snippetRow = row?.nextElementSibling
    const snippet = clean(snippetRow?.querySelector('.result-snippet')?.textContent ?? row?.querySelector('.result-snippet')?.textContent)
    push(clean(anchor.textContent), anchor.getAttribute('href') ?? '', snippet)
    if (out.length >= max) return out
  }
  // Last resort: any redirect link.
  if (out.length === 0) {
    for (const anchor of Array.from(document.querySelectorAll('a[href*="uddg="]'))) {
      push(clean(anchor.textContent), anchor.getAttribute('href') ?? '', '')
      if (out.length >= max) break
    }
  }
  return out
}

export function isDuckDuckGoBlocked(status: number, html: string): boolean {
  if (status === 202 || status === 403 || status === 429 || status === 503) return true
  return /anomaly\.js|anomaly-modal|g-recaptcha|cf-challenge|challenge-platform/i.test(html)
}

/** Brave: `{ web: { results: [{ title, url, description }] } }` (description may contain <strong> markup). */
export function parseBraveResponse(json: unknown, max = MAX_SEARCH_RESULTS): SearchResult[] {
  const results = (json as { web?: { results?: unknown } } | null)?.web?.results
  if (!Array.isArray(results)) return []
  const out: SearchResult[] = []
  for (const item of results) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = typeof record['title'] === 'string' ? stripTags(record['title']) : ''
    const url = typeof record['url'] === 'string' ? record['url'] : ''
    const description = typeof record['description'] === 'string' ? stripTags(record['description']) : ''
    if (!title || !/^https?:\/\//i.test(url)) continue
    out.push({ title, url, snippet: description })
    if (out.length >= max) break
  }
  return out
}

export function formatSearchResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `Keine Treffer für "${query}".`
  const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
  return [`${results.length} Treffer für "${query}":`, ...lines].join('\n')
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return typeof any === 'function' ? any([timeout, signal]) : timeout
}

async function fetchDuckDuckGo(base: string, query: string, options: SearchOptions): Promise<{ status: number; html: string }> {
  const url = `${base}?q=${encodeURIComponent(query)}`
  const res = await options.fetchFn(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: combinedSignal(options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS, options.signal),
  })
  return { status: res.status, html: await res.text() }
}

export async function searchDuckDuckGo(query: string, count: number, options: SearchOptions): Promise<SearchResult[]> {
  let response: { status: number; html: string }
  try {
    response = await fetchDuckDuckGo(DDG_HTML_URL, query, options)
  } catch (err) {
    log.warn('html.duckduckgo.com failed – trying lite', err instanceof Error ? err.message : err)
    response = await fetchDuckDuckGo(DDG_LITE_URL, query, options)
  }
  if (isDuckDuckGoBlocked(response.status, response.html)) throw new Error(SEARCH_BLOCKED_MESSAGE)
  if (response.status >= 400) throw new Error(`DuckDuckGo antwortet mit HTTP ${response.status}.`)
  const results = parseDuckDuckGoHtml(response.html, count)
  if (results.length === 0 && response.html.length < 2000) throw new Error(SEARCH_BLOCKED_MESSAGE)
  return results
}

export async function searchBrave(query: string, count: number, apiKey: string, options: SearchOptions): Promise<SearchResult[]> {
  if (!apiKey.trim()) throw new Error(NO_BRAVE_KEY_MESSAGE)
  const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${Math.min(20, Math.max(1, count))}`
  const res = await options.fetchFn(url, {
    headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey.trim() },
    signal: combinedSignal(options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS, options.signal),
  })
  if (res.status === 401 || res.status === 403) throw new Error('Brave Search: API-Key ungültig oder abgelehnt.')
  if (res.status === 429) throw new Error('Brave Search: Rate-Limit erreicht – später erneut versuchen.')
  if (!res.ok) throw new Error(`Brave Search antwortet mit HTTP ${res.status}.`)
  return parseBraveResponse(await res.json(), count)
}

/** Provider dispatch by config; throws Errors with readable German messages. */
export async function searchWeb(query: string, count: number, config: WebConfig, options: SearchOptions): Promise<SearchResult[]> {
  const n = Math.min(MAX_SEARCH_RESULTS, Math.max(1, count))
  if (config.searchProvider === 'brave') return searchBrave(query, n, config.braveApiKey, options)
  return searchDuckDuckGo(query, n, options)
}
