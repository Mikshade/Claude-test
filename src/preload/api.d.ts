import type { FlowyApi } from '../shared/ipc'

declare global {
  interface Window {
    flowy: FlowyApi
  }
}

export {}
