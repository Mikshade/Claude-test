import { describe, expect, it } from 'vitest'
import { cleanForSpeech, lastEmotionIn, SentenceChunker, stripMarkers } from './text'

function feed(chunker: SentenceChunker, deltas: string[]): Array<{ text: string; emotion: string }> {
  const out: Array<{ text: string; emotion: string }> = []
  for (const d of deltas) out.push(...chunker.push(d))
  out.push(...chunker.flush())
  return out
}

describe('SentenceChunker', () => {
  it('emits sentences at punctuation boundaries', () => {
    const c = new SentenceChunker({ minChars: 1 })
    const out = feed(c, ['Hallo! Wie geht ', 'es dir heute? Ich bin ', 'bereit.'])
    expect(out.map((s) => s.text)).toEqual(['Hallo!', 'Wie geht es dir heute?', 'Ich bin bereit.'])
  })

  it('waits for enough characters before splitting on a period (avoids "Dr." micro-chunks)', () => {
    const c = new SentenceChunker({ minChars: 12 })
    const out = feed(c, ['Dr. Müller ist da.'])
    expect(out.map((s) => s.text)).toEqual(['Dr. Müller ist da.'])
  })

  it('switches emotion on [[marker]] and strips it from the text', () => {
    const c = new SentenceChunker({ minChars: 1 })
    const out = feed(c, ['[[happy]] Super, das klappt! [[sad]]Leider nicht ', 'alles. Egal.'])
    expect(out).toEqual([
      { text: 'Super, das klappt!', emotion: 'happy' },
      { text: 'Leider nicht alles.', emotion: 'sad' },
      { text: 'Egal.', emotion: 'sad' },
    ])
  })

  it('does not split a marker that arrives in two deltas', () => {
    const c = new SentenceChunker({ minChars: 1 })
    const out = feed(c, ['Okay. [[sur', 'prised]] Was?!'])
    expect(out).toEqual([
      { text: 'Okay.', emotion: 'neutral' },
      { text: 'Was?!', emotion: 'surprised' },
    ])
  })

  it('ignores unknown markers but still strips them', () => {
    const c = new SentenceChunker({ minChars: 1 })
    const out = feed(c, ['[[banana]] Hallo.'])
    expect(out).toEqual([{ text: 'Hallo.', emotion: 'neutral' }])
  })

  it('splits very long sentences at a word boundary', () => {
    const c = new SentenceChunker({ maxChars: 40, minChars: 1 })
    const long = 'wort '.repeat(20).trim()
    const out = feed(c, [long])
    expect(out.length).toBeGreaterThan(1)
    for (const s of out) expect(s.text.length).toBeLessThanOrEqual(40)
    expect(out.map((s) => s.text).join(' ')).toBe(long)
  })

  it('flushes trailing text without punctuation', () => {
    const c = new SentenceChunker()
    const out = feed(c, ['Das ist das Ende ohne Punkt'])
    expect(out.map((s) => s.text)).toEqual(['Das ist das Ende ohne Punkt'])
  })

  it('handles streaming one character at a time', () => {
    const c = new SentenceChunker({ minChars: 1 })
    const text = 'Eins. Zwei! [[happy]] Drei?'
    const out = feed(c, text.split(''))
    expect(out).toEqual([
      { text: 'Eins.', emotion: 'neutral' },
      { text: 'Zwei!', emotion: 'neutral' },
      { text: 'Drei?', emotion: 'happy' },
    ])
  })

  it('reset clears the buffer and emotion', () => {
    const c = new SentenceChunker({ minChars: 1 })
    c.push('[[angry]] Grr')
    c.reset()
    expect(c.emotion).toBe('neutral')
    expect(c.flush()).toEqual([])
  })
})

describe('helpers', () => {
  it('stripMarkers removes all markers', () => {
    expect(stripMarkers('a [[happy]] b [[ sad ]] c')).toBe('a  b  c')
  })
  it('lastEmotionIn finds the last valid marker', () => {
    expect(lastEmotionIn('[[happy]] x [[nope]] y [[shy]]')).toBe('shy')
    expect(lastEmotionIn('nothing')).toBeNull()
  })
  it('cleanForSpeech removes markdown noise', () => {
    expect(cleanForSpeech('**Fett** und `code` und [Link](https://x.y) https://a.b/c')).toBe('Fett und code und Link Link')
    expect(cleanForSpeech('```js\nlet a = 1\n```\nFertig.')).toBe('(Code) Fertig.')
  })
})
