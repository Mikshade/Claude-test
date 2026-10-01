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
 */
import type { BrowserWindow } from 'electron'
import type { FlowyConfig } from '@shared/config'
import type { Push, PushChannel } from '@shared/ipc'

export interface OverlayWindow {
  readonly window: BrowserWindow
  /** Toggle click-through. `interactive=true` means the character can be clicked. */
  setInteractive(interactive: boolean): void
  /** Give the overlay keyboard focus (chat input) or return focus to the previously active app. */
  setFocus(focused: boolean): void
  /** Show/hide the character (keeps the window alive). */
  setVisible(visible: boolean): void
  isVisible(): boolean
  /** Typed push to the overlay renderer. */
  send<C extends PushChannel>(channel: C, payload: Push[C]): void
  /** Re-fit to the configured display (call after config.display changes). */
  refit(config: FlowyConfig): void
  /** Stop polling, destroy the window. */
  dispose(): void
}

export interface OverlayOptions {
  config: FlowyConfig
  preloadPath: string
  /** Called when the window finished loading the page. */
  onReady?: () => void
}

export function createOverlayWindow(_options: OverlayOptions): OverlayWindow {
  throw new Error('not implemented: createOverlayWindow (src/main/windows/overlay.ts)')
}
