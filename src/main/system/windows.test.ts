import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PowerShellHost, PsResult, PsRunOptions } from './powershell'
import { APPS_CACHE_MS, createWindowsSystem, extractJson, findApp, type InstalledApp, nodeSystemInfo } from './windows'

type Handler = Partial<PsResult> | ((script: string) => Partial<PsResult>)

/** Fake host: the first matching handler (substring or regex of the script) decides the result. */
function fakeHost(handlers: Array<[string | RegExp, Handler]> = []) {
  const calls: Array<{ script: string; options: PsRunOptions | undefined }> = []
  const base: PsResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 1 }
  const host: PowerShellHost = {
    async run(script, options) {
      calls.push({ script, options })
      for (const [matcher, handler] of handlers) {
        const hit = typeof matcher === 'string' ? script.includes(matcher) : matcher.test(script)
        if (hit) return { ...base, ...(typeof handler === 'function' ? handler(script) : handler) }
      }
      return { ...base, stdout: '', stderr: 'no handler', exitCode: 1 }
    },
    async runRaw() {
      return base
    },
    executable: () => 'powershell.exe',
    dispose: () => undefined,
    isRunning: () => true,
  }
  return { host, calls }
}

const json = (value: unknown): Partial<PsResult> => ({ stdout: `${JSON.stringify(value)}\n` })

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('extractJson', () => {
  it('parses clean JSON, JSON after stray output and the null literal', () => {
    expect(extractJson('{"a":1}\n')).toEqual({ a: 1 })
    expect(extractJson('Add-Type warning\nmore noise\n[{"a":1}]\n')).toEqual([{ a: 1 }])
    expect(extractJson('null\n')).toBeNull()
    expect(extractJson('')).toBeUndefined()
    expect(extractJson('garbage {not json')).toBeUndefined()
    expect(extractJson('x {"a":"}"} trailing')).toEqual({ a: '}' })
  })
})

describe('findApp', () => {
  const apps: InstalledApp[] = [
    { name: 'Spotify', launch: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
    { name: 'Visual Studio Code', launch: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Microsoft VS Code\\Code.exe' },
    { name: 'Rechner', launch: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  ]
  it('matches exact names first, then AppIDs, prefixes and substrings (case-insensitive)', () => {
    expect(findApp(apps, 'spotify')?.name).toBe('Spotify')
    expect(findApp(apps, 'spotify.exe')?.name).toBe('Spotify')
    expect(findApp(apps, 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')?.name).toBe('Rechner')
    expect(findApp(apps, 'visual')?.name).toBe('Visual Studio Code')
    expect(findApp(apps, 'studio')?.name).toBe('Visual Studio Code')
    expect(findApp(apps, 'code.exe')?.name).toBe('Visual Studio Code')
    expect(findApp(apps, 'firefox')).toBeNull()
    expect(findApp(apps, '')).toBeNull()
  })
})

describe('createWindowsSystem on non-Windows', () => {
  it('returns neutral values and never calls the host', async () => {
    const { host, calls } = fakeHost()
    const sys = createWindowsSystem(host, { platform: 'linux' })
    expect(await sys.getActiveWindow()).toBeNull()
    expect(await sys.listWindows()).toEqual([])
    expect(await sys.focusWindow({ titleContains: 'x' })).toBe(false)
    expect(await sys.minimizeWindow({ hwnd: 1 })).toBe(false)
    expect(await sys.closeWindow({ processName: 'x' })).toBe(false)
    expect(await sys.listInstalledApps()).toEqual([])
    expect(await sys.getVolume()).toEqual({ percent: 0, muted: false })
    await sys.setVolume(50)
    await sys.setMuted(true)
    await sys.mediaKey('next')
    expect(await sys.getBrightness()).toBeNull()
    await sys.setBrightness(50)
    await sys.typeText('hi')
    await sys.pressKeys('ctrl+c')
    await sys.clickAt(1, 2)
    await sys.lockWorkstation()
    await sys.power('sleep')
    expect(await sys.isElevated()).toBe(false)
    await sys.warmup()
    const info = await sys.getSystemInfo()
    expect(info.hostname).toBe(os.hostname())
    expect(info.memoryGb).toBeGreaterThan(0)
    await expect(sys.launchApp('notepad')).rejects.toThrow(/nur unter Windows/)
    await expect(sys.pressKeys('ctrl+nope')).rejects.toThrow(/Unbekannte Taste/)
    expect(calls).toHaveLength(0)
    expect(nodeSystemInfo().os).toContain(os.type())
  })
})

describe('createWindowsSystem on Windows', () => {
  it('getActiveWindow parses the JSON (tolerating stray output) and null', async () => {
    const { host } = fakeHost([
      ['GetForegroundWindow', { stdout: 'noise line\n{"hwnd":1234,"title":"Editor – notes.txt","processName":"notepad","exePath":"C:\\\\Windows\\\\notepad.exe","pid":42}\n' }],
    ])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    expect(await sys.getActiveWindow()).toEqual({ title: 'Editor – notes.txt', processName: 'notepad', exePath: 'C:\\Windows\\notepad.exe', pid: 42 })

    const none = createWindowsSystem(fakeHost([['GetForegroundWindow', { stdout: 'null\n' }]]).host, { platform: 'win32' })
    expect(await none.getActiveWindow()).toBeNull()
    const broken = createWindowsSystem(fakeHost([['GetForegroundWindow', { stdout: '', stderr: 'Add-Type failed', exitCode: 1 }]]).host, { platform: 'win32' })
    expect(await broken.getActiveWindow()).toBeNull()
    const nulls = createWindowsSystem(fakeHost([['GetForegroundWindow', json({ hwnd: 1, title: 'T', processName: null, exePath: null, pid: 7 })]]).host, {
      platform: 'win32',
    })
    expect(await nulls.getActiveWindow()).toEqual({ title: 'T', processName: '', exePath: '', pid: 7 })
  })

  it('listWindows maps entries, drops untitled ones and tolerates a single object', async () => {
    const { host } = fakeHost([
      ['TopWindows', json([{ hwnd: 1, title: 'A', processName: 'a', pid: 1 }, { hwnd: 2, title: '  ', processName: 'b', pid: 2 }])],
    ])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    expect(await sys.listWindows()).toEqual([{ hwnd: 1, title: 'A', processName: 'a', pid: 1 }])
    const single = createWindowsSystem(fakeHost([['TopWindows', json({ hwnd: 3, title: 'Solo', processName: 'c', pid: 3 })]]).host, { platform: 'win32' })
    expect(await single.listWindows()).toEqual([{ hwnd: 3, title: 'Solo', processName: 'c', pid: 3 }])
    const failing = createWindowsSystem(fakeHost([['TopWindows', { stdout: '', stderr: 'boom\nmore', exitCode: 1 }]]).host, { platform: 'win32' })
    await expect(failing.listWindows()).rejects.toThrow('Fensterliste fehlgeschlagen: boom')
    const slow = createWindowsSystem(fakeHost([['TopWindows', { timedOut: true, exitCode: -1 }]]).host, { platform: 'win32' })
    await expect(slow.listWindows()).rejects.toThrow(/Zeitüberschreitung/)
  })

  it('window actions return the ok flag and skip the host without criteria', async () => {
    const { host, calls } = fakeHost([
      [/Focus\(\$target\)/, json({ ok: true, found: true, hwnd: 5, title: 'X', method: 'set-foreground' })],
      [/ShowWindow\(\$target, 6\)/, json({ ok: false, found: false, hwnd: 0, title: '', method: '' })],
      [/PostMessageW/, json({ ok: true, found: false, hwnd: 0, title: '', method: 'close-main-window' })],
    ])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    expect(await sys.focusWindow({ titleContains: 'x' })).toBe(true)
    expect(await sys.minimizeWindow({ hwnd: 77 })).toBe(false)
    expect(await sys.closeWindow({ processName: 'spotify' })).toBe(true)
    expect(calls).toHaveLength(3)
    expect(calls[0]!.script).toContain("IndexOf('x'")
    expect(calls[1]!.script).toContain('[IntPtr][long]77')
    expect(calls[2]!.script).toContain("Get-Process -Name 'spotify'")
    expect(await sys.focusWindow({})).toBe(false)
    expect(await sys.focusWindow({ titleContains: '   ' })).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('listInstalledApps caches for 60 s, sorts, and dedupes concurrent calls', async () => {
    let now = 1_000_000
    let served = 0
    const { host, calls } = fakeHost([
      [
        'Get-StartApps',
        () => {
          served++
          return json([
            { name: 'Zed', launch: 'Zed!App' },
            { name: 'Alpha', launch: 'Alpha!App' },
            { name: '', launch: 'ignored' },
            { name: 'NoLaunch', launch: '' },
          ])
        },
      ],
    ])
    const sys = createWindowsSystem(host, { platform: 'win32', now: () => now })
    const [a, b] = await Promise.all([sys.listInstalledApps(), sys.listInstalledApps()])
    expect(a).toEqual([{ name: 'Alpha', launch: 'Alpha!App' }, { name: 'Zed', launch: 'Zed!App' }])
    expect(b).toBe(a)
    expect(served).toBe(1)
    now += APPS_CACHE_MS - 1
    expect(await sys.listInstalledApps()).toBe(a)
    now += 2
    expect(await sys.listInstalledApps()).not.toBe(a)
    expect(served).toBe(2)
    expect(calls[0]!.options?.timeoutMs).toBeGreaterThanOrEqual(30_000)
  })

  it('launchApp resolves names via the Start-menu cache, paths via explorer and reports what ran', async () => {
    const { host, calls } = fakeHost([
      ['Get-StartApps', json([{ name: 'Spotify', launch: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' }])],
      ['Start-Process', { stdout: 'ok\n' }],
    ])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    expect(await sys.launchApp('spotify')).toBe('Gestartet: Spotify (SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify)')
    expect(calls.at(-1)!.script).toContain("'shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'")

    expect(await sys.launchApp('C:\\Tools\\x.exe')).toBe('Gestartet: C:\\Tools\\x.exe')
    expect(calls.at(-1)!.script).toContain("Start-Process -FilePath 'explorer.exe' -ArgumentList 'C:\\Tools\\x.exe'")

    expect(await sys.launchApp('C:\\Tools\\x.exe', ['--a', 'b c'])).toBe('Gestartet: C:\\Tools\\x.exe --a b c')
    expect(calls.at(-1)!.script).toContain(`Start-Process -FilePath 'C:\\Tools\\x.exe' -ArgumentList @('--a', '"b c"')`)

    expect(await sys.launchApp('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')).toBe('Gestartet: Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')
    expect(calls.at(-1)!.script).toContain("'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'")
    expect(await sys.launchApp('notepad')).toBe('Gestartet: notepad')
    expect(calls.at(-1)!.script).toContain("Start-Process -FilePath 'notepad' -ErrorAction Stop")
    await expect(sys.launchApp('   ')).rejects.toThrow('Kein Programm angegeben.')
  })

  it('launchApp surfaces failures with a German message and still works when the app list fails', async () => {
    const { host } = fakeHost([
      ['Get-StartApps', { stdout: '', stderr: 'Get-StartApps : not found', exitCode: 1 }],
      ['Start-Process', { stdout: '', stderr: "Start-Process : This command cannot be run due to the error: Das System kann die angegebene Datei nicht finden.\nAt line:1", exitCode: 1 }],
    ])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    await expect(sys.launchApp('doesnotexist')).rejects.toThrow(/Starten von „doesnotexist“ fehlgeschlagen: Start-Process : This command/)
  })

  it('volume getters/setters parse JSON and clamp', async () => {
    const { host, calls } = fakeHost([['FlowyAudio', json({ percent: 42, muted: true })]])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    expect(await sys.getVolume()).toEqual({ percent: 42, muted: true })
    await sys.setVolume(250)
    expect(calls.at(-1)!.script).toContain('[single](100 / 100)')
    await sys.setMuted(false)
    expect(calls.at(-1)!.script).toContain('Mute = $false')
    const failing = createWindowsSystem(fakeHost([['FlowyAudio', { exitCode: 1, stderr: 'COM error' }]]).host, { platform: 'win32' })
    await expect(failing.getVolume()).rejects.toThrow('Lautstärke abfragen fehlgeschlagen: COM error')
    await expect(failing.setVolume(1)).rejects.toThrow('Lautstärke setzen fehlgeschlagen: COM error')
  })

  it('brightness returns null when unsupported and throws a readable error on set failure', async () => {
    const supported = createWindowsSystem(fakeHost([['WmiMonitorBrightness', json({ percent: 75 })]]).host, { platform: 'win32' })
    expect(await supported.getBrightness()).toBe(75)
    const unsupported = createWindowsSystem(fakeHost([['WmiMonitorBrightness', { stdout: '{"percent":null}\n' }]]).host, { platform: 'win32' })
    expect(await unsupported.getBrightness()).toBeNull()
    const broken = createWindowsSystem(fakeHost([['WmiMonitorBrightness', { exitCode: 1, stderr: 'x' }]]).host, { platform: 'win32' })
    expect(await broken.getBrightness()).toBeNull()
    const external = createWindowsSystem(
      fakeHost([['WmiSetBrightness', { exitCode: 1, stderr: 'Die Helligkeit dieses Monitors kann nicht gesteuert werden (nur interne Displays werden unterstützt).' }]]).host,
      { platform: 'win32' },
    )
    await expect(external.setBrightness(50)).rejects.toThrow(/Helligkeit setzen fehlgeschlagen: Die Helligkeit dieses Monitors/)
  })

  it('input methods build scripts, convert DIP coordinates and validate key combos', async () => {
    const { host, calls } = fakeHost([['FlowyWin32', { stdout: 'ok\n' }]])
    const sys = createWindowsSystem(host, { platform: 'win32', dipToScreenPoint: (p) => ({ x: p.x * 2, y: p.y * 2 }) })
    await sys.typeText('Hallo')
    expect(calls.at(-1)!.script).toContain("TypeUnicode('Hallo')")
    await sys.typeText('')
    expect(calls).toHaveLength(1)
    await sys.pressKeys('ctrl+s')
    expect(calls.at(-1)!.script).toContain('keybd_event(0x53, 0, 0')
    await expect(sys.pressKeys('hyper+x')).rejects.toThrow('Unbekannte Taste: hyper')
    await sys.clickAt(100, 200, 'double')
    expect(calls.at(-1)!.script).toContain("Click(200, 400, 'left')")
    await sys.mediaKey('play-pause')
    expect(calls.at(-1)!.script).toContain('Key(0xB3)')
    await sys.lockWorkstation()
    expect(calls.at(-1)!.script).toContain('LockWorkStation()')
    const identity = createWindowsSystem(host, { platform: 'win32', dipToScreenPoint: null })
    await identity.clickAt(3, 4)
    expect(calls.at(-1)!.script).toContain("Click(3, 4, 'left')")
  })

  it('power actions run the right script and report failures', async () => {
    const { host, calls } = fakeHost([['shutdown.exe', { stdout: 'ok\n' }], ['-EncodedCommand', { stdout: 'ok\n' }]])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    await sys.power('shutdown')
    expect(calls.at(-1)!.script).toContain('shutdown.exe /s /t 5')
    await sys.power('sleep')
    expect(calls.at(-1)!.script).toContain('-EncodedCommand')
    const failing = createWindowsSystem(fakeHost([['shutdown.exe', { exitCode: 1, stderr: 'Zugriff verweigert' }]]).host, { platform: 'win32' })
    await expect(failing.power('restart')).rejects.toThrow('Energieaktion „restart“ fehlgeschlagen: Zugriff verweigert')
  })

  it('isElevated is cached and false on failure', async () => {
    const { host, calls } = fakeHost([['WindowsPrincipal', { stdout: 'True\r\n' }]])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    expect(await sys.isElevated()).toBe(true)
    expect(await sys.isElevated()).toBe(true)
    expect(calls).toHaveLength(1)
    const user = createWindowsSystem(fakeHost([['WindowsPrincipal', { stdout: 'false\n' }]]).host, { platform: 'win32' })
    expect(await user.isElevated()).toBe(false)
    const failing = createWindowsSystem(fakeHost([['WindowsPrincipal', { exitCode: 1 }]]).host, { platform: 'win32' })
    expect(await failing.isElevated()).toBe(false)
  })

  it('getSystemInfo parses CIM output with battery and falls back to Node info', async () => {
    const { host } = fakeHost([
      [
        'Win32_OperatingSystem',
        json({ os: 'Microsoft Windows 11 Pro 10.0.26100 (Build 26100)', hostname: 'PC', user: 'me', cpu: 'Ryzen', memoryGb: 31.9, uptimeMinutes: 123, battery: { percent: 88, charging: true } }),
      ],
    ])
    const sys = createWindowsSystem(host, { platform: 'win32' })
    expect(await sys.getSystemInfo()).toEqual({
      os: 'Microsoft Windows 11 Pro 10.0.26100 (Build 26100)',
      hostname: 'PC',
      user: 'me',
      cpu: 'Ryzen',
      memoryGb: 31.9,
      uptimeMinutes: 123,
      battery: { percent: 88, charging: true },
    })
    const noBattery = createWindowsSystem(fakeHost([['Win32_OperatingSystem', json({ os: 'W', hostname: 'h', user: 'u', cpu: 'c', memoryGb: 8, uptimeMinutes: 1 })]]).host, {
      platform: 'win32',
    })
    expect((await noBattery.getSystemInfo()).battery).toBeUndefined()
    const failing = createWindowsSystem(fakeHost([['Win32_OperatingSystem', { exitCode: 1, stderr: 'CIM broken' }]]).host, { platform: 'win32' })
    expect((await failing.getSystemInfo()).hostname).toBe(os.hostname())
  })

  it('warmup runs the interop initializers with a long timeout', async () => {
    const { host, calls } = fakeHost([['Initialize-FlowyAudio', { stdout: 'ok\n' }]])
    await createWindowsSystem(host, { platform: 'win32' }).warmup()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.script).toContain('Initialize-FlowyWin32')
    expect(calls[0]!.options?.timeoutMs).toBe(60_000)
  })
})
