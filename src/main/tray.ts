/**
 * System tray icon + menu: open settings, pin/unpin, mute, hide/show, restart as admin, quit.
 *
 * OWNER: settings-window agent.
 */
import type { Tray } from 'electron'
import type { FlowyConfig } from '@shared/config'
import type { CompanionState } from '@shared/state'

export interface TrayActions {
  openSettings(page?: string): void
  toggleVisibility(): void
  togglePinned(): void
  toggleMuted(): void
  relaunchElevated(): void
  clearHistory(): void
  quit(): void
}

export interface TrayController {
  readonly tray: Tray
  /** Refresh menu labels/checkmarks from current config + state. */
  update(config: FlowyConfig, state: CompanionState, flags: { visible: boolean; muted: boolean }): void
  dispose(): void
}

export function createTray(_iconPath: string, _actions: TrayActions): TrayController {
  throw new Error('not implemented: createTray (src/main/tray.ts)')
}
