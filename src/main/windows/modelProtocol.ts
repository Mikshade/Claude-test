/**
 * `flowy-model://` custom protocol: serves the configured Live2D model directory (and the bundled
 * default) to the renderer so pixi-live2d-display can fetch model3.json/textures/motions with
 * ordinary fetch/XHR regardless of where the files live on disk. Also exposes whether the Cubism
 * Core runtime file exists in the renderer public dir.
 *
 * OWNER: overlay agent.
 *
 * URL layout: flowy-model://model/<relative path inside model dir>
 */
import type { ConfigStore } from '../config/store'

export const MODEL_SCHEME = 'flowy-model'
export const MODEL_HOST = 'model'

export const registerModelProtocol = {
  /** Must run before app 'ready'. */
  registerSchemes(): void {
    throw new Error('not implemented: registerModelProtocol.registerSchemes (src/main/windows/modelProtocol.ts)')
  },
  /** Must run after app 'ready'. `resolveModelDir` returns the directory to serve. */
  registerHandler(_resolveModelDir: () => string): void {
    throw new Error('not implemented: registerModelProtocol.registerHandler (src/main/windows/modelProtocol.ts)')
  },
  /** True if src/renderer/public/vendor/live2dcubismcore.min.js was bundled. */
  coreAvailable(): boolean {
    return false
  },
}

export type { ConfigStore }
