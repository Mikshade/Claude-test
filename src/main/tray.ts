/**
 * System tray icon + menu: open settings, pin/unpin, mute, hide/show, clear history, restart as admin, quit.
 *
 * OWNER: settings-window agent.
 *
 * `buildTrayTemplate()` is pure (unit-tested): it turns config + runtime flags into a Menu template.
 * `createTray()` wraps Electron's Tray; a missing icon file falls back to an empty image so dev on
 * Linux never crashes. Labels come from a tiny de/en table keyed by `config.character.language`.
 */
import { Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, Tray } from 'electron'
import type { FlowyConfig, Language } from '@shared/config'
import type { CompanionState } from '@shared/state'
import { createLogger } from './log'

const log = createLogger('tray')

export interface TrayActions {
  openSettings(page?: string): void
  toggleVisibility(): void
  togglePinned(): void
  toggleMuted(): void
  relaunchElevated(): void
  clearHistory(): void
  quit(): void
}

export interface TrayFlags {
  visible: boolean
  muted: boolean
}

export interface TrayController {
  readonly tray: Tray
  /** Refresh menu labels/checkmarks from current config + state. */
  update(config: FlowyConfig, state: CompanionState, flags: TrayFlags): void
  dispose(): void
}

export const TRAY_STRINGS = {
  de: {
    settings: 'Einstellungen…',
    pinned: 'Anheften',
    muted: 'Stumm',
    hide: 'Verstecken',
    show: 'Zeigen',
    clearHistory: 'Verlauf löschen',
    relaunchElevated: 'Als Administrator neu starten',
    quit: 'Beenden',
    stateListening: 'hört zu',
    stateTranscribing: 'versteht',
    stateThinking: 'denkt nach',
    stateSpeaking: 'spricht',
    stateError: 'Fehler',
    stateSleeping: 'schläft',
    stateBooting: 'startet',
  },
  en: {
    settings: 'Settings…',
    pinned: 'Pin',
    muted: 'Mute',
    hide: 'Hide',
    show: 'Show',
    clearHistory: 'Clear history',
    relaunchElevated: 'Restart as administrator',
    quit: 'Quit',
    stateListening: 'listening',
    stateTranscribing: 'transcribing',
    stateThinking: 'thinking',
    stateSpeaking: 'speaking',
    stateError: 'error',
    stateSleeping: 'sleeping',
    stateBooting: 'starting',
  },
} as const satisfies Record<Language, Record<string, string>>

export type TrayStringKey = keyof (typeof TRAY_STRINGS)['de']

/** Translate a tray string; unknown languages fall back to German (the default UI language). */
export function trayString(key: TrayStringKey, lang: Language): string {
  const table: Record<TrayStringKey, string> = TRAY_STRINGS[lang] ?? TRAY_STRINGS.de
  return table[key]
}

/** Tooltip: plain 'Flowy' while idle, 'Flowy – <state>' otherwise. */
export function trayTooltip(state: CompanionState, lang: Language): string {
  const keys: Partial<Record<CompanionState, TrayStringKey>> = {
    listening: 'stateListening',
    transcribing: 'stateTranscribing',
    thinking: 'stateThinking',
    speaking: 'stateSpeaking',
    error: 'stateError',
    sleeping: 'stateSleeping',
    booting: 'stateBooting',
  }
  const key = keys[state]
  return key ? `Flowy – ${trayString(key, lang)}` : 'Flowy'
}

/**
 * Pure: the tray/context menu template for the current config + flags. `actions` wires the click
 * handlers (pass a stub in tests). 'Restart as administrator' is only enabled on Windows.
 */
export function buildTrayTemplate(
  config: FlowyConfig,
  _state: CompanionState,
  flags: TrayFlags,
  lang: Language,
  actions: TrayActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const s = (key: TrayStringKey): string => trayString(key, lang)
  return [
    { id: 'settings', label: s('settings'), click: () => actions.openSettings() },
    { type: 'separator' },
    { id: 'pinned', label: s('pinned'), type: 'checkbox', checked: config.avatar.pinned, click: () => actions.togglePinned() },
    { id: 'muted', label: s('muted'), type: 'checkbox', checked: flags.muted, click: () => actions.toggleMuted() },
    { id: 'visibility', label: flags.visible ? s('hide') : s('show'), click: () => actions.toggleVisibility() },
    { id: 'clearHistory', label: s('clearHistory'), click: () => actions.clearHistory() },
    { type: 'separator' },
    {
      id: 'relaunchElevated',
      label: s('relaunchElevated'),
      enabled: platform === 'win32',
      click: () => actions.relaunchElevated(),
    },
    { type: 'separator' },
    { id: 'quit', label: s('quit'), click: () => actions.quit() },
  ]
}

/** Load the tray icon; an unreadable/missing file yields an empty image (Electron shows a blank tray entry). */
export function loadTrayImage(iconPath: string): NativeImage {
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    log.warn(`tray icon not found or unreadable: ${iconPath} – using an empty image`)
    image = nativeImage.createEmpty()
  }
  return image
}

export function createTray(iconPath: string, actions: TrayActions): TrayController {
  const tray = new Tray(loadTrayImage(iconPath))
  tray.setToolTip('Flowy')
  tray.on('click', () => {
    try {
      actions.openSettings()
    } catch (err) {
      log.error('openSettings from tray failed', err)
    }
  })
  let disposed = false

  function update(config: FlowyConfig, state: CompanionState, flags: TrayFlags): void {
    if (disposed || tray.isDestroyed()) return
    const lang = config.character.language
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate(config, state, flags, lang, actions)))
    tray.setToolTip(trayTooltip(state, lang))
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (!tray.isDestroyed()) tray.destroy()
    log.debug('disposed')
  }

  log.info('tray created')
  return { tray, update, dispose }
}
