/**
 * Character factory: Live2D when a model URL and the Cubism Core runtime are available (the core is
 * fetched from the official CDN when the vendored file is missing), otherwise the procedural
 * fallback character. The Live2D implementation is loaded lazily so pixi/the plugin are only
 * evaluated when they are actually used.
 */
import type { Point } from '@shared/state'
import type { CharacterView } from './types'
import { createFallbackCharacter } from './fallback'

export const CUBISM_CORE_CDN = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
export const CORE_LOAD_TIMEOUT_MS = 10_000

/** CharacterView plus the extras main.ts needs from both implementations. */
export interface Character extends CharacterView {
  readonly kind: 'live2d' | 'fallback'
  /** Stop rendering (window hidden). */
  pause(): void
  /** Resume rendering without a physics jump. */
  resume(): void
  /** Look straight ahead (used while cursor tracking is disabled). */
  lookAhead(): void
  /** Current top-left position in window coords. */
  position(): Point
}

export interface CharacterOptions {
  /** `flowy-model://model/<file>.model3.json` or null when no model is configured/bundled. */
  modelUrl: string | null
  /** Main found the vendored Cubism Core file (it is then loaded by index.html before us). */
  coreAvailable: boolean
  height: number
  mirror: boolean
  stage: HTMLElement
}

export type CharacterPlan = 'live2d' | 'inject-core' | 'fallback'

/** Pure decision: what to try first. */
export function planCharacter(modelUrl: string | null, coreAvailable: boolean, coreLoaded: boolean): CharacterPlan {
  if (!modelUrl) return 'fallback'
  if (coreLoaded) return 'live2d'
  // Even when main says the file exists, the global may be missing (script failed) – the CDN is the next try.
  return coreAvailable || !coreLoaded ? 'inject-core' : 'fallback'
}

export function coreLoaded(): boolean {
  return typeof window !== 'undefined' && window.Live2DCubismCore !== undefined
}

/** Inject the Cubism Core <script> from the CDN and wait for the global (rejects on error/timeout). */
export function injectCubismCore(src = CUBISM_CORE_CDN, timeoutMs = CORE_LOAD_TIMEOUT_MS): Promise<void> {
  if (coreLoaded()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    const timer = window.setTimeout(() => finish(new Error(`Cubism Core load timed out after ${timeoutMs} ms`)), timeoutMs)
    const finish = (err: Error | null): void => {
      window.clearTimeout(timer)
      script.onload = null
      script.onerror = null
      if (err) {
        script.remove()
        reject(err)
      } else resolve()
    }
    script.onload = () => finish(coreLoaded() ? null : new Error('Cubism Core script loaded but window.Live2DCubismCore is missing'))
    script.onerror = () => finish(new Error(`Cubism Core script failed to load from ${src}`))
    document.head.appendChild(script)
  })
}

/** Create and load the best available character. Never rejects – the fallback always works. */
export async function createCharacter(options: CharacterOptions): Promise<Character> {
  const { modelUrl, coreAvailable, height, mirror, stage } = options
  const plan = planCharacter(modelUrl, coreAvailable, coreLoaded())
  if (modelUrl && plan !== 'fallback') {
    try {
      if (plan === 'inject-core') {
        console.info('[character] Cubism Core not present, loading it from the CDN')
        await injectCubismCore()
      }
      const { createLive2DCharacter } = await import('./live2d')
      const live2d = createLive2DCharacter({ modelUrl, height, mirror, stage })
      await live2d.load()
      console.info('[character] Live2D model ready', modelUrl, live2d.size)
      return live2d
    } catch (err) {
      console.warn('[character] Live2D unavailable, using the fallback character:', err)
    }
  }
  const fallback = createFallbackCharacter({ height, mirror, stage })
  await fallback.load()
  return fallback
}
