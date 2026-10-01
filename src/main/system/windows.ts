/**
 * Windows integration built on the PowerShell host (no native modules).
 *
 * OWNER: system agent. Everything must degrade gracefully on non-Windows (return empty/false, never throw
 * synchronously), because development happens on Linux.
 *
 * Each method builds a script (./scripts.ts, pure), runs it on the shared host and parses the JSON it
 * prints. Script output is treated as untrusted data (validated with zod, never executed).
 */
import os from 'node:os'
import { screen as electronScreen } from 'electron'
import { z } from 'zod'
import type { ActiveWindowInfo } from '@shared/state'
import { createLogger } from '../log'
import type { PowerShellHost, PsResult } from './powershell'
import {
  activeWindowScript,
  clickScript,
  getBrightnessScript,
  getVolumeScript,
  isElevatedScript,
  launchScript,
  type LaunchTarget,
  listWindowsScript,
  looksLikeAppId,
  looksLikePath,
  mediaKeyScript,
  powerScript,
  pressKeysScript,
  lockWorkstationScript,
  parseKeySequence,
  setBrightnessScript,
  setMutedScript,
  setVolumeScript,
  startAppsScript,
  systemInfoScript,
  typeTextScript,
  warmupScript,
  windowActionScript,
  type WindowQuery,
} from './scripts'

const log = createLogger('windows')

export interface WindowInfo {
  hwnd: number
  title: string
  processName: string
  pid: number
}

export interface InstalledApp {
  name: string
  /** AppUserModelId (UWP/Start apps) or exe path. */
  launch: string
}

export interface SystemInfo {
  os: string
  hostname: string
  user: string
  cpu: string
  memoryGb: number
  uptimeMinutes: number
  battery?: { percent: number; charging: boolean }
}

export interface WindowsSystem {
  getActiveWindow(): Promise<ActiveWindowInfo | null>
  listWindows(): Promise<WindowInfo[]>
  focusWindow(query: { hwnd?: number; titleContains?: string; processName?: string }): Promise<boolean>
  minimizeWindow(query: { hwnd?: number; titleContains?: string }): Promise<boolean>
  closeWindow(query: { hwnd?: number; titleContains?: string; processName?: string }): Promise<boolean>
  listInstalledApps(): Promise<InstalledApp[]>
  launchApp(nameOrPath: string, args?: string[]): Promise<string>
  getVolume(): Promise<{ percent: number; muted: boolean }>
  setVolume(percent: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
  mediaKey(key: 'play-pause' | 'next' | 'previous' | 'stop'): Promise<void>
  getBrightness(): Promise<number | null>
  setBrightness(percent: number): Promise<void>
  typeText(text: string): Promise<void>
  pressKeys(combo: string): Promise<void>
  clickAt(x: number, y: number, button?: 'left' | 'right' | 'double'): Promise<void>
  lockWorkstation(): Promise<void>
  power(action: 'sleep' | 'hibernate' | 'shutdown' | 'restart'): Promise<void>
  isElevated(): Promise<boolean>
  getSystemInfo(): Promise<SystemInfo>
  /** Compiles the Win32/CoreAudio interop types in the host ahead of the first real call (optional). */
  warmup(): Promise<void>
}

export interface Point {
  x: number
  y: number
}

export interface WindowsSystemOptions {
  /** Injected for tests; default `process.platform`. */
  platform?: NodeJS.Platform
  /** DIP → physical pixel conversion; default Electron `screen.dipToScreenPoint` when available, `null` = identity. */
  dipToScreenPoint?: ((point: Point) => Point) | null
  now?: () => number
  /** Lifetime of the Start-menu app cache. */
  appsCacheMs?: number
}

export const APPS_CACHE_MS = 60_000

const TIMEOUT_FAST_MS = 15_000
const TIMEOUT_SLOW_MS = 30_000
const TIMEOUT_WARMUP_MS = 60_000

// ---------------------------------------------------------------------------------------------------
// Output parsing (pure, exported for tests)
// ---------------------------------------------------------------------------------------------------

/**
 * Extracts the JSON document from script output that may contain stray lines before it
 * (warnings, `Add-Type` noise). Returns `undefined` when no JSON can be found.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed === 'null') return null
  const attempts: string[] = [trimmed]
  const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0)
  if (starts.length > 0) {
    const start = Math.min(...starts)
    const tail = trimmed.slice(start)
    attempts.push(tail)
    const lastEnd = Math.max(tail.lastIndexOf('}'), tail.lastIndexOf(']'))
    if (lastEnd >= 0) attempts.push(tail.slice(0, lastEnd + 1))
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* next */
    }
  }
  return undefined
}

const optionalString = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined ? '' : String(v)))
const optionalNumber = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
})

const ActiveWindowSchema = z.object({
  hwnd: optionalNumber,
  title: optionalString,
  processName: optionalString,
  exePath: optionalString,
  pid: optionalNumber,
})
/** PowerShell 5.1 may still collapse single-element arrays when a script forgets `-InputObject @()`. */
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
const WindowListSchema = z.preprocess(
  asArray,
  z.array(z.object({ hwnd: optionalNumber, title: optionalString, processName: optionalString, pid: optionalNumber })),
)
const WindowActionSchema = z.object({
  ok: z.boolean().default(false),
  found: z.boolean().default(false),
  method: optionalString,
  title: optionalString,
})
const AppsSchema = z.preprocess(asArray, z.array(z.object({ name: optionalString, launch: optionalString })))
const VolumeSchema = z.object({ percent: optionalNumber, muted: z.boolean().default(false) })
const BrightnessSchema = z.object({ percent: z.number().nullable().default(null) })
const SystemInfoSchema = z.object({
  os: optionalString,
  hostname: optionalString,
  user: optionalString,
  cpu: optionalString,
  memoryGb: optionalNumber,
  uptimeMinutes: optionalNumber,
  battery: z.object({ percent: optionalNumber, charging: z.boolean().default(false) }).nullable().optional(),
})

/** Case-insensitive app lookup: exact name → exact AppID → name prefix → name contains → AppID contains. */
export function findApp(apps: InstalledApp[], query: string): InstalledApp | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const qNoExt = q.replace(/\.exe$/, '')
  const byName = (pred: (name: string) => boolean): InstalledApp | undefined => apps.find((a) => pred(a.name.toLowerCase()))
  return (
    byName((n) => n === q || n === qNoExt) ??
    apps.find((a) => a.launch.toLowerCase() === q) ??
    byName((n) => n.startsWith(qNoExt)) ??
    byName((n) => n.includes(qNoExt)) ??
    apps.find((a) => a.launch.toLowerCase().includes(qNoExt)) ??
    null
  )
}

/** Pure fallback used off-Windows and when CIM fails. */
export function nodeSystemInfo(): SystemInfo {
  let user = ''
  try {
    user = os.userInfo().username
  } catch {
    user = process.env['USERNAME'] ?? process.env['USER'] ?? ''
  }
  return {
    os: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    user,
    cpu: os.cpus()[0]?.model ?? '',
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    uptimeMinutes: Math.round(os.uptime() / 60),
  }
}

// ---------------------------------------------------------------------------------------------------

export function createWindowsSystem(ps: PowerShellHost, options: WindowsSystemOptions = {}): WindowsSystem {
  const platform = options.platform ?? process.platform
  const isWindows = platform === 'win32'
  const now = options.now ?? Date.now
  const appsCacheMs = options.appsCacheMs ?? APPS_CACHE_MS
  const dipToScreenPoint = options.dipToScreenPoint === undefined ? defaultDipToScreenPoint() : options.dipToScreenPoint

  let appsCache: { at: number; apps: InstalledApp[] } | null = null
  let appsInFlight: Promise<InstalledApp[]> | null = null
  let elevated: Promise<boolean> | null = null

  // ---- helpers ----------------------------------------------------------------------------------

  function describeFailure(result: PsResult, what: string): Error {
    if (result.timedOut) return new Error(`Zeitüberschreitung bei: ${what}.`)
    const reason = firstLine(result.stderr) || `Exit-Code ${result.exitCode}`
    return new Error(`${what} fehlgeschlagen: ${reason}`)
  }

  /** Runs a script and parses + validates its JSON output. */
  async function runJson<T>(script: string, schema: z.ZodType<T>, what: string, timeoutMs = TIMEOUT_FAST_MS): Promise<T> {
    const result = await ps.run(script, { timeoutMs })
    const data = extractJson(result.stdout)
    if (data === undefined) throw describeFailure(result, what)
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      log.warn(`${what}: unexpected output`, result.stdout.slice(0, 300))
      throw new Error(`${what} fehlgeschlagen: unerwartete Ausgabe.`)
    }
    return parsed.data
  }

  /** Runs a fire-and-forget script; throws a German error on failure. */
  async function runOk(script: string, what: string, timeoutMs = TIMEOUT_FAST_MS): Promise<void> {
    const result = await ps.run(script, { timeoutMs })
    if (result.timedOut || result.exitCode !== 0) throw describeFailure(result, what)
  }

  async function windowAction(query: WindowQuery, action: 'focus' | 'minimize' | 'close', what: string): Promise<boolean> {
    if (!isWindows) return false
    if (!hasCriteria(query)) return false
    const r = await runJson(windowActionScript(query, action), WindowActionSchema, what)
    if (!r.found && action !== 'close') log.debug(`${what}: no window matched`, query)
    return r.ok
  }

  // ---- API --------------------------------------------------------------------------------------

  async function getActiveWindow(): Promise<ActiveWindowInfo | null> {
    if (!isWindows) return null
    const result = await ps.run(activeWindowScript(), { timeoutMs: TIMEOUT_FAST_MS })
    const data = extractJson(result.stdout)
    if (data === null) return null
    if (data === undefined) {
      log.warn('getActiveWindow failed', firstLine(result.stderr))
      return null
    }
    const parsed = ActiveWindowSchema.safeParse(data)
    if (!parsed.success) return null
    return { title: parsed.data.title, processName: parsed.data.processName, exePath: parsed.data.exePath, pid: parsed.data.pid }
  }

  async function listWindows(): Promise<WindowInfo[]> {
    if (!isWindows) return []
    const list = await runJson(listWindowsScript(), WindowListSchema, 'Fensterliste')
    return list
      .filter((w) => w.title.trim() !== '')
      .map((w) => ({ hwnd: w.hwnd, title: w.title, processName: w.processName, pid: w.pid }))
  }

  async function listInstalledApps(): Promise<InstalledApp[]> {
    if (!isWindows) return []
    if (appsCache && now() - appsCache.at < appsCacheMs) return appsCache.apps
    if (appsInFlight) return appsInFlight
    appsInFlight = (async () => {
      try {
        const apps = (await runJson(startAppsScript(), AppsSchema, 'App-Liste', TIMEOUT_SLOW_MS))
          .filter((a) => a.name && a.launch)
          .sort((a, b) => a.name.localeCompare(b.name, 'de'))
        appsCache = { at: now(), apps }
        return apps
      } finally {
        appsInFlight = null
      }
    })()
    return appsInFlight
  }

  async function launchApp(nameOrPath: string, args: string[] = []): Promise<string> {
    const target = nameOrPath.trim()
    if (!target) throw new Error('Kein Programm angegeben.')
    if (!isWindows) throw new Error('Programme starten ist nur unter Windows verfügbar.')
    const cleanArgs = args.map((a) => String(a))
    let launch: LaunchTarget
    let label = target
    if (looksLikePath(target)) {
      launch = { kind: 'path', path: target, args: cleanArgs }
    } else if (looksLikeAppId(target)) {
      launch = { kind: 'appId', appId: target }
    } else {
      const apps = await listInstalledApps().catch((err: unknown) => {
        log.warn('listInstalledApps failed, launching by name', err)
        return [] as InstalledApp[]
      })
      const match = findApp(apps, target)
      if (match) {
        launch = { kind: 'appId', appId: match.launch }
        label = match.name
      } else {
        launch = { kind: 'command', command: target, args: cleanArgs }
      }
    }
    const result = await ps.run(launchScript(launch), { timeoutMs: TIMEOUT_FAST_MS })
    if (result.timedOut || result.exitCode !== 0) throw describeFailure(result, `Starten von „${label}“`)
    const argText = cleanArgs.length > 0 && launch.kind !== 'appId' ? ` ${cleanArgs.join(' ')}` : ''
    const via = launch.kind === 'appId' && launch.appId !== label ? ` (${launch.appId})` : ''
    return `Gestartet: ${label}${argText}${via}`
  }

  async function getVolume(): Promise<{ percent: number; muted: boolean }> {
    if (!isWindows) return { percent: 0, muted: false }
    const v = await runJson(getVolumeScript(), VolumeSchema, 'Lautstärke abfragen')
    return { percent: clamp(v.percent), muted: v.muted }
  }

  async function setVolume(percent: number): Promise<void> {
    if (!isWindows) return
    await runOk(setVolumeScript(percent), 'Lautstärke setzen')
  }

  async function setMuted(muted: boolean): Promise<void> {
    if (!isWindows) return
    await runOk(setMutedScript(muted), muted ? 'Stummschalten' : 'Stummschaltung aufheben')
  }

  async function mediaKey(key: 'play-pause' | 'next' | 'previous' | 'stop'): Promise<void> {
    if (!isWindows) return
    await runOk(mediaKeyScript(key), 'Medientaste senden')
  }

  async function getBrightness(): Promise<number | null> {
    if (!isWindows) return null
    try {
      const b = await runJson(getBrightnessScript(), BrightnessSchema, 'Helligkeit abfragen')
      return b.percent === null ? null : clamp(b.percent)
    } catch (err) {
      log.debug('getBrightness unsupported', err)
      return null
    }
  }

  async function setBrightness(percent: number): Promise<void> {
    if (!isWindows) return
    await runOk(setBrightnessScript(percent), 'Helligkeit setzen')
  }

  async function typeText(text: string): Promise<void> {
    if (!isWindows || text.length === 0) return
    await runOk(typeTextScript(text), 'Text eingeben', TIMEOUT_SLOW_MS)
  }

  async function pressKeys(combo: string): Promise<void> {
    parseKeySequence(combo) // validates early (German error for unknown keys), also off-Windows
    if (!isWindows) return
    await runOk(pressKeysScript(combo), `Tastenkombination „${combo}“`)
  }

  async function clickAt(x: number, y: number, button: 'left' | 'right' | 'double' = 'left'): Promise<void> {
    if (!isWindows) return
    const point = dipToScreenPoint ? dipToScreenPoint({ x, y }) : { x, y }
    await runOk(clickScript(point.x, point.y, button), 'Mausklick')
  }

  async function lockWorkstation(): Promise<void> {
    if (!isWindows) return
    await runOk(lockWorkstationScript(), 'Sperren')
  }

  async function power(action: 'sleep' | 'hibernate' | 'shutdown' | 'restart'): Promise<void> {
    if (!isWindows) return
    await runOk(powerScript(action), `Energieaktion „${action}“`)
  }

  function isElevated(): Promise<boolean> {
    if (!isWindows) return Promise.resolve(false)
    if (!elevated) {
      elevated = ps
        .run(isElevatedScript(), { timeoutMs: TIMEOUT_FAST_MS })
        .then((r) => r.exitCode === 0 && r.stdout.trim().toLowerCase() === 'true')
        .catch((err: unknown) => {
          log.warn('isElevated failed', err)
          elevated = null
          return false
        })
    }
    return elevated
  }

  async function getSystemInfo(): Promise<SystemInfo> {
    if (!isWindows) return nodeSystemInfo()
    try {
      const info = await runJson(systemInfoScript(), SystemInfoSchema, 'Systeminformationen', TIMEOUT_SLOW_MS)
      const out: SystemInfo = {
        os: info.os,
        hostname: info.hostname || os.hostname(),
        user: info.user,
        cpu: info.cpu,
        memoryGb: info.memoryGb,
        uptimeMinutes: info.uptimeMinutes,
      }
      if (info.battery) out.battery = { percent: clamp(info.battery.percent), charging: info.battery.charging }
      return out
    } catch (err) {
      log.warn('getSystemInfo via CIM failed, using Node fallback', err)
      return nodeSystemInfo()
    }
  }

  async function warmup(): Promise<void> {
    if (!isWindows) return
    const r = await ps.run(warmupScript(), { timeoutMs: TIMEOUT_WARMUP_MS })
    if (r.exitCode !== 0) log.warn('interop warmup failed', firstLine(r.stderr))
    else log.info(`interop types ready (${r.durationMs} ms)`)
  }

  return {
    getActiveWindow,
    listWindows,
    focusWindow: (query) => windowAction(query, 'focus', 'Fenster aktivieren'),
    minimizeWindow: (query) => windowAction(query, 'minimize', 'Fenster minimieren'),
    closeWindow: (query) => windowAction(query, 'close', 'Fenster schließen'),
    listInstalledApps,
    launchApp,
    getVolume,
    setVolume,
    setMuted,
    mediaKey,
    getBrightness,
    setBrightness,
    typeText,
    pressKeys,
    clickAt,
    lockWorkstation,
    power,
    isElevated,
    getSystemInfo,
    warmup,
  }
}

function defaultDipToScreenPoint(): ((point: Point) => Point) | null {
  // `screen.dipToScreenPoint` exists on Windows only (and not in the test mock).
  const fn = (electronScreen as unknown as { dipToScreenPoint?: (p: Point) => Point } | undefined)?.dipToScreenPoint
  if (typeof fn !== 'function') return null
  return (p) => {
    try {
      return fn.call(electronScreen, p)
    } catch {
      return p
    }
  }
}

function hasCriteria(query: WindowQuery): boolean {
  return (query.hwnd !== undefined && query.hwnd > 0) || Boolean(query.titleContains?.trim()) || Boolean(query.processName?.trim())
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? ''
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)))
}
