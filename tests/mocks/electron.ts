/**
 * Minimal Electron mock for unit tests (vitest aliases 'electron' here).
 * Extend as modules under test need more surface.
 */
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'

export const app = Object.assign(new EventEmitter(), {
  getPath: (name: string) => path.join(os.tmpdir(), 'flowy-test', name),
  getVersion: () => '0.0.0-test',
  getAppPath: () => process.cwd(),
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  quit: () => undefined,
  setAppUserModelId: () => undefined,
  setLoginItemSettings: () => undefined,
  commandLine: { appendSwitch: () => undefined },
})

export const ipcMain = {
  handle: () => undefined,
  removeHandler: () => undefined,
  on: () => undefined,
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
}

export interface MockDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

export function mockDisplay(id: number, x = 0, y = 0, width = 1920, height = 1080, taskbar = 40): MockDisplay {
  return {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height: height - taskbar },
    scaleFactor: 1,
  }
}

/**
 * `screen` is an EventEmitter so tests can `screen.emit('display-metrics-changed', ...)`.
 * Test helpers: `_displays` (first entry = primary), `_cursor` (returned by getCursorScreenPoint), `_reset()`.
 */
export const screen = Object.assign(new EventEmitter(), {
  _displays: [mockDisplay(1)] as MockDisplay[],
  _cursor: { x: 0, y: 0 },
  getPrimaryDisplay: (): MockDisplay => screen._displays[0] ?? mockDisplay(1),
  getAllDisplays: (): MockDisplay[] => [...screen._displays],
  getCursorScreenPoint: (): { x: number; y: number } => ({ ...screen._cursor }),
  getDisplayNearestPoint: (): MockDisplay => screen.getPrimaryDisplay(),
  getDisplayMatching: (): MockDisplay => screen.getPrimaryDisplay(),
  _reset(): void {
    screen._displays = [mockDisplay(1)]
    screen._cursor = { x: 0, y: 0 }
    screen.removeAllListeners()
  },
})

/**
 * Recording globalShortcut: remembers registered accelerators and their callbacks.
 * Test helpers (underscore-prefixed): `_registered` map, `_failing` set (accelerators whose
 * registration returns false, e.g. "taken by another app"), `_press(accelerator)` to simulate a
 * key press, `_reset()` to clear everything between tests.
 */
export const globalShortcut = {
  _registered: new Map<string, () => void>(),
  _failing: new Set<string>(),
  register(accelerator: string, callback: () => void): boolean {
    if (!accelerator || globalShortcut._failing.has(accelerator)) return false
    if (globalShortcut._registered.has(accelerator)) return false
    globalShortcut._registered.set(accelerator, callback)
    return true
  },
  unregister(accelerator: string): void {
    globalShortcut._registered.delete(accelerator)
  },
  unregisterAll(): void {
    globalShortcut._registered.clear()
  },
  isRegistered(accelerator: string): boolean {
    return globalShortcut._registered.has(accelerator)
  },
  _press(accelerator: string): boolean {
    const callback = globalShortcut._registered.get(accelerator)
    if (!callback) return false
    callback()
    return true
  },
  _reset(): void {
    globalShortcut._registered.clear()
    globalShortcut._failing.clear()
  },
}

/** Recording permission handlers so window modules can be tested; shared by every mock webContents. */
function makeSession(): MockSession {
  return {
    _permissionRequestHandler: null,
    _permissionCheckHandler: null,
    setPermissionRequestHandler(handler) {
      this._permissionRequestHandler = handler
    },
    setPermissionCheckHandler(handler) {
      this._permissionCheckHandler = handler
    },
    setDisplayMediaRequestHandler: () => undefined,
  }
}
export interface MockSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic recording mock
  _permissionRequestHandler: ((...args: any[]) => void) | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic recording mock
  _permissionCheckHandler: ((...args: any[]) => boolean) | null
  setPermissionRequestHandler(handler: MockSession['_permissionRequestHandler']): void
  setPermissionCheckHandler(handler: MockSession['_permissionCheckHandler']): void
  setDisplayMediaRequestHandler(): void
}
export const session = {
  defaultSession: makeSession(),
  fromPartition: (): MockSession => session.defaultSession,
  _reset(): void {
    session.defaultSession = makeSession()
  },
}

export interface MockRect {
  x: number
  y: number
  width: number
  height: number
}

let nextWebContentsId = 1

/**
 * Stateful BrowserWindow mock: remembers constructor options, bounds, shown/focused/destroyed state and
 * the calls made to the mouse/z-order setters (`_calls`). `BrowserWindow._instances` lists every window
 * created since `BrowserWindow._reset()`. `webContents` is an EventEmitter (emit 'did-finish-load' etc.).
 */
export class BrowserWindow extends EventEmitter {
  static _instances: BrowserWindow[] = []
  static _reset(): void {
    BrowserWindow._instances = []
  }
  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow._instances.filter((w) => !w._destroyed)
  }
  static fromWebContents(wc: unknown): BrowserWindow | null {
    return BrowserWindow._instances.find((w) => w.webContents === wc) ?? null
  }

  readonly options: Record<string, unknown>
  readonly _calls: Array<{ method: string; args: unknown[] }> = []
  _bounds: MockRect
  _shown = false
  _focused = false
  _destroyed = false
  _alwaysOnTop = false
  _ignoreMouse: { ignore: boolean; forward: boolean } | null = null
  readonly id: number

  webContents = Object.assign(new EventEmitter(), {
    id: nextWebContentsId++,
    _sent: [] as Array<{ channel: string; payload: unknown }>,
    send(channel: string, payload?: unknown): void {
      this._sent.push({ channel, payload })
    },
    isDestroyed: (): boolean => this._destroyed,
    getURL: (): string => (this.options['_url'] as string | undefined) ?? 'file:///out/renderer/overlay/index.html',
    openDevTools: (): void => undefined,
    closeDevTools: (): void => undefined,
    setWindowOpenHandler: (): void => undefined,
    session: session.defaultSession,
  })

  constructor(options: Record<string, unknown> = {}) {
    super()
    this.options = options
    this.id = this.webContents.id
    this._bounds = {
      x: (options['x'] as number | undefined) ?? 0,
      y: (options['y'] as number | undefined) ?? 0,
      width: (options['width'] as number | undefined) ?? 800,
      height: (options['height'] as number | undefined) ?? 600,
    }
    this._shown = options['show'] !== false
    BrowserWindow._instances.push(this)
  }

  private record(method: string, ...args: unknown[]): void {
    this._calls.push({ method, args })
  }

  isDestroyed(): boolean {
    return this._destroyed
  }
  destroy(): void {
    this._destroyed = true
    this._shown = false
    this.emit('closed')
  }
  close(): void {
    this.destroy()
  }
  loadURL(url: string): Promise<void> {
    this.record('loadURL', url)
    this.options['_url'] = url
    return Promise.resolve()
  }
  loadFile(file: string): Promise<void> {
    this.record('loadFile', file)
    return Promise.resolve()
  }
  show(): void {
    this.record('show')
    this._shown = true
    this._focused = true
  }
  showInactive(): void {
    this.record('showInactive')
    this._shown = true
  }
  hide(): void {
    this.record('hide')
    this._shown = false
  }
  isVisible(): boolean {
    return this._shown && !this._destroyed
  }
  focus(): void {
    this.record('focus')
    this._focused = true
  }
  blur(): void {
    this.record('blur')
    this._focused = false
  }
  isFocused(): boolean {
    return this._focused
  }
  moveTop(): void {
    this.record('moveTop')
  }
  getBounds(): MockRect {
    return { ...this._bounds }
  }
  setBounds(bounds: Partial<MockRect>): void {
    this.record('setBounds', bounds)
    this._bounds = { ...this._bounds, ...bounds }
  }
  setPosition(x: number, y: number): void {
    this.setBounds({ x, y })
  }
  setSize(width: number, height: number): void {
    this.setBounds({ width, height })
  }
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
    this.record('setIgnoreMouseEvents', ignore, options)
    this._ignoreMouse = { ignore, forward: ignore && options?.forward === true }
  }
  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.record('setAlwaysOnTop', flag, level)
    this._alwaysOnTop = flag
  }
  isAlwaysOnTop(): boolean {
    return this._alwaysOnTop
  }
  setVisibleOnAllWorkspaces(visible: boolean, options?: unknown): void {
    this.record('setVisibleOnAllWorkspaces', visible, options)
  }
  setMenuBarVisibility(visible: boolean): void {
    this.record('setMenuBarVisibility', visible)
  }
  setContentProtection(enable: boolean): void {
    this.record('setContentProtection', enable)
  }
  setSkipTaskbar(skip: boolean): void {
    this.record('setSkipTaskbar', skip)
  }
  setTitle(title: string): void {
    this.record('setTitle', title)
  }
  setMenu(): void {
    this.record('setMenu')
  }
  center(): void {
    this.record('center')
  }
  minimize(): void {
    this.record('minimize')
  }
  restore(): void {
    this.record('restore')
  }
  isMinimized(): boolean {
    return false
  }
}

/** `net.fetch` resolves 404 by default; tests `vi.spyOn(net, 'fetch')` to serve files. */
export const net = {
  fetch: async (_input: string | Request, _init?: RequestInit): Promise<Response> =>
    new Response('Not found', { status: 404 }),
  isOnline: (): boolean => true,
}

export const shell = { openExternal: async () => undefined, openPath: async () => '' }
export const clipboard = { readText: () => '', writeText: () => undefined }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => undefined }
export const nativeImage = { createFromPath: () => ({}), createFromBuffer: () => ({}) }
export const desktopCapturer = { getSources: async () => [] }
/** Recording protocol mock: `_schemes` from registerSchemesAsPrivileged, `_handlers` from handle(). */
export const protocol = {
  _schemes: [] as Array<{ scheme: string; privileges?: Record<string, boolean> }>,
  _handlers: new Map<string, (request: Request) => Response | Promise<Response>>(),
  registerSchemesAsPrivileged(schemes: Array<{ scheme: string; privileges?: Record<string, boolean> }>): void {
    protocol._schemes.push(...schemes)
  },
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void {
    protocol._handlers.set(scheme, handler)
  },
  unhandle(scheme: string): void {
    protocol._handlers.delete(scheme)
  },
  isProtocolHandled(scheme: string): boolean {
    return protocol._handlers.has(scheme)
  },
  _reset(): void {
    protocol._schemes = []
    protocol._handlers.clear()
  },
}
export const Menu = { buildFromTemplate: () => ({ popup: () => undefined }) }
export const Tray = class {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
  destroy(): void {}
}
export const Notification = class {
  show(): void {}
}

export default {
  app,
  ipcMain,
  safeStorage,
  screen,
  globalShortcut,
  BrowserWindow,
  shell,
  clipboard,
  dialog,
  session,
  net,
  protocol,
}
