/**
 * Well-known file system locations. Everything user-specific lives under Electron's userData.
 */
import path from 'node:path'
import { app } from 'electron'

export function userDataDir(): string {
  return app.getPath('userData')
}

export function configFile(): string {
  return path.join(userDataDir(), 'config.json')
}

export function historyFile(): string {
  return path.join(userDataDir(), 'history.json')
}

export function notesFile(): string {
  return path.join(userDataDir(), 'memory.json')
}

export function logDir(): string {
  return path.join(userDataDir(), 'logs')
}

/** Bundled default Live2D model directory (resources/models in dev, <resources>/models when packaged). */
export function bundledModelsDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(app.getAppPath(), 'resources', 'models')
}

/** Name of the default sample model folder created by `npm run setup:live2d`. */
export const DEFAULT_MODEL_DIRNAME = 'default'
