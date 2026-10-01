/**
 * Typed wrappers around ipcMain / webContents so main-process modules never use raw channel strings.
 *
 * Handlers are registered in `registerIpcHandlers` (src/main/ipcHandlers.ts) once all modules exist.
 */
import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Invoke, InvokeChannel, Push, PushChannel } from '@shared/ipc'
import { createLogger } from './log'

const log = createLogger('ipc')

type Handler<C extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: Invoke[C]['args']
) => Promise<Invoke[C]['result']> | Invoke[C]['result']

/** Register a typed invoke handler. Errors are logged and re-thrown to the renderer as Error messages. */
export function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as Invoke[C]['args']))
    } catch (err) {
      log.error(`handler ${channel} failed`, err)
      throw err instanceof Error ? new Error(err.message) : new Error(String(err))
    }
  })
}

/** Send a typed push message to a window (no-op when the window is gone). */
export function sendTo<C extends PushChannel>(win: BrowserWindow | null | undefined, channel: C, payload: Push[C]): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/** Broadcast a typed push message to several windows. */
export function broadcast<C extends PushChannel>(wins: Array<BrowserWindow | null | undefined>, channel: C, payload: Push[C]): void {
  for (const w of wins) sendTo(w, channel, payload)
}
