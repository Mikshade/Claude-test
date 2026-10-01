import * as electron from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScreenAwarenessConfig } from '@shared/config'
import { CAPTURE_FAILED_MESSAGE, captureForAwareness, captureScreen, fitLongEdge, resolveDisplay } from './screenshot'

/** Test-helper surface of tests/mocks/electron.ts (vitest aliases 'electron' there). */
interface FakeNativeImage {
  _resizeCalls: Array<{ width?: number; height?: number; quality?: string }>
  getSize(): { width: number; height: number }
}
interface MockDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}
interface ElectronMockHelpers {
  screen: { _displays: MockDisplay[]; _reset(): void }
  desktopCapturer: {
    _sources: Array<{ id: string; name: string; display_id: string; thumbnail: FakeNativeImage }>
    _lastOptions: null | { types: string[]; thumbnailSize?: { width: number; height: number } }
    _error: Error | null
    _reset(): void
  }
  createFakeNativeImage(width: number, height: number): FakeNativeImage
  mockDisplay(id: number, x?: number, y?: number, width?: number, height?: number): MockDisplay
}
const { screen, desktopCapturer, createFakeNativeImage, mockDisplay } = electron as unknown as ElectronMockHelpers

function addSource(displayId: number, width: number, height: number) {
  const thumbnail = createFakeNativeImage(width, height)
  desktopCapturer._sources.push({ id: `screen:${displayId}:0`, name: `Screen ${displayId}`, display_id: String(displayId), thumbnail })
  return thumbnail
}

beforeEach(() => {
  screen._reset()
  desktopCapturer._reset()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fitLongEdge', () => {
  it('scales down proportionally and never upscales', () => {
    expect(fitLongEdge(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 })
    expect(fitLongEdge(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 })
    expect(fitLongEdge(800, 600, 1280)).toEqual({ width: 800, height: 600 })
    expect(fitLongEdge(3840, 2160, 1000)).toEqual({ width: 1000, height: 563 })
    expect(fitLongEdge(0, 0, 100)).toEqual({ width: 0, height: 0 })
    expect(fitLongEdge(100, 50, 0)).toEqual({ width: 100, height: 50 })
  })
})

describe('resolveDisplay', () => {
  it('returns the primary display for "primary"/undefined and matches ids with a fallback', () => {
    screen._displays = [mockDisplay(1), mockDisplay(2, 1920, 0, 2560, 1440)]
    expect(resolveDisplay('primary').id).toBe(1)
    expect(resolveDisplay(undefined).id).toBe(1)
    expect(resolveDisplay(2).id).toBe(2)
    expect(resolveDisplay(99).id).toBe(1)
  })
})

describe('captureScreen', () => {
  it('requests a physical-size thumbnail, downscales to 1280 long edge and returns JPEG q70 by default', async () => {
    const thumbnail = addSource(1, 1920, 1080)
    const capture = await captureScreen()
    expect(desktopCapturer._lastOptions).toEqual({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } })
    expect(thumbnail._resizeCalls).toEqual([{ width: 1280, height: 720, quality: 'good' }])
    expect(capture).toMatchObject({ mediaType: 'image/jpeg', width: 1280, height: 720 })
    const bytes = Buffer.from(capture.base64, 'base64')
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    expect(bytes[3]).toBe(70)
    expect(capture.bytes).toBe(bytes.length)
  })

  it('multiplies the thumbnail size by the scale factor', async () => {
    const display = mockDisplay(1)
    display.scaleFactor = 2
    screen._displays = [display]
    addSource(1, 3840, 2160)
    await captureScreen({ maxLongEdge: 1920 })
    expect(desktopCapturer._lastOptions?.thumbnailSize).toEqual({ width: 3840, height: 2160 })
  })

  it('picks the source whose display_id matches and falls back to the first source', async () => {
    screen._displays = [mockDisplay(1), mockDisplay(2, 1920, 0, 1280, 1024)]
    addSource(1, 1920, 1080)
    const second = addSource(2, 1280, 1024)
    const capture = await captureScreen({ display: 2, format: 'png' })
    expect(desktopCapturer._lastOptions?.thumbnailSize).toEqual({ width: 1280, height: 1024 })
    expect(second._resizeCalls).toEqual([])
    expect(capture).toMatchObject({ mediaType: 'image/png', width: 1280, height: 1024 })
    expect(Buffer.from(capture.base64, 'base64').subarray(0, 2)).toEqual(Buffer.from([0x89, 0x50]))

    desktopCapturer._reset()
    const only = addSource(7, 640, 480)
    const fallback = await captureScreen({ display: 2 })
    expect(only._resizeCalls).toEqual([])
    expect(fallback).toMatchObject({ width: 640, height: 480 })
  })

  it('honours maxLongEdge and jpegQuality', async () => {
    const thumbnail = addSource(1, 1920, 1080)
    const capture = await captureScreen({ maxLongEdge: 640, jpegQuality: 45 })
    expect(thumbnail._resizeCalls).toEqual([{ width: 640, height: 360, quality: 'good' }])
    expect(Buffer.from(capture.base64, 'base64')[3]).toBe(45)
    expect(capture).toMatchObject({ width: 640, height: 360 })
  })

  it('throws readable errors for empty images, missing sources and capturer failures', async () => {
    addSource(1, 0, 0)
    await expect(captureScreen()).rejects.toThrow(CAPTURE_FAILED_MESSAGE)
    desktopCapturer._reset()
    await expect(captureScreen()).rejects.toThrow(/keine Bildschirmquelle/)
    desktopCapturer._error = new Error('permission denied')
    await expect(captureScreen()).rejects.toThrow(`${CAPTURE_FAILED_MESSAGE}: permission denied`)
  })
})

describe('captureForAwareness', () => {
  it('uses the limits from the screen-awareness config', async () => {
    const thumbnail = addSource(1, 1920, 1080)
    const config: ScreenAwarenessConfig = { mode: 'always', includeActiveWindow: true, maxLongEdge: 1000, jpegQuality: 50 }
    const capture = await captureForAwareness(config)
    expect(thumbnail._resizeCalls).toEqual([{ width: 1000, height: 563, quality: 'good' }])
    expect(capture.mediaType).toBe('image/jpeg')
    expect(Buffer.from(capture.base64, 'base64')[3]).toBe(50)
  })
})
