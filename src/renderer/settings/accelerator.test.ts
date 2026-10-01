import { describe, expect, it } from 'vitest'
import { acceleratorFromKeyEvent, acceleratorWarning, type KeyLike, keyNameFromCode, prettyAccelerator } from './accelerator'

function key(partial: Partial<KeyLike> & { code: string; key: string }): KeyLike {
  return { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...partial }
}

describe('keyNameFromCode', () => {
  it('maps letters, digits, function keys, numpad and punctuation', () => {
    expect(keyNameFromCode('KeyA', 'a')).toBe('A')
    expect(keyNameFromCode('Digit7', '7')).toBe('7')
    expect(keyNameFromCode('F12', 'F12')).toBe('F12')
    expect(keyNameFromCode('F24', 'F24')).toBe('F24')
    expect(keyNameFromCode('Numpad3', '3')).toBe('num3')
    expect(keyNameFromCode('NumpadAdd', '+')).toBe('numadd')
    expect(keyNameFromCode('Space', ' ')).toBe('Space')
    expect(keyNameFromCode('ArrowUp', 'ArrowUp')).toBe('Up')
    expect(keyNameFromCode('Comma', ',')).toBe(',')
    expect(keyNameFromCode('AudioVolumeUp', 'AudioVolumeUp')).toBe('VolumeUp')
  })
  it('returns null for lone modifiers and unknown non-printable keys', () => {
    expect(keyNameFromCode('ControlLeft', 'Control')).toBeNull()
    expect(keyNameFromCode('ShiftRight', 'Shift')).toBeNull()
    expect(keyNameFromCode('MetaLeft', 'Meta')).toBeNull()
    expect(keyNameFromCode('Unidentified', 'Dead')).toBeNull()
  })
  it('falls back to the printed character for unknown codes', () => {
    expect(keyNameFromCode('IntlBackslash', '<')).toBe('<')
    expect(keyNameFromCode('KeyZ', 'y')).toBe('Z') // physical layout wins
  })
})

describe('acceleratorFromKeyEvent', () => {
  it('builds Electron accelerators with modifiers in a stable order', () => {
    expect(acceleratorFromKeyEvent(key({ code: 'Space', key: ' ', ctrlKey: true, shiftKey: true }))).toBe('CommandOrControl+Shift+Space')
    expect(acceleratorFromKeyEvent(key({ code: 'KeyH', key: 'h', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }))).toBe('CommandOrControl+Alt+Shift+Super+H')
    expect(acceleratorFromKeyEvent(key({ code: 'F9', key: 'F9' }))).toBe('F9')
    expect(acceleratorFromKeyEvent(key({ code: 'Enter', key: 'Enter', ctrlKey: true, shiftKey: true }))).toBe('CommandOrControl+Shift+Enter')
  })
  it('returns null while only modifiers are pressed', () => {
    expect(acceleratorFromKeyEvent(key({ code: 'ControlLeft', key: 'Control', ctrlKey: true }))).toBeNull()
    expect(acceleratorFromKeyEvent(key({ code: 'AltLeft', key: 'Alt', altKey: true }))).toBeNull()
  })
})

describe('acceleratorWarning', () => {
  it('flags bare keys and bare Escape', () => {
    expect(acceleratorWarning('')).toBeNull()
    expect(acceleratorWarning('CommandOrControl+Shift+Space')).toBeNull()
    expect(acceleratorWarning('F9')).toBeNull()
    expect(acceleratorWarning('MediaPlayPause')).toBeNull()
    expect(acceleratorWarning('A')).toBe('noModifier')
    expect(acceleratorWarning('Space')).toBe('noModifier')
    expect(acceleratorWarning('Escape')).toBe('bareEscape')
    expect(acceleratorWarning('CommandOrControl+Shift+Escape')).toBeNull()
  })
})

describe('prettyAccelerator', () => {
  it('renders human-readable combos', () => {
    expect(prettyAccelerator('CommandOrControl+Shift+Space')).toBe('Ctrl + Shift + Space')
    expect(prettyAccelerator('Super+H')).toBe('Win + H')
  })
})
