import { describe, expect, it } from 'vitest'
import {
  activeWindowScript,
  clickScript,
  getBrightnessScript,
  getVolumeScript,
  isElevatedScript,
  launchScript,
  listWindowsScript,
  looksLikeAppId,
  looksLikePath,
  mediaKeyScript,
  normalizeProcessName,
  parseKeyChord,
  parseKeySequence,
  powerScript,
  pressKeysScript,
  psArg,
  setBrightnessScript,
  setMutedScript,
  setVolumeScript,
  startAppsScript,
  systemInfoScript,
  TYPE_CHUNK_CHARS,
  typeTextScript,
  warmupScript,
  windowActionScript,
} from './scripts'

const JSON_ARRAY = 'ConvertTo-Json -Compress -Depth 4 -InputObject @('

describe('window scripts', () => {
  it('activeWindowScript resolves ApplicationFrameHost via the CoreWindow child and prints JSON or null', () => {
    const s = activeWindowScript()
    expect(s.startsWith('Initialize-FlowyWin32')).toBe(true)
    expect(s).toContain("'ApplicationFrameHost'")
    expect(s).toContain('CoreWindowPid')
    expect(s).toContain("'null'")
    expect(s).toContain('ConvertTo-Json -Compress -Depth 4 -InputObject')
    expect(s).toContain('exePath')
  })

  it('listWindowsScript enumerates top windows and always emits a JSON array', () => {
    const s = listWindowsScript()
    expect(s).toContain('[FlowyWin32]::TopWindows()')
    expect(s).toContain(JSON_ARRAY)
    expect(s).toContain('processName')
  })

  it('windowActionScript escapes the title, normalizes the process name and picks the action', () => {
    const focus = windowActionScript({ titleContains: "O'Reilly – Notes", processName: 'Notepad.EXE' }, 'focus')
    expect(focus).toContain("$t.IndexOf('O''Reilly – Notes', [System.StringComparison]::OrdinalIgnoreCase) -ge 0")
    expect(focus).toContain("$pn -eq 'notepad'")
    expect(focus).toContain(') -and (')
    expect(focus).toContain('[FlowyWin32]::Focus($target)')
    expect(focus).not.toContain('Stop-Process')
    expect(focus).not.toContain('[IntPtr][long]')

    const minimize = windowActionScript({ hwnd: 123456 }, 'minimize')
    expect(minimize).toContain('$cand = [IntPtr][long]123456')
    expect(minimize).toContain('ShowWindow($target, 6)')
    expect(minimize).toContain('if ($false) { $target = $h; break }') // no title/process criteria

    const close = windowActionScript({ titleContains: 'x' }, 'close')
    expect(close).toContain('PostMessageW($target, 0x0010')
    expect(close).not.toContain('Stop-Process')

    const closeByProcess = windowActionScript({ processName: 'spotify' }, 'close')
    expect(closeByProcess).toContain("Get-Process -Name 'spotify'")
    expect(closeByProcess).toContain('CloseMainWindow()')
    expect(closeByProcess).toContain('Stop-Process -Id $p.Id -Force')
    expect(closeByProcess).toContain('ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ ok = [bool]$ok; found =')
  })

  it('normalizeProcessName strips .exe and lower-cases', () => {
    expect(normalizeProcessName(' Spotify.EXE ')).toBe('spotify')
    expect(normalizeProcessName('code')).toBe('code')
  })
})

describe('app scripts', () => {
  it('startAppsScript uses Get-StartApps with a JSON array', () => {
    const s = startAppsScript()
    expect(s).toContain('Get-StartApps')
    expect(s).toContain(JSON_ARRAY)
    expect(s).toContain('launch = [string]$_.AppID')
  })

  it('psArg wraps values with whitespace in double quotes (PowerShell 5.1 -ArgumentList quirk)', () => {
    expect(psArg('plain')).toBe("'plain'")
    expect(psArg('C:\\Program Files\\App\\app.exe')).toBe(`'"C:\\Program Files\\App\\app.exe"'`)
    expect(psArg('say "hi" there')).toBe(`'"say \\"hi\\" there"'`)
    expect(psArg('"already quoted"')).toBe(`'"already quoted"'`)
  })

  it('launchScript routes AppIDs and plain paths through explorer.exe, arguments through Start-Process', () => {
    expect(launchScript({ kind: 'appId', appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' })).toBe(
      "Start-Process -FilePath 'explorer.exe' -ArgumentList 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'\n'ok'",
    )
    expect(launchScript({ kind: 'appId', appId: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Mozilla Firefox\\firefox.exe' })).toContain(
      `'"shell:AppsFolder\\{6D809377-6AF0-444B-8957-A3773F02200E}\\Mozilla Firefox\\firefox.exe"'`,
    )
    expect(launchScript({ kind: 'path', path: "C:\\Tools\\it's.exe", args: [] })).toBe(
      "Start-Process -FilePath 'explorer.exe' -ArgumentList 'C:\\Tools\\it''s.exe'\n'ok'",
    )
    expect(launchScript({ kind: 'path', path: 'C:\\Tools\\x.exe', args: ['--flag', 'a b'] })).toBe(
      `Start-Process -FilePath 'C:\\Tools\\x.exe' -ArgumentList @('--flag', '"a b"') -ErrorAction Stop\n'ok'`,
    )
    expect(launchScript({ kind: 'command', command: 'notepad', args: [] })).toBe("Start-Process -FilePath 'notepad' -ErrorAction Stop\n'ok'")
    expect(launchScript({ kind: 'command', command: 'code', args: ['.'] })).toContain("-ArgumentList @('.')")
  })

  it('looksLikeAppId / looksLikePath classify launch targets', () => {
    expect(looksLikeAppId('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')).toBe(true)
    expect(looksLikeAppId('{6D809377-6AF0-444B-8957-A3773F02200E}\\Mozilla Firefox\\firefox.exe')).toBe(true)
    expect(looksLikeAppId('Spotify')).toBe(false)
    expect(looksLikeAppId('C:\\x.exe')).toBe(false)
    expect(looksLikePath('C:\\Windows\\notepad.exe')).toBe(true)
    expect(looksLikePath('\\\\server\\share\\tool.exe')).toBe(true)
    expect(looksLikePath('calc.exe')).toBe(true)
    expect(looksLikePath('Spotify')).toBe(false)
    expect(looksLikePath('ms-settings:display')).toBe(false)
  })
})

describe('audio / media / brightness scripts', () => {
  it('volume scripts initialize CoreAudio, clamp and report JSON', () => {
    expect(getVolumeScript()).toBe(
      'Initialize-FlowyAudio\nConvertTo-Json -Compress -InputObject ([ordered]@{ percent = [int][math]::Round([FlowyAudio]::Volume * 100); muted = [bool][FlowyAudio]::Mute })',
    )
    expect(setVolumeScript(150)).toContain('[FlowyAudio]::Volume = [single](100 / 100)')
    expect(setVolumeScript(-5)).toContain('[FlowyAudio]::Volume = [single](0 / 100)')
    expect(setVolumeScript(33.4)).toContain('[single](33 / 100)')
    expect(setVolumeScript(Number.NaN)).toContain('[single](0 / 100)')
    expect(setMutedScript(true)).toContain('[FlowyAudio]::Mute = $true')
    expect(setMutedScript(false)).toContain('[FlowyAudio]::Mute = $false')
  })

  it('mediaKeyScript uses the documented virtual-key codes', () => {
    expect(mediaKeyScript('play-pause')).toContain('[FlowyWin32]::Key(0xB3)')
    expect(mediaKeyScript('next')).toContain('Key(0xB0)')
    expect(mediaKeyScript('previous')).toContain('Key(0xB1)')
    expect(mediaKeyScript('stop')).toContain('Key(0xB2)')
  })

  it('brightness scripts use WmiMonitorBrightness and clamp the value', () => {
    expect(getBrightnessScript()).toContain('WmiMonitorBrightness')
    expect(getBrightnessScript()).toContain('{"percent":null}')
    const set = setBrightnessScript(120)
    expect(set).toContain('WmiMonitorBrightnessMethods')
    expect(set).toContain('Brightness = [byte]100')
    expect(set).toContain('throw')
  })
})

describe('key parsing', () => {
  it('parses chords with modifiers, named keys, function keys and aliases', () => {
    expect(parseKeyChord('ctrl+shift+t')).toEqual({ modifiers: [{ vk: 0x11 }, { vk: 0x10 }], key: { vk: 0x54 } })
    expect(parseKeyChord('alt+tab')).toEqual({ modifiers: [{ vk: 0x12 }], key: { vk: 0x09 } })
    expect(parseKeyChord('win+d')).toEqual({ modifiers: [{ vk: 0x5b, extended: true }], key: { vk: 0x44 } })
    expect(parseKeyChord('enter')).toEqual({ modifiers: [], key: { vk: 0x0d } })
    expect(parseKeyChord('F5')).toEqual({ modifiers: [], key: { vk: 0x74 } })
    expect(parseKeyChord('f12').key.vk).toBe(0x7b)
    expect(parseKeyChord('Strg + C')).toEqual({ modifiers: [{ vk: 0x11 }], key: { vk: 0x43 } })
    expect(parseKeyChord('ctrl+alt+entf').key).toEqual({ vk: 0x2e, extended: true })
    expect(parseKeyChord('numpad5').key.vk).toBe(0x65)
    expect(parseKeyChord('7').key.vk).toBe(0x37)
  })

  it('handles the plus key and lone modifiers', () => {
    expect(parseKeyChord('ctrl++')).toEqual({ modifiers: [{ vk: 0x11 }], key: { vk: 0xbb } })
    expect(parseKeyChord('ctrl+plus').key.vk).toBe(0xbb)
    expect(parseKeyChord('+').key.vk).toBe(0xbb)
    expect(parseKeyChord('win')).toEqual({ modifiers: [], key: { vk: 0x5b, extended: true } })
  })

  it('rejects unknown keys with a German message', () => {
    expect(() => parseKeyChord('ctrl+foo')).toThrow('Unbekannte Taste: foo')
    expect(() => parseKeyChord('')).toThrow('Keine Taste angegeben.')
    expect(() => parseKeyChord('a+b')).toThrow(/nicht verstanden/)
  })

  it('parseKeySequence splits on commas/whitespace but keeps "ctrl+," together', () => {
    expect(parseKeySequence('ctrl+c, ctrl+v')).toHaveLength(2)
    expect(parseKeySequence('alt+f4 enter').map((c) => c.key.vk)).toEqual([0x73, 0x0d])
    expect(parseKeySequence('ctrl+,')).toEqual([{ modifiers: [{ vk: 0x11 }], key: { vk: 0xbc } }])
    expect(() => parseKeySequence('  ')).toThrow('Keine Taste angegeben.')
  })

  it('pressKeysScript emits down/up events in the right order with extended flags', () => {
    const lines = pressKeysScript('ctrl+shift+t').split('\n')
    expect(lines[0]).toBe('Initialize-FlowyWin32')
    expect(lines.slice(1, 7)).toEqual([
      '[FlowyWin32]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)',
      '[FlowyWin32]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)',
      '[FlowyWin32]::keybd_event(0x54, 0, 0, [UIntPtr]::Zero)',
      '[FlowyWin32]::keybd_event(0x54, 0, 2, [UIntPtr]::Zero)',
      '[FlowyWin32]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)',
      '[FlowyWin32]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)',
    ])
    const del = pressKeysScript('delete')
    expect(del).toContain('keybd_event(0x2E, 0, 1, [UIntPtr]::Zero)')
    expect(del).toContain('keybd_event(0x2E, 0, 3, [UIntPtr]::Zero)')
    const seq = pressKeysScript('ctrl+c, ctrl+v')
    expect(seq).toContain('Start-Sleep -Milliseconds 30')
    expect(seq.match(/keybd_event\(0x11, 0, 0/g)).toHaveLength(2)
  })
})

describe('input scripts', () => {
  it('typeTextScript quotes, chunks and converts newlines to Enter', () => {
    const s = typeTextScript("it's\r\nfine\n")
    expect(s.split('\n')).toEqual([
      'Initialize-FlowyWin32',
      "[FlowyWin32]::TypeUnicode('it''s')",
      '[FlowyWin32]::Key(0x0D)',
      "[FlowyWin32]::TypeUnicode('fine')",
      '[FlowyWin32]::Key(0x0D)',
      "'ok'",
    ])
    const long = typeTextScript('x'.repeat(TYPE_CHUNK_CHARS * 2 + 1))
    expect(long.match(/TypeUnicode\(/g)).toHaveLength(3)
    expect(typeTextScript('Grüße 👋')).toContain("TypeUnicode('Grüße 👋')")
    expect(typeTextScript('a\0b')).toContain("TypeUnicode('ab')")
  })

  it('clickScript rounds coordinates and doubles the click', () => {
    expect(clickScript(10.4, 20.6)).toBe("Initialize-FlowyWin32\n[FlowyWin32]::Click(10, 21, 'left')\n'ok'")
    expect(clickScript(1, 2, 'right')).toContain("Click(1, 2, 'right')")
    const dbl = clickScript(5, 5, 'double')
    expect(dbl.match(/Click\(5, 5, 'left'\)/g)).toHaveLength(2)
    expect(dbl).toContain('Start-Sleep -Milliseconds 60')
  })
})

describe('power / info scripts', () => {
  it('powerScript uses shutdown.exe with a grace period and a detached SetSuspendState for sleep', () => {
    expect(powerScript('shutdown')).toBe("shutdown.exe /s /t 5\n'ok'")
    expect(powerScript('restart')).toBe("shutdown.exe /r /t 5\n'ok'")
    const sleep = powerScript('sleep')
    expect(sleep).toContain("Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden")
    const encoded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(sleep)?.[1]
    expect(encoded).toBeTruthy()
    const inner = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(inner).toContain('SetSuspendState($false, $false, $false)')
    expect(inner).toContain('powrprof.dll')
    const hib = Buffer.from(/'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(powerScript('hibernate'))![1]!, 'base64').toString('utf16le')
    expect(hib).toContain('SetSuspendState($true, $false, $false)')
  })

  it('isElevated / systemInfo / warmup scripts', () => {
    expect(isElevatedScript()).toContain('WindowsBuiltInRole]::Administrator')
    const info = systemInfoScript()
    for (const cls of ['Win32_OperatingSystem', 'Win32_Processor', 'Win32_ComputerSystem', 'Win32_Battery']) expect(info).toContain(cls)
    expect(info).toContain('uptimeMinutes')
    expect(info).toContain('ConvertTo-Json -Compress -Depth 4 -InputObject $info')
    expect(warmupScript()).toBe("Initialize-FlowyWin32\nInitialize-FlowyAudio\n'ok'")
  })
})
