import { Menu as ElectronMenu, Tray as ElectronTray } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type FlowyConfig } from '@shared/config'
import { buildCharacterMenuTemplate, showCharacterMenu } from './windows/contextMenu'
import { buildTrayTemplate, createTray, TRAY_STRINGS, type TrayActions, trayString, trayTooltip } from './tray'

interface MockTray {
  image: { isEmpty(): boolean }
  _tooltip: string
  _menu: { template: Array<Record<string, unknown>> } | null
  _destroyed: boolean
  _emit(event: string, ...args: unknown[]): void
}
interface MockMenu {
  template: Array<Record<string, unknown>>
  _popups: unknown[]
}
const TrayMock = ElectronTray as unknown as { _instances: MockTray[]; _reset(): void }
const MenuMock = ElectronMenu as unknown as { _popups: Array<{ menu: MockMenu; options: unknown }>; _reset(): void }

function actions(): TrayActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    openSettings: (page?: string) => calls.push(`openSettings:${page ?? ''}`),
    toggleVisibility: () => calls.push('toggleVisibility'),
    togglePinned: () => calls.push('togglePinned'),
    toggleMuted: () => calls.push('toggleMuted'),
    relaunchElevated: () => calls.push('relaunchElevated'),
    clearHistory: () => calls.push('clearHistory'),
    quit: () => calls.push('quit'),
  }
}

function config(partial: { pinned?: boolean; language?: 'de' | 'en' } = {}): FlowyConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  if (partial.pinned !== undefined) c.avatar.pinned = partial.pinned
  if (partial.language) c.character.language = partial.language
  return c
}

function labels(template: Array<Record<string, unknown>>): Array<string | undefined> {
  return template.map((item) => (item['type'] === 'separator' ? '---' : (item['label'] as string)))
}

describe('TRAY_STRINGS', () => {
  it('de and en define the same keys', () => {
    expect(Object.keys(TRAY_STRINGS.en).sort()).toEqual(Object.keys(TRAY_STRINGS.de).sort())
  })
  it('falls back to German for unknown languages', () => {
    expect(trayString('quit', 'xx' as never)).toBe('Beenden')
    expect(trayString('quit', 'en')).toBe('Quit')
  })
})

describe('trayTooltip', () => {
  it('is plain Flowy while idle and carries the state otherwise', () => {
    expect(trayTooltip('idle', 'de')).toBe('Flowy')
    expect(trayTooltip('listening', 'de')).toBe('Flowy – hört zu')
    expect(trayTooltip('speaking', 'en')).toBe('Flowy – speaking')
  })
})

describe('buildTrayTemplate', () => {
  it('builds the German menu with checkmarks from config + flags', () => {
    const a = actions()
    const template = buildTrayTemplate(config({ pinned: true }), 'idle', { visible: true, muted: false }, 'de', a, 'win32')
    expect(labels(template)).toEqual([
      'Einstellungen…',
      '---',
      'Anheften',
      'Stumm',
      'Verstecken',
      'Verlauf löschen',
      '---',
      'Als Administrator neu starten',
      '---',
      'Beenden',
    ])
    const byId = (id: string): Record<string, unknown> => template.find((i) => i.id === id) as Record<string, unknown>
    expect(byId('pinned')).toMatchObject({ type: 'checkbox', checked: true })
    expect(byId('muted')).toMatchObject({ type: 'checkbox', checked: false })
    expect(byId('relaunchElevated')).toMatchObject({ enabled: true })
  })

  it('uses English labels, "Show" when hidden, and disables elevation off Windows', () => {
    const a = actions()
    const template = buildTrayTemplate(config({ language: 'en' }), 'speaking', { visible: false, muted: true }, 'en', a, 'linux')
    expect(labels(template)).toEqual([
      'Settings…',
      '---',
      'Pin',
      'Mute',
      'Show',
      'Clear history',
      '---',
      'Restart as administrator',
      '---',
      'Quit',
    ])
    expect(template.find((i) => i.id === 'muted')).toMatchObject({ checked: true })
    expect(template.find((i) => i.id === 'pinned')).toMatchObject({ checked: false })
    expect(template.find((i) => i.id === 'relaunchElevated')).toMatchObject({ enabled: false })
  })

  it('wires every click to its action', () => {
    const a = actions()
    const template = buildTrayTemplate(config(), 'idle', { visible: true, muted: false }, 'de', a, 'win32')
    for (const item of template) {
      if (typeof item.click === 'function') (item.click as () => void)()
    }
    expect(a.calls).toEqual([
      'openSettings:',
      'togglePinned',
      'toggleMuted',
      'toggleVisibility',
      'clearHistory',
      'relaunchElevated',
      'quit',
    ])
  })
})

describe('createTray', () => {
  beforeEach(() => {
    TrayMock._reset()
    MenuMock._reset()
  })

  it('creates a tray with an (empty fallback) image, tooltip and click → settings', () => {
    const a = actions()
    const controller = createTray('/nonexistent/tray.png', a)
    const tray = TrayMock._instances[0]!
    expect(controller.tray).toBe(tray)
    expect(tray.image.isEmpty()).toBe(true)
    expect(tray._tooltip).toBe('Flowy')
    tray._emit('click')
    expect(a.calls).toEqual(['openSettings:'])
  })

  it('update() rebuilds the context menu and tooltip; dispose() destroys', () => {
    const a = actions()
    const controller = createTray('/nonexistent/tray.png', a)
    const tray = TrayMock._instances[0]!
    controller.update(config({ pinned: true, language: 'en' }), 'thinking', { visible: false, muted: true })
    expect(tray._menu).not.toBeNull()
    expect(labels(tray._menu!.template)).toContain('Show')
    expect(tray._menu!.template.find((i) => i['id'] === 'pinned')).toMatchObject({ checked: true })
    expect(tray._tooltip).toBe('Flowy – thinking')

    controller.update(config({ pinned: false }), 'idle', { visible: true, muted: false })
    expect(labels(tray._menu!.template)).toContain('Verstecken')
    expect(tray._tooltip).toBe('Flowy')

    controller.dispose()
    expect(tray._destroyed).toBe(true)
    controller.dispose() // idempotent
    const before = tray._menu
    controller.update(config(), 'idle', { visible: true, muted: false }) // no-op after dispose
    expect(tray._menu).toBe(before)
  })
})

describe('character context menu', () => {
  beforeEach(() => MenuMock._reset())

  it('mirrors the tray menu with checkmarks when context is given', () => {
    const a = actions()
    const template = buildCharacterMenuTemplate(
      a,
      { config: config({ pinned: true, language: 'en' }), flags: { visible: true, muted: false } },
      'win32',
    ) as Array<Record<string, unknown>>
    expect(labels(template)[0]).toBe('Settings…')
    expect(template.find((i) => i['id'] === 'pinned')).toMatchObject({ type: 'checkbox', checked: true })
  })

  it('falls back to plain German items without context', () => {
    const template = buildCharacterMenuTemplate(actions(), undefined, 'linux') as Array<Record<string, unknown>>
    expect(labels(template)).toEqual([
      'Einstellungen…',
      '---',
      'Anheften',
      'Stumm',
      'Verstecken',
      'Verlauf löschen',
      '---',
      'Als Administrator neu starten',
      '---',
      'Beenden',
    ])
    expect(template.find((i) => i['id'] === 'pinned')?.['type']).toBeUndefined()
    expect(template.find((i) => i['id'] === 'relaunchElevated')).toMatchObject({ enabled: false })
  })

  it('pops the menu up anchored to the window (or unanchored when it is gone)', () => {
    const win = { isDestroyed: vi.fn(() => false) }
    showCharacterMenu(win as never, actions())
    expect(MenuMock._popups).toHaveLength(1)
    expect(MenuMock._popups[0]?.options).toEqual({ window: win })
    showCharacterMenu(null, actions())
    expect(MenuMock._popups[1]?.options).toBeUndefined()
  })
})
