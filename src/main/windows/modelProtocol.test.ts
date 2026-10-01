import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { net as electronNet, protocol as electronProtocol } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  contentTypeFor,
  coreCandidates,
  createModelRequestHandler,
  findDefaultModelJson,
  MODEL_HOST,
  MODEL_SCHEME,
  modelUrlFor,
  registerModelProtocol,
  relativePathFromUrl,
  safeJoin,
} from './modelProtocol'

/** Test-helper surface of the recording mock in tests/mocks/electron.ts. */
interface RecordingProtocol {
  _schemes: Array<{ scheme: string; privileges?: Record<string, boolean> }>
  _handlers: Map<string, (request: Request) => Response | Promise<Response>>
  _reset(): void
}
const protocol = electronProtocol as unknown as RecordingProtocol
const net = electronNet as unknown as { fetch: (input: string, init?: RequestInit) => Promise<Response> }

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-model-'))
  protocol._reset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('safeJoin', () => {
  it('joins relative paths inside the root', () => {
    expect(safeJoin('/models/haru', 'haru.model3.json')).toBe('/models/haru/haru.model3.json')
    expect(safeJoin('/models/haru', 'haru.2048/texture_00.png')).toBe('/models/haru/haru.2048/texture_00.png')
    expect(safeJoin('/models/haru', 'motions/../expressions/f01.exp3.json')).toBe('/models/haru/expressions/f01.exp3.json')
    expect(safeJoin('/models/haru/', './haru.moc3')).toBe('/models/haru/haru.moc3')
    expect(safeJoin('/models/haru', '..foo/bar')).toBe('/models/haru/..foo/bar')
  })

  it('rejects traversal out of the root', () => {
    expect(safeJoin('/models/haru', '../secrets.json')).toBeNull()
    expect(safeJoin('/models/haru', 'a/../../secrets.json')).toBeNull()
    expect(safeJoin('/models/haru', '../haru2/x.png')).toBeNull()
    expect(safeJoin('/models/haru', '..')).toBeNull()
    expect(safeJoin('/models/haru', 'x/../../..')).toBeNull()
  })

  it('rejects absolute and drive-relative inputs', () => {
    expect(safeJoin('/models/haru', '/etc/passwd')).toBeNull()
    expect(safeJoin('/models/haru', 'C:\\Windows\\system32\\drivers\\etc\\hosts')).toBeNull()
    expect(safeJoin('/models/haru', 'C:/x')).toBeNull()
    expect(safeJoin('/models/haru', 'C:x')).toBeNull()
    expect(safeJoin('/models/haru', '\\\\server\\share\\x')).toBeNull()
    expect(safeJoin('/models/haru', '//server/share/x')).toBeNull()
    expect(safeJoin('/models/haru', 'a\0b')).toBeNull()
  })

  it('handles Windows semantics (backslashes, other drives) with path.win32', () => {
    const w = path.win32
    expect(safeJoin('C:\\Users\\me\\models\\haru', 'haru.2048\\texture_00.png', w)).toBe(
      'C:\\Users\\me\\models\\haru\\haru.2048\\texture_00.png',
    )
    expect(safeJoin('C:\\Users\\me\\models\\haru', 'haru.2048/texture_00.png', w)).toBe(
      'C:\\Users\\me\\models\\haru\\haru.2048\\texture_00.png',
    )
    expect(safeJoin('C:\\Users\\me\\models\\haru', '..\\..\\secrets.json', w)).toBeNull()
    expect(safeJoin('C:\\Users\\me\\models\\haru', 'D:\\other\\x.png', w)).toBeNull()
    expect(safeJoin('C:\\Users\\me\\models\\haru', 'D:x.png', w)).toBeNull()
    expect(safeJoin('C:\\Users\\me\\models\\haru', '\\Windows\\x', w)).toBeNull()
    expect(safeJoin('C:\\Users\\me\\models\\haru', '/Windows/x', w)).toBeNull()
  })

  it('rejects symlinks that point outside the root (realpath check)', () => {
    const root = path.join(tmp, 'root')
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
    fs.writeFileSync(path.join(root, 'ok.txt'), 'y')
    let symlinks = true
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'))
      fs.symlinkSync(path.join(root, 'ok.txt'), path.join(root, 'alias.txt'))
    } catch {
      symlinks = false
    }
    expect(safeJoin(root, 'ok.txt')).toBe(path.join(root, 'ok.txt'))
    expect(safeJoin(root, 'missing.txt')).toBe(path.join(root, 'missing.txt'))
    if (symlinks) {
      expect(safeJoin(root, 'escape.txt')).toBeNull()
      expect(safeJoin(root, 'alias.txt')).toBe(path.join(root, 'alias.txt'))
    }
  })
})

describe('relativePathFromUrl', () => {
  it('decodes the pathname and strips the leading slash', () => {
    expect(relativePathFromUrl('flowy-model://model/haru.model3.json')).toBe('haru.model3.json')
    expect(relativePathFromUrl('flowy-model://model/haru.2048/texture_00.png')).toBe('haru.2048/texture_00.png')
    expect(relativePathFromUrl('flowy-model://model/My%20Model.model3.json')).toBe('My Model.model3.json')
    expect(relativePathFromUrl('flowy-model://model/%E3%81%AF%E3%82%8B.moc3')).toBe('はる.moc3')
  })

  it('rejects wrong host/scheme, empty paths and malformed encoding', () => {
    expect(relativePathFromUrl('flowy-model://other/x.json')).toBeNull()
    expect(relativePathFromUrl('flowy-model://model/')).toBeNull()
    expect(relativePathFromUrl('flowy-model://model')).toBeNull()
    expect(relativePathFromUrl('file:///model/x.json')).toBeNull()
    expect(relativePathFromUrl('flowy-model://model/%E0%A4%A')).toBeNull()
    expect(relativePathFromUrl('not a url')).toBeNull()
  })

  it('exposes encoded traversal so safeJoin can reject it', () => {
    expect(relativePathFromUrl('flowy-model://model/%2e%2e%2fsecret.json')).toBe('../secret.json')
    expect(safeJoin('/models/haru', relativePathFromUrl('flowy-model://model/%2e%2e%2fsecret.json')!)).toBeNull()
    expect(safeJoin('/models/haru', relativePathFromUrl('flowy-model://model/a%2f..%2f..%2fsecret.json')!)).toBeNull()
  })
})

describe('request handler', () => {
  function serveFromDisk(): void {
    vi.spyOn(net, 'fetch').mockImplementation(async (input: string) => {
      const file = fileURLToPath(input)
      try {
        const body = fs.readFileSync(file)
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } })
      } catch {
        return new Response('nope', { status: 404 })
      }
    })
  }

  it('serves files from the (freshly resolved) model dir with CORS and content-type headers', async () => {
    const dirA = path.join(tmp, 'a')
    const dirB = path.join(tmp, 'b')
    fs.mkdirSync(path.join(dirA, 'tex'), { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    fs.writeFileSync(path.join(dirA, 'a.model3.json'), '{"a":1}')
    fs.writeFileSync(path.join(dirA, 'tex', 't.png'), 'png')
    fs.writeFileSync(path.join(dirB, 'b.moc3'), 'moc')
    serveFromDisk()

    let current = dirA
    const handler = createModelRequestHandler(() => current)

    const res = await handler(new Request('flowy-model://model/a.model3.json'))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.text()).toBe('{"a":1}')

    const png = await handler(new Request('flowy-model://model/tex/t.png'))
    expect(png.status).toBe(200)
    expect(await png.text()).toBe('png')

    current = dirB
    expect((await handler(new Request('flowy-model://model/a.model3.json'))).status).toBe(404)
    const moc = await handler(new Request('flowy-model://model/b.moc3'))
    expect(moc.status).toBe(200)
    expect(await moc.text()).toBe('moc')
    expect(net.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/^file:\/\/\/.*b\.moc3$/),
      expect.objectContaining({ bypassCustomProtocolHandlers: true }),
    )
  })

  it('fills in a content-type when the file loader gives none', async () => {
    const dir = path.join(tmp, 'm')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'x.moc3'), 'moc')
    fs.writeFileSync(path.join(dir, 'x.model3.json'), '{}')
    vi.spyOn(net, 'fetch').mockImplementation(async (input: string) => new Response(fs.readFileSync(fileURLToPath(input))))
    const handler = createModelRequestHandler(() => dir)
    const moc = await handler(new Request('flowy-model://model/x.moc3'))
    expect(moc.headers.get('content-type')).toBe('application/octet-stream')
    const json = await handler(new Request('flowy-model://model/x.model3.json'))
    expect(json.headers.get('content-type')).toBe('application/json')
  })

  it('answers 404 for traversal, wrong host, missing files and handler errors', async () => {
    const dir = path.join(tmp, 'root')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(tmp, 'secret.json'), 'secret')
    serveFromDisk()
    const handler = createModelRequestHandler(() => dir)

    for (const url of [
      'flowy-model://model/../secret.json', // normalized away by the URL parser → /secret.json → missing
      'flowy-model://model/%2e%2e%2fsecret.json',
      'flowy-model://model/..%2fsecret.json',
      'flowy-model://model/%2e%2e/secret.json',
      'flowy-model://evil/x.json',
      'flowy-model://model/',
      'flowy-model://model/missing.png',
    ]) {
      const res = await handler(new Request(url))
      expect(res.status, url).toBe(404)
      expect(await res.text()).not.toBe('secret')
    }

    const throwing = createModelRequestHandler(() => {
      throw new Error('config broken')
    })
    expect((await throwing(new Request('flowy-model://model/x.json'))).status).toBe(404)

    vi.spyOn(net, 'fetch').mockRejectedValue(new Error('net down'))
    fs.writeFileSync(path.join(dir, 'y.json'), '{}')
    expect((await handler(new Request('flowy-model://model/y.json'))).status).toBe(404)
  })
})

describe('registerModelProtocol', () => {
  it('registers the privileged scheme and installs the handler', async () => {
    registerModelProtocol.registerSchemes()
    expect(protocol._schemes).toEqual([
      {
        scheme: MODEL_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
      },
    ])
    const dir = path.join(tmp, 'r')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'm.model3.json'), '{"ok":true}')
    vi.spyOn(net, 'fetch').mockImplementation(async (input: string) => new Response(fs.readFileSync(fileURLToPath(input))))
    registerModelProtocol.registerHandler(() => dir)
    const handler = protocol._handlers.get(MODEL_SCHEME)
    expect(handler).toBeTypeOf('function')
    const res = await handler!(new Request(`${MODEL_SCHEME}://${MODEL_HOST}/m.model3.json`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('coreAvailable checks the dev and packaged locations', () => {
    const candidates = coreCandidates()
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatch(/src[\\/]renderer[\\/]public[\\/]vendor[\\/]live2dcubismcore\.min\.js$/)
    expect(candidates[1]).toMatch(/renderer[\\/]vendor[\\/]live2dcubismcore\.min\.js$/)

    const exists = vi.spyOn(fs, 'existsSync')
    exists.mockReturnValue(false)
    expect(registerModelProtocol.coreAvailable()).toBe(false)
    exists.mockImplementation((p) => String(p) === candidates[1])
    expect(registerModelProtocol.coreAvailable()).toBe(true)
    exists.mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(registerModelProtocol.coreAvailable()).toBe(false)
  })
})

describe('findDefaultModelJson', () => {
  it('prefers a model3.json in the dir itself, then one level deep, sorted', () => {
    const dir = path.join(tmp, 'models')
    fs.mkdirSync(path.join(dir, 'zeta'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'alpha'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'alpha', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'alpha', 'deep', 'too-deep.model3.json'), '{}')
    expect(findDefaultModelJson(dir)).toBeNull() // two levels deep is not searched

    fs.writeFileSync(path.join(dir, 'zeta', 'z.model3.json'), '{}')
    expect(findDefaultModelJson(dir)).toBe(path.join(dir, 'zeta', 'z.model3.json'))
    fs.writeFileSync(path.join(dir, 'alpha', 'a.model3.json'), '{}')
    expect(findDefaultModelJson(dir)).toBe(path.join(dir, 'alpha', 'a.model3.json'))

    fs.writeFileSync(path.join(dir, 'top.model3.json'), '{}')
    fs.writeFileSync(path.join(dir, 'a-first-but-not-a-model.json'), '{}')
    expect(findDefaultModelJson(dir)).toBe(path.join(dir, 'top.model3.json'))
  })

  it('falls back to a Cubism 2 model.json and returns null for missing dirs', () => {
    const dir = path.join(tmp, 'c2')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub', 'shizuku.model.json'), '{}')
    expect(findDefaultModelJson(dir)).toBe(path.join(dir, 'sub', 'shizuku.model.json'))
    fs.writeFileSync(path.join(dir, 'sub', 'new.model3.json'), '{}')
    expect(findDefaultModelJson(dir)).toBe(path.join(dir, 'sub', 'new.model3.json'))
    expect(findDefaultModelJson(path.join(tmp, 'does-not-exist'))).toBeNull()
    expect(findDefaultModelJson(path.join(dir, 'sub', 'new.model3.json'))).toBeNull() // a file, not a dir
  })
})

describe('modelUrlFor / contentTypeFor', () => {
  it('builds the renderer URL from the basename, percent-encoded', () => {
    expect(modelUrlFor('/models/haru/haru.model3.json')).toBe('flowy-model://model/haru.model3.json')
    expect(modelUrlFor('C:\\Users\\me\\My Model\\my model.model3.json')).toMatch(/^flowy-model:\/\/model\/.*my%20model\.model3\.json$/)
    expect(modelUrlFor('/m/はる.model3.json')).toBe('flowy-model://model/%E3%81%AF%E3%82%8B.model3.json')
  })

  it('maps model file extensions to content types', () => {
    expect(contentTypeFor('x.model3.json')).toBe('application/json')
    expect(contentTypeFor('x.PNG')).toBe('image/png')
    expect(contentTypeFor('x.moc3')).toBe('application/octet-stream')
    expect(contentTypeFor('x.unknownext')).toBe('application/octet-stream')
  })
})
