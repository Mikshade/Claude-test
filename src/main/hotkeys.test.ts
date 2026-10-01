import { globalShortcut as electronGlobalShortcut } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HotkeysConfig } from '@shared/config'
import { type HotkeyHandlers, normalizeAccelerator, registerHotkeys } from './hotkeys'

/** Test-helper surface of the recording mock in tests/mocks/electron.ts (vitest aliases 'electron' there). */
interface RecordingGlobalShortcut {
  _registered: Map<string, () => void>
  _failing: Set<string>
  _press(accelerator: string): boolean
  _reset(): void
  register(accelerator: string, callback: () => void): boolean
  isRegistered(accelerator: string): boolean
}
const globalShortcut = electronGlobalShortcut as unknown as RecordingGlobalShortcut

const base: HotkeysConfig = {
  pushToTalk: 'CommandOrControl+Shift+Space',
  toggleVisibility: 'CommandOrControl+Shift+H',
  openChat: 'CommandOrControl+Shift+Enter',
  interrupt: '',
}

function handlers(): HotkeyHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    pushToTalk: () => calls.push('pushToTalk'),
    toggleVisibility: () => calls.push('toggleVisibility'),
    openChat: () => calls.push('openChat'),
    interrupt: () => calls.push('interrupt'),
  }
}

beforeEach(() => {
  globalShortcut._reset()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeAccelerator', () => {
  it('canonicalizes case, order and modifier aliases', () => {
    expect(normalizeAccelerator('Ctrl+Shift+Space', 'win32')).toBe('control+shift+space')
    expect(normalizeAccelerator('shift + CONTROL + space', 'win32')).toBe('control+shift+space')
    expect(normalizeAccelerator('CommandOrControl+Shift+Space', 'win32')).toBe('control+shift+space')
    expect(normalizeAccelerator('CmdOrCtrl+Shift+Space', 'linux')).toBe('control+shift+space')
    expect(normalizeAccelerator('CmdOrCtrl+Shift+Space', 'darwin')).toBe('command+shift+space')
    expect(normalizeAccelerator('Cmd+Option+K', 'darwin')).toBe('alt+command+k')
    expect(normalizeAccelerator('Escape', 'win32')).toBe('escape')
    expect(normalizeAccelerator('', 'win32')).toBe('')
  })
})

describe('registerHotkeys', () => {
  it('registers every non-empty accelerator and dispatches presses to the handlers', () => {
    const h = handlers()
    const reg = registerHotkeys(base, h)
    expect([...globalShortcut._registered.keys()]).toEqual([
      'CommandOrControl+Shift+Space',
      'CommandOrControl+Shift+H',
      'CommandOrControl+Shift+Enter',
    ])
    expect(globalShortcut._press('CommandOrControl+Shift+Space')).toBe(true)
    expect(globalShortcut._press('CommandOrControl+Shift+H')).toBe(true)
    expect(globalShortcut._press('CommandOrControl+Shift+Enter')).toBe(true)
    expect(globalShortcut._press('Escape')).toBe(false)
    expect(h.calls).toEqual(['pushToTalk', 'toggleVisibility', 'openChat'])
    reg.dispose()
  })

  it('registers Escape for interrupt only when configured', () => {
    const h = handlers()
    const reg = registerHotkeys({ ...base, interrupt: 'Escape' }, h)
    expect(globalShortcut.isRegistered('Escape')).toBe(true)
    globalShortcut._press('Escape')
    expect(h.calls).toEqual(['interrupt'])
    expect(reg.apply({ ...base, interrupt: '   ' })).toEqual([])
    expect(globalShortcut.isRegistered('Escape')).toBe(false)
    reg.dispose()
  })

  it('apply() replaces the previous accelerators', () => {
    const h = handlers()
    const reg = registerHotkeys(base, h)
    const failed = reg.apply({ ...base, pushToTalk: 'F9', toggleVisibility: 'F10' })
    expect(failed).toEqual([])
    expect([...globalShortcut._registered.keys()]).toEqual(['F9', 'F10', 'CommandOrControl+Shift+Enter'])
    globalShortcut._press('F9')
    expect(globalShortcut._press('CommandOrControl+Shift+Space')).toBe(false)
    expect(h.calls).toEqual(['pushToTalk'])
    reg.dispose()
  })

  it('reports accelerators that are taken or invalid as failed and keeps the others', () => {
    globalShortcut._failing.add('CommandOrControl+Shift+H')
    const registerSpy = vi.spyOn(globalShortcut, 'register')
    registerSpy.mockImplementation((accelerator: string, callback: () => void) => {
      if (accelerator === 'Not+A+Real+Key') throw new Error('invalid accelerator')
      globalShortcut._registered.set(accelerator, callback)
      return !globalShortcut._failing.has(accelerator)
    })
    const h = handlers()
    const reg = registerHotkeys(base, h)
    const failed = reg.apply({ ...base, openChat: 'Not+A+Real+Key' })
    expect(failed).toEqual(['CommandOrControl+Shift+H', 'Not+A+Real+Key'])
    expect(globalShortcut._press('CommandOrControl+Shift+Space')).toBe(true)
    expect(h.calls).toEqual(['pushToTalk'])
    expect(console.warn).toHaveBeenCalled()
    reg.dispose()
  })

  it('registers a duplicate accelerator once (first action wins) and reports the duplicate as failed', () => {
    const h = handlers()
    const reg = registerHotkeys(base, h)
    const failed = reg.apply({ ...base, openChat: 'ctrl+shift+space', interrupt: 'Shift+CommandOrControl+Space' })
    expect(failed).toEqual(['ctrl+shift+space', 'Shift+CommandOrControl+Space'])
    expect(globalShortcut._registered.size).toBe(2)
    globalShortcut._press('CommandOrControl+Shift+Space')
    expect(h.calls).toEqual(['pushToTalk'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('used for both pushToTalk and openChat'))
    reg.dispose()
  })

  it('dispose() unregisters everything it registered', () => {
    const reg = registerHotkeys({ ...base, interrupt: 'Escape' }, handlers())
    expect(globalShortcut._registered.size).toBe(4)
    reg.dispose()
    expect(globalShortcut._registered.size).toBe(0)
    // idempotent
    reg.dispose()
    expect(globalShortcut._registered.size).toBe(0)
  })

  it('a throwing handler is logged and does not propagate', () => {
    const h = handlers()
    h.pushToTalk = () => {
      throw new Error('boom')
    }
    const reg = registerHotkeys(base, h)
    expect(() => globalShortcut._press('CommandOrControl+Shift+Space')).not.toThrow()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('hotkey handler pushToTalk'))
    reg.dispose()
  })
})
