/**
 * `flowy-model://` custom protocol: serves the configured Live2D model directory (and the bundled
 * default) to the renderer so pixi-live2d-display can fetch model3.json/textures/motions with
 * ordinary fetch/XHR regardless of where the files live on disk. Also exposes whether the Cubism
 * Core runtime file exists in the renderer public dir.
 *
 * OWNER: overlay agent.
 *
 * URL layout: flowy-model://model/<relative path inside model dir>
 *
 * Why a custom scheme: the renderer loads the model via XMLHttpRequest and `PIXI.Texture.fromURL`;
 * from the Vite dev server (http://localhost) `file://` is blocked ("Not allowed to load local
 * resource") and `fetch()` never supports `file:`. The scheme is registered as standard + secure +
 * supportFetchAPI + stream + corsEnabled before `app.whenReady()` (index.ts) and handled afterwards.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, net, protocol } from 'electron'
import type { ConfigStore } from '../config/store'
import { createLogger } from '../log'

const log = createLogger('model-protocol')

export const MODEL_SCHEME = 'flowy-model'
export const MODEL_HOST = 'model'

/** File name of the proprietary Cubism Core runtime (fetched by `npm run setup:live2d`). */
export const CUBISM_CORE_FILE = 'live2dcubismcore.min.js'

/**
 * Join `relative` onto `root` and return the absolute path, or `null` when the result would escape
 * `root` (../ traversal, absolute or drive-relative input, or a symlink pointing outside root).
 * `p` lets tests exercise Windows semantics on Linux (realpath is skipped when the file does not exist).
 */
export function safeJoin(root: string, relative: string, p: path.PlatformPath = path): string | null {
  if (relative.includes('\0')) return null
  // Absolute (/x, \x, C:\x, \\server\share) and drive-relative (C:x) inputs are never allowed.
  if (p.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || /^[\\/]{2}/.test(relative)) return null
  if (p === path.win32 ? /^[\\/]/.test(relative) : relative.startsWith('/')) return null

  const rootAbs = p.resolve(root)
  const target = p.resolve(rootAbs, relative)
  if (!isInside(rootAbs, target, p)) return null

  // Symlinks: compare the real locations when both exist (a missing file simply 404s later).
  if (p === path) {
    try {
      const realRoot = fs.realpathSync(rootAbs)
      const realTarget = fs.realpathSync(target)
      if (!isInside(realRoot, realTarget, p)) return null
    } catch {
      /* target (or root) does not exist – nothing to serve, but not a traversal either */
    }
  }
  return target
}

function isInside(root: string, target: string, p: path.PlatformPath): boolean {
  const rel = p.relative(root, target)
  if (rel === '') return true
  if (p.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${p.sep}`)
}

const MIME: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.moc': 'application/octet-stream',
  '.mtn': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.js': 'text/javascript',
  '.txt': 'text/plain',
}

/** Content type by extension (Chromium's file loader does not know .moc3/.mtn). */
export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** Candidate locations of the Cubism Core runtime: dev public dir, then the packaged renderer output. */
export function coreCandidates(): string[] {
  const candidates: string[] = []
  try {
    candidates.push(path.join(app.getAppPath(), 'src', 'renderer', 'public', 'vendor', CUBISM_CORE_FILE))
  } catch {
    /* app not available (should not happen in main) */
  }
  candidates.push(path.join(__dirname, '..', 'renderer', 'vendor', CUBISM_CORE_FILE))
  return candidates
}

const MODEL3 = /\.model3\.json$/i
const MODEL2 = /\.model\.json$/i

/**
 * First `*.model3.json` directly in `dir`, else one level deep (sorted, deterministic). Falls back to a
 * Cubism 2 `*.model.json` with the same search order. `null` when nothing is found or `dir` is missing.
 */
export function findDefaultModelJson(dir: string): string | null {
  const levels = [dir, ...subdirectories(dir)]
  for (const pattern of [MODEL3, MODEL2]) {
    for (const level of levels) {
      const hit = filesIn(level).find((f) => pattern.test(f))
      if (hit) return path.join(level, hit)
    }
  }
  return null
}

function filesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

function subdirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .sort()
  } catch {
    return []
  }
}

/** URL the renderer loads for a model file: the directory is served as the host root. */
export function modelUrlFor(modelPath: string): string {
  return `${MODEL_SCHEME}://${MODEL_HOST}/${encodeURIComponent(path.basename(modelPath))}`
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })
}

/**
 * Resolve a request URL to a relative path inside the model dir. `null` for a wrong host, an empty
 * path or malformed percent-encoding. (Decoding happens here, so `%2e%2e%2f` becomes `../` and is
 * then rejected by `safeJoin`.)
 */
export function relativePathFromUrl(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${MODEL_SCHEME}:` || url.host !== MODEL_HOST) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const relative = decoded.replace(/^\/+/, '')
  return relative.length > 0 ? relative : null
}

/** Build the protocol handler (exported for tests; `registerHandler` installs it). */
export function createModelRequestHandler(resolveModelDir: () => string): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const relative = relativePathFromUrl(request.url)
      if (relative === null) return notFound()
      // Fresh call per request so a changed avatar.modelPath takes effect without a restart.
      const root = resolveModelDir()
      const file = safeJoin(root, relative)
      if (file === null) {
        log.warn(`rejected model request outside the model dir: ${relative}`)
        return notFound()
      }
      const upstream = await net.fetch(pathToFileURL(file).href, { bypassCustomProtocolHandlers: true })
      if (!upstream.ok) return notFound()
      const headers = new Headers(upstream.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      if (!headers.has('Content-Type')) headers.set('Content-Type', contentTypeFor(file))
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
    } catch (err) {
      log.warn(`model request failed: ${request.url}`, err instanceof Error ? err.message : err)
      return notFound()
    }
  }
}

export const registerModelProtocol = {
  /** Must run before app 'ready'. */
  registerSchemes(): void {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: MODEL_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
      },
    ])
  },
  /** Must run after app 'ready'. `resolveModelDir` returns the directory to serve. */
  registerHandler(resolveModelDir: () => string): void {
    protocol.handle(MODEL_SCHEME, createModelRequestHandler(resolveModelDir))
    log.info(`${MODEL_SCHEME}:// handler registered`)
  },
  /** True if src/renderer/public/vendor/live2dcubismcore.min.js was bundled (dev or packaged location). */
  coreAvailable(): boolean {
    return coreCandidates().some((candidate) => {
      try {
        return fs.existsSync(candidate)
      } catch {
        return false
      }
    })
  },
}

export type { ConfigStore }
