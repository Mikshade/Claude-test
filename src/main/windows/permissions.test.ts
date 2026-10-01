import type { Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decidePermission, installPermissionHandlers, isOwnOrigin } from './permissions'

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isOwnOrigin', () => {
  it('accepts file://, localhost dev server and the model scheme', () => {
    expect(isOwnOrigin('file:///C:/Flowy/out/renderer/overlay/index.html')).toBe(true)
    expect(isOwnOrigin('file://')).toBe(true)
    expect(isOwnOrigin('http://localhost:5173/overlay/index.html')).toBe(true)
    expect(isOwnOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isOwnOrigin('flowy-model://model/haru.model3.json')).toBe(true)
  })

  it('rejects foreign origins, opaque origins and garbage', () => {
    expect(isOwnOrigin('https://example.com')).toBe(false)
    expect(isOwnOrigin('http://localhost.evil.com')).toBe(false)
    expect(isOwnOrigin('https://cubism.live2d.com')).toBe(false)
    expect(isOwnOrigin('devtools://devtools/bundled/')).toBe(false)
    expect(isOwnOrigin('null')).toBe(false)
    expect(isOwnOrigin('')).toBe(false)
    expect(isOwnOrigin(undefined)).toBe(false)
    expect(isOwnOrigin(null)).toBe(false)
  })
})

describe('decidePermission', () => {
  const own = 'file:///out/renderer/overlay/index.html'

  it('grants the microphone, speaker selection and clipboard to our own pages only', () => {
    expect(decidePermission('media', own, { mediaTypes: ['audio'] })).toBe(true)
    expect(decidePermission('media', own)).toBe(true)
    expect(decidePermission('speaker-selection', own)).toBe(true)
    expect(decidePermission('clipboard-read', own)).toBe(true)
    expect(decidePermission('clipboard-sanitized-write', own)).toBe(true)
    expect(decidePermission('media', 'https://example.com', { mediaTypes: ['audio'] })).toBe(false)
    expect(decidePermission('clipboard-read', 'https://example.com')).toBe(false)
  })

  it('denies camera access even from our own pages', () => {
    expect(decidePermission('media', own, { mediaTypes: ['video'] })).toBe(false)
    expect(decidePermission('media', own, { mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(decidePermission('media', own, { mediaType: 'video' })).toBe(false)
    expect(decidePermission('media', own, { mediaType: 'audio' })).toBe(true)
    expect(decidePermission('media', own, { mediaType: 'unknown' })).toBe(true)
  })

  it('denies everything else', () => {
    for (const p of ['geolocation', 'notifications', 'display-capture', 'usb', 'hid', 'fullscreen', 'openExternal', 'unknown']) {
      expect(decidePermission(p, own)).toBe(false)
    }
  })
})

interface FakeSession {
  request: ((...args: unknown[]) => void) | null
  check: ((...args: unknown[]) => boolean) | null
  installs: number
  setPermissionRequestHandler(handler: FakeSession['request']): void
  setPermissionCheckHandler(handler: FakeSession['check']): void
}

function fakeSession(): FakeSession {
  return {
    request: null,
    check: null,
    installs: 0,
    setPermissionRequestHandler(handler) {
      this.installs++
      this.request = handler
    },
    setPermissionCheckHandler(handler) {
      this.installs++
      this.check = handler
    },
  }
}

describe('installPermissionHandlers', () => {
  it('installs both handlers once per session and wires them to the policy', () => {
    const ses = fakeSession()
    installPermissionHandlers(ses as unknown as Session)
    installPermissionHandlers(ses as unknown as Session)
    expect(ses.installs).toBe(2)

    const webContents = { getURL: () => 'file:///out/renderer/overlay/index.html' }
    const results: boolean[] = []
    const cb = (granted: boolean): void => {
      results.push(granted)
    }
    ses.request?.(webContents, 'media', cb, { requestingUrl: webContents.getURL(), isMainFrame: true, mediaTypes: ['audio'] })
    ses.request?.(webContents, 'media', cb, { requestingUrl: webContents.getURL(), isMainFrame: true, mediaTypes: ['video'] })
    ses.request?.(webContents, 'geolocation', cb, { requestingUrl: webContents.getURL(), isMainFrame: true })
    ses.request?.(webContents, 'clipboard-read', cb, { requestingUrl: 'https://evil.example', isMainFrame: true })
    // Falls back to the webContents URL when requestingUrl is empty.
    ses.request?.(webContents, 'speaker-selection', cb, { requestingUrl: '', isMainFrame: true })
    expect(results).toEqual([true, false, false, false, true])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("denied permission request 'geolocation'"))

    expect(ses.check?.(null, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(true)
    expect(ses.check?.(null, 'media', 'file://', { isMainFrame: true, mediaType: 'video' })).toBe(false)
    expect(ses.check?.(null, 'media', 'https://evil.example', { isMainFrame: true, mediaType: 'audio' })).toBe(false)
    expect(ses.check?.(null, 'notifications', 'file://', { isMainFrame: true })).toBe(false)
    // requestingUrl wins over the origin when present.
    expect(ses.check?.(null, 'clipboard-read', 'https://evil.example', { isMainFrame: true, requestingUrl: 'http://localhost:5173/x' })).toBe(true)
  })

  it('tolerates a webContents whose getURL throws', () => {
    const ses = fakeSession()
    installPermissionHandlers(ses as unknown as Session)
    const results: boolean[] = []
    const broken = {
      getURL: () => {
        throw new Error('gone')
      },
    }
    ses.request?.(broken, 'media', (g: boolean) => results.push(g), { requestingUrl: '', isMainFrame: true })
    expect(results).toEqual([false])
  })
})
