/**
 * Screen capture for screen awareness (desktopCapturer → NativeImage → downscaled JPEG/PNG).
 *
 * OWNER: system agent.
 */

export interface CaptureOptions {
  /** 'primary' or an Electron display id. */
  display?: 'primary' | number
  /** Downscale so the long edge is at most this many px. */
  maxLongEdge?: number
  format?: 'jpeg' | 'png'
  jpegQuality?: number
}

export interface Capture {
  base64: string
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  bytes: number
}

export async function captureScreen(_options: CaptureOptions = {}): Promise<Capture> {
  throw new Error('not implemented: captureScreen (src/main/system/screenshot.ts)')
}
