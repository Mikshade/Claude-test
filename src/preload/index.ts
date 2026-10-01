/**
 * Preload: exposes a minimal, whitelisted, typed bridge as `window.flowy`.
 * contextIsolation is on and the renderer is sandboxed – nothing else from Node leaks through.
 *
 * The window creator passes `--flowy-page=overlay|settings` via webPreferences.additionalArguments.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { type FlowyApi, INVOKE_CHANNELS, type InvokeChannel, PUSH_CHANNELS, type PushChannel } from '@shared/ipc'

const invokeSet = new Set<string>(INVOKE_CHANNELS)
const pushSet = new Set<string>(PUSH_CHANNELS)

const pageArg = process.argv.find((a) => a.startsWith('--flowy-page='))
const page: FlowyApi['page'] = pageArg?.endsWith('settings') ? 'settings' : 'overlay'

const api: FlowyApi = {
  page,
  invoke: (channel: InvokeChannel, ...args: unknown[]) => {
    if (!invokeSet.has(channel)) return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: PushChannel, listener: (payload: never) => void) => {
    if (!pushSet.has(channel)) throw new Error(`IPC channel not allowed: ${channel}`)
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => listener(args[0] as never)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('flowy', api)
