import { describe, expect, it, vi } from 'vitest'
import { fakeResponse } from './fakes.test'
import { makeConfig } from './fakes.test'
import {
  BRAVE_URL,
  DDG_HTML_URL,
  DDG_LITE_URL,
  formatSearchResults,
  isDuckDuckGoBlocked,
  NO_BRAVE_KEY_MESSAGE,
  parseBraveResponse,
  parseDuckDuckGoHtml,
  resolveDuckDuckGoUrl,
  SEARCH_BLOCKED_MESSAGE,
  searchWeb,
  stripTags,
} from './webSearch'

const DDG_HTML = `<html><body><div id="links">
<div class="result results_links results_links_deep web-result result--ad">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=bing&u3=https%3A%2F%2Fads.example">Anzeige</a></h2>
  <a class="result__snippet">Werbung</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fde.wikipedia.org%2Fwiki%2FElectron&amp;rd=1">Electron – Wikipedia</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fde.wikipedia.org%2Fwiki%2FElectron">Electron ist ein <b>Framework</b>
    für Desktop-Apps.</a>
</div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2F&amp;rd=1">Electron</a></h2>
  <a class="result__snippet">Build cross-platform desktop apps.</a>
</div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.electronjs.org%2F">Duplicate</a></div>
</div></body></html>`

const DDG_LITE = `<html><body><table>
<tr><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rd=1" class='result-link'>Example A</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Snippet for A</td></tr>
<tr><td valign="top">2.&nbsp;</td><td><a rel="nofollow" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fb" class='result-link'>Example B</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>Snippet for B</td></tr>
</table></body></html>`

describe('resolveDuckDuckGoUrl', () => {
  it('decodes the uddg redirect and protocol-relative links', () => {
    expect(resolveDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx%3Fa%3D1&rd=1')).toBe('https://example.com/x?a=1')
    expect(resolveDuckDuckGoUrl('/l/?uddg=https%3A%2F%2Fexample.com')).toBe('https://example.com')
    expect(resolveDuckDuckGoUrl('//example.com/y')).toBe('https://example.com/y')
    expect(resolveDuckDuckGoUrl('https://plain.example')).toBe('https://plain.example')
  })
})

describe('parseDuckDuckGoHtml', () => {
  it('parses the html endpoint, skips ads and duplicates', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML)
    expect(results).toEqual([
      { title: 'Electron – Wikipedia', url: 'https://de.wikipedia.org/wiki/Electron', snippet: 'Electron ist ein Framework für Desktop-Apps.' },
      { title: 'Electron', url: 'https://www.electronjs.org/', snippet: 'Build cross-platform desktop apps.' },
    ])
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1)
  })

  it('parses the lite endpoint', () => {
    expect(parseDuckDuckGoHtml(DDG_LITE)).toEqual([
      { title: 'Example A', url: 'https://example.com/a', snippet: 'Snippet for A' },
      { title: 'Example B', url: 'https://example.com/b', snippet: 'Snippet for B' },
    ])
  })

  it('returns nothing for unrelated markup', () => {
    expect(parseDuckDuckGoHtml('<html><body><p>nothing</p></body></html>')).toEqual([])
  })
})

describe('isDuckDuckGoBlocked', () => {
  it('detects status codes and challenge markup', () => {
    expect(isDuckDuckGoBlocked(202, '<html>')).toBe(true)
    expect(isDuckDuckGoBlocked(200, '<script src="/anomaly.js"></script>')).toBe(true)
    expect(isDuckDuckGoBlocked(200, DDG_HTML)).toBe(false)
  })
})

describe('parseBraveResponse', () => {
  it('maps web.results and strips markup', () => {
    const json = {
      query: { original: 'x' },
      web: {
        results: [
          { title: 'A <strong>Title</strong>', url: 'https://a.example', description: 'desc &amp; <strong>more</strong>' },
          { title: 'no url', url: 'ftp://x' },
          null,
          { title: 'B', url: 'https://b.example' },
        ],
      },
    }
    expect(parseBraveResponse(json)).toEqual([
      { title: 'A Title', url: 'https://a.example', snippet: 'desc & more' },
      { title: 'B', url: 'https://b.example', snippet: '' },
    ])
    expect(parseBraveResponse({})).toEqual([])
    expect(parseBraveResponse(null)).toEqual([])
    expect(stripTags('<b>x</b> &lt;y&gt;')).toBe('x <y>')
  })
})

describe('formatSearchResults', () => {
  it('numbers results and handles the empty case', () => {
    expect(formatSearchResults([], 'q')).toBe('Keine Treffer für "q".')
    expect(formatSearchResults([{ title: 'T', url: 'https://u', snippet: 'S' }], 'q')).toBe('1 Treffer für "q":\n1. T\n   https://u\n   S')
  })
})

describe('searchWeb', () => {
  it('queries DuckDuckGo with a browser UA and parses results', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(DDG_HTML))
    const results = await searchWeb('electron framework', 5, makeConfig().web, { fetchFn })
    expect(results).toHaveLength(2)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DDG_HTML_URL}?q=electron%20framework`)
    expect((init.headers as Record<string, string>)['User-Agent']).toContain('Mozilla/5.0')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to the lite endpoint on a network error', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(fakeResponse(DDG_LITE))
    const results = await searchWeb('x', 5, makeConfig().web, { fetchFn })
    expect(results.map((r) => r.url)).toEqual(['https://example.com/a', 'https://example.com/b'])
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(`${DDG_LITE_URL}?q=x`)
  })

  it('reports CAPTCHA/202 as a readable blocked error', async () => {
    const fetchFn = vi.fn(async () => fakeResponse('<html>anomaly-modal</html>', { status: 202 }))
    await expect(searchWeb('x', 5, makeConfig().web, { fetchFn })).rejects.toThrow(SEARCH_BLOCKED_MESSAGE)
  })

  it('uses the Brave API with the subscription header', async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b.example', description: 'd' }] } }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    const config = makeConfig({ web: { searchProvider: 'brave', braveApiKey: 'key123' } }).web
    const results = await searchWeb('hello world', 3, config, { fetchFn })
    expect(results).toEqual([{ title: 'B', url: 'https://b.example', snippet: 'd' }])
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BRAVE_URL}?q=hello%20world&count=3`)
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('key123')
  })

  it('explains a missing or rejected Brave key', async () => {
    const config = makeConfig({ web: { searchProvider: 'brave', braveApiKey: '' } }).web
    const fetchFn = vi.fn(async () => fakeResponse('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
    await expect(searchWeb('x', 3, config, { fetchFn })).rejects.toThrow(NO_BRAVE_KEY_MESSAGE)
    expect(fetchFn).not.toHaveBeenCalled()
    const withKey = makeConfig({ web: { searchProvider: 'brave', braveApiKey: 'bad' } }).web
    await expect(searchWeb('x', 3, withKey, { fetchFn })).rejects.toThrow('API-Key ungültig')
  })
})
