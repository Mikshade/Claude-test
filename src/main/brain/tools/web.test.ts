import { describe, expect, it, vi } from 'vitest'
import { fakeContext, fakeResponse, fakeServices, runTool, textOf, toolByName } from './fakes.test'
import { classifyBody, decodeBody, detectCharset, fetchPage, MAX_BODY_BYTES, readBodyCapped, webTools } from './web'

const ARTICLE = `<html><head><title>Test Article</title></head><body><article>${'<p>Ein langer Absatz mit genug Text, damit Readability ihn als Artikel erkennt und nicht verwirft. </p>'.repeat(8)}</article></body></html>`

describe('charset handling', () => {
  it('prefers the header, then meta tags, then utf-8', () => {
    expect(detectCharset('text/html; charset=ISO-8859-15', new Uint8Array())).toBe('iso-8859-15')
    expect(detectCharset('text/html', new TextEncoder().encode('<html><head><meta charset="windows-1252">'))).toBe('windows-1252')
    expect(detectCharset('text/html', new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=utf-16">'))).toBe('utf-16')
    expect(detectCharset('', new TextEncoder().encode('<?xml version="1.0" encoding="latin1"?>'))).toBe('latin1')
    expect(detectCharset('application/json', new Uint8Array())).toBe('utf-8')
  })

  it('decodes with the charset and falls back to utf-8 for unknown labels', () => {
    expect(decodeBody(Buffer.from('Gr\xfc\xdfe', 'latin1'), 'windows-1252')).toBe('Grüße')
    expect(decodeBody(new TextEncoder().encode('ok'), 'no-such-charset')).toBe('ok')
  })
})

describe('classifyBody', () => {
  it('classifies by content type and sniffs when missing', () => {
    expect(classifyBody('text/html; charset=utf-8', '')).toBe('html')
    expect(classifyBody('application/json', '')).toBe('json')
    expect(classifyBody('application/ld+json', '')).toBe('json')
    expect(classifyBody('text/plain', '')).toBe('text')
    expect(classifyBody('application/pdf', '')).toBe('binary')
    expect(classifyBody('', '<!DOCTYPE html><html>')).toBe('html')
    expect(classifyBody('', '  {"a":1}')).toBe('json')
    expect(classifyBody('', 'hello')).toBe('text')
  })
})

describe('readBodyCapped', () => {
  it('caps streamed bodies', async () => {
    const big = new Uint8Array(1000).fill(65)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.subarray(0, 400))
        controller.enqueue(big.subarray(400, 800))
        controller.enqueue(big.subarray(800))
        controller.close()
      },
    })
    const result = await readBodyCapped(new Response(stream), 500)
    expect(result.truncated).toBe(true)
    expect(result.bytes.byteLength).toBe(500)
    const small = await readBodyCapped(new Response('abc'), 500)
    expect(small.truncated).toBe(false)
    expect(Buffer.from(small.bytes).toString()).toBe('abc')
    expect(MAX_BODY_BYTES).toBe(2 * 1024 * 1024)
  })
})

describe('fetchPage', () => {
  it('sends browser-like headers and decodes the body', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(Buffer.from('<p>Gr\xfc\xdfe</p>', 'latin1'), { headers: { 'content-type': 'text/html; charset=windows-1252' }, url: 'https://final.example/' }))
    const page = await fetchPage('https://example.org', { fetchFn })
    expect(page.body).toBe('<p>Grüße</p>')
    expect(page.finalUrl).toBe('https://final.example/')
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe('follow')
    expect((init.headers as Record<string, string>)['Accept-Language']).toContain('de')
  })
})

describe('web_fetch', () => {
  const tool = (fetchFn: typeof fetch) => toolByName(webTools(fakeServices({ fetch: fetchFn })), 'web_fetch')

  it('extracts article text with a header', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(ARTICLE, { url: 'https://example.org/article' }))
    const result = await runTool(tool(fetchFn), { url: 'https://example.org/article' })
    expect(result.isError).toBeUndefined()
    const text = textOf(result.content)
    expect(text).toContain('Titel: Test Article')
    expect(text).toContain('URL: https://example.org/article')
    expect(text).toContain('Ein langer Absatz')
  })

  it('returns JSON and text responses as-is, capped by maxChars', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(JSON.stringify({ a: 'x'.repeat(5000) }), { headers: { 'content-type': 'application/json' } }))
    const result = await runTool(tool(fetchFn), { url: 'https://api.example/data', maxChars: 600 })
    const text = textOf(result.content)
    expect(text).toContain('{"a":"xxx')
    expect(text).toContain('…[gekürzt')
    expect(text.length).toBeLessThan(800)
  })

  it('never exceeds the configured page cap', async () => {
    const fetchFn = vi.fn(async () => fakeResponse('y'.repeat(50_000), { headers: { 'content-type': 'text/plain' } }))
    const ctx = fakeContext({ web: { maxPageChars: 2000 } })
    const result = await runTool(tool(fetchFn), { url: 'https://example.org/big', maxChars: 100_000 }, ctx)
    expect(textOf(result.content).length).toBeLessThan(2200)
  })

  it('reports HTTP errors, binary bodies and bad URLs', async () => {
    const notFound = vi.fn(async () => fakeResponse('<html><body>Seite nicht gefunden</body></html>', { status: 404, statusText: 'Not Found' }))
    const missing = await runTool(tool(notFound), { url: 'https://example.org/missing' })
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('HTTP 404')
    expect(missing.content).toContain('Seite nicht gefunden')

    const pdf = vi.fn(async () => fakeResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { 'content-type': 'application/pdf' } }))
    const binary = await runTool(tool(pdf), { url: 'https://example.org/x.pdf' })
    expect(binary.isError).toBe(true)
    expect(binary.content).toContain('application/pdf')

    const never = vi.fn<typeof fetch>()
    await expect(runTool(tool(never), { url: 'file:///etc/passwd' })).rejects.toThrow('Nur http(s)-URLs erlaubt')
    await expect(runTool(tool(never), { url: 'not a url' })).rejects.toThrow('Ungültige URL')
    expect(never).not.toHaveBeenCalled()
  })

  it('has a German summary and an untrusted-data note in the description', () => {
    const t = tool(vi.fn<typeof fetch>())
    expect(t.summarize?.({ url: 'https://example.org/path' })).toBe('Lade Webseite: https://example.org/path')
    expect(t.description).toMatch(/untrusted/i)
    expect(t.readOnly).toBe(true)
    expect(t.category).toBe('web')
  })
})

describe('web_search', () => {
  it('formats results and passes the provider config', async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(JSON.stringify({ web: { results: [{ title: 'R', url: 'https://r.example', description: 'd' }] } }), { headers: { 'content-type': 'application/json' } }),
    )
    const tool = toolByName(webTools(fakeServices({ fetch: fetchFn })), 'web_search')
    const ctx = fakeContext({ web: { searchProvider: 'brave', braveApiKey: 'k' } })
    const result = await runTool(tool, { query: 'r', count: 2 }, ctx)
    expect(textOf(result.content)).toBe('1 Treffer für "r":\n1. R\n   https://r.example\n   d')
    expect(tool.inputSchema.safeParse({ query: 'x', count: 9 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ query: '  ' }).success).toBe(false)
    expect(tool.summarize?.({ query: 'wetter berlin', count: 5 })).toBe('Websuche: wetter berlin')
  })
})
