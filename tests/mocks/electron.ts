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

export const screen = {
  getPrimaryDisplay: () => ({
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
  }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on: () => undefined,
}

export const globalShortcut = {
  register: () => true,
  unregister: () => undefined,
  unregisterAll: () => undefined,
  isRegistered: () => false,
}

export class BrowserWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { send: () => undefined, isDestroyed: () => false })
  isDestroyed(): boolean {
    return false
  }
}

export const shell = { openExternal: async () => undefined, openPath: async () => '' }
export const clipboard = { readText: () => '', writeText: () => undefined }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => undefined }
export const nativeImage = { createFromPath: () => ({}), createFromBuffer: () => ({}) }
export const desktopCapturer = { getSources: async () => [] }
export const protocol = { registerSchemesAsPrivileged: () => undefined, handle: () => undefined }
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

export default { app, ipcMain, safeStorage, screen, globalShortcut, BrowserWindow, shell, clipboard, dialog }
