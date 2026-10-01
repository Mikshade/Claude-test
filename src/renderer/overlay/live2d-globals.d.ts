/**
 * Ambient globals of the overlay page: the proprietary Cubism Core runtime is loaded by a classic
 * <script> (vendor file or CDN) and announces itself as `window.Live2DCubismCore`. The plugin's own
 * types export the namespace from the module, not as a global, so we declare the window field here.
 */
declare global {
  interface Window {
    Live2DCubismCore?: unknown
    /** Set when the global PIXI namespace is exposed (not required – we pass an explicit ticker). */
    PIXI?: unknown
  }
}

export {}
