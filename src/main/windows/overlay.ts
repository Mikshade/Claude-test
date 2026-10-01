/**
 * The transparent, frameless, always-on-top, click-through overlay that hosts the character.
 *
 * OWNER: overlay agent. Responsibilities:
 *  - create the BrowserWindow covering the chosen display's work area (not `fullscreen: true`!)
 *  - keep it on top (level 'screen-saver'), skip taskbar, no shadow, not resizable, visible on all workspaces
 *  - click-through by default: setIgnoreMouseEvents(true, { forward: true }); the renderer calls
 *    'overlay:setInteractive' when the cursor is over the character
 *  - poll screen.getCursorScreenPoint() at ~60 Hz and push 'cursor:position' (in window-relative DIP coords)
 *  - react to display changes (screen 'display-metrics-changed') by re-fitting the bounds
 *  - load out/renderer/overlay/index.html (prod) or ELECTRON_RENDERER_URL + '/overlay/index.html' (dev)
 *
 * Focus model: the window is `focusable: true` because the chat input needs real keyboard focus, but it
 * must never take focus on its own – it is only ever shown with `showInactive()`, and `focus()` is only
 * called from `setFocus(true)` (chat opened by the user). `setFocus(false)` just blurs; Windows then
 * activates the next top-level window in z-order, which is usually – but not guaranteed to be – the app
 * the user came from (restoring the exact previous foreground window would need user32 calls).
 *
 * Windows notes (see research): `setAlwaysOnTop(true, 'screen-saver')` makes the window HWND_TOPMOST
 * above the taskbar; among topmost windows the last raised wins, so `moveTop()` is re-asserted every
 * few seconds. `setVisibleOnAllWorkspaces` is a no-op on Windows (harmless). Mouse forwarding stops
 * after a page reload (electron#15376), so click-through is re-applied on every 'did-finish-load'.
 */
import path from 'node:path'
import { BrowserWindow, type Display, type Rectangle, screen } from 'electron'
import type { FlowyConfig } from '@shared/config'
import type { Push, PushChannel } from '@shared/ipc'
import type { Point } from '@shared/state'
import { sendTo } from '../ipc'
import { createLogger } from '../log'
import { installPermissionHandlers } from './permissions'

const log = createLogger('overlay')

/** Cursor poll period (~60 Hz). */
export const CURSOR_POLL_MS = 16
/** Debounce for display add/remove/metrics events before re-fitting the bounds. */
export const REFIT_DEBOUNCE_MS = 300
/** Period for re-asserting the topmost z-order while visible. */
export const TOPMOST_REASSERT_MS = 5000
/** Grace period after hiding so the compositor has removed the window before a screenshot is taken. */
export const CAPTURE_HIDE_SETTLE_MS = 40

export interface OverlayWindow {
  readonly window: BrowserWindow
  /** Toggle click-through. `interactive=true` means the character can be clicked. */
  setInteractive(interactive: boolean): void
  isInteractive(): boolean
  /** Give the overlay keyboard focus (chat input) or return focus to the previously active app. */
  setFocus(focused: boolean): void
  /** Show/hide the character (keeps the window alive). */
  setVisible(visible: boolean): void
  isVisible(): boolean
  /** Typed push to the overlay renderer. */
  send<C extends PushChannel>(channel: C, payload: Push[C]): void
  /** Re-fit to the configured display (call after config.display changes). Remembers the config. */
  refit(config: FlowyConfig): void
  /** Remember a new config without re-fitting (used by the display-change debounce). */
  setConfig(config: FlowyConfig): void
  /** The display the overlay currently covers. */
  currentDisplay(): Display
  /** Re-assert the topmost z-order (cheap; also runs periodically while visible). */
  moveTop(): void
  /**
   * Hide the window, run `fn` (e.g. a screenshot), then show it again without focus. Fallback for
   * when `setContentProtection` does not keep her out of her own screenshots; the orchestrator decides.
   */
  withHiddenForCapture<T>(fn: () => Promise<T>): Promise<T>
  /** Stop polling, destroy the window. */
  dispose(): void
}

export interface OverlayOptions {
  config: FlowyConfig
  preloadPath: string
  /** Called when the window finished loading the page. */
  onReady?: () => void
  /**
   * `win.setContentProtection(true)` (WDA_EXCLUDEFROMCAPTURE) so she is not in her own screenshots.
   * Default true. Untested together with the layered (click-through) window style – if screenshots
   * still show her, pass false and use `withHiddenForCapture` instead.
   */
  excludeFromCapture?: boolean
}

/** Convert a screen point (DIP) to window-relative coordinates (DIP == CSS px in the renderer). */
export function toWindowRelative(point: Point, bounds: Rectangle): Point {
  return { x: point.x - bounds.x, y: point.y - bounds.y }
}

/** Pick the configured display: 'primary' or a display id, falling back to the primary when it is gone. */
export function pickDisplay(selector: FlowyConfig['display'], displays: readonly Display[], primary: Display): Display {
  if (selector === 'primary') return primary
  return displays.find((d) => d.id === selector) ?? primary
}

function resolveDisplay(config: FlowyConfig): Display {
  return pickDisplay(config.display, screen.getAllDisplays(), screen.getPrimaryDisplay())
}

function samePoint(a: Point | null, b: Point): boolean {
  return a !== null && a.x === b.x && a.y === b.y
}

export function createOverlayWindow(options: OverlayOptions): OverlayWindow {
  let config = options.config
  let display = resolveDisplay(config)
  const area = display.workArea

  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
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
    // Must be focusable: the chat input needs keyboard focus. We never call show()/focus() ourselves.
    focusable: true,
    // Transparent windows must not have a thick frame or rounded corners (Win11 would clip the edges).
    thickFrame: false,
    roundedCorners: false,
    // WS_EX_TOOLWINDOW: keeps her out of Alt+Tab (skipTaskbar alone only hides the taskbar button).
    ...(process.platform === 'win32' ? { type: 'toolbar' as const } : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The window is never focused; without this Chromium throttles rAF/timers to ~1 fps.
      backgroundThrottling: false,
      additionalArguments: ['--flowy-page=overlay'],
      spellcheck: false,
    },
  })

  installPermissionHandlers(win.webContents.session)

  // 'screen-saver' = HWND_TOPMOST above the taskbar on Windows; all topmost windows share one band and the
  // last raised wins, hence the periodic moveTop() below.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setMenuBarVisibility(false)
  if (options.excludeFromCapture !== false) {
    // WDA_EXCLUDEFROMCAPTURE (Win10 2004+): she disappears from desktopCapturer screenshots. NOTE: untested
    // in combination with the WS_EX_LAYERED style that setIgnoreMouseEvents() applies – verify on Windows.
    win.setContentProtection(true)
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env['FLOWY_DEBUG']) {
    // Attached DevTools would kill the transparency.
    win.webContents.openDevTools({ mode: 'detach' })
  }

  // ---- click-through ---------------------------------------------------------------------------
  let interactive = false
  function applyClickThrough(): void {
    if (win.isDestroyed()) return
    if (interactive) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: true })
  }
  function setInteractive(next: boolean): void {
    if (next === interactive) return
    interactive = next
    applyClickThrough()
    log.debug(`interactive=${next}`)
  }
  applyClickThrough()

  // ---- visibility --------------------------------------------------------------------------------
  /** Logical state ("the character is shown"); the window may additionally be hidden for a capture. */
  let wantVisible = true
  /** True once 'ready-to-show' or 'did-finish-load' fired – before that showInactive() would show an empty window. */
  let pageLoaded = false
  let disposed = false

  function showIfWanted(): void {
    if (disposed || win.isDestroyed()) return
    pageLoaded = true
    if (wantVisible && !win.isVisible()) win.showInactive()
    updateTimers()
  }

  // ---- cursor polling + topmost re-assert ------------------------------------------------------
  let pollTimer: NodeJS.Timeout | null = null
  let topTimer: NodeJS.Timeout | null = null
  let lastCursor: Point | null = null

  function poll(): void {
    if (win.isDestroyed() || !win.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    if (samePoint(lastCursor, cursor)) return
    lastCursor = cursor
    sendTo(win, 'cursor:position', toWindowRelative(cursor, win.getBounds()))
  }

  function moveTop(): void {
    if (win.isDestroyed() || !win.isVisible()) return
    win.moveTop()
  }

  function updateTimers(): void {
    const shouldRun = !disposed && wantVisible && !win.isDestroyed() && win.isVisible()
    if (shouldRun && pollTimer === null) {
      lastCursor = null
      pollTimer = setInterval(poll, CURSOR_POLL_MS)
      topTimer = setInterval(moveTop, TOPMOST_REASSERT_MS)
    } else if (!shouldRun && pollTimer !== null) {
      stopTimers()
    }
  }

  function stopTimers(): void {
    if (pollTimer !== null) clearInterval(pollTimer)
    if (topTimer !== null) clearInterval(topTimer)
    pollTimer = null
    topTimer = null
  }

  // ---- display changes ---------------------------------------------------------------------------
  let refitTimer: NodeJS.Timeout | null = null

  function refit(next: FlowyConfig): void {
    config = next
    if (win.isDestroyed()) return
    display = resolveDisplay(config)
    const workArea = display.workArea
    const current = win.getBounds()
    if (
      current.x !== workArea.x ||
      current.y !== workArea.y ||
      current.width !== workArea.width ||
      current.height !== workArea.height
    ) {
      win.setBounds({ ...workArea })
      const { x, y, width, height } = workArea
      log.info(`fitted to display ${display.id} work area ${width}x${height}@${x},${y}`)
    }
    lastCursor = null // bounds changed → re-send the cursor position
    if (win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver')
  }

  function scheduleRefit(): void {
    if (disposed) return
    if (refitTimer !== null) clearTimeout(refitTimer)
    refitTimer = setTimeout(() => {
      refitTimer = null
      refit(config)
    }, REFIT_DEBOUNCE_MS)
  }

  const onDisplayChange = (): void => scheduleRefit()
  screen.on('display-metrics-changed', onDisplayChange)
  screen.on('display-added', onDisplayChange)
  screen.on('display-removed', onDisplayChange)

  // ---- page load ---------------------------------------------------------------------------------
  win.once('ready-to-show', showIfWanted)
  win.webContents.on('did-finish-load', () => {
    // Mouse forwarding is lost after (re)loads (electron#15376) – re-apply the current mode.
    applyClickThrough()
    showIfWanted()
    try {
      options.onReady?.()
    } catch (err) {
      log.error('onReady handler threw', err)
    }
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`overlay renderer gone: ${details.reason}`)
  })
  win.on('closed', () => {
    stopTimers()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loading = devUrl
    ? win.loadURL(`${devUrl}/overlay/index.html`)
    : win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'))
  loading.catch((err: unknown) => log.error('overlay page failed to load', err))

  // ---- public API --------------------------------------------------------------------------------
  function setVisible(visible: boolean): void {
    if (win.isDestroyed()) return
    wantVisible = visible
    if (visible) {
      if (pageLoaded) win.showInactive()
    } else {
      win.hide()
    }
    updateTimers()
    sendTo(win, 'avatar:setVisible', visible)
  }

  function setFocus(focused: boolean): void {
    if (win.isDestroyed()) return
    if (focused) {
      if (!win.isVisible() && wantVisible) win.showInactive()
      win.moveTop()
      // Activation from a background process can be refused by Windows (SetForegroundWindow rules); it works
      // after our global hotkey (the hotkey message grants foreground rights) or a click on her.
      win.focus()
    } else {
      win.blur()
    }
  }

  async function withHiddenForCapture<T>(fn: () => Promise<T>): Promise<T> {
    const hide = !win.isDestroyed() && win.isVisible()
    if (hide) {
      win.hide()
      await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_HIDE_SETTLE_MS))
    }
    try {
      return await fn()
    } finally {
      if (hide && !disposed && wantVisible && !win.isDestroyed() && !win.isVisible()) win.showInactive()
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stopTimers()
    if (refitTimer !== null) clearTimeout(refitTimer)
    refitTimer = null
    screen.removeListener('display-metrics-changed', onDisplayChange)
    screen.removeListener('display-added', onDisplayChange)
    screen.removeListener('display-removed', onDisplayChange)
    if (!win.isDestroyed()) win.destroy()
    log.debug('disposed')
  }

  log.info(`overlay created on display ${display.id} (${area.width}x${area.height}@${area.x},${area.y})`)

  return {
    window: win,
    setInteractive,
    isInteractive: () => interactive,
    setFocus,
    setVisible,
    isVisible: () => wantVisible && !win.isDestroyed(),
    send: (channel, payload) => sendTo(win, channel, payload),
    refit,
    setConfig: (next) => {
      config = next
    },
    currentDisplay: () => display,
    moveTop,
    withHiddenForCapture,
    dispose,
  }
}
