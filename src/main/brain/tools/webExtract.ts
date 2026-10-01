/**
 * Readable-text extraction for web_fetch: linkedom + Mozilla Readability for articles, html-to-text as
 * the fallback for pages Readability cannot handle (apps, listings, short pages).
 */
import { Readability } from '@mozilla/readability'
import { convert } from 'html-to-text'
import { parseHTML } from 'linkedom'

export interface ExtractedPage {
  title: string
  text: string
  byline?: string
  siteName?: string
  excerpt?: string
  method: 'readability' | 'html-to-text'
}

/** The slice of the DOM we use (the main tsconfig has no DOM lib; linkedom is typed loosely). */
export interface MiniElement {
  textContent: string | null
  getAttribute(name: string): string | null
  querySelector(selector: string): MiniElement | null
  querySelectorAll(selector: string): ArrayLike<MiniElement> & Iterable<MiniElement>
  closest(selector: string): MiniElement | null
  classList: { contains(name: string): boolean }
  nextElementSibling: MiniElement | null
}

export interface MiniDocument extends MiniElement {
  title: string
}

/** Parse HTML with linkedom into a document (throws on grossly invalid input only). */
export function parseDocument(html: string): MiniDocument {
  return (parseHTML(html) as unknown as { document: MiniDocument }).document
}

/** Readability results shorter than this fall back to the plain conversion. */
export const MIN_ARTICLE_CHARS = 200

/** Collapse runs of spaces, trim lines, at most one blank line in a row. */
export function cleanWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ​]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plain-text conversion that skips navigation, scripts, images and link targets. */
export function htmlToPlainText(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    preserveNewlines: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'svg', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'header', format: 'skip' },
      { selector: 'footer', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'noscript', format: 'skip' },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
      { selector: 'h5', options: { uppercase: false } },
      { selector: 'h6', options: { uppercase: false } },
      { selector: 'table', format: 'dataTable' },
    ],
  })
  return cleanWhitespace(text)
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function titleOf(document: MiniDocument): string {
  const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
  const title = nonEmpty(document.title) ?? nonEmpty(og) ?? nonEmpty(document.querySelector('h1')?.textContent)
  return cleanWhitespace(title ?? '')
}

type ReadabilityDocument = ConstructorParameters<typeof Readability>[0]

/**
 * Extract the readable text of an HTML page. Readability wins when it finds an article of at least
 * MIN_ARTICLE_CHARS characters; otherwise the whole page is converted with html-to-text.
 */
export function extractReadableText(html: string, _url?: string): ExtractedPage {
  let document: MiniDocument | null = null
  let title = ''
  try {
    document = parseDocument(html)
    title = titleOf(document)
  } catch {
    document = null
  }
  if (document) {
    try {
      const article = new Readability(document as unknown as ReadabilityDocument, { charThreshold: MIN_ARTICLE_CHARS }).parse()
      const text = cleanWhitespace(article?.textContent ?? '')
      if (article && text.length >= MIN_ARTICLE_CHARS) {
        const out: ExtractedPage = { title: cleanWhitespace(article.title ?? '') || title, text, method: 'readability' }
        const byline = nonEmpty(article.byline)
        const siteName = nonEmpty(article.siteName)
        const excerpt = nonEmpty(article.excerpt)
        if (byline) out.byline = cleanWhitespace(byline)
        if (siteName) out.siteName = cleanWhitespace(siteName)
        if (excerpt) out.excerpt = cleanWhitespace(excerpt)
        return out
      }
    } catch {
      /* fall through to html-to-text */
    }
  }
  let text = ''
  try {
    text = htmlToPlainText(html)
  } catch {
    text = cleanWhitespace(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '))
  }
  return { title, text, method: 'html-to-text' }
}
