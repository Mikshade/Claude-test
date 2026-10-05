import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_MARKER,
  countTurns,
  createHistory,
  hasImageBlocks,
  IMAGE_PLACEHOLDER,
  isToolResultMessage,
  redactImageBlocks,
  SUMMARY_PREFIX,
  turnStartIndexes,
} from './history'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-history-'))
  file = path.join(dir, 'nested', 'history.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const user = (text: string): Anthropic.MessageParam => ({ role: 'user', content: text })
const assistant = (text: string): Anthropic.MessageParam => ({ role: 'assistant', content: [{ type: 'text', text }] })
const toolUse = (id: string, name = 'read_file'): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'hmm', signature: 'sig' },
    { type: 'text', text: 'Moment…' },
    { type: 'tool_use', id, name, input: { path: 'C:\\x.txt' } },
  ],
})
const toolResult = (id: string, text = 'ok', isError = false): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }],
})

/** Three turns: plain, tool loop with two iterations, plain. */
function seed(h: ReturnType<typeof createHistory>): void {
  h.append(user('Hallo'))
  h.append(assistant('Hi!'))
  h.append(user('Lies die Datei'))
  h.append(toolUse('t1'))
  h.append(toolResult('t1'))
  h.append(toolUse('t2'))
  h.append(toolResult('t2', 'boom', true))
  h.append(assistant('Fertig.'))
  h.append(user('Danke'))
  h.append(assistant('Gern.'))
}

describe('turn segmentation', () => {
  it('treats tool_result messages as part of the previous turn', () => {
    expect(isToolResultMessage(toolResult('x'))).toBe(true)
    expect(isToolResultMessage(user('x'))).toBe(false)
    expect(isToolResultMessage({ role: 'user', content: [{ type: 'text', text: 'x' }] })).toBe(false)
    const h = createHistory(file)
    seed(h)
    expect(turnStartIndexes(h.messages())).toEqual([0, 2, 8])
    expect(countTurns(h.messages())).toBe(3)
  })
})

describe('trim', () => {
  it('removes whole turns from the front and never splits tool_use/tool_result pairs', () => {
    const h = createHistory(file)
    seed(h)
    h.trim(2)
    const m = h.messages()
    expect(m).toHaveLength(8)
    expect(m[0]).toEqual(user('Lies die Datei'))
    expect(countTurns(m)).toBe(2)
    // every tool_use still has its tool_result right after it
    for (let i = 0; i < m.length; i++) {
      const msg = m[i]!
      if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_use')) {
        expect(isToolResultMessage(m[i + 1]!)).toBe(true)
      }
    }
    h.trim(1)
    expect(h.messages()).toEqual([user('Danke'), assistant('Gern.')])
    expect(h.messages()[0]!.role).toBe('user')
  })

  it('is a no-op when within the limit and clamps to at least one turn', () => {
    const h = createHistory(file)
    seed(h)
    h.trim(10)
    expect(h.messages()).toHaveLength(10)
    h.trim(0)
    expect(countTurns(h.messages())).toBe(1)
    expect(h.messages()[0]).toEqual(user('Danke'))
  })

  it('persists the trimmed state', () => {
    const h = createHistory(file)
    seed(h)
    h.trim(1)
    expect(createHistory(file).messages()).toEqual([user('Danke'), assistant('Gern.')])
  })
})

describe('persistence', () => {
  it('round-trips messages verbatim through save/load (incl. thinking blocks) and creates the directory', () => {
    const h = createHistory(file)
    seed(h)
    h.save()
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const again = createHistory(file)
    expect(again.messages()).toEqual(h.messages())
    expect(again.messages()[3]).toEqual(toolUse('t1'))
  })

  it('only writes when dirty', () => {
    const h = createHistory(file)
    h.save()
    expect(fs.existsSync(file)).toBe(false)
    h.append(user('x'))
    h.save()
    expect(fs.existsSync(file)).toBe(true)
    const mtime = fs.statSync(file).mtimeMs
    h.save()
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
  })

  it('starts empty on a corrupt file and on unknown shapes', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"version":1,"entries":[{"at":1,"message":{"role":"user","content":"a"}}', 'utf8')
    expect(createHistory(file).messages()).toEqual([])
    fs.writeFileSync(file, '"just a string"', 'utf8')
    expect(createHistory(file).messages()).toEqual([])
    fs.writeFileSync(file, '{"version":1,"entries":[{"at":1,"message":{"role":"ghost","content":"a"}}, 42]}', 'utf8')
    expect(createHistory(file).messages()).toEqual([])
  })

  it('accepts a bare message list and drops leading non-user messages', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const legacy: Anthropic.MessageParam[] = [assistant('orphan'), toolResult('o'), user('Hallo'), assistant('Hi')]
    fs.writeFileSync(file, JSON.stringify({ messages: legacy }), 'utf8')
    const h = createHistory(file)
    expect(h.messages()).toEqual([user('Hallo'), assistant('Hi')])
  })

  it('clear() empties and persists immediately', () => {
    const h = createHistory(file)
    seed(h)
    h.save()
    h.clear()
    expect(h.messages()).toEqual([])
    expect(createHistory(file).messages()).toEqual([])
  })
})

describe('compact', () => {
  it('replaces older turns with a summary pair and keeps the last turns intact', () => {
    const h = createHistory(file)
    seed(h)
    h.compact('Der User wollte eine Datei lesen; der zweite Versuch schlug fehl.', 1)
    const m = h.messages()
    expect(m).toHaveLength(4)
    expect(m[0]!.role).toBe('user')
    expect(m[0]!.content).toBe(`${SUMMARY_PREFIX}\nDer User wollte eine Datei lesen; der zweite Versuch schlug fehl.`)
    expect(m[1]!.role).toBe('assistant')
    expect(m[2]).toEqual(user('Danke'))
    expect(m[3]).toEqual(assistant('Gern.'))
    expect(countTurns(m)).toBe(2)
    expect(createHistory(file).messages()).toEqual(m)
  })

  it('does nothing when there is nothing older than keepTurns', () => {
    const h = createHistory(file)
    seed(h)
    h.compact('irrelevant', 3)
    expect(h.messages()).toHaveLength(10)
  })

  it('summarizes everything with keepTurns = 0 and just drops with an empty summary', () => {
    const h = createHistory(file)
    seed(h)
    h.compact('Alles.', 0)
    expect(h.messages()).toHaveLength(2)
    expect(h.messages()[0]!.content).toContain('Alles.')
    h.compact('   ', 0)
    expect(h.messages()).toEqual([])
  })
})

describe('view', () => {
  it('flattens messages into user/assistant/tool entries in order', () => {
    const h = createHistory(file)
    h.append({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
        { type: 'text', text: `Was siehst du?${CONTEXT_MARKER}active_window: Editor\ntime: 12:00` },
      ],
    })
    h.append(toolUse('t1', 'take_screenshot'))
    h.append(toolResult('t1', 'done'))
    h.append(toolResult('t2', 'nope', true))
    h.append(assistant('[[happy]] Ich sehe einen Editor.'))
    h.append({ role: 'system', content: 'operator note' })
    const v = h.view()
    expect(v.map((x) => x.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'assistant'])
    expect(v[0]!.text).toBe('[Screenshot]\nWas siehst du?')
    expect(v[1]!.text).toBe('Moment…')
    expect(v[2]!.text).toContain('take_screenshot')
    expect(v[2]!.text).toContain('C:\\\\x.txt')
    expect(v[3]!.text).toBe('done')
    expect(v[4]!.text).toBe('[error] nope')
    expect(v[5]!.text).toBe('[[happy]] Ich sehe einen Editor.')
    expect(new Set(v.map((x) => x.id)).size).toBe(v.length)
    for (const entry of v) expect(typeof entry.at).toBe('number')
  })

  it('respects the limit (newest entries win)', () => {
    const h = createHistory(file)
    seed(h)
    const all = h.view()
    expect(h.view(2)).toEqual(all.slice(-2))
    expect(h.view(0)).toEqual([])
    expect(h.view(100)).toEqual(all)
  })
})

describe('image redaction', () => {
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: 'QUJD' } }
  const shot = (): Anthropic.MessageParam => ({ role: 'user', content: [image, { type: 'text', text: 'Was siehst du?' }] })
  const toolShot = (id: string): Anthropic.MessageParam => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: [image, { type: 'text', text: 'Screenshot 10×10' }] }],
  })

  it('redactImageBlocks replaces image blocks in user messages and tool results and leaves the rest untouched', () => {
    const plain = user('Hallo')
    expect(redactImageBlocks(plain)).toBe(plain)
    const reply = assistant('x')
    expect(redactImageBlocks(reply)).toBe(reply)
    const result = toolResult('t1')
    expect(redactImageBlocks(result)).toBe(result)
    expect(hasImageBlocks(shot())).toBe(true)
    expect(hasImageBlocks(plain)).toBe(false)
    expect(redactImageBlocks(shot())).toEqual({
      role: 'user',
      content: [{ type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: 'Was siehst du?' }],
    })
    expect(redactImageBlocks(toolShot('t1'))).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: 'Screenshot 10×10' }] }],
    })
  })

  it('never writes base64 images to disk and drops them from memory on redactImages()', () => {
    const h = createHistory(file)
    h.append(shot())
    h.append(toolUse('t1', 'take_screenshot'))
    h.append(toolShot('t1'))
    h.append(assistant('Ein Editor.'))
    h.save()
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('QUJD')
    expect(raw).toContain(IMAGE_PLACEHOLDER)
    // the running turn still has its images in memory
    expect(JSON.stringify(h.messages())).toContain('QUJD')

    h.redactImages()
    const m = h.messages()
    expect(JSON.stringify(m)).not.toContain('QUJD')
    expect(m[0]).toEqual({ role: 'user', content: [{ type: 'text', text: IMAGE_PLACEHOLDER }, { type: 'text', text: 'Was siehst du?' }] })
    expect(m[2]).toEqual(redactImageBlocks(toolShot('t1')))
    expect(m[3]).toEqual(assistant('Ein Editor.'))
    expect(countTurns(m)).toBe(1)
    expect(isToolResultMessage(m[2]!)).toBe(true)
    h.save()
    expect(createHistory(file).messages()).toEqual(m)
    expect(h.view()[0]!.text).toBe(`${IMAGE_PLACEHOLDER}\nWas siehst du?`)
  })
})
