import { BrowserWindow as ElectronBrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSettingsWindowManager,
  hashScript,
  normalizePage,
  SETTINGS_WINDOW_MIN_SIZE,
  SETTINGS_WINDOW_SIZE,
  type SettingsWindowManager,
  settingsLoadTarget,
} from './settings'

/** Test-helper surface of the stateful BrowserWindow mock in tests/mocks/electron.ts. */
interface MockWindow {
  options: Record<string, unknown>
  _calls: Array<{ method: string; args: unknown[] }>
  _shown: boolean
  _focused: boolean
  _destroyed: boolean
  isDestroyed(): boolean
  emit(event: string, ...args: unknown[]): boolean
  webContents: {
    _sent: Array<{ channel: string; payload: unknown }>
    _executed: string[]
    emit(event: string, ...args: unknown[]): boolean
  }
}
const Win = ElectronBrowserWindow as unknown as { _instances: MockWindow[]; _reset(): void }

function calls(win: MockWindow, method: string): unknown[][] {
  return win._calls.filter((c) => c.method === method).map((c) => c.args)
}

describe('normalizePage', () => {
  it('trims, strips a leading # and rejects junk', () => {
    expect(normalizePage(undefined)).toBe('')
    expect(normalizePage('')).toBe('')
    expect(normalizePage(' voice ')).toBe('voice')
    expect(normalizePage('#wizard')).toBe('wizard')
    expect(normalizePage('about-page')).toBe('about-page')
    expect(normalizePage('bad page')).toBe('')
    expect(normalizePage("x';alert(1)")).toBe('')
  })
})

describe('settingsLoadTarget', () => {
  it('uses the dev server url with a hash in dev', () => {
    expect(settingsLoadTarget('voice', 'http://localhost:5173/', '/out/renderer')).toEqual({
      kind: 'url',
      url: 'http://localhost:5173/settings/index.html#voice',
    })
    expect(settingsLoadTarget(undefined, 'http://localhost:5173', '/out/renderer')).toEqual({
      kind: 'url',
      url: 'http://localhost:5173/settings/index.html',
    })
  })

  it('loads the built file with a hash option in production', () => {
    const target = settingsLoadTarget('#wizard', undefined, '/app/out/renderer')
    expect(target.kind).toBe('file')
    if (target.kind !== 'file') return
    expect(target.file).toMatch(/renderer[\\/]settings[\\/]index\.html$/)
    expect(target.hash).toBe('wizard')
    expect(settingsLoadTarget('', '', '/app/out/renderer')).toMatchObject({ kind: 'file', hash: '' })
  })
})

describe('hashScript', () => {
  it('produces a safe location.hash assignment', () => {
    expect(hashScript('voice')).toBe('location.hash = "#voice"; undefined')
    expect(hashScript('bad "page"')).toBe('location.hash = "#"; undefined')
  })
})

describe('createSettingsWindowManager', () => {
  /** electron-vite's types mark ELECTRON_RENDERER_URL read-only; tests need to set it. */
  const env = process.env as Record<string, string | undefined>
  const originalDevUrl = env['ELECTRON_RENDERER_URL']
  let managers: SettingsWindowManager[] = []

  function make(): SettingsWindowManager {
    const m = createSettingsWindowManager({ preloadPath: '/out/preload/index.js', title: 'Flowy – Einstellungen' })
    managers.push(m)
    return m
  }

  beforeEach(() => {
    Win._reset()
    delete env['ELECTRON_RENDERER_URL']
  })
  afterEach(() => {
    for (const m of managers) m.close()
    managers = []
    if (originalDevUrl === undefined) delete env['ELECTRON_RENDERER_URL']
    else env['ELECTRON_RENDERER_URL'] = originalDevUrl
  })

  it('creates a sandboxed 980x720 window and shows it on ready-to-show', () => {
    const m = make()
    expect(m.current()).toBeNull()
    const win = m.open('voice') as unknown as MockWindow
    expect(Win._instances).toHaveLength(1)
    expect(win.options).toMatchObject({
      width: SETTINGS_WINDOW_SIZE.width,
      height: SETTINGS_WINDOW_SIZE.height,
      minWidth: SETTINGS_WINDOW_MIN_SIZE.width,
      minHeight: SETTINGS_WINDOW_MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: 'Flowy – Einstellungen',
    })
    expect(win.options['webPreferences']).toMatchObject({
      preload: '/out/preload/index.js',
      contextIsolation: true,
      sandbox: true,
      additionalArguments: ['--flowy-page=settings'],
    })
    expect(win._shown).toBe(false)
    win.emit('ready-to-show')
    expect(win._shown).toBe(true)
    expect(m.current()).toBe(win)
  })

  it('loads the built file with the page as hash in production', () => {
    const win = make().open('wizard') as unknown as MockWindow
    const [file, options] = calls(win, 'loadFile')[0] ?? []
    expect(file).toMatch(/renderer[\\/]settings[\\/]index\.html$/)
    expect(options).toEqual({ hash: 'wizard' })
    expect(calls(win, 'loadURL')).toEqual([])
  })

  it('loads without a hash option when no page is given', () => {
    const win = make().open() as unknown as MockWindow
    expect(calls(win, 'loadFile')[0]?.[1]).toBeUndefined()
  })

  it('loads from the dev server in dev', () => {
    env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
    const win = make().open('about') as unknown as MockWindow
    expect(calls(win, 'loadURL')).toEqual([['http://localhost:5173/settings/index.html#about']])
    expect(calls(win, 'loadFile')).toEqual([])
  })

  it('focuses the existing window and switches the page via location.hash', () => {
    const m = make()
    const first = m.open('voice') as unknown as MockWindow
    first.emit('ready-to-show')
    const second = m.open('brain') as unknown as MockWindow
    expect(second).toBe(first)
    expect(Win._instances).toHaveLength(1)
    expect(first._focused).toBe(true)
    expect(first.webContents._executed).toEqual(['location.hash = "#brain"; undefined'])
    // open() without a page keeps the current page
    m.open()
    expect(first.webContents._executed).toHaveLength(1)
  })

  it('send() pushes typed messages only while the window exists', () => {
    const m = make()
    m.send('config:changed', {} as never) // no window yet → no-op
    const win = m.open() as unknown as MockWindow
    m.send('state:changed', 'idle')
    expect(win.webContents._sent).toEqual([{ channel: 'state:changed', payload: 'idle' }])
    m.close()
    expect(win._destroyed).toBe(true)
    expect(m.current()).toBeNull()
    m.send('state:changed', 'idle') // destroyed → no-op, no throw
  })

  it('forgets the window when the user closes it and creates a fresh one next time', () => {
    const m = make()
    const first = m.open() as unknown as MockWindow
    first.emit('closed')
    first._destroyed = true
    expect(m.current()).toBeNull()
    const second = m.open('look') as unknown as MockWindow
    expect(second).not.toBe(first)
    expect(Win._instances).toHaveLength(2)
  })
})
