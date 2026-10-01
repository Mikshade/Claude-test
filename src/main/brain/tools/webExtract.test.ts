import { describe, expect, it } from 'vitest'
import { cleanWhitespace, extractReadableText, htmlToPlainText, MIN_ARTICLE_CHARS, parseDocument } from './webExtract'

const paragraph =
  'Die Stadtwerke haben heute angekündigt, dass die Fernwärmepreise zum Jahreswechsel um durchschnittlich vier Prozent ' +
  'sinken werden. Grund dafür seien gesunkene Beschaffungskosten und ein neuer Liefervertrag mit dem regionalen Netzbetreiber. '

const ARTICLE_HTML = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Fernwärme wird günstiger – Beispielzeitung</title>
<meta property="og:site_name" content="Beispielzeitung"><meta name="author" content="Anna Muster"></head>
<body>
<nav><a href="/">Start</a> <a href="/politik">Politik</a> <a href="/sport">Sport</a></nav>
<header><h1>Fernwärme wird günstiger</h1><p class="byline">Von Anna Muster</p></header>
<article>
  <p>${paragraph}</p>
  <p>${paragraph}</p>
  <p>${paragraph}</p>
  <p>Kunden   müssen nichts tun: Die Anpassung erfolgt automatisch mit der nächsten Abrechnung.</p>
</article>
<aside>Meistgelesen: <a href="/x">Zehn Tipps für den Winter</a></aside>
<footer>© 2026 Beispielzeitung · <a href="/impressum">Impressum</a></footer>
<script>window.dataLayer = []</script>
</body></html>`

const PLAIN_HTML = `<html><head><title>Login</title><style>body{color:red}</style></head>
<body><nav>Menü</nav><h1>Anmelden</h1><form><label>Benutzername</label><input><label>Passwort</label><input type="password"></form>
<p>Noch kein Konto? <a href="/register">Registrieren</a></p><img src="x.png" alt="logo"><script>alert(1)</script></body></html>`

describe('cleanWhitespace', () => {
  it('collapses spaces, trims lines and limits blank lines', () => {
    expect(cleanWhitespace('  a \t b c  \r\n\r\n\r\n\r\n  d  ')).toBe('a b c\n\nd')
  })
})

describe('extractReadableText', () => {
  it('uses Readability for articles', () => {
    const page = extractReadableText(ARTICLE_HTML, 'https://example.org/a')
    expect(page.method).toBe('readability')
    expect(page.title).toContain('Fernwärme wird günstiger')
    expect(page.text).toContain('Stadtwerke haben heute angekündigt')
    expect(page.text).toContain('Kunden müssen nichts tun')
    expect(page.text).not.toContain('Impressum')
    expect(page.text).not.toContain('dataLayer')
    expect(page.text.length).toBeGreaterThan(MIN_ARTICLE_CHARS)
    expect(page.byline ?? page.siteName ?? '').toMatch(/Anna Muster|Beispielzeitung/)
  })

  it('falls back to html-to-text for non-article pages and keeps the title', () => {
    const page = extractReadableText(PLAIN_HTML)
    expect(page.method).toBe('html-to-text')
    expect(page.title).toBe('Login')
    expect(page.text).toContain('Anmelden')
    expect(page.text).toContain('Benutzername')
    expect(page.text).toContain('Registrieren')
    expect(page.text).not.toContain('/register')
    expect(page.text).not.toContain('alert(1)')
    expect(page.text).not.toContain('color:red')
  })

  it('survives garbage input', () => {
    expect(extractReadableText('')).toEqual({ title: '', text: '', method: 'html-to-text' })
    const page = extractReadableText('<<<>>> not html at all')
    expect(page.method).toBe('html-to-text')
    expect(page.text).toContain('not html at all')
  })

  it('htmlToPlainText drops navigation and scripts', () => {
    expect(htmlToPlainText('<nav>no</nav><p>yes <b>bold</b></p><script>x()</script>')).toBe('yes bold')
  })

  it('parseDocument exposes querySelector and title', () => {
    const doc = parseDocument('<html><head><title>T</title></head><body><a class="x" href="/y">link</a></body></html>')
    expect(doc.title).toBe('T')
    expect(doc.querySelector('a.x')?.getAttribute('href')).toBe('/y')
    expect(Array.from(doc.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['link'])
  })
})
