import { BrowserWindow as ElectronBrowserWindow, type Display, screen as electronScreen } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type FlowyConfig } from '@shared/config'
import {
  CAPTURE_HIDE_SETTLE_MS,
  createOverlayWindow,
  CURSOR_POLL_MS,
  type OverlayWindow,
  pickDisplay,
  REFIT_DEBOUNCE_MS,
  TOPMOST_REASSERT_MS,
  toWindowRelative,
} from './overlay'

/** Test-helper surface of the stateful mocks in tests/mocks/electron.ts. */
interface MockDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}
interface MockScreen {
  _displays: MockDisplay[]
  _cursor: { x: number; y: number }
  _reset(): void
  emit(event: string, ...args: unknown[]): boolean
  listenerCount(event: string): number
}
interface MockWindow {
  options: Record<string, unknown>
  _calls: Array<{ method: string; args: unknown[] }>
  _shown: boolean
  _focused: boolean
  _destroyed: boolean
  _ignoreMouse: { ignore: boolean; forward: boolean } | null
  getBounds(): { x: number; y: number; width: number; height: number }
  isVisible(): boolean
  isDestroyed(): boolean
  emit(event: string, ...args: unknown[]): boolean
  webContents: { _sent: Array<{ channel: string; payload: unknown }>; emit(event: string, ...args: unknown[]): boolean }
}
const screen = electronScreen as unknown as MockScreen
const Win = ElectronBrowserWindow as unknown as { _instances: MockWindow[]; _reset(): void }

/** Only the fields the overlay reads; cast because Electron's Display has many more. */
function display(id: number, x = 0, y = 0, width = 1920, height = 1080, taskbar = 40): Display {
  const d: MockDisplay = {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height: height - taskbar },
    scaleFactor: 1,
  }
  return d as unknown as Display
}

function calls(win: MockWindow, method: string): unknown[][] {
  return win._calls.filter((c) => c.method === method).map((c) => c.args)
}

function sent(win: MockWindow, channel: string): unknown[] {
  return win.webContents._sent.filter((s) => s.channel === channel).map((s) => s.payload)
}

function config(partial: Partial<FlowyConfig> = {}): FlowyConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...partial }
}

/** Create an overlay and simulate the page having loaded. */
type Booted = { overlay: OverlayWindow; win: MockWindow }
type OverlayExtra = Partial<Parameters<typeof createOverlayWindow>[0]>

function boot(cfg: FlowyConfig = config(), extra: OverlayExtra = {}): Booted {
  const overlay = createOverlayWindow({ config: cfg, preloadPath: '/out/preload/index.js', ...extra })
  const win = overlay.window as unknown as MockWindow
  win.emit('ready-to-show')
  win.webContents.emit('did-finish-load')
  return { overlay, win }
}

let created: OverlayWindow[] = []

beforeEach(() => {
  vi.useFakeTimers()
  screen._reset()
  Win._reset()
  created = []
  vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
  vi.stubEnv('FLOWY_DEBUG', undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  for (const o of created) o.dispose()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function track(result: Booted): Booted {
  created.push(result.overlay)
  return result
}

describe('toWindowRelative', () => {
  it('subtracts the window origin (DIP)', () => {
    expect(toWindowRelative({ x: 100, y: 50 }, { x: 0, y: 0, width: 10, height: 10 })).toEqual({ x: 100, y: 50 })
    expect(toWindowRelative({ x: 2020, y: 150 }, { x: 1920, y: 0, width: 10, height: 10 })).toEqual({ x: 100, y: 150 })
    const leftOfPrimary = { x: -1920, y: -200, width: 10, height: 10 }
    expect(toWindowRelative({ x: -5, y: 10 }, leftOfPrimary)).toEqual({ x: 1915, y: 210 })
  })
})

describe('pickDisplay', () => {
  const primary = display(1)
  const second = display(2, 1920, 0, 2560, 1440)

  it("returns the primary for 'primary' and the matching id otherwise", () => {
    expect(pickDisplay('primary', [primary, second], primary)).toBe(primary)
    expect(pickDisplay(2, [primary, second], primary)).toBe(second)
    expect(pickDisplay(1, [second, primary], primary)).toBe(primary)
  })

  it('falls back to the primary when the id is unknown (display unplugged)', () => {
    expect(pickDisplay(42, [primary, second], primary)).toBe(primary)
    expect(pickDisplay(2, [primary], primary)).toBe(primary)
  })
})

describe('createOverlayWindow', () => {
  it('creates a transparent, non-focus-stealing window on the work area of the configured display', () => {
    screen._displays = [display(1), display(7, 1920, 0, 2560, 1440, 48)]
    const { overlay, win } = track(boot(config({ display: 7 })))
    expect(win.options).toMatchObject({
      x: 1920,
      y: 0,
      width: 2560,
      height: 1392,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      title: 'Flowy',
      focusable: true,
    })
    expect(win.options['fullscreen']).toBeUndefined()
    expect(win.options['webPreferences']).toMatchObject({
      preload: '/out/preload/index.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: ['--flowy-page=overlay'],
      spellcheck: false,
    })
    expect(calls(win, 'setAlwaysOnTop')[0]).toEqual([true, 'screen-saver'])
    expect(calls(win, 'setVisibleOnAllWorkspaces')[0]).toEqual([true, { visibleOnFullScreen: true }])
    expect(calls(win, 'setMenuBarVisibility')[0]).toEqual([false])
    expect(calls(win, 'setContentProtection')).toEqual([[true]])
    expect(calls(win, 'loadFile')[0]?.[0]).toMatch(/renderer[\\/]overlay[\\/]index\.html$/)
    expect(calls(win, 'loadURL')).toEqual([])
    // Shown without focus, never show()/focus().
    expect(calls(win, 'showInactive').length).toBeGreaterThanOrEqual(1)
    expect(calls(win, 'show')).toEqual([])
    expect(calls(win, 'focus')).toEqual([])
    expect(win._focused).toBe(false)
    expect(overlay.isVisible()).toBe(true)
    expect(overlay.currentDisplay().id).toBe(7)
  })

  it('falls back to the primary display and honours excludeFromCapture=false and the dev server URL', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const { overlay, win } = track(boot(config({ display: 99 }), { excludeFromCapture: false }))
    expect(overlay.currentDisplay().id).toBe(1)
    expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
    expect(calls(win, 'setContentProtection')).toEqual([])
    expect(calls(win, 'loadURL')).toEqual([['http://localhost:5173/overlay/index.html']])
    expect(calls(win, 'loadFile')).toEqual([])
  })

  it('calls onReady after did-finish-load and survives a throwing handler', () => {
    const onReady = vi.fn(() => {
      throw new Error('boom')
    })
    const overlay = createOverlayWindow({ config: config(), preloadPath: 'p', onReady })
    created.push(overlay)
    const win = overlay.window as unknown as MockWindow
    expect(onReady).not.toHaveBeenCalled()
    expect(() => win.webContents.emit('did-finish-load')).not.toThrow()
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('onReady handler threw'))
  })

  describe('click-through', () => {
    it('is click-through with forwarding by default and toggles idempotently', () => {
      const { overlay, win } = track(boot())
      expect(win._ignoreMouse).toEqual({ ignore: true, forward: true })
      const before = calls(win, 'setIgnoreMouseEvents').length
      expect(overlay.isInteractive()).toBe(false)

      overlay.setInteractive(true)
      overlay.setInteractive(true)
      overlay.setInteractive(true)
      expect(win._ignoreMouse).toEqual({ ignore: false, forward: false })
      expect(calls(win, 'setIgnoreMouseEvents').length).toBe(before + 1)
      expect(calls(win, 'setIgnoreMouseEvents').at(-1)).toEqual([false, undefined])
      expect(overlay.isInteractive()).toBe(true)

      overlay.setInteractive(false)
      overlay.setInteractive(false)
      expect(win._ignoreMouse).toEqual({ ignore: true, forward: true })
      expect(calls(win, 'setIgnoreMouseEvents').length).toBe(before + 2)
      expect(calls(win, 'setIgnoreMouseEvents').at(-1)).toEqual([true, { forward: true }])
    })

    it('re-applies the current mode after every page load (forwarding is lost on reload)', () => {
      const { overlay, win } = track(boot())
      overlay.setInteractive(true)
      const before = calls(win, 'setIgnoreMouseEvents').length
      win.webContents.emit('did-finish-load')
      expect(calls(win, 'setIgnoreMouseEvents').length).toBe(before + 1)
      expect(calls(win, 'setIgnoreMouseEvents').at(-1)).toEqual([false, undefined])
      overlay.setInteractive(false)
      win.webContents.emit('did-finish-load')
      expect(calls(win, 'setIgnoreMouseEvents').at(-1)).toEqual([true, { forward: true }])
    })
  })

  describe('cursor polling', () => {
    it('sends window-relative positions only when the cursor moved', () => {
      screen._displays = [display(1), display(2, 1920, 0, 1920, 1080)]
      const { win } = track(boot(config({ display: 2 })))
      screen._cursor = { x: 2000, y: 100 }
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position')).toEqual([{ x: 80, y: 100 }])

      vi.advanceTimersByTime(CURSOR_POLL_MS * 10)
      expect(sent(win, 'cursor:position')).toHaveLength(1)

      screen._cursor = { x: 2001, y: 100 }
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position')).toEqual([
        { x: 80, y: 100 },
        { x: 81, y: 100 },
      ])
      // Positions outside the window are still reported (negative / larger than the bounds).
      screen._cursor = { x: 10, y: 10 }
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position').at(-1)).toEqual({ x: -1910, y: 10 })
    })

    it('pauses while hidden and resumes (re-sending the position) when shown again', () => {
      const { overlay, win } = track(boot())
      screen._cursor = { x: 5, y: 5 }
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position')).toHaveLength(1)

      overlay.setVisible(false)
      expect(overlay.isVisible()).toBe(false)
      expect(win.isVisible()).toBe(false)
      expect(sent(win, 'avatar:setVisible')).toEqual([false])
      screen._cursor = { x: 6, y: 6 }
      vi.advanceTimersByTime(CURSOR_POLL_MS * 20)
      expect(sent(win, 'cursor:position')).toHaveLength(1)

      overlay.setVisible(true)
      expect(overlay.isVisible()).toBe(true)
      expect(win.isVisible()).toBe(true)
      expect(calls(win, 'show')).toEqual([])
      expect(sent(win, 'avatar:setVisible')).toEqual([false, true])
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position')).toEqual([
        { x: 5, y: 5 },
        { x: 6, y: 6 },
      ])
    })

    it('does not poll before the page is shown', () => {
      const overlay = createOverlayWindow({ config: config(), preloadPath: 'p' })
      created.push(overlay)
      const win = overlay.window as unknown as MockWindow
      screen._cursor = { x: 5, y: 5 }
      vi.advanceTimersByTime(CURSOR_POLL_MS * 5)
      expect(sent(win, 'cursor:position')).toEqual([])
      win.emit('ready-to-show')
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position')).toEqual([{ x: 5, y: 5 }])
    })
  })

  it('re-asserts the topmost z-order periodically while visible', () => {
    const { overlay, win } = track(boot())
    const before = calls(win, 'moveTop').length
    vi.advanceTimersByTime(TOPMOST_REASSERT_MS * 2)
    expect(calls(win, 'moveTop').length).toBe(before + 2)
    overlay.setVisible(false)
    vi.advanceTimersByTime(TOPMOST_REASSERT_MS * 2)
    expect(calls(win, 'moveTop').length).toBe(before + 2)
  })

  describe('focus', () => {
    it('focuses only on request and blurs to give focus back', () => {
      const { overlay, win } = track(boot())
      expect(calls(win, 'focus')).toEqual([])
      overlay.setFocus(true)
      expect(calls(win, 'focus')).toHaveLength(1)
      expect(calls(win, 'moveTop').length).toBeGreaterThanOrEqual(1)
      expect(win._focused).toBe(true)
      overlay.setFocus(false)
      expect(calls(win, 'blur')).toHaveLength(1)
      expect(win._focused).toBe(false)
    })
  })

  describe('refit / display changes', () => {
    it('refit(config) moves the window to the new display work area and remembers the config', () => {
      screen._displays = [display(1), display(2, 1920, 0, 2560, 1440, 50)]
      const { overlay, win } = track(boot())
      expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
      overlay.refit(config({ display: 2 }))
      expect(win.getBounds()).toEqual({ x: 1920, y: 0, width: 2560, height: 1390 })
      expect(overlay.currentDisplay().id).toBe(2)
      // Same bounds → no redundant setBounds.
      const n = calls(win, 'setBounds').length
      overlay.refit(config({ display: 2 }))
      expect(calls(win, 'setBounds').length).toBe(n)
      // Cursor is re-sent after a refit even when unchanged.
      screen._cursor = { x: 2000, y: 10 }
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position').at(-1)).toEqual({ x: 80, y: 10 })
    })

    it('debounces screen events (300 ms) and re-fits with the latest config', () => {
      screen._displays = [display(1), display(2, 1920, 0, 2560, 1440)]
      const { overlay, win } = track(boot(config({ display: 2 })))
      expect(screen.listenerCount('display-metrics-changed')).toBe(1)
      expect(screen.listenerCount('display-added')).toBe(1)
      expect(screen.listenerCount('display-removed')).toBe(1)
      const n = calls(win, 'setBounds').length

      // Display 2 unplugged → fall back to primary, but only after the debounce.
      screen._displays = [display(1)]
      screen.emit('display-removed', {}, display(2))
      screen.emit('display-metrics-changed', {}, display(1), ['workArea'])
      vi.advanceTimersByTime(REFIT_DEBOUNCE_MS - 1)
      expect(calls(win, 'setBounds').length).toBe(n)
      vi.advanceTimersByTime(1)
      expect(calls(win, 'setBounds').length).toBe(n + 1)
      expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
      expect(overlay.currentDisplay().id).toBe(1)

      // Display comes back with a different work area; setConfig() changes the target without a refit.
      screen._displays = [display(1), display(2, 1920, 0, 2560, 1440, 60)]
      overlay.setConfig(config({ display: 2 }))
      expect(calls(win, 'setBounds').length).toBe(n + 1)
      screen.emit('display-added', {}, display(2))
      vi.advanceTimersByTime(REFIT_DEBOUNCE_MS)
      expect(win.getBounds()).toEqual({ x: 1920, y: 0, width: 2560, height: 1380 })

      // A taskbar resize on the current display is applied too.
      screen._displays = [display(1), display(2, 1920, 0, 2560, 1440, 100)]
      screen.emit('display-metrics-changed', {}, display(2), ['workArea'])
      vi.advanceTimersByTime(REFIT_DEBOUNCE_MS)
      expect(win.getBounds()).toEqual({ x: 1920, y: 0, width: 2560, height: 1340 })
    })
  })

  describe('withHiddenForCapture', () => {
    it('hides, waits for the compositor, runs fn and shows again without focus', async () => {
      const { overlay, win } = track(boot())
      const order: string[] = []
      const p = overlay.withHiddenForCapture(async () => {
        order.push(`fn visible=${win.isVisible()}`)
        return 42
      })
      expect(win.isVisible()).toBe(false)
      expect(order).toEqual([]) // waits CAPTURE_HIDE_SETTLE_MS before capturing
      await vi.advanceTimersByTimeAsync(CAPTURE_HIDE_SETTLE_MS)
      await expect(p).resolves.toBe(42)
      expect(order).toEqual(['fn visible=false'])
      expect(win.isVisible()).toBe(true)
      expect(calls(win, 'show')).toEqual([])
      expect(calls(win, 'showInactive').length).toBeGreaterThanOrEqual(2)
      // The character stays logically visible – no avatar:setVisible pushes.
      expect(sent(win, 'avatar:setVisible')).toEqual([])
    })

    it('restores visibility even when fn throws, and leaves a hidden overlay hidden', async () => {
      const { overlay, win } = track(boot())
      const p = overlay.withHiddenForCapture(async () => {
        throw new Error('capture failed')
      })
      const rejected = expect(p).rejects.toThrow('capture failed') // attach before the timer fires
      await vi.advanceTimersByTimeAsync(CAPTURE_HIDE_SETTLE_MS)
      await rejected
      expect(win.isVisible()).toBe(true)

      overlay.setVisible(false)
      const hides = calls(win, 'hide').length
      await expect(overlay.withHiddenForCapture(async () => 'x')).resolves.toBe('x')
      expect(calls(win, 'hide').length).toBe(hides)
      expect(win.isVisible()).toBe(false)
    })
  })

  describe('send / dispose', () => {
    it('send() is typed and silent once the window is destroyed', () => {
      const { overlay, win } = track(boot())
      overlay.send('state:changed', 'idle')
      expect(sent(win, 'state:changed')).toEqual(['idle'])
      overlay.dispose()
      overlay.send('state:changed', 'speaking')
      expect(sent(win, 'state:changed')).toEqual(['idle'])
      expect(overlay.isVisible()).toBe(false)
    })

    it('dispose() stops timers, removes screen listeners and destroys the window (idempotent)', () => {
      const { overlay, win } = track(boot())
      screen._cursor = { x: 1, y: 1 }
      vi.advanceTimersByTime(CURSOR_POLL_MS)
      expect(sent(win, 'cursor:position')).toHaveLength(1)
      screen.emit('display-metrics-changed', {}, display(1), ['workArea'])

      overlay.dispose()
      expect(win.isDestroyed()).toBe(true)
      expect(screen.listenerCount('display-metrics-changed')).toBe(0)
      expect(screen.listenerCount('display-added')).toBe(0)
      expect(screen.listenerCount('display-removed')).toBe(0)

      screen._cursor = { x: 2, y: 2 }
      vi.advanceTimersByTime(REFIT_DEBOUNCE_MS + CURSOR_POLL_MS * 5 + TOPMOST_REASSERT_MS)
      expect(sent(win, 'cursor:position')).toHaveLength(1)
      expect(() => overlay.dispose()).not.toThrow()
      expect(() => overlay.setInteractive(true)).not.toThrow()
      expect(() => overlay.setVisible(true)).not.toThrow()
      expect(() => overlay.setFocus(true)).not.toThrow()
      expect(() => overlay.refit(config())).not.toThrow()
    })
  })
})
