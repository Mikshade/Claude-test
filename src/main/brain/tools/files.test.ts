import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shell } from 'electron'
import { fakeContext, fakeServices, runTool, textOf, toolByName } from './fakes.test'
import {
  fileTools,
  formatEntry,
  globToRegExp,
  isProbablyBinary,
  listDirectory,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  normalizePath,
  readFileSlice,
  searchFiles,
  shouldSkipDir,
  sortEntries,
} from './files'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-files-'))
  ;(shell as unknown as { _reset(): void })._reset()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const write = (rel: string, content: string | Buffer): string => {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

describe('normalizePath', () => {
  const home = '/home/max'
  it('rejects empty and device paths', () => {
    expect(() => normalizePath('   ')).toThrow('Pfad ist leer.')
    expect(() => normalizePath('\\\\?\\C:\\x', { pathImpl: path.win32, home: 'C:\\Users\\max' })).toThrow('Gerätepfade')
  })

  it('expands ~ and resolves relative paths against home', () => {
    expect(normalizePath('~', { home, pathImpl: path.posix })).toBe('/home/max')
    expect(normalizePath('~/Desktop/a.txt', { home, pathImpl: path.posix })).toBe('/home/max/Desktop/a.txt')
    expect(normalizePath('notes/x.md', { home, pathImpl: path.posix })).toBe('/home/max/notes/x.md')
    expect(normalizePath('"/tmp/quoted"', { home, pathImpl: path.posix })).toBe('/tmp/quoted')
  })

  it('handles Windows paths, %VAR% and $env:VAR', () => {
    const win = { home: 'C:\\Users\\max', pathImpl: path.win32, env: { USERPROFILE: 'C:\\Users\\max', TEMP: 'C:\\Temp' } }
    expect(normalizePath('C:/Users/max/../max/a.txt', win)).toBe('C:\\Users\\max\\a.txt')
    expect(normalizePath('%USERPROFILE%\\Desktop', win)).toBe('C:\\Users\\max\\Desktop')
    expect(normalizePath('$env:TEMP\\x', win)).toBe('C:\\Temp\\x')
    expect(normalizePath('~\\Documents', win)).toBe('C:\\Users\\max\\Documents')
    expect(normalizePath('Downloads', win)).toBe('C:\\Users\\max\\Downloads')
  })
})

describe('globToRegExp', () => {
  it('matches basenames at any depth when there is no slash', () => {
    const re = globToRegExp('*.ts')
    expect(re.test('a.ts')).toBe(true)
    expect(re.test('src/deep/b.TS')).toBe(true)
    expect(re.test('a.tsx')).toBe(false)
  })

  it('supports **, ?, braces and classes', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('lib/a.ts')).toBe(false)
    expect(globToRegExp('report*.{docx,xlsx}').test('docs/report-2026.xlsx')).toBe(true)
    expect(globToRegExp('report*.{docx,xlsx}').test('report.pdf')).toBe(false)
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true)
    expect(globToRegExp('file?.txt').test('file10.txt')).toBe(false)
    expect(globToRegExp('[ab].txt').test('a.txt')).toBe(true)
    expect(globToRegExp('[ab].txt').test('c.txt')).toBe(false)
    expect(globToRegExp('**').test('anything/at/all')).toBe(true)
    expect(globToRegExp('').test('x/y')).toBe(true)
  })
})

describe('small helpers', () => {
  it('detects binary content by NUL bytes', () => {
    expect(isProbablyBinary(Buffer.from('hello'))).toBe(false)
    expect(isProbablyBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBe(true)
  })

  it('sorts directories first, then names case-insensitively and numerically', () => {
    const sorted = sortEntries([
      { name: 'b.txt', type: 'file' as const },
      { name: 'Zeta', type: 'dir' as const },
      { name: 'alpha', type: 'dir' as const },
      { name: 'A.txt', type: 'file' as const },
      { name: 'file10', type: 'file' as const },
      { name: 'file2', type: 'file' as const },
    ])
    expect(sorted.map((e) => e.name)).toEqual(['alpha', 'Zeta', 'A.txt', 'b.txt', 'file2', 'file10'])
  })

  it('formats entries', () => {
    expect(formatEntry({ name: 'x.txt', type: 'file', size: 2048, mtime: new Date(2026, 0, 2, 3, 4) })).toBe('    2.0 KB  2026-01-02 03:04  x.txt')
    expect(formatEntry({ name: 'sub', type: 'dir', size: 0, mtime: null })).toContain('[DIR]')
  })

  it('skips caches and AppData\\Local only', () => {
    expect(shouldSkipDir('node_modules', '/x')).toBe(true)
    expect(shouldSkipDir('.git', '/x')).toBe(true)
    expect(shouldSkipDir('Local', 'C:\\Users\\max\\AppData')).toBe(true)
    expect(shouldSkipDir('Local', 'C:\\Users\\max\\AppData\\')).toBe(true)
    expect(shouldSkipDir('Roaming', 'C:\\Users\\max\\AppData')).toBe(false)
    expect(shouldSkipDir('Local', 'C:\\Projects')).toBe(false)
    expect(shouldSkipDir('src', '/x')).toBe(false)
  })
})

describe('readFileSlice', () => {
  it('returns the whole small file with line counts', async () => {
    const file = write('a.txt', 'one\ntwo\r\nthree')
    const slice = await readFileSlice(file)
    expect(slice).toMatchObject({ text: 'one\ntwo\nthree', startLine: 1, endLine: 3, totalLines: 3, hasMore: false, truncated: false, encoding: 'utf-8' })
  })

  it('supports offset and limit', async () => {
    const file = write('b.txt', Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'))
    const slice = await readFileSlice(file, { offset: 4, limit: 3 })
    expect(slice.text).toBe('line4\nline5\nline6')
    expect(slice).toMatchObject({ startLine: 4, endLine: 6, hasMore: true })
    expect(slice.totalLines).toBeUndefined()
    const tail = await readFileSlice(file, { offset: 9 })
    expect(tail.text).toBe('line9\nline10')
    expect(tail).toMatchObject({ startLine: 9, endLine: 10, totalLines: 10, hasMore: false })
    const beyond = await readFileSlice(file, { offset: 50 })
    expect(beyond).toMatchObject({ text: '', startLine: 0, endLine: 0, totalLines: 10 })
  })

  it('caps the output at MAX_READ_BYTES and points to the next offset', async () => {
    const line = 'x'.repeat(1000)
    const file = write('big.txt', Array.from({ length: 300 }, () => line).join('\n'))
    const slice = await readFileSlice(file)
    expect(slice.truncated).toBe(true)
    expect(slice.hasMore).toBe(true)
    expect(slice.text.length).toBeLessThanOrEqual(MAX_READ_BYTES)
    expect(slice.endLine).toBeLessThan(300)
    expect(slice.endLine).toBeGreaterThan(100)
  })

  it('strips a BOM, rejects binaries and falls back to windows-1252', async () => {
    const bom = write('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hallo')]))
    expect((await readFileSlice(bom)).text).toBe('hallo')
    const bin = write('bin.dat', Buffer.from([1, 2, 0, 4]))
    await expect(readFileSlice(bin)).rejects.toMatchObject({ code: 'EBINARY' })
    const latin = write('latin.txt', Buffer.from('Gr\xfc\xdfe', 'latin1'))
    const slice = await readFileSlice(latin)
    expect(slice.text).toBe('Grüße')
    expect(slice.encoding).toBe('windows-1252')
  })

  it('reports directories as EISDIR', async () => {
    await expect(readFileSlice(dir)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('listDirectory', () => {
  it('sorts, hides dotfiles and caps', async () => {
    write('b.txt', 'b')
    write('.hidden', 'h')
    write('sub/x', 'x')
    write('A.txt', 'a')
    const result = await listDirectory(dir, false)
    expect(result.entries.map((e) => e.name)).toEqual(['sub', 'A.txt', 'b.txt'])
    expect(result.hidden).toBe(1)
    expect(result.total).toBe(3)
    const all = await listDirectory(dir, true)
    expect(all.entries.map((e) => e.name)).toEqual(['sub', '.hidden', 'A.txt', 'b.txt'])
    expect(MAX_LIST_ENTRIES).toBe(500)
  })
})

describe('searchFiles', () => {
  beforeEach(() => {
    write('src/a.ts', 'export const a = 1\nconst needle = true\n')
    write('src/sub/b.ts', 'nothing here')
    write('src/c.txt', 'needle in txt')
    write('node_modules/x/d.ts', 'needle')
    write('AppData/Local/Temp/e.ts', 'needle')
    write('AppData/Roaming/f.ts', 'needle')
    write('.git/g.ts', 'needle')
  })

  it.each([true, false])('finds files by glob and skips caches (native glob: %s)', async (useGlob) => {
    const outcome = await searchFiles({ directory: dir, pattern: '**/*.ts', useGlob })
    const rel = outcome.matches.map((m) => path.relative(dir, m.path).split(path.sep).join('/')).sort()
    expect(rel).toEqual(['AppData/Roaming/f.ts', 'src/a.ts', 'src/sub/b.ts'])
    expect(outcome.limitReached).toBe(false)
    expect(outcome.timedOut).toBe(false)
  })

  it.each([true, false])('matches basenames without a slash and filters by content (native glob: %s)', async (useGlob) => {
    const outcome = await searchFiles({ directory: dir, pattern: '*.ts', contentRegex: /NEEDLE/i, useGlob })
    const rel = outcome.matches.map((m) => path.relative(dir, m.path).split(path.sep).join('/')).sort()
    expect(rel).toEqual(['AppData/Roaming/f.ts', 'src/a.ts'])
    const a = outcome.matches.find((m) => m.path.endsWith('a.ts'))!
    expect(a.line).toBe(2)
    expect(a.text).toBe('const needle = true')
  })

  it('stops at maxResults', async () => {
    const outcome = await searchFiles({ directory: dir, pattern: '**/*', maxResults: 2, useGlob: false })
    expect(outcome.matches).toHaveLength(2)
    expect(outcome.limitReached).toBe(true)
  })

  it('reports a timeout when the deadline has passed', async () => {
    const outcome = await searchFiles({ directory: dir, pattern: '**/*', timeoutMs: -1, useGlob: false })
    expect(outcome.timedOut).toBe(true)
  })
})

describe('file tools', () => {
  const tools = fileTools(fakeServices())

  it('read_file returns a header and content, rejects binaries', async () => {
    const file = write('r.txt', 'a\nb\nc')
    const result = await runTool(toolByName(tools, 'read_file'), { path: file, offset: 2 })
    expect(result.isError).toBeUndefined()
    expect(textOf(result.content)).toBe(`${file} (Zeilen 2–3 von 3, 5 B)\n---\nb\nc`)
    const bin = write('r.bin', Buffer.from([0, 1, 2]))
    const binary = await runTool(toolByName(tools, 'read_file'), { path: bin })
    expect(binary.isError).toBe(true)
    expect(binary.content).toContain('open_path')
    expect(toolByName(tools, 'read_file').inputSchema.safeParse({ path: '' }).success).toBe(false)
    expect(toolByName(tools, 'read_file').inputSchema.safeParse({ path: 'x', offset: 0 }).success).toBe(false)
  })

  it('read_file surfaces ENOENT through the gating error mapper', async () => {
    await expect(runTool(toolByName(tools, 'read_file'), { path: path.join(dir, 'missing.txt') })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('write_file creates parents, respects overwrite=false; append_file appends', async () => {
    const file = path.join(dir, 'deep', 'w.txt')
    const writeTool = toolByName(tools, 'write_file')
    const first = await runTool(writeTool, { path: file, content: 'hello\nworld' })
    expect(first.content).toBe(`Geschrieben: ${file} (11 B, 2 Zeilen)`)
    const refused = await runTool(writeTool, { path: file, content: 'x', overwrite: false })
    expect(refused.isError).toBe(true)
    await runTool(writeTool, { path: file, content: 'new' })
    expect(fs.readFileSync(file, 'utf8')).toBe('new')
    await runTool(toolByName(tools, 'append_file'), { path: file, content: '\nmore' })
    expect(fs.readFileSync(file, 'utf8')).toBe('new\nmore')
    expect(writeTool.confirmation?.({ path: file, content: 'c', overwrite: true })).toMatchObject({ title: 'Datei schreiben?', detail: file })
  })

  it('list_directory formats entries with a header', async () => {
    write('l/one.txt', '1')
    write('l/sub/two.txt', '2')
    const result = await runTool(toolByName(tools, 'list_directory'), { path: path.join(dir, 'l') })
    const lines = textOf(result.content).split('\n')
    expect(lines[0]).toBe(`${path.join(dir, 'l')} (2 Einträge)`)
    expect(lines[1]).toContain('[DIR]')
    expect(lines[1]).toContain(`sub${path.sep}`)
    expect(lines[2]).toContain('one.txt')
  })

  it('search_files validates the regex and formats results', async () => {
    write('s/a.md', 'alpha\nbeta')
    const tool = toolByName(tools, 'search_files')
    const bad = await runTool(tool, { directory: path.join(dir, 's'), contentRegex: '(' })
    expect(bad.isError).toBe(true)
    expect(bad.content).toContain('Ungültiger regulärer Ausdruck')
    const good = await runTool(tool, { directory: path.join(dir, 's'), pattern: '*.md', contentRegex: 'BETA' })
    expect(textOf(good.content)).toBe(`1 Treffer für "*.md" in ${path.join(dir, 's')}\n${path.join(dir, 's', 'a.md')}:2: beta`)
    const notDir = await runTool(tool, { directory: path.join(dir, 's', 'a.md') })
    expect(notDir.isError).toBe(true)
  })

  it('file_info describes files and folders', async () => {
    const file = write('i/info.txt', 'text')
    const info = await runTool(toolByName(tools, 'file_info'), { path: file })
    const text = textOf(info.content)
    expect(text).toContain('Typ: Datei')
    expect(text).toContain('Größe: 4 B (4 Bytes)')
    expect(text).toContain('Inhalt: Text')
    const folder = await runTool(toolByName(tools, 'file_info'), { path: path.join(dir, 'i') })
    expect(textOf(folder.content)).toContain('Typ: Ordner')
    expect(textOf(folder.content)).toContain('Einträge: 1')
  })

  it('move_path renames, moves into folders and guards existing targets', async () => {
    const src = write('m/src.txt', 's')
    fs.mkdirSync(path.join(dir, 'm', 'target'))
    const tool = toolByName(tools, 'move_path')
    const moved = await runTool(tool, { from: src, to: path.join(dir, 'm', 'target') })
    expect(moved.content).toBe(`Verschoben: ${src} → ${path.join(dir, 'm', 'target', 'src.txt')}`)
    const existing = write('m/exists.txt', 'e')
    const blocked = await runTool(tool, { from: path.join(dir, 'm', 'target', 'src.txt'), to: existing })
    expect(blocked.isError).toBe(true)
    const forced = await runTool(tool, { from: path.join(dir, 'm', 'target', 'src.txt'), to: existing, overwrite: true })
    expect(forced.isError).toBeUndefined()
    expect(fs.readFileSync(existing, 'utf8')).toBe('s')
  })

  it('delete_path uses the Recycle Bin and never deletes permanently', async () => {
    const file = write('d/del.txt', 'x')
    const mock = shell as unknown as { _trashed: string[]; _trashError: Error | null }
    const result = await runTool(toolByName(tools, 'delete_path'), { path: file })
    expect(result.content).toBe(`In den Papierkorb verschoben: ${file}`)
    expect(mock._trashed).toEqual([file])
    expect(fs.existsSync(file)).toBe(true) // the mock does not remove it; the tool must not either
    mock._trashError = new Error('no trash here')
    const failed = await runTool(toolByName(tools, 'delete_path'), { path: file })
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('no trash here')
    expect(fs.existsSync(file)).toBe(true)
    await expect(runTool(toolByName(tools, 'delete_path'), { path: path.join(dir, 'nope') })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('create_directory is idempotent', async () => {
    const target = path.join(dir, 'c', 'd', 'e')
    const tool = toolByName(tools, 'create_directory')
    expect((await runTool(tool, { path: target })).content).toBe(`Ordner erstellt: ${target}`)
    expect((await runTool(tool, { path: target })).content).toBe(`Ordner existiert bereits: ${target}`)
    const file = write('c/file', 'f')
    expect((await runTool(tool, { path: file })).isError).toBe(true)
  })

  it('has German summaries and the expected destructive flags', () => {
    const flags = Object.fromEntries(tools.map((t) => [t.name, `${t.destructive ? 'D' : '-'}${t.readOnly ? 'R' : '-'}`]))
    expect(flags).toEqual({
      read_file: '-R',
      write_file: 'D-',
      append_file: 'D-',
      list_directory: '-R',
      search_files: '-R',
      file_info: '-R',
      move_path: 'D-',
      delete_path: 'D-',
      create_directory: '--',
    })
    expect(toolByName(tools, 'delete_path').summarize?.({ path: 'C:\\x' })).toBe('Lösche (Papierkorb): C:\\x')
    expect(toolByName(tools, 'move_path').summarize?.({ from: 'a', to: 'b', overwrite: false })).toBe('Verschiebe: a → b')
    expect(fakeContext().config.permissions.allowFiles).toBe(true)
  })
})
