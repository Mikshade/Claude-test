import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shell } from 'electron'
import { appTools, parseHttpUrl } from './apps'
import { fakeServices, runTool, textOf, toolByName } from './fakes.test'

const shellMock = shell as unknown as { _opened: string[]; _external: string[]; _openPathError: string; _reset(): void }
let dir: string

beforeEach(() => {
  shellMock._reset()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-apps-'))
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('parseHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(parseHttpUrl(' https://example.org/a?b=1 ').href).toBe('https://example.org/a?b=1')
    expect(() => parseHttpUrl('javascript:alert(1)')).toThrow('Nur http(s)-URLs erlaubt')
    expect(() => parseHttpUrl('ms-settings:display')).toThrow('Nur http(s)-URLs erlaubt')
    expect(() => parseHttpUrl('nope')).toThrow('Ungültige URL')
  })
})

describe('open_path / open_url', () => {
  it('opens existing paths with the default app and reports shell errors', async () => {
    const tools = appTools(fakeServices())
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'x')
    expect((await runTool(toolByName(tools, 'open_path'), { path: file })).content).toBe(`Geöffnet: ${file}`)
    expect(shellMock._opened).toEqual([file])
    shellMock._openPathError = 'No app'
    const failed = await runTool(toolByName(tools, 'open_path'), { path: file })
    expect(failed).toEqual({ isError: true, content: 'Konnte nicht öffnen: No app' })
    await expect(runTool(toolByName(tools, 'open_path'), { path: path.join(dir, 'missing') })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('opens http(s) URLs externally and rejects other schemes', async () => {
    const tool = toolByName(appTools(fakeServices()), 'open_url')
    expect((await runTool(tool, { url: 'https://example.org' })).content).toBe('Im Browser geöffnet: https://example.org/')
    expect(shellMock._external).toEqual(['https://example.org/'])
    await expect(runTool(tool, { url: 'file:///C:/x' })).rejects.toThrow('Nur http(s)')
    expect(tool.summarize?.({ url: 'https://example.org' })).toBe('Öffne URL: https://example.org')
  })
})

describe('app and window tools', () => {
  it('launches apps and lists/filters installed apps', async () => {
    const services = fakeServices()
    const tools = appTools(services)
    expect((await runTool(toolByName(tools, 'launch_app'), { nameOrPath: ' Spotify ', args: ['--minimized'] })).content).toBe('Gestartet: Spotify')
    expect(services.system.calls[0]).toEqual({ method: 'launchApp', args: ['Spotify', ['--minimized']] })
    const all = textOf((await runTool(toolByName(tools, 'list_installed_apps'), {})).content)
    expect(all).toBe('2 Apps\nNotepad — C:\\Windows\\notepad.exe\nSpotify — SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')
    const filtered = textOf((await runTool(toolByName(tools, 'list_installed_apps'), { filter: 'spot' })).content)
    expect(filtered).toBe('1 Apps\nSpotify — SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')
    expect((await runTool(toolByName(tools, 'list_installed_apps'), { filter: 'zzz' })).content).toBe('Keine App passt zu "zzz".')
  })

  it('lists, focuses and closes windows by query', async () => {
    const services = fakeServices()
    const tools = appTools(services)
    expect(textOf((await runTool(toolByName(tools, 'list_windows'), {})).content)).toBe('1 Fenster\n[1] Editor – notes.txt — notepad (pid 100)')
    const focus = toolByName(tools, 'focus_window')
    expect(focus.inputSchema.safeParse({}).success).toBe(false)
    expect((await runTool(focus, { titleContains: 'notes' })).content).toBe('Fenster im Vordergrund: "notes"')
    expect((await runTool(focus, { hwnd: 99 })).isError).toBe(true)
    const close = toolByName(tools, 'close_window')
    expect(close.destructive).toBe(true)
    expect((await runTool(close, { processName: 'notepad' })).content).toBe('Fenster geschlossen: notepad')
    expect(close.confirmation?.({ hwnd: 1 })).toEqual({ title: 'Fenster schließen?', detail: 'hwnd 1' })
    expect(focus.summarize?.({ processName: 'code' })).toBe('Fokussiere Fenster: code')
  })

  it('reports the active window', async () => {
    const services = fakeServices()
    const tool = toolByName(appTools(services), 'get_active_window')
    expect(tool.category).toBe('system')
    expect(textOf((await runTool(tool, {})).content)).toBe('Titel: Editor – notes.txt\nProzess: notepad (pid 100)\nPfad: C:\\Windows\\notepad.exe')
    services.system.active = null
    expect((await runTool(tool, {})).content).toBe('Kein aktives Fenster (Desktop oder gesperrt).')
  })

  it('fails readably without a system service', async () => {
    const tool = toolByName(appTools(fakeServices({ system: undefined })), 'list_windows')
    await expect(runTool(tool, {})).rejects.toThrow('Systemsteuerung nicht verfügbar')
  })
})
