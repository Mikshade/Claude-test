/**
 * Global hotkeys via Electron globalShortcut (toggle semantics: press once to start listening,
 * press again to stop; recording also auto-stops on silence).
 *
 * - An empty accelerator disables that action.
 * - NOTE on `interrupt`: a global `Escape` hotkey steals Escape from EVERY application (dialogs,
 *   games, editors …). It is only registered when `config.hotkeys.interrupt` is non-empty – the
 *   integrator may leave it empty and rely on the push-to-talk key / bubble UI to interrupt.
 * - Duplicate accelerators (same key for two actions) are registered once for the first action in
 *   declaration order; the later ones are reported as failed and a warning is logged.
 * - Works on every platform Electron supports; a missing display server (headless Linux) makes
 *   `register` throw or return false – that is reported as failed, never thrown.
 *
 * OWNER: overlay agent (reassigned).
 */
import { globalShortcut } from 'electron'
import type { HotkeysConfig } from '@shared/config'
import { createLogger } from './log'

const log = createLogger('hotkeys')

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

export type HotkeyAction = keyof HotkeyHandlers

/** Registration order – the first action wins when two share an accelerator. */
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ['pushToTalk', 'toggleVisibility', 'openChat', 'interrupt']

/**
 * Canonical form of an accelerator for duplicate detection: lowercase, modifier aliases resolved
 * (Ctrl/Control, Cmd/Command, CmdOrCtrl/CommandOrControl → the platform's key), modifiers sorted,
 * the key last. "Ctrl+Shift+Space" and "Shift+Control+space" are the same hotkey.
 */
export function normalizeAccelerator(accelerator: string, platform: NodeJS.Platform = process.platform): string {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return ''
  const key = parts[parts.length - 1]!
  const modifiers = parts.slice(0, -1).map((m) => {
    switch (m) {
      case 'cmdorctrl':
      case 'commandorcontrol':
        return platform === 'darwin' ? 'command' : 'control'
      case 'ctrl':
        return 'control'
      case 'cmd':
        return 'command'
      case 'option':
        return 'alt'
      default:
        return m
    }
  })
  return [...new Set(modifiers)].sort().concat(key).join('+')
}

export function registerHotkeys(config: HotkeysConfig, handlers: HotkeyHandlers): HotkeyRegistration {
  /** Accelerators (verbatim) currently registered by this module. */
  let registered: string[] = []

  function invoke(action: HotkeyAction, accelerator: string): void {
    try {
      handlers[action]()
    } catch (err) {
      log.error(`hotkey handler ${action} (${accelerator}) threw`, err)
    }
  }

  function unregisterAll(): void {
    for (const accelerator of registered) {
      try {
        globalShortcut.unregister(accelerator)
      } catch (err) {
        log.warn(`cannot unregister ${accelerator}`, err instanceof Error ? err.message : err)
      }
    }
    registered = []
  }

  function apply(next: HotkeysConfig): string[] {
    unregisterAll()
    const failed: string[] = []
    const seen = new Map<string, HotkeyAction>()
    for (const action of HOTKEY_ACTIONS) {
      const accelerator = (next[action] ?? '').trim()
      if (!accelerator) continue // disabled
      const canonical = normalizeAccelerator(accelerator)
      const owner = seen.get(canonical)
      if (owner !== undefined) {
        log.warn(`hotkey ${accelerator} is used for both ${owner} and ${action} – ${action} is not registered`)
        failed.push(accelerator)
        continue
      }
      let ok = false
      try {
        ok = globalShortcut.register(accelerator, () => invoke(action, accelerator))
      } catch (err) {
        log.warn(`cannot register hotkey ${accelerator} for ${action}`, err instanceof Error ? err.message : err)
      }
      if (!ok) {
        log.warn(`hotkey ${accelerator} (${action}) could not be registered – invalid or taken by another app`)
        failed.push(accelerator)
        continue
      }
      seen.set(canonical, action)
      registered.push(accelerator)
      log.debug(`registered ${accelerator} → ${action}`)
    }
    return failed
  }

  apply(config)

  return {
    apply,
    dispose() {
      unregisterAll()
    },
  }
}
