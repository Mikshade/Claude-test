import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNotesStore, DIGEST_MAX_CHARS, DIGEST_NOTES, MAX_NOTE_CHARS, MAX_NOTES, scoreNote, tokenize } from './notes'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `flowy-notes-${Math.random().toString(36).slice(2)}-`))
  file = path.join(dir, 'nested', 'memory.json')
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('tokenize', () => {
  it('lowercases, splits on non-letters and drops short tokens', () => {
    expect(tokenize('Hallo, Welt! Der Kaffee-Automat ist um 7 Uhr an.')).toEqual([
      'hallo',
      'welt',
      'der',
      'kaffee',
      'automat',
      'ist',
      'um',
      'uhr',
      'an',
    ])
    expect(tokenize('Größe ÄÖÜ façade')).toEqual(['größe', 'äöü', 'façade'])
    expect(tokenize('a b c')).toEqual([])
    expect(tokenize('')).toEqual([])
  })
})

describe('add / all / remove', () => {
  it('adds notes with ids, normalized tags and timestamps, oldest first', () => {
    const store = createNotesStore(file)
    const a = store.add('  Der User   trinkt Kaffee schwarz ', [' Essen ', 'essen', 'Gewohnheit'])
    const b = store.add('Projekt Flowy nutzt Electron')
    expect(a.id).toMatch(/^n/)
    expect(a.id).not.toBe(b.id)
    expect(a.text).toBe('Der User trinkt Kaffee schwarz')
    expect(a.tags).toEqual(['essen', 'gewohnheit'])
    expect(b.tags).toEqual([])
    expect(a.createdAt).toBeLessThanOrEqual(b.createdAt)
    expect(store.all().map((n) => n.id)).toEqual([a.id, b.id])
  })

  it('returns copies so callers cannot mutate the store', () => {
    const store = createNotesStore(file)
    const note = store.add('Katze heißt Mochi', ['tier'])
    note.text = 'x'
    note.tags.push('y')
    expect(store.all()[0]).toEqual({ ...note, text: 'Katze heißt Mochi', tags: ['tier'] })
  })

  it('rejects empty text and truncates very long text', () => {
    const store = createNotesStore(file)
    expect(() => store.add('   ')).toThrow(/empty/)
    const long = store.add('x'.repeat(MAX_NOTE_CHARS + 50))
    expect(long.text.length).toBe(MAX_NOTE_CHARS)
    expect(long.text.endsWith('…')).toBe(true)
  })

  it('refreshes an identical note instead of duplicating it', () => {
    const store = createNotesStore(file)
    const first = store.add('Lieblingsfarbe ist Blau', ['farbe'])
    store.add('Zweite Notiz')
    const again = store.add('lieblingsfarbe ist blau', ['user'])
    expect(store.all()).toHaveLength(2)
    expect(again.id).toBe(first.id)
    expect(again.tags).toEqual(['farbe', 'user'])
    // refreshed note is now the most recent one
    expect(store.all()[1]!.id).toBe(first.id)
  })

  it('removes by id', () => {
    const store = createNotesStore(file)
    const a = store.add('eins')
    const b = store.add('zwei')
    expect(store.remove(a.id)).toBe(true)
    expect(store.remove(a.id)).toBe(false)
    expect(store.remove('nope')).toBe(false)
    expect(store.all().map((n) => n.id)).toEqual([b.id])
  })
})

describe('search', () => {
  function seeded(): ReturnType<typeof createNotesStore> {
    const store = createNotesStore(file)
    store.add('Der User mag Kaffee ohne Zucker', ['essen'])
    store.add('Die Katze heißt Mochi', ['haustier'])
    store.add('Arbeitet an Flowy, einem Electron Projekt', ['projekt', 'arbeit'])
    store.add('Die Kaffeemaschine steht links in der Küche')
    return store
  }

  it('scores by the number of matching query tokens and returns only hits', () => {
    const store = seeded()
    const hits = store.search('Kaffee Zucker')
    expect(hits.map((n) => n.text)).toEqual([
      'Der User mag Kaffee ohne Zucker', // 2 hits
      'Die Kaffeemaschine steht links in der Küche', // 1 hit (substring kaffee)
    ])
    expect(store.search('Mochi')).toHaveLength(1)
    expect(store.search('Hund')).toEqual([])
    expect(store.search('')).toEqual([])
    expect(store.search('a')).toEqual([])
  })

  it('matches tags', () => {
    const store = seeded()
    expect(store.search('haustier').map((n) => n.text)).toEqual(['Die Katze heißt Mochi'])
    expect(store.search('arbeit')[0]!.text).toContain('Flowy')
  })

  it('prefers more recent notes on equal keyword hits', () => {
    const store = createNotesStore(file)
    store.add('Termin beim Zahnarzt am Montag')
    store.add('Termin beim Friseur am Freitag')
    const hits = store.search('Termin')
    expect(hits.map((n) => n.text)).toEqual(['Termin beim Friseur am Freitag', 'Termin beim Zahnarzt am Montag'])
  })

  it('respects the limit (default 10)', () => {
    const store = createNotesStore(file)
    for (let i = 0; i < 15; i++) store.add(`Notiz Nummer ${i} über Tee`)
    expect(store.search('tee')).toHaveLength(10)
    expect(store.search('tee', 3)).toHaveLength(3)
    expect(store.search('tee', 0)).toHaveLength(0)
  })

  it('scoreNote is case-insensitive and counts distinct query tokens', () => {
    const note = { id: 'x', text: 'Der Drucker im Büro heißt HP-Laser', tags: ['hardware'], createdAt: 0 }
    expect(scoreNote(note, ['drucker', 'büro', 'hardware', 'laser', 'nope'])).toBe(4)
    expect(scoreNote(note, [])).toBe(0)
  })
})

describe('digest', () => {
  it('lists the most recent notes, newest first, as "- text" lines', () => {
    const store = createNotesStore(file)
    expect(store.digest()).toBe('')
    for (let i = 1; i <= DIGEST_NOTES + 5; i++) store.add(`Notiz ${i}`)
    const lines = store.digest().split('\n')
    expect(lines).toHaveLength(DIGEST_NOTES)
    expect(lines[0]).toBe(`- Notiz ${DIGEST_NOTES + 5}`)
    expect(lines[DIGEST_NOTES - 1]).toBe('- Notiz 6')
  })

  it('caps the total length and truncates with an ellipsis', () => {
    const store = createNotesStore(file)
    for (let i = 0; i < 5; i++) store.add(`${String.fromCharCode(65 + i)} `.repeat(300))
    const digest = store.digest()
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
    expect(digest.endsWith('…')).toBe(true)
    expect(digest.split('\n').length).toBeLessThan(5)
    expect(digest.startsWith('- E E E')).toBe(true)
  })
})

describe('persistence', () => {
  it('writes atomically to disk (creating parent directories) and reloads', () => {
    const store = createNotesStore(file)
    const a = store.add('Erste Notiz', ['t1'])
    store.add('Zweite Notiz')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([])

    const reloaded = createNotesStore(file)
    expect(reloaded.all()).toEqual(store.all())
    expect(reloaded.all()[0]).toEqual(a)
    reloaded.remove(a.id)
    expect(createNotesStore(file).all().map((n) => n.text)).toEqual(['Zweite Notiz'])
  })

  it('tolerates a missing, corrupt or malformed file', () => {
    expect(createNotesStore(file).all()).toEqual([])

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json', 'utf8')
    const corrupt = createNotesStore(file)
    expect(corrupt.all()).toEqual([])
    corrupt.add('nach Korruption')
    expect(createNotesStore(file).all().map((n) => n.text)).toEqual(['nach Korruption'])

    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        notes: [
          { id: 'ok1', text: 'gültig', tags: ['a', 7, ''], createdAt: 10 },
          { id: 'ok1', text: 'doppelte id', createdAt: 11 },
          { id: '', text: 'keine id' },
          { id: 'bad', text: '' },
          'junk',
          null,
          { id: 'ok2', text: 'ohne Zeitstempel' },
        ],
      }),
      'utf8',
    )
    const tolerant = createNotesStore(file)
    expect(tolerant.all()).toEqual([
      { id: 'ok2', text: 'ohne Zeitstempel', tags: [], createdAt: 0 },
      { id: 'ok1', text: 'gültig', tags: ['a'], createdAt: 10 },
    ])

    fs.writeFileSync(file, JSON.stringify([{ id: 'bare', text: 'bare array', createdAt: 1 }]), 'utf8')
    expect(createNotesStore(file).all().map((n) => n.id)).toEqual(['bare'])
  })

  it('keeps at most MAX_NOTES notes, dropping the oldest', () => {
    const store = createNotesStore(file)
    for (let i = 0; i < MAX_NOTES + 3; i++) store.add(`Notiz ${i}`)
    const all = store.all()
    expect(all).toHaveLength(MAX_NOTES)
    expect(all[0]!.text).toBe('Notiz 3')
    expect(all[all.length - 1]!.text).toBe(`Notiz ${MAX_NOTES + 2}`)
    expect(createNotesStore(file).all()).toHaveLength(MAX_NOTES)
  })

  it('trims an oversized file on load', () => {
    const notes = Array.from({ length: MAX_NOTES + 10 }, (_, i) => ({ id: `id${i}`, text: `n${i}`, tags: [], createdAt: i }))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, notes }), 'utf8')
    const store = createNotesStore(file)
    expect(store.all()).toHaveLength(MAX_NOTES)
    expect(store.all()[0]!.id).toBe('id10')
  })

  it('survives an unwritable location without throwing', () => {
    const blocked = path.join(dir, 'file-not-dir')
    fs.writeFileSync(blocked, 'x', 'utf8')
    const store = createNotesStore(path.join(blocked, 'memory.json'))
    expect(() => store.add('geht nicht auf Platte')).not.toThrow()
    expect(store.all()).toHaveLength(1)
  })
})
