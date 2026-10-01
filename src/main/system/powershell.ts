/**
 * Persistent PowerShell host: one long-lived `powershell.exe`/`pwsh` process (resources/ps/flowy-host.ps1)
 * that executes scripts sequentially in a single STA runspace, driven by a JSON-lines protocol over stdio.
 * Avoids the ~200 ms process start and the 0.5-3 s `Add-Type` compile per call.
 *
 * OWNER: system agent.
 *
 * Protocol (see resources/ps/README.md):
 *  - Node → host: `{ id, script: base64(utf8), timeoutMs }\n`
 *  - host → Node: `##FLOWY-READY##` once, then `##FLOWY## {"id","stdout","stderr","exitCode","timedOut","fatal"}` per request.
 *    Any other stdout line is logged at debug level and ignored.
 *  - Requests are serialized (FIFO). Node hard timeout = timeoutMs + 5 s → kill the process tree
 *    (`taskkill /PID <pid> /T /F`), resolve the call with `timedOut: true`, respawn lazily on the next call.
 *  - Readiness: if `##FLOWY-READY##` does not arrive within 8 s (or the process exits early) the host is
 *    respawned once with `windowsHide: false` + `-WindowStyle Hidden` (Windows PowerShell 5.1 quirk).
 *  - `runRaw` runs a one-shot process (`-EncodedCommand`, or a temp `.ps1` for large scripts).
 *  - On non-Windows platforms `run`/`runRaw` reject with a readable German error and never spawn.
 */
import { type ChildProcess, execFileSync, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { createLogger } from '../log'

const log = createLogger('powershell')

export interface PsResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
}

export interface PsRunOptions {
  timeoutMs?: number
  /** Max characters of stdout to keep (tail is dropped with a marker). */
  maxOutputChars?: number
  signal?: AbortSignal
}

export interface PowerShellHost {
  run(script: string, options?: PsRunOptions): Promise<PsResult>
  /** Run in a fresh, separate process (e.g. for `Start-Process -Verb RunAs`). */
  runRaw(script: string, options?: PsRunOptions): Promise<PsResult>
  /** Resolved executable ('pwsh' if PowerShell 7 is installed, else 'powershell'). */
  executable(): string
  dispose(): void
  /** True while a host process is running and ready (diagnostics). */
  isRunning(): boolean
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface PowerShellHostOptions {
  /** Use PowerShell 7 (`pwsh.exe`) when it is installed. Default: Windows PowerShell 5.1. */
  preferPwsh?: boolean
  /** Explicit executable (skips detection). */
  executablePath?: string
  /** Path of flowy-host.ps1. Default: packaged → <resources>/ps, dev → <app>/resources/ps. */
  hostScriptPath?: string
  /** Injected for tests. */
  spawn?: SpawnFn
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (file: string) => boolean
  readyTimeoutMs?: number
  defaultTimeoutMs?: number
}

export const HOST_READY_MARKER = '##FLOWY-READY##'
export const HOST_REPLY_PREFIX = '##FLOWY## '
export const DEFAULT_TIMEOUT_MS = 30_000
export const READY_TIMEOUT_MS = 8_000
/** Extra time the Node side waits beyond the script timeout before killing the host. */
export const HARD_TIMEOUT_GRACE_MS = 5_000
/** Scripts up to this size go through `-EncodedCommand`; larger ones through a temp `.ps1`. */
export const ENCODED_COMMAND_MAX_BYTES = 10 * 1024
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000

export const NOT_WINDOWS_MESSAGE = 'PowerShell ist nur unter Windows verfügbar.'

/** Prepended to every one-shot script: UTF-8 output, no prompts, no progress bars. */
export const PS_PRELUDE = [
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  "$ProgressPreference = 'SilentlyContinue'",
  "$ConfirmPreference = 'None'",
].join('\n')

const BASE_ARGS: readonly string[] = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text']

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------

/** `-EncodedCommand` payload: base64 of the UTF-16LE script. */
export function buildEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Single-quoted PowerShell string literal (the only escape inside '…' is doubling the quote). */
export function psQuote(value: string): string {
  return `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`
}

/**
 * PowerShell writes errors as CLIXML (`#< CLIXML<Objs …><S S="Error">…`) when started with
 * `-EncodedCommand`, redirected stderr and no `-OutputFormat`. We always pass `-OutputFormat Text`,
 * this is the safety net: returns the plain error text, the input unchanged when it is not CLIXML.
 */
export function decodeClixml(stderr: string): string {
  const marker = '#< CLIXML'
  const at = stderr.indexOf(marker)
  if (at < 0) return stderr
  const before = stderr.slice(0, at)
  const xml = stderr.slice(at)
  const parts = [...xml.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => decodeClixmlText(m[1] ?? ''))
  const text = parts.length > 0 ? parts.join('') : xml.replace(/^#< CLIXML\r?\n?/, '').replace(/<[^>]+>/g, '')
  return (before + text).replace(/\r\n/g, '\n').trimEnd()
}

function decodeClixmlText(s: string): string {
  return s
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/_x000A_/g, '\n')
    .replace(/_x000D_/g, '')
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Keeps the head of long output and appends a German marker. */
export function truncateOutput(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  const dropped = text.length - maxChars
  return `${text.slice(0, maxChars)}\n… [gekürzt: ${dropped} Zeichen weggelassen]`
}

export interface HostReply {
  id: string
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  fatal: boolean
  durationMs: number
}

/** Parses one stdout line of the host; `null` for anything that is not a protocol reply. */
export function parseHostReply(line: string): HostReply | null {
  if (!line.startsWith(HOST_REPLY_PREFIX)) return null
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(HOST_REPLY_PREFIX.length))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['id'] !== 'string') return null
  return {
    id: r['id'],
    stdout: typeof r['stdout'] === 'string' ? r['stdout'] : '',
    stderr: typeof r['stderr'] === 'string' ? r['stderr'] : '',
    exitCode: typeof r['exitCode'] === 'number' ? r['exitCode'] : r['timedOut'] === true ? -1 : 1,
    timedOut: r['timedOut'] === true,
    fatal: r['fatal'] === true,
    durationMs: typeof r['durationMs'] === 'number' ? r['durationMs'] : 0,
  }
}

/** Arguments for the persistent host process. */
export function buildHostArgs(hostScriptPath: string, fallbackWindowStyle: boolean): string[] {
  const args = [...BASE_ARGS]
  if (fallbackWindowStyle) args.push('-WindowStyle', 'Hidden')
  args.push('-File', hostScriptPath)
  return args
}

/** Default Windows PowerShell 5.1 path. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows'
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Finds PowerShell 7 (`pwsh.exe`): Program Files, Store alias, then `where.exe`. */
export function findPwsh(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fileExists,
  lookup: () => string | null = whereExe,
): string | null {
  const candidates = [
    path.win32.join(env['ProgramFiles'] || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    env['LOCALAPPDATA'] ? path.win32.join(env['LOCALAPPDATA'], 'Microsoft', 'WindowsApps', 'pwsh.exe') : '',
  ].filter(Boolean)
  for (const c of candidates) if (exists(c)) return c
  return lookup()
}

function fileExists(file: string): boolean {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function whereExe(): string | null {
  try {
    const out = execFileSync('where.exe', ['pwsh'], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

/** Location of flowy-host.ps1 (packaged: extraResources `ps/`, dev: repo `resources/ps/`). */
export function defaultHostScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ps', 'flowy-host.ps1')
    : path.join(app.getAppPath(), 'resources', 'ps', 'flowy-host.ps1')
}

// ---------------------------------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------------------------------

interface Job {
  script: string
  timeoutMs: number
  maxOutputChars: number
  signal: AbortSignal | undefined
  resolve: (result: PsResult) => void
  reject: (error: Error) => void
}

interface Pending {
  finish: (result: PsResult) => void
  startedAt: number
}

interface HostProcess {
  proc: ChildProcess
  ready: boolean
  alive: boolean
  buffer: string
}

export function createPowerShellHost(options: PowerShellHostOptions = {}): PowerShellHost {
  const platform = options.platform ?? process.platform
  const spawnFn: SpawnFn = options.spawn ?? nodeSpawn
  const env = options.env ?? process.env
  const exists = options.exists ?? fileExists
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const isWindows = platform === 'win32'

  let resolvedExe: string | null = null
  let host: HostProcess | null = null
  let starting: Promise<HostProcess> | null = null
  /** Sticky: once the hidden spawn failed the readiness probe we always use the fallback. */
  let useFallbackSpawn = false
  let disposed = false
  let pumping = false
  const queue: Job[] = []
  const pending = new Map<string, Pending>()

  function resolveExecutable(): string {
    if (resolvedExe) return resolvedExe
    if (options.executablePath) resolvedExe = options.executablePath
    else if (!isWindows) resolvedExe = 'powershell'
    else {
      const pwsh = options.preferPwsh ? findPwsh(env, exists, isWindows && !options.spawn ? whereExe : () => null) : null
      resolvedExe = pwsh ?? windowsPowerShellPath(env)
    }
    log.debug(`executable: ${resolvedExe}`)
    return resolvedExe
  }

  function hostScriptPath(): string {
    return options.hostScriptPath ?? defaultHostScriptPath()
  }

  // ---- process lifecycle --------------------------------------------------------------------------

  function killTree(proc: ChildProcess): void {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const pid = proc.pid
    try {
      if (isWindows && pid) {
        const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => {
          try {
            proc.kill()
          } catch {
            /* already gone */
          }
        })
        return
      }
      proc.kill()
    } catch (err) {
      log.debug('kill failed', err)
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
  }

  function failPending(result: Omit<PsResult, 'durationMs'>): void {
    for (const [id, p] of [...pending]) {
      pending.delete(id)
      p.finish({ ...result, durationMs: Date.now() - p.startedAt })
    }
  }

  function discardHost(h: HostProcess, reason: string): void {
    if (!h.alive) return
    h.alive = false
    h.ready = false
    if (host === h) host = null
    log.debug(`host discarded: ${reason}`)
    killTree(h.proc)
    failPending({ stdout: '', stderr: `PowerShell-Host wurde beendet (${reason}).`, exitCode: -1, timedOut: false })
  }

  function spawnHost(fallback: boolean): Promise<HostProcess> {
    const exe = resolveExecutable()
    const args = buildHostArgs(hostScriptPath(), fallback)
    log.info(`starting PowerShell host (${fallback ? 'fallback window mode' : 'hidden'}): ${exe}`)
    const proc = spawnFn(exe, args, { windowsHide: !fallback, stdio: 'pipe', env })
    const h: HostProcess = { proc, ready: false, alive: true, buffer: '' }

    return new Promise<HostProcess>((resolve, reject) => {
      let settled = false
      const readyTimer = setTimeout(
        () => fail(new Error(`Bereitschaftsmeldung nach ${readyTimeoutMs} ms nicht erhalten.`)),
        readyTimeoutMs,
      )
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        h.alive = false
        killTree(proc)
        reject(err)
      }
      const succeed = (): void => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        h.ready = true
        resolve(h)
      }

      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string | Buffer) => {
        h.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let nl: number
        while ((nl = h.buffer.indexOf('\n')) >= 0) {
          const line = h.buffer.slice(0, nl).replace(/\r$/, '')
          h.buffer = h.buffer.slice(nl + 1)
          if (!h.ready && line.trim() === HOST_READY_MARKER) {
            succeed()
            continue
          }
          handleLine(h, line)
        }
      })
      proc.stderr?.on('data', (chunk: string | Buffer) => {
        const text = String(chunk).trim()
        if (text) log.debug(`host stderr: ${text}`)
      })
      proc.on('error', (err: Error) => {
        log.warn('host process error', err)
        if (!settled) fail(err)
        else discardHost(h, err.message)
      })
      proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        const reason = `exit ${code ?? signal ?? '?'}`
        if (!settled) fail(new Error(`PowerShell-Host vorzeitig beendet (${reason}).`))
        else discardHost(h, reason)
      })
      proc.stdin?.on('error', (err: Error) => log.debug('host stdin error', err.message))
    })
  }

  async function startHost(): Promise<HostProcess> {
    const modes = useFallbackSpawn ? [true] : [false, true]
    let lastError: unknown = null
    for (const fallback of modes) {
      try {
        const h = await spawnHost(fallback)
        if (disposed) {
          // dispose() raced the start: do not leave an orphaned host behind.
          try {
            h.proc.stdin?.end()
          } catch {
            /* ignore */
          }
          discardHost(h, 'disposed')
          throw new Error('PowerShell-Host wurde beendet.')
        }
        host = h
        return h
      } catch (err) {
        lastError = err
        log.warn(`PowerShell host start failed (${fallback ? 'fallback' : 'hidden'} mode): ${errorMessage(err)}`)
        if (!fallback) useFallbackSpawn = true
      }
    }
    throw new Error(`PowerShell-Host konnte nicht gestartet werden: ${errorMessage(lastError)}`)
  }

  function ensureHost(): Promise<HostProcess> {
    if (host?.ready && host.alive) return Promise.resolve(host)
    if (!starting) {
      starting = startHost().finally(() => {
        starting = null
      })
    }
    return starting
  }

  // ---- protocol -----------------------------------------------------------------------------------

  function handleLine(h: HostProcess, line: string): void {
    const reply = parseHostReply(line)
    if (!reply) {
      if (line.trim()) log.debug(`host: ${line}`)
      return
    }
    const p = pending.get(reply.id)
    if (!p) {
      log.debug(`stale reply ignored (id ${reply.id})`)
      return
    }
    pending.delete(reply.id)
    if (reply.fatal) {
      log.warn('host reported a fatal (unstoppable) script – restarting the host')
      discardHost(h, 'fatal')
      p.finish({
        stdout: reply.stdout,
        stderr: reply.stderr || 'Skript konnte nicht abgebrochen werden.',
        exitCode: -1,
        timedOut: true,
        durationMs: Date.now() - p.startedAt,
      })
      return
    }
    p.finish({
      stdout: reply.stdout,
      stderr: reply.stderr,
      exitCode: reply.timedOut ? -1 : reply.exitCode,
      timedOut: reply.timedOut,
      durationMs: Date.now() - p.startedAt,
    })
  }

  function dispatch(h: HostProcess, job: Job): Promise<PsResult> {
    return new Promise<PsResult>((resolve) => {
      const id = randomUUID()
      const startedAt = Date.now()
      let done = false
      const finish = (result: PsResult): void => {
        if (done) return
        done = true
        clearTimeout(hardTimer)
        pending.delete(id)
        job.signal?.removeEventListener('abort', onAbort)
        resolve({ ...result, stdout: truncateOutput(result.stdout, job.maxOutputChars) })
      }
      const hardTimer = setTimeout(() => {
        log.warn(`script exceeded ${job.timeoutMs} ms + grace – killing the PowerShell host`)
        const result: PsResult = {
          stdout: '',
          stderr: `Zeitüberschreitung nach ${job.timeoutMs} ms – der PowerShell-Host wurde neu gestartet.`,
          exitCode: -1,
          timedOut: true,
          durationMs: Date.now() - startedAt,
        }
        finish(result)
        discardHost(h, 'timeout')
      }, job.timeoutMs + HARD_TIMEOUT_GRACE_MS)
      const onAbort = (): void => {
        finish({ stdout: '', stderr: 'Abgebrochen.', exitCode: -1, timedOut: false, durationMs: Date.now() - startedAt })
        discardHost(h, 'abort')
      }
      job.signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, { finish, startedAt })

      const payload = JSON.stringify({ id, script: Buffer.from(job.script, 'utf8').toString('base64'), timeoutMs: job.timeoutMs }) + '\n'
      const stdin = h.proc.stdin
      if (!stdin || !h.alive) {
        finish({ stdout: '', stderr: 'PowerShell-Host ist nicht erreichbar.', exitCode: -1, timedOut: false, durationMs: 0 })
        return
      }
      try {
        stdin.write(payload, (err) => {
          if (err) {
            finish(sendFailure(err.message, Date.now() - startedAt))
            discardHost(h, 'stdin')
          }
        })
      } catch (err) {
        finish(sendFailure(errorMessage(err), 0))
        discardHost(h, 'stdin')
      }
    })
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const job = queue.shift()!
        if (disposed) {
          job.reject(new Error('PowerShell-Host wurde beendet.'))
          continue
        }
        if (job.signal?.aborted) {
          job.reject(new Error('Abgebrochen.'))
          continue
        }
        let h: HostProcess
        try {
          h = await ensureHost()
        } catch (err) {
          job.reject(err instanceof Error ? err : new Error(errorMessage(err)))
          continue
        }
        job.resolve(await dispatch(h, job))
      }
    } finally {
      pumping = false
    }
  }

  // ---- public API ---------------------------------------------------------------------------------

  function run(script: string, runOptions: PsRunOptions = {}): Promise<PsResult> {
    if (!isWindows) return Promise.reject(new Error(NOT_WINDOWS_MESSAGE))
    if (disposed) return Promise.reject(new Error('PowerShell-Host wurde beendet.'))
    return new Promise<PsResult>((resolve, reject) => {
      queue.push({
        script,
        timeoutMs: Math.max(100, Math.floor(runOptions.timeoutMs ?? defaultTimeoutMs)),
        maxOutputChars: runOptions.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
        signal: runOptions.signal,
        resolve,
        reject,
      })
      void pump()
    })
  }

  async function runRaw(script: string, runOptions: PsRunOptions = {}): Promise<PsResult> {
    if (!isWindows) throw new Error(NOT_WINDOWS_MESSAGE)
    if (runOptions.signal?.aborted) throw new Error('Abgebrochen.')
    const full = `${PS_PRELUDE}\n${script}\n`
    const args = [...BASE_ARGS]
    if (useFallbackSpawn) args.push('-WindowStyle', 'Hidden')
    let tempFile: string | null = null
    if (Buffer.byteLength(full, 'utf8') < ENCODED_COMMAND_MAX_BYTES) {
      args.push('-EncodedCommand', buildEncodedCommand(full))
    } else {
      tempFile = path.join(os.tmpdir(), `flowy-${randomUUID()}.ps1`)
      // PowerShell 5.1 reads BOM-less .ps1 files as ANSI → write a UTF-8 BOM.
      await fs.promises.writeFile(tempFile, `\uFEFF${full}`, 'utf8')
      args.push('-File', tempFile)
    }
    try {
      return await runOneShot(resolveExecutable(), args, runOptions)
    } finally {
      if (tempFile) fs.promises.unlink(tempFile).catch(() => undefined)
    }
  }

  function runOneShot(exe: string, args: string[], runOptions: PsRunOptions): Promise<PsResult> {
    const timeoutMs = Math.max(100, Math.floor(runOptions.timeoutMs ?? defaultTimeoutMs))
    const maxOutputChars = runOptions.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    return new Promise<PsResult>((resolve, reject) => {
      const startedAt = Date.now()
      let proc: ChildProcess
      try {
        proc = spawnFn(exe, args, { windowsHide: !useFallbackSpawn, stdio: ['ignore', 'pipe', 'pipe'], env })
      } catch (err) {
        reject(new Error(`PowerShell konnte nicht gestartet werden: ${errorMessage(err)}`))
        return
      }
      const out: string[] = []
      const err: string[] = []
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        killTree(proc)
      }, timeoutMs)
      const onAbort = (): void => {
        killTree(proc)
      }
      runOptions.signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = (): void => {
        clearTimeout(timer)
        runOptions.signal?.removeEventListener('abort', onAbort)
      }
      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')
      proc.stdout?.on('data', (c: string | Buffer) => out.push(String(c)))
      proc.stderr?.on('data', (c: string | Buffer) => err.push(String(c)))
      proc.on('error', (e: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`PowerShell konnte nicht gestartet werden: ${e.message}`))
      })
      proc.on('close', (code: number | null) => {
        if (settled) return
        settled = true
        cleanup()
        const aborted = runOptions.signal?.aborted === true
        const stderr = decodeClixml(err.join(''))
        resolve({
          stdout: truncateOutput(out.join(''), maxOutputChars),
          stderr: timedOut
            ? `${stderr}\nZeitüberschreitung nach ${timeoutMs} ms.`.trim()
            : aborted
              ? `${stderr}\nAbgebrochen.`.trim()
              : stderr,
          exitCode: timedOut || aborted ? -1 : (code ?? -1),
          timedOut,
          durationMs: Date.now() - startedAt,
        })
      })
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const job of queue.splice(0)) job.reject(new Error('PowerShell-Host wurde beendet.'))
    const h = host
    if (!h) return
    host = null
    h.ready = false
    failPending({ stdout: '', stderr: 'PowerShell-Host wird beendet.', exitCode: -1, timedOut: false })
    try {
      h.proc.stdin?.end() // the host loop sees EOF and exits by itself
    } catch {
      /* ignore */
    }
    const killer = setTimeout(() => {
      if (h.alive) {
        h.alive = false
        killTree(h.proc)
      }
    }, 2000)
    killer.unref?.()
    h.proc.once('exit', () => {
      h.alive = false
      clearTimeout(killer)
    })
  }

  return {
    run,
    runRaw,
    executable: () => resolveExecutable(),
    dispose,
    isRunning: () => host?.ready === true && host.alive,
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sendFailure(reason: string, durationMs: number): PsResult {
  return { stdout: '', stderr: `Senden an den PowerShell-Host fehlgeschlagen: ${reason}`, exitCode: -1, timedOut: false, durationMs }
}
