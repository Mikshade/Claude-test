/**
 * PowerShell script builders for src/main/system/windows.ts – pure functions returning script text.
 *
 * OWNER: system agent.
 *
 * Conventions:
 *  - Scripts run inside the persistent host runspace (resources/ps/flowy-host.ps1), which provides
 *    `Initialize-FlowyWin32` / `Initialize-FlowyAudio` (lazy `Add-Type` of the interop classes).
 *  - Structured results are emitted with `ConvertTo-Json -Compress -Depth 4 -InputObject @(...)`
 *    (`-InputObject` keeps single-element arrays as arrays – PowerShell 5.1 quirk).
 *  - Strings coming from the model/user go through `psQuote` (single-quoted literals, no interpolation).
 */
import { buildEncodedCommand, psQuote } from './powershell'

export const WIN32_INIT = 'Initialize-FlowyWin32'
export const AUDIO_INIT = 'Initialize-FlowyAudio'

/** Warms up the interop types (first `Add-Type` costs 0.5-3 s). */
export function warmupScript(): string {
  return `${WIN32_INIT}\n${AUDIO_INIT}\n'ok'`
}

// ---------------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------------

const PROCESS_MAP = "$procs = @{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $procs[[int]$_.Id] = [string]$_.ProcessName }"

/** Foreground window → JSON `{ hwnd, title, processName, exePath, pid }` or the literal `null`. */
export function activeWindowScript(): string {
  return [
    WIN32_INIT,
    '$h = [FlowyWin32]::GetForegroundWindow()',
    "if ($h -eq [IntPtr]::Zero) { 'null' } else {",
    '  $procId = [int][FlowyWin32]::GetPid($h)',
    '  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue',
    "  if ($proc -and $proc.ProcessName -eq 'ApplicationFrameHost') {",
    '    $cp = [int][FlowyWin32]::CoreWindowPid($h)',
    '    if ($cp -gt 0) { $procId = $cp; $proc = Get-Process -Id $cp -ErrorAction SilentlyContinue }',
    '  }',
    "  $exe = ''",
    '  try { if ($proc -and $proc.Path) { $exe = [string]$proc.Path } } catch { }',
    '  ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ hwnd = $h.ToInt64(); title = [FlowyWin32]::GetTitle($h); processName = [string]$proc.ProcessName; exePath = $exe; pid = $procId })',
    '}',
  ].join('\n')
}

/** Visible, titled, non-cloaked top-level windows → JSON array of `{ hwnd, title, processName, pid }`. */
export function listWindowsScript(): string {
  return [
    WIN32_INIT,
    PROCESS_MAP,
    '$list = foreach ($h in [FlowyWin32]::TopWindows()) {',
    '  $wp = [int][FlowyWin32]::GetPid($h)',
    '  [ordered]@{ hwnd = $h.ToInt64(); title = [FlowyWin32]::GetTitle($h); processName = [string]$procs[$wp]; pid = $wp }',
    '}',
    'ConvertTo-Json -Compress -Depth 4 -InputObject @($list)',
  ].join('\n')
}

export interface WindowQuery {
  hwnd?: number
  titleContains?: string
  processName?: string
}

export type WindowAction = 'focus' | 'minimize' | 'close'

/** Strips a trailing `.exe` and lower-cases for process-name matching. */
export function normalizeProcessName(name: string): string {
  return name.trim().replace(/\.exe$/i, '').toLowerCase()
}

/**
 * Resolves the window (hwnd / titleContains case-insensitive / processName) and applies the action.
 * Output: JSON `{ ok, found, hwnd, title, method }`. For `close` with only a processName and no
 * matching window, falls back to `CloseMainWindow()` and finally `Stop-Process -Force`.
 */
export function windowActionScript(query: WindowQuery, action: WindowAction): string {
  const conditions: string[] = []
  if (query.titleContains !== undefined && query.titleContains !== '') {
    conditions.push(`($t.IndexOf(${psQuote(query.titleContains)}, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)`)
  }
  const processName = query.processName ? normalizeProcessName(query.processName) : ''
  if (processName) conditions.push(`($pn -eq ${psQuote(processName)})`)
  const condition = conditions.length > 0 ? conditions.join(' -and ') : '$false'

  const lines = [
    WIN32_INIT,
    '$target = [IntPtr]::Zero',
    `$method = ''`,
  ]
  if (query.hwnd !== undefined && Number.isFinite(query.hwnd) && query.hwnd > 0) {
    lines.push(`$cand = [IntPtr][long]${Math.floor(query.hwnd)}`, 'if ([FlowyWin32]::IsWindow($cand)) { $target = $cand }')
  }
  lines.push(
    'if ($target -eq [IntPtr]::Zero) {',
    `  ${PROCESS_MAP}`,
    '  foreach ($h in [FlowyWin32]::TopWindows()) {',
    '    $t = [string][FlowyWin32]::GetTitle($h)',
    '    $pn = ([string]$procs[[int][FlowyWin32]::GetPid($h)]).ToLowerInvariant()',
    `    if (${condition}) { $target = $h; break }`,
    '  }',
    '}',
    '$ok = $false',
    'if ($target -ne [IntPtr]::Zero) {',
  )
  switch (action) {
    case 'focus':
      lines.push("  $method = 'set-foreground'", '  $ok = [bool][FlowyWin32]::Focus($target)')
      break
    case 'minimize':
      lines.push("  $method = 'show-window'", '  [void][FlowyWin32]::ShowWindow($target, 6)', '  $ok = $true')
      break
    case 'close':
      lines.push("  $method = 'wm-close'", '  $ok = [bool][FlowyWin32]::PostMessageW($target, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)')
      break
  }
  if (action === 'close' && processName) {
    lines.push(
      '} else {',
      `  $plist = @(Get-Process -Name ${psQuote(processName)} -ErrorAction SilentlyContinue)`,
      '  if ($plist.Count -gt 0) {',
      "    $method = 'close-main-window'",
      '    $closed = $false',
      '    foreach ($p in $plist) { try { if ($p.CloseMainWindow()) { $closed = $true } } catch { } }',
      '    if (-not $closed) {',
      "      $method = 'stop-process'",
      '      foreach ($p in $plist) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $closed = $true } catch { } }',
      '    }',
      '    $ok = $closed',
      '  }',
    )
  }
  lines.push(
    '}',
    "$title = ''",
    'if ($target -ne [IntPtr]::Zero) { $title = [FlowyWin32]::GetTitle($target) }',
    'ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ ok = [bool]$ok; found = ($target -ne [IntPtr]::Zero); hwnd = $target.ToInt64(); title = [string]$title; method = $method })',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------------------------------

/** Start-menu apps (UWP + Win32) → JSON array of `{ name, launch }` (launch = AppUserModelId). */
export function startAppsScript(): string {
  return [
    '$apps = Get-StartApps -ErrorAction Stop | ForEach-Object { [ordered]@{ name = [string]$_.Name; launch = [string]$_.AppID } }',
    'ConvertTo-Json -Compress -Depth 4 -InputObject @($apps)',
  ].join('\n')
}

export type LaunchTarget =
  | { kind: 'appId'; appId: string }
  | { kind: 'path'; path: string; args: string[] }
  | { kind: 'command'; command: string; args: string[] }

/** True for things that look like a Start-menu AppUserModelId (`Pkg_hash!App`, `{KNOWNFOLDER}\…`). */
export function looksLikeAppId(value: string): boolean {
  return /^[^\s\\/]+_[a-z0-9]{13}![^\s\\/]+$/i.test(value) || /^\{[0-9A-F-]{36}\}\\/i.test(value)
}

/** True for file-system paths (drive letter, UNC or an executable/shortcut extension). */
export function looksLikePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') || /\.(exe|lnk|bat|cmd|com|msc|url)$/i.test(value.trim())
}

/**
 * Launch script. AppIDs and argument-less paths go through `explorer.exe` so the new process is a
 * child of the shell, not of the PowerShell host (a host restart must never kill the user's apps).
 */
export function launchScript(target: LaunchTarget): string {
  switch (target.kind) {
    case 'appId':
      return `Start-Process -FilePath 'explorer.exe' -ArgumentList ${psArg(`shell:AppsFolder\\${target.appId}`)}\n'ok'`
    case 'path': {
      if (target.args.length === 0) return `Start-Process -FilePath 'explorer.exe' -ArgumentList ${psArg(target.path)}\n'ok'`
      return `Start-Process -FilePath ${psQuote(target.path)} -ArgumentList @(${target.args.map(psArg).join(', ')}) -ErrorAction Stop\n'ok'`
    }
    case 'command': {
      const args = target.args.length > 0 ? ` -ArgumentList @(${target.args.map(psArg).join(', ')})` : ''
      return `Start-Process -FilePath ${psQuote(target.command)}${args} -ErrorAction Stop\n'ok'`
    }
  }
}

/**
 * A single process argument as a PowerShell literal. Windows PowerShell 5.1 joins `-ArgumentList`
 * with spaces without quoting, so values containing whitespace are wrapped in double quotes here.
 */
export function psArg(value: string): string {
  const clean = value.replace(/\0/g, '')
  if (/\s/.test(clean) && !/^".*"$/.test(clean)) return psQuote(`"${clean.replace(/"/g, '\\"')}"`)
  return psQuote(clean)
}

// ---------------------------------------------------------------------------------------------------
// Audio / media / brightness
// ---------------------------------------------------------------------------------------------------

const VOLUME_JSON = 'ConvertTo-Json -Compress -InputObject ([ordered]@{ percent = [int][math]::Round([FlowyAudio]::Volume * 100); muted = [bool][FlowyAudio]::Mute })'

export function getVolumeScript(): string {
  return `${AUDIO_INIT}\n${VOLUME_JSON}`
}

export function setVolumeScript(percent: number): string {
  const p = clampPercent(percent)
  return `${AUDIO_INIT}\n[FlowyAudio]::Volume = [single](${p} / 100)\n${VOLUME_JSON}`
}

export function setMutedScript(muted: boolean): string {
  return `${AUDIO_INIT}\n[FlowyAudio]::Mute = ${muted ? '$true' : '$false'}\n${VOLUME_JSON}`
}

export const MEDIA_KEYS = { 'play-pause': 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2 } as const
export type MediaKey = keyof typeof MEDIA_KEYS

export function mediaKeyScript(key: MediaKey): string {
  return `${WIN32_INIT}\n[FlowyWin32]::Key(${hex(MEDIA_KEYS[key])})\n'ok'`
}

/** Internal (laptop) panels only → JSON `{ percent }` with `null` when unsupported. */
export function getBrightnessScript(): string {
  return [
    'try {',
    '  $b = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Where-Object { $_.Active })',
    '  if ($b.Count -eq 0) { $b = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop) }',
    '  if ($b.Count -gt 0) { ConvertTo-Json -Compress -InputObject @{ percent = [int]$b[0].CurrentBrightness } } else { \'{"percent":null}\' }',
    "} catch { '{\"percent\":null}' }",
  ].join('\n')
}

export function setBrightnessScript(percent: number): string {
  const p = clampPercent(percent)
  return [
    '$m = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue)',
    "if ($m.Count -eq 0) { throw 'Die Helligkeit dieses Monitors kann nicht gesteuert werden (nur interne Displays werden unterstützt).' }",
    `foreach ($i in $m) { [void](Invoke-CimMethod -InputObject $i -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]${p} } -ErrorAction Stop) }`,
    "'ok'",
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------

export const TYPE_CHUNK_CHARS = 400

/** Unicode typing via SendInput; newlines become Enter presses, text is sent in chunks. */
export function typeTextScript(text: string): string {
  const lines = [WIN32_INIT]
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\0/g, '')
  const segments = normalized.split('\n')
  segments.forEach((segment, index) => {
    for (let i = 0; i < segment.length; i += TYPE_CHUNK_CHARS) {
      lines.push(`[FlowyWin32]::TypeUnicode(${psQuote(segment.slice(i, i + TYPE_CHUNK_CHARS))})`)
    }
    if (index < segments.length - 1) lines.push('[FlowyWin32]::Key(0x0D)')
  })
  lines.push("'ok'")
  return lines.join('\n')
}

interface VirtualKey {
  vk: number
  /** KEYEVENTF_EXTENDEDKEY – navigation keys, right-hand modifiers etc. */
  extended?: boolean
}

const MODIFIER_KEYS: Record<string, VirtualKey> = {
  ctrl: { vk: 0x11 },
  control: { vk: 0x11 },
  strg: { vk: 0x11 },
  shift: { vk: 0x10 },
  umschalt: { vk: 0x10 },
  alt: { vk: 0x12 },
  altgr: { vk: 0xa5, extended: true },
  win: { vk: 0x5b, extended: true },
  windows: { vk: 0x5b, extended: true },
  meta: { vk: 0x5b, extended: true },
  super: { vk: 0x5b, extended: true },
  cmd: { vk: 0x5b, extended: true },
}

const NAMED_KEYS: Record<string, VirtualKey> = {
  enter: { vk: 0x0d },
  return: { vk: 0x0d },
  eingabe: { vk: 0x0d },
  tab: { vk: 0x09 },
  esc: { vk: 0x1b },
  escape: { vk: 0x1b },
  space: { vk: 0x20 },
  leertaste: { vk: 0x20 },
  backspace: { vk: 0x08 },
  delete: { vk: 0x2e, extended: true },
  del: { vk: 0x2e, extended: true },
  entf: { vk: 0x2e, extended: true },
  insert: { vk: 0x2d, extended: true },
  ins: { vk: 0x2d, extended: true },
  einfg: { vk: 0x2d, extended: true },
  home: { vk: 0x24, extended: true },
  pos1: { vk: 0x24, extended: true },
  end: { vk: 0x23, extended: true },
  ende: { vk: 0x23, extended: true },
  pageup: { vk: 0x21, extended: true },
  pgup: { vk: 0x21, extended: true },
  bildauf: { vk: 0x21, extended: true },
  pagedown: { vk: 0x22, extended: true },
  pgdn: { vk: 0x22, extended: true },
  bildab: { vk: 0x22, extended: true },
  up: { vk: 0x26, extended: true },
  arrowup: { vk: 0x26, extended: true },
  down: { vk: 0x28, extended: true },
  arrowdown: { vk: 0x28, extended: true },
  left: { vk: 0x25, extended: true },
  arrowleft: { vk: 0x25, extended: true },
  right: { vk: 0x27, extended: true },
  arrowright: { vk: 0x27, extended: true },
  printscreen: { vk: 0x2c, extended: true },
  print: { vk: 0x2c, extended: true },
  druck: { vk: 0x2c, extended: true },
  pause: { vk: 0x13 },
  capslock: { vk: 0x14 },
  numlock: { vk: 0x90, extended: true },
  scrolllock: { vk: 0x91 },
  apps: { vk: 0x5d, extended: true },
  menu: { vk: 0x5d, extended: true },
  volumeup: { vk: 0xaf, extended: true },
  volumedown: { vk: 0xae, extended: true },
  volumemute: { vk: 0xad, extended: true },
  mute: { vk: 0xad, extended: true },
  playpause: { vk: 0xb3, extended: true },
  nexttrack: { vk: 0xb0, extended: true },
  prevtrack: { vk: 0xb1, extended: true },
  stopmedia: { vk: 0xb2, extended: true },
  plus: { vk: 0xbb },
  '+': { vk: 0xbb },
  minus: { vk: 0xbd },
  '-': { vk: 0xbd },
  comma: { vk: 0xbc },
  ',': { vk: 0xbc },
  period: { vk: 0xbe },
  '.': { vk: 0xbe },
  multiply: { vk: 0x6a },
  add: { vk: 0x6b },
  subtract: { vk: 0x6d },
  decimal: { vk: 0x6e },
  divide: { vk: 0x6f, extended: true },
}

export interface KeyChord {
  modifiers: VirtualKey[]
  key: VirtualKey
}

function lookupKey(token: string): VirtualKey | null {
  const t = token.toLowerCase()
  if (t in NAMED_KEYS) return NAMED_KEYS[t] ?? null
  if (/^[a-z]$/.test(t)) return { vk: 0x41 + (t.charCodeAt(0) - 97) }
  if (/^[0-9]$/.test(t)) return { vk: 0x30 + (t.charCodeAt(0) - 48) }
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(t)
  if (f) return { vk: 0x70 + Number(f[1]) - 1 }
  const num = /^(?:numpad|num)([0-9])$/.exec(t)
  if (num) return { vk: 0x60 + Number(num[1]) }
  return null
}

/**
 * Parses one chord like `ctrl+shift+t`, `alt+tab`, `win+d`, `enter`, `f5`, `ctrl++`.
 * Throws a German error for unknown keys.
 */
export function parseKeyChord(chord: string): KeyChord {
  const compact = chord.trim().replace(/\s*\+\s*/g, '+')
  if (!compact) throw new Error('Keine Taste angegeben.')
  // 'ctrl++' → ['ctrl', 'plus']; a lone '+' stays a key.
  const tokens = compact === '+' ? ['+'] : compact.replace(/\+\+$/, '+plus').split('+').filter(Boolean)
  if (tokens.length === 0) throw new Error(`Tastenkombination nicht verstanden: ${chord}`)
  const modifiers: VirtualKey[] = []
  let key: VirtualKey | null = null
  tokens.forEach((token, index) => {
    const lower = token.toLowerCase()
    const asModifier = MODIFIER_KEYS[lower]
    if (asModifier && index < tokens.length - 1) {
      modifiers.push(asModifier)
      return
    }
    const resolved = lookupKey(lower) ?? (asModifier ? asModifier : null)
    if (!resolved) throw new Error(`Unbekannte Taste: ${token}`)
    if (key) throw new Error(`Tastenkombination nicht verstanden: ${chord}`)
    key = resolved
  })
  if (!key) throw new Error(`Tastenkombination nicht verstanden: ${chord}`)
  return { modifiers, key }
}

/** Splits `ctrl+c, ctrl+v` / `alt+f4 enter` into chords. */
export function parseKeySequence(combo: string): KeyChord[] {
  const normalized = combo.trim().replace(/\s*\+\s*/g, '+')
  // Separators are commas/whitespace, except directly after '+' (so 'ctrl+,' stays one chord).
  const chords = normalized.split(/(?<!\+)[,\s]+/).filter(Boolean)
  if (chords.length === 0 && normalized) chords.push(normalized)
  if (chords.length === 0) throw new Error('Keine Taste angegeben.')
  return chords.map(parseKeyChord)
}

function keyEvent(key: VirtualKey, up: boolean): string {
  const flags = (key.extended ? 1 : 0) | (up ? 2 : 0)
  return `[FlowyWin32]::keybd_event(${hex(key.vk)}, 0, ${flags}, [UIntPtr]::Zero)`
}

/** keybd_event sequence: modifiers down, key tap, modifiers up (reverse order), 30 ms between chords. */
export function pressKeysScript(combo: string): string {
  const chords = parseKeySequence(combo)
  const lines = [WIN32_INIT]
  chords.forEach((chord, index) => {
    if (index > 0) lines.push('Start-Sleep -Milliseconds 30')
    for (const m of chord.modifiers) lines.push(keyEvent(m, false))
    lines.push(keyEvent(chord.key, false), keyEvent(chord.key, true))
    for (const m of [...chord.modifiers].reverse()) lines.push(keyEvent(m, true))
  })
  lines.push("'ok'")
  return lines.join('\n')
}

export type MouseButton = 'left' | 'right' | 'double'

/** Physical pixel coordinates (callers convert DIP → physical). */
export function clickScript(x: number, y: number, button: MouseButton = 'left'): string {
  const px = Math.round(x)
  const py = Math.round(y)
  const lines = [WIN32_INIT]
  if (button === 'double') {
    lines.push(`[FlowyWin32]::Click(${px}, ${py}, 'left')`, 'Start-Sleep -Milliseconds 60', `[FlowyWin32]::Click(${px}, ${py}, 'left')`)
  } else {
    lines.push(`[FlowyWin32]::Click(${px}, ${py}, '${button}')`)
  }
  lines.push("'ok'")
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------------
// Power / session / info
// ---------------------------------------------------------------------------------------------------

export function lockWorkstationScript(): string {
  return `${WIN32_INIT}\n[void][FlowyWin32]::LockWorkStation()\n'ok'`
}

export type PowerAction = 'sleep' | 'hibernate' | 'shutdown' | 'restart'

const SUSPEND_SOURCE =
  'using System.Runtime.InteropServices; public static class FlowyPower { [DllImport("powrprof.dll", SetLastError = true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent); }'

/**
 * `SetSuspendState` blocks until the machine resumes, so sleep/hibernate run in a detached
 * PowerShell process (the host returns immediately). Shutdown/restart use `shutdown.exe` with a
 * 5 s grace period (`shutdown.exe /a` aborts it).
 */
export function powerScript(action: PowerAction): string {
  switch (action) {
    case 'shutdown':
      return "shutdown.exe /s /t 5\n'ok'"
    case 'restart':
      return "shutdown.exe /r /t 5\n'ok'"
    case 'sleep':
    case 'hibernate': {
      const hibernate = action === 'hibernate' ? '$true' : '$false'
      const inner = `Add-Type -TypeDefinition ${psQuote(SUSPEND_SOURCE)}\n[void][FlowyPower]::SetSuspendState(${hibernate}, $false, $false)`
      const encoded = buildEncodedCommand(inner)
      return [
        `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', '${encoded}')`,
        "'ok'",
      ].join('\n')
    }
  }
}

export function isElevatedScript(): string {
  return "if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'true' } else { 'false' }"
}

/** JSON `{ os, hostname, user, cpu, memoryGb, uptimeMinutes, battery? }`. */
export function systemInfoScript(): string {
  return [
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop',
    '$cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1',
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue',
    '$bat = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1',
    '$uptime = 0',
    'try { $uptime = [int](((Get-Date) - $os.LastBootUpTime).TotalMinutes) } catch { }',
    '$mem = 0',
    'try { $mem = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } catch { }',
    '$info = [ordered]@{',
    "  os = (([string]$os.Caption).Trim() + ' ' + [string]$os.Version + ' (Build ' + [string]$os.BuildNumber + ')')",
    '  hostname = [string]$env:COMPUTERNAME',
    '  user = [string]$env:USERNAME',
    '  cpu = ([string]$cpu.Name).Trim()',
    '  memoryGb = [double]$mem',
    '  uptimeMinutes = [int]$uptime',
    '}',
    'if ($bat) { $info.battery = [ordered]@{ percent = [int]$bat.EstimatedChargeRemaining; charging = (@(2, 6, 7, 8, 9) -contains [int]$bat.BatteryStatus) } }',
    'ConvertTo-Json -Compress -Depth 4 -InputObject $info',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------------

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`
}
