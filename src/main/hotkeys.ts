/**
 * Global hotkeys via Electron globalShortcut (toggle semantics: press once to start listening,
 * press again to stop; recording also auto-stops on silence).
 *
 * OWNER: overlay agent.
 */
import type { HotkeysConfig } from '@shared/config'

export interface HotkeyHandlers {
  pushToTalk(): void
  toggleVisibility(): void
  openChat(): void
  interrupt(): void
}

export interface HotkeyRegistration {
  /** Re-register with new accelerators (e.g. after settings change). Returns accelerators that failed. */
  apply(config: HotkeysConfig): string[]
  dispose(): void
}

export function registerHotkeys(_config: HotkeysConfig, _handlers: HotkeyHandlers): HotkeyRegistration {
  throw new Error('not implemented: registerHotkeys (src/main/hotkeys.ts)')
}
