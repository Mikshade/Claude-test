/**
 * Turn a keyboard event into an Electron accelerator string (for the hotkey capture inputs).
 * Pure – unit-tested in accelerator.test.ts.
 *
 * OWNER: settings-ui agent.
 */

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super', 'Fn', 'CapsLock', 'NumLock', 'ScrollLock'])

const CODE_MAP: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  Pause: 'Pause',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  MediaPlayPause: 'MediaPlayPause',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
}

/** The key part of an accelerator for a `code` (null = not a usable key, e.g. a lone modifier). */
export function keyNameFromCode(code: string, key: string): string | null {
  if (MODIFIER_KEYS.has(key)) return null
  const mapped = CODE_MAP[code]
  if (mapped) return mapped
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]!
  m = /^Digit([0-9])$/.exec(code)
  if (m) return m[1]!
  m = /^Numpad([0-9])$/.exec(code)
  if (m) return `num${m[1]}`
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (m) return `F${m[1]}`
  // Fallback for layouts/codes we do not know: single printable characters are fine.
  if (key.length === 1 && key.trim().length === 1) return key.toUpperCase()
  return null
}

/**
 * Accelerator for a keydown event, or null while only modifiers are held. Ctrl is written as
 * `CommandOrControl` (the form used by the defaults) so the same config also works on macOS.
 */
export function acceleratorFromKeyEvent(e: KeyLike): string | null {
  const keyName = keyNameFromCode(e.code, e.key)
  if (!keyName) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  parts.push(keyName)
  return parts.join('+')
}

export type AcceleratorWarning = 'noModifier' | 'bareEscape' | null

/** Warn about hotkeys that would steal ordinary typing or Escape from every application. */
export function acceleratorWarning(accelerator: string): AcceleratorWarning {
  const trimmed = accelerator.trim()
  if (!trimmed) return null
  const parts = trimmed.split('+')
  const key = parts[parts.length - 1] ?? ''
  if (parts.length === 1) {
    if (key === 'Escape') return 'bareEscape'
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key) || /^(Media|Volume|PrintScreen|Pause)/.test(key)) return null
    return 'noModifier'
  }
  return null
}

/** Human-readable form: CommandOrControl → Ctrl, Super → Win. */
export function prettyAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((p) => (p === 'CommandOrControl' || p === 'CmdOrCtrl' ? 'Ctrl' : p === 'Super' ? 'Win' : p))
    .join(' + ')
}
