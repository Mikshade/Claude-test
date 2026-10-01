/**
 * Right-click menu on the character (popup Menu anchored to the overlay window).
 *
 * OWNER: settings-window agent.
 *
 * Shares the actions and labels of the tray menu. When the caller passes the current config + flags
 * (`context`), the menu shows the same checkmarks and the configured language; without it the items
 * are plain (German default) so the existing `showCharacterMenu(win, actions)` call keeps working.
 */
import { type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { FlowyConfig, Language } from '@shared/config'
import type { CompanionState } from '@shared/state'
import { buildTrayTemplate, type TrayActions, type TrayFlags, trayString } from '../tray'

export interface CharacterMenuContext {
  config: FlowyConfig
  flags: TrayFlags
  state?: CompanionState
}

/** Pure: template of the character context menu ('Einstellungen…' first, then the tray actions). */
export function buildCharacterMenuTemplate(
  actions: TrayActions,
  context?: CharacterMenuContext,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  if (context) {
    return buildTrayTemplate(context.config, context.state ?? 'idle', context.flags, context.config.character.language, actions, platform)
  }
  const lang: Language = 'de'
  return [
    { id: 'settings', label: trayString('settings', lang), click: () => actions.openSettings() },
    { type: 'separator' },
    { id: 'pinned', label: trayString('pinned', lang), click: () => actions.togglePinned() },
    { id: 'muted', label: trayString('muted', lang), click: () => actions.toggleMuted() },
    { id: 'visibility', label: trayString('hide', lang), click: () => actions.toggleVisibility() },
    { id: 'clearHistory', label: trayString('clearHistory', lang), click: () => actions.clearHistory() },
    { type: 'separator' },
    { id: 'relaunchElevated', label: trayString('relaunchElevated', lang), enabled: platform === 'win32', click: () => actions.relaunchElevated() },
    { type: 'separator' },
    { id: 'quit', label: trayString('quit', lang), click: () => actions.quit() },
  ]
}

export function showCharacterMenu(win: BrowserWindow | null, actions: TrayActions, context?: CharacterMenuContext): void {
  const menu = Menu.buildFromTemplate(buildCharacterMenuTemplate(actions, context))
  if (win && !win.isDestroyed()) menu.popup({ window: win })
  else menu.popup()
}
