/**
 * Settings / first-run wizard window (a normal, focusable window).
 *
 * OWNER: settings-window agent (main side) – the page itself is src/renderer/settings.
 */
import type { BrowserWindow } from 'electron'
import type { Push, PushChannel } from '@shared/ipc'

export interface SettingsWindowManager {
  /** Open (or focus) the settings window, optionally jumping to a page id such as 'voice' or 'wizard'. */
  open(page?: string): BrowserWindow
  current(): BrowserWindow | null
  send<C extends PushChannel>(channel: C, payload: Push[C]): void
  close(): void
}

export interface SettingsWindowOptions {
  preloadPath: string
  /** Shown as the window title. */
  title: string
}

export function createSettingsWindowManager(_options: SettingsWindowOptions): SettingsWindowManager {
  throw new Error('not implemented: createSettingsWindowManager (src/main/windows/settings.ts)')
}
