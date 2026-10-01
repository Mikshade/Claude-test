/**
 * Settings / first-run wizard window (a normal, focusable window).
 *
 * OWNER: settings-window agent (main side) – the page itself is src/renderer/settings.
 *
 * - 980×720 (min 820×600), shown on 'ready-to-show', menu bar hidden, sandboxed preload with
 *   `--flowy-page=settings` so the preload reports `page === 'settings'`.
 * - `open(page)` loads `renderer/settings/index.html#<page>` (dev: ELECTRON_RENDERER_URL). When the
 *   window already exists it is focused and the page switch is done with `location.hash = …`
 *   (the renderer listens for `hashchange`).
 * - Only this window ever receives clear-text API keys (`config:get`); see ARCHITECTURE.md.
 */
import path from 'node:path'
import { BrowserWindow, shell } from 'electron'
import type { Push, PushChannel } from '@shared/ipc'
import { sendTo } from '../ipc'
import { createLogger } from '../log'
import { installPermissionHandlers } from './permissions'

const log = createLogger('settings-window')

export const SETTINGS_WINDOW_SIZE = { width: 980, height: 720 } as const
export const SETTINGS_WINDOW_MIN_SIZE = { width: 820, height: 600 } as const

export interface SettingsWindowManager {
  /** Open (or focus) the settings window, optionally jumping to a page id such as 'voice' or 'wizard'. */
  open(page?: string): BrowserWindow
  current(): BrowserWindow | null
  send<C extends PushChannel>(channel: C, payload: Push[C]): void
  close(): void
}

export interface SettingsWindowOptions {
  preloadPath: string
  /** Shown as the window title. */
  title: string
}

/** Where the settings page is loaded from: the dev server (URL with hash) or the built file (+ hash option). */
export type SettingsLoadTarget = { kind: 'url'; url: string } | { kind: 'file'; file: string; hash: string }

/** Normalise a page id: trims, drops a leading '#', empty/undefined → '' (the renderer picks the default). */
export function normalizePage(page: string | undefined): string {
  const trimmed = (page ?? '').trim()
  const bare = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  // Page ids are plain identifiers; anything else would end up in a URL / script string.
  return /^[a-z][a-z0-9-]*$/i.test(bare) ? bare : ''
}

/**
 * Build the load target for `page`. `devUrl` is `process.env.ELECTRON_RENDERER_URL` (set by electron-vite
 * in dev), `rendererDir` the built renderer directory (`out/renderer`).
 */
export function settingsLoadTarget(page: string | undefined, devUrl: string | undefined, rendererDir: string): SettingsLoadTarget {
  const id = normalizePage(page)
  if (devUrl) {
    const base = devUrl.replace(/\/+$/, '')
    return { kind: 'url', url: `${base}/settings/index.html${id ? `#${id}` : ''}` }
  }
  return { kind: 'file', file: path.join(rendererDir, 'settings', 'index.html'), hash: id }
}

/** JavaScript that switches the already-loaded page (executed in the renderer). */
export function hashScript(page: string): string {
  return `location.hash = ${JSON.stringify(`#${normalizePage(page)}`)}; undefined`
}

export function createSettingsWindowManager(options: SettingsWindowOptions): SettingsWindowManager {
  let win: BrowserWindow | null = null

  function current(): BrowserWindow | null {
    return win && !win.isDestroyed() ? win : null
  }

  function create(page: string | undefined): BrowserWindow {
    const created = new BrowserWindow({
      width: SETTINGS_WINDOW_SIZE.width,
      height: SETTINGS_WINDOW_SIZE.height,
      minWidth: SETTINGS_WINDOW_MIN_SIZE.width,
      minHeight: SETTINGS_WINDOW_MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: options.title,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        additionalArguments: ['--flowy-page=settings'],
        spellcheck: false,
      },
    })
    win = created

    // The settings page records the microphone for the STT test and lists audio devices.
    installPermissionHandlers(created.webContents.session)

    created.once('ready-to-show', () => {
      if (!created.isDestroyed()) created.show()
    })
    created.on('closed', () => {
      if (win === created) win = null
    })
    // Links are opened through 'app:openExternal'; a stray target=_blank must never open a new Electron window.
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    created.webContents.on('render-process-gone', (_event, details) => {
      log.error(`settings renderer gone: ${details.reason}`)
    })

    const target = settingsLoadTarget(page, process.env['ELECTRON_RENDERER_URL'], path.join(__dirname, '../renderer'))
    const loading =
      target.kind === 'url' ? created.loadURL(target.url) : created.loadFile(target.file, target.hash ? { hash: target.hash } : undefined)
    loading.catch((err: unknown) => log.error('settings page failed to load', err))

    log.info(`settings window opened (${normalizePage(page) || 'default page'})`)
    return created
  }

  function open(page?: string): BrowserWindow {
    const existing = current()
    if (!existing) return create(page)
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (normalizePage(page)) {
      existing.webContents.executeJavaScript(hashScript(page ?? '')).catch((err: unknown) => {
        log.warn('cannot switch settings page', err instanceof Error ? err.message : err)
      })
    }
    return existing
  }

  function close(): void {
    const existing = current()
    if (existing) existing.close()
    win = null
  }

  return {
    open,
    current,
    send: (channel, payload) => sendTo(current(), channel, payload),
    close,
  }
}
