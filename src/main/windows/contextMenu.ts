/**
 * Right-click menu on the character (popup Menu anchored to the overlay window).
 *
 * OWNER: settings-window agent.
 */
import type { BrowserWindow } from 'electron'
import type { TrayActions } from '../tray'

export function showCharacterMenu(_win: BrowserWindow | null, _actions: TrayActions): void {
  throw new Error('not implemented: showCharacterMenu (src/main/windows/contextMenu.ts)')
}
