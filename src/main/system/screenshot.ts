/**
 * Screen capture for screen awareness (desktopCapturer → NativeImage → downscaled JPEG/PNG).
 *
 * OWNER: system agent.
 *
 * The thumbnail is requested at the display's physical size (DIP × scaleFactor) so it is
 * pixel-accurate, then downscaled so the long edge is at most `maxLongEdge` (default 1280).
 * Screenshots contain untrusted text (prompt injection); consumers must treat them as data.
 */
import { desktopCapturer, type Display, type NativeImage, screen } from 'electron'
import type { ScreenAwarenessConfig } from '@shared/config'
import { createLogger } from '../log'

const log = createLogger('screenshot')

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

export const DEFAULT_MAX_LONG_EDGE = 1280
export const DEFAULT_JPEG_QUALITY = 70
export const CAPTURE_FAILED_MESSAGE = 'Bildschirmaufnahme fehlgeschlagen'

/** Target size so that the long edge is ≤ maxLongEdge (never upscales, keeps the aspect ratio). */
export function fitLongEdge(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  const long = Math.max(width, height)
  if (!Number.isFinite(maxLongEdge) || maxLongEdge <= 0 || long <= maxLongEdge || long === 0) return { width, height }
  const scale = maxLongEdge / long
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Resolves 'primary' / a display id to a Display (falls back to the primary display). */
export function resolveDisplay(which: 'primary' | number | undefined): Display {
  const primary = screen.getPrimaryDisplay()
  if (which === undefined || which === 'primary') return primary
  const match = screen.getAllDisplays().find((d) => d.id === which)
  if (!match) log.warn(`display ${which} not found, using primary`)
  return match ?? primary
}

export async function captureScreen(options: CaptureOptions = {}): Promise<Capture> {
  const display = resolveDisplay(options.display)
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const size = display.size ?? display.bounds
  const thumbnailSize = {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }

  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  } catch (err) {
    throw new Error(`${CAPTURE_FAILED_MESSAGE}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (sources.length === 0) throw new Error(`${CAPTURE_FAILED_MESSAGE}: keine Bildschirmquelle gefunden.`)
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]!
  let image: NativeImage | undefined = source.thumbnail
  if (!image || image.isEmpty()) throw new Error(CAPTURE_FAILED_MESSAGE)

  const current = image.getSize()
  const target = fitLongEdge(current.width, current.height, options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE)
  if (target.width !== current.width || target.height !== current.height) {
    image = image.resize({ width: target.width, height: target.height, quality: 'good' })
  }

  const format = options.format ?? 'jpeg'
  const quality = Math.min(100, Math.max(1, Math.round(options.jpegQuality ?? DEFAULT_JPEG_QUALITY)))
  const buffer = format === 'png' ? image.toPNG() : image.toJPEG(quality)
  if (!buffer || buffer.length === 0) throw new Error(`${CAPTURE_FAILED_MESSAGE}: leeres Bild.`)
  const finalSize = image.getSize()
  return {
    base64: buffer.toString('base64'),
    mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
    width: finalSize.width,
    height: finalSize.height,
    bytes: buffer.length,
  }
}

/** Convenience for the orchestrator: JPEG with the limits from the screen-awareness config. */
export function captureForAwareness(config: ScreenAwarenessConfig, display: 'primary' | number = 'primary'): Promise<Capture> {
  return captureScreen({ display, maxLongEdge: config.maxLongEdge, jpegQuality: config.jpegQuality, format: 'jpeg' })
}
