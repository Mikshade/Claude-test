import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildEncodedCommand,
  buildHostArgs,
  createPowerShellHost,
  decodeClixml,
  defaultHostScriptPath,
  findPwsh,
  HOST_READY_MARKER,
  HOST_REPLY_PREFIX,
  NOT_WINDOWS_MESSAGE,
  parseHostReply,
  PS_PRELUDE,
  psQuote,
  type SpawnFn,
  truncateOutput,
  windowsPowerShellPath,
} from './powershell'

// ---------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------

interface Request {
  id: string
  script: string
  timeoutMs: number
}

class FakeChild extends EventEmitter {
  pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  readonly requests: Request[] = []
  readonly rawInput: string[] = []
  private inbuf = ''

  constructor(readonly command: string, readonly args: readonly string[], readonly options: Record<string, unknown>) {
    super()
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.inbuf += String(chunk)
      let nl: number
      while ((nl = this.inbuf.indexOf('\n')) >= 0) {
        const line = this.inbuf.slice(0, nl)
        this.inbuf = this.inbuf.slice(nl + 1)
        this.rawInput.push(line)
        const req = JSON.parse(line) as { id: string; script: string; timeoutMs: number }
        this.requests.push({ id: req.id, script: Buffer.from(req.script, 'base64').toString('utf8'), timeoutMs: req.timeoutMs })
      }
    })
  }

  ready(): void {
    this.stdout.write(`${HOST_READY_MARKER}\n`)
  }

  reply(reply: Record<string, unknown>): void {
    this.stdout.write(`${HOST_REPLY_PREFIX}${JSON.stringify(reply)}\n`)
  }

  exit(code: number | null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code, null)
    this.emit('close', code, null)
  }

  kill(): boolean {
    this.killed = true
    process.nextTick(() => this.exit(null))
    return true
  }
}

function fakeSpawn(): { spawn: SpawnFn; children: FakeChild[]; kills: FakeChild[] } {
  const children: FakeChild[] = []
  const kills: FakeChild[] = []
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild(command, args, options as Record<string, unknown>)
    if (command === 'taskkill') {
      kills.push(child)
      child.pid = 999
      process.nextTick(() => child.exit(0))
    } else {
      children.push(child)
    }
    return child as unknown as ChildProcess
  }
  return { spawn, children, kills }
}

/** Lets stream data events / microtasks settle (setImmediate stays real, see fake-timer config). */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Polls (real event loop turns) until the condition holds – for real async fs work. */
async function waitUntil(condition: () => boolean, maxRounds = 500): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    if (condition()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('waitUntil: condition not met')
}

const HOST_SCRIPT = 'C:\\Flowy\\resources\\ps\\flowy-host.ps1'
const ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }

function makeHost(spawn: SpawnFn, extra: Parameters<typeof createPowerShellHost>[0] = {}) {
  return createPowerShellHost({ spawn, platform: 'win32', hostScriptPath: HOST_SCRIPT, env: ENV, ...extra })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------

describe('pure helpers', () => {
  it('buildEncodedCommand encodes UTF-16LE base64 (round trip)', () => {
    const encoded = buildEncodedCommand('Write-Output "Grüße 👋"')
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Output "Grüße 👋"')
  })

  it('psQuote doubles single quotes and strips NUL', () => {
    expect(psQuote("O'Reilly")).toBe("'O''Reilly'")
    expect(psQuote('a\0b')).toBe("'ab'")
    expect(psQuote('$env:PATH "x"')).toBe(`'$env:PATH "x"'`)
  })

  it('decodeClixml extracts error text and leaves plain stderr alone', () => {
    const clixml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-Item : Cannot find path_x000D__x000A_</S><S S="Error">At line:1 char:1 &lt;x&gt; &amp; &quot;q&quot;_x000D__x000A_</S></Objs>'
    expect(decodeClixml(clixml)).toBe('Get-Item : Cannot find path\nAt line:1 char:1 <x> & "q"')
    expect(decodeClixml('plain error')).toBe('plain error')
    expect(decodeClixml('')).toBe('')
    expect(decodeClixml('before\n#< CLIXML\n<Objs><S S="Error">boom</S></Objs>')).toBe('before\nboom')
  })

  it('truncateOutput keeps the head and adds a German marker', () => {
    expect(truncateOutput('abc', 10)).toBe('abc')
    const out = truncateOutput('x'.repeat(50), 10)
    expect(out.startsWith('x'.repeat(10))).toBe(true)
    expect(out).toContain('gekürzt: 40 Zeichen')
    expect(truncateOutput('abc', 0)).toBe('abc')
  })

  it('parseHostReply accepts protocol lines only and fills defaults', () => {
    expect(parseHostReply('hello')).toBeNull()
    expect(parseHostReply(`${HOST_REPLY_PREFIX}not json`)).toBeNull()
    expect(parseHostReply(`${HOST_REPLY_PREFIX}{"stdout":"x"}`)).toBeNull()
    expect(parseHostReply(`${HOST_REPLY_PREFIX}{"id":"1","stdout":"out","stderr":"","exitCode":0,"timedOut":false,"fatal":false,"durationMs":5}`)).toEqual({
      id: '1',
      stdout: 'out',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      fatal: false,
      durationMs: 5,
    })
    expect(parseHostReply(`${HOST_REPLY_PREFIX}{"id":"2","timedOut":true}`)).toMatchObject({ id: '2', exitCode: -1, timedOut: true, stdout: '' })
  })

  it('buildHostArgs adds -WindowStyle Hidden only in fallback mode and ends with -File', () => {
    expect(buildHostArgs(HOST_SCRIPT, false)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-OutputFormat',
      'Text',
      '-File',
      HOST_SCRIPT,
    ])
    const fallback = buildHostArgs(HOST_SCRIPT, true)
    expect(fallback).toContain('-WindowStyle')
    expect(fallback.slice(-2)).toEqual(['-File', HOST_SCRIPT])
  })

  it('resolves the Windows PowerShell 5.1 path and pwsh candidates', () => {
    expect(windowsPowerShellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windowsPowerShellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const pf = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(findPwsh(ENV, (f) => f === pf, () => null)).toBe(pf)
    expect(findPwsh(ENV, () => false, () => null)).toBeNull()
    expect(findPwsh(ENV, () => false, () => 'C:\\x\\pwsh.exe')).toBe('C:\\x\\pwsh.exe')
  })

  it('executable() prefers pwsh only when requested and present', () => {
    const { spawn } = fakeSpawn()
    expect(makeHost(spawn).executable()).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const pf = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(makeHost(spawn, { preferPwsh: true, exists: (f) => f === pf }).executable()).toBe(pf)
    expect(makeHost(spawn, { preferPwsh: true, exists: () => false }).executable()).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(makeHost(spawn, { executablePath: 'X:\\ps.exe' }).executable()).toBe('X:\\ps.exe')
  })

  it('the bundled host script exists in dev and uses the same protocol markers', () => {
    const file = defaultHostScriptPath()
    expect(file).toBe(path.join(process.cwd(), 'resources', 'ps', 'flowy-host.ps1'))
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain(`'${HOST_READY_MARKER}'`)
    expect(text).toContain(`'${HOST_REPLY_PREFIX}'`)
    expect(text).toContain('Initialize-FlowyWin32')
    expect(text).toContain('Initialize-FlowyAudio')
    // Pure ASCII: PowerShell 5.1 reads BOM-less files as ANSI.
    expect(/^[\x00-\x7f]*$/.test(text)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------
// Non-Windows
// ---------------------------------------------------------------------------------------------------

describe('non-Windows platforms', () => {
  it('run/runRaw reject with a German message and never spawn', async () => {
    const { spawn, children } = fakeSpawn()
    const host = createPowerShellHost({ spawn, platform: 'linux' })
    await expect(host.run('Get-Date')).rejects.toThrow(NOT_WINDOWS_MESSAGE)
    await expect(host.runRaw('Get-Date')).rejects.toThrow(NOT_WINDOWS_MESSAGE)
    expect(children).toHaveLength(0)
    expect(host.isRunning()).toBe(false)
    host.dispose()
  })
})

// ---------------------------------------------------------------------------------------------------
// Persistent host
// ---------------------------------------------------------------------------------------------------

describe('persistent host', () => {
  it('spawns lazily with the documented argv, frames requests and resolves replies', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    expect(children).toHaveLength(0)

    const promise = host.run('Write-Output "Grüße"', { timeoutMs: 5000 })
    expect(children).toHaveLength(1)
    const child = children[0]!
    expect(child.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(child.args).toEqual(buildHostArgs(HOST_SCRIPT, false))
    expect(child.options).toMatchObject({ windowsHide: true, stdio: 'pipe' })

    child.ready()
    await flush()
    expect(host.isRunning()).toBe(true)
    expect(child.requests).toHaveLength(1)
    const req = child.requests[0]!
    expect(req.script).toBe('Write-Output "Grüße"')
    expect(req.timeoutMs).toBe(5000)
    expect(child.rawInput[0]).toMatch(/^[\x20-\x7e]+$/) // ASCII-only request line

    child.reply({ id: req.id, stdout: 'Grüße\n', stderr: '', exitCode: 0, timedOut: false, fatal: false, durationMs: 3 })
    const result = await promise
    expect(result).toMatchObject({ stdout: 'Grüße\n', stderr: '', exitCode: 0, timedOut: false })
    host.dispose()
  })

  it('handles chunked replies, stray output and unknown ids', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('x')
    const child = children[0]!
    child.stdout.write('Add-Type noise\r\n##FLOWY-READ')
    child.stdout.write('Y##\r\n')
    await flush()
    const id = child.requests[0]!.id
    child.reply({ id: 'someone-else', stdout: 'stale', exitCode: 0, timedOut: false, fatal: false })
    child.stdout.write('diagnostic line\n')
    const line = `${HOST_REPLY_PREFIX}${JSON.stringify({ id, stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, fatal: false })}\n`
    child.stdout.write(line.slice(0, 20))
    await flush()
    child.stdout.write(line.slice(20))
    const result = await promise
    expect(result.stdout).toBe('ok')
    host.dispose()
  })

  it('serializes requests FIFO on one host', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const first = host.run('1')
    const second = host.run('2')
    const child = children[0]!
    child.ready()
    await flush()
    expect(child.requests.map((r) => r.script)).toEqual(['1'])
    child.reply({ id: child.requests[0]!.id, stdout: 'one', exitCode: 0, timedOut: false, fatal: false })
    await flush()
    expect(child.requests.map((r) => r.script)).toEqual(['1', '2'])
    child.reply({ id: child.requests[1]!.id, stdout: 'two', exitCode: 0, timedOut: false, fatal: false })
    expect((await first).stdout).toBe('one')
    expect((await second).stdout).toBe('two')
    expect(children).toHaveLength(1)
    host.dispose()
  })

  it('falls back to -WindowStyle Hidden when the readiness marker does not arrive in time', async () => {
    const { spawn, children, kills } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('x')
    expect(children).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(8000)
    await flush()
    expect(kills).toHaveLength(1)
    expect(kills[0]!.args).toEqual(['/PID', '4242', '/T', '/F'])
    expect(children).toHaveLength(2)
    const second = children[1]!
    expect(second.options).toMatchObject({ windowsHide: false })
    expect(second.args).toContain('-WindowStyle')
    second.ready()
    await flush()
    second.reply({ id: second.requests[0]!.id, stdout: 'late', exitCode: 0, timedOut: false, fatal: false })
    expect((await promise).stdout).toBe('late')

    // The fallback mode is sticky for later respawns.
    second.exit(1)
    await flush()
    const again = host.run('y')
    expect(children).toHaveLength(3)
    expect(children[2]!.args).toContain('-WindowStyle')
    children[2]!.ready()
    await flush()
    children[2]!.reply({ id: children[2]!.requests[0]!.id, stdout: 'z', exitCode: 0, timedOut: false, fatal: false })
    expect((await again).stdout).toBe('z')
    host.dispose()
  })

  it('respawns in fallback mode immediately when the first host exits early', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('x')
    children[0]!.exit(2)
    await flush()
    expect(children).toHaveLength(2)
    children[1]!.ready()
    await flush()
    children[1]!.reply({ id: children[1]!.requests[0]!.id, stdout: 'ok', exitCode: 0, timedOut: false, fatal: false })
    expect((await promise).stdout).toBe('ok')
    host.dispose()
  })

  it('rejects the call when both spawn modes fail, then retries on the next call', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('x')
    children[0]!.exit(2)
    await flush()
    children[1]!.exit(2)
    await expect(promise).rejects.toThrow(/PowerShell-Host konnte nicht gestartet werden/)
    const retry = host.run('y')
    expect(children).toHaveLength(3)
    children[2]!.ready()
    await flush()
    children[2]!.reply({ id: children[2]!.requests[0]!.id, stdout: 'ok', exitCode: 0, timedOut: false, fatal: false })
    expect((await retry).stdout).toBe('ok')
    host.dispose()
  })

  it('kills the tree on hard timeout, resolves timedOut and respawns lazily', async () => {
    const { spawn, children, kills } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('Start-Sleep 99', { timeoutMs: 1000 })
    const child = children[0]!
    child.ready()
    await flush()
    await vi.advanceTimersByTimeAsync(5999)
    expect(kills).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    const result = await promise
    expect(result).toMatchObject({ timedOut: true, exitCode: -1 })
    expect(result.stderr).toMatch(/Zeitüberschreitung/)
    expect(kills).toHaveLength(1)
    expect(kills[0]!.args).toEqual(['/PID', '4242', '/T', '/F'])
    expect(host.isRunning()).toBe(false)

    const next = host.run('x')
    expect(children).toHaveLength(2)
    children[1]!.ready()
    await flush()
    children[1]!.reply({ id: children[1]!.requests[0]!.id, stdout: 'fresh', exitCode: 0, timedOut: false, fatal: false })
    expect((await next).stdout).toBe('fresh')
    host.dispose()
  })

  it('passes host-side timeouts through and treats fatal replies like a timeout', async () => {
    const { spawn, children, kills } = fakeSpawn()
    const host = makeHost(spawn)
    const a = host.run('a')
    const child = children[0]!
    child.ready()
    await flush()
    child.reply({ id: child.requests[0]!.id, stdout: '', stderr: 'Zeitueberschreitung', exitCode: -1, timedOut: true, fatal: false })
    expect(await a).toMatchObject({ timedOut: true, exitCode: -1 })
    expect(kills).toHaveLength(0)

    const b = host.run('b')
    await flush()
    child.reply({ id: child.requests[1]!.id, stdout: '', stderr: '', exitCode: -1, timedOut: true, fatal: true })
    expect(await b).toMatchObject({ timedOut: true, exitCode: -1 })
    expect(kills).toHaveLength(1)
    expect(host.isRunning()).toBe(false)
    host.dispose()
  })

  it('fails the pending call when the host dies and respawns for the next one', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('x')
    const child = children[0]!
    child.ready()
    await flush()
    child.exit(1)
    const result = await promise
    expect(result).toMatchObject({ exitCode: -1, timedOut: false })
    expect(result.stderr).toMatch(/beendet/)
    const next = host.run('y')
    expect(children).toHaveLength(2)
    children[1]!.ready()
    await flush()
    children[1]!.reply({ id: children[1]!.requests[0]!.id, stdout: 'ok', exitCode: 0, timedOut: false, fatal: false })
    expect((await next).stdout).toBe('ok')
    host.dispose()
  })

  it('aborting the signal kills the host and resolves the call', async () => {
    const { spawn, children, kills } = fakeSpawn()
    const host = makeHost(spawn)
    const controller = new AbortController()
    const promise = host.run('x', { signal: controller.signal })
    children[0]!.ready()
    await flush()
    controller.abort()
    const result = await promise
    expect(result).toMatchObject({ exitCode: -1, timedOut: false, stderr: 'Abgebrochen.' })
    expect(kills).toHaveLength(1)
    await expect(host.run('y', { signal: controller.signal })).rejects.toThrow('Abgebrochen.')
    host.dispose()
  })

  it('truncates long stdout according to maxOutputChars', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('x', { maxOutputChars: 5 })
    children[0]!.ready()
    await flush()
    children[0]!.reply({ id: children[0]!.requests[0]!.id, stdout: '1234567890', exitCode: 0, timedOut: false, fatal: false })
    const result = await promise
    expect(result.stdout.startsWith('12345')).toBe(true)
    expect(result.stdout).toContain('gekürzt')
    host.dispose()
  })

  it('dispose ends stdin, fails pending calls and rejects later calls', async () => {
    const { spawn, children, kills } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.run('x')
    const child = children[0]!
    child.ready()
    await flush()
    host.dispose()
    expect(await promise).toMatchObject({ exitCode: -1 })
    expect(child.stdin.writableEnded).toBe(true)
    await expect(host.run('y')).rejects.toThrow(/beendet/)
    await vi.advanceTimersByTimeAsync(2000)
    expect(kills).toHaveLength(1) // did not exit by itself within 2 s → taskkill
    expect(children).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------
// runRaw
// ---------------------------------------------------------------------------------------------------

describe('runRaw', () => {
  it('runs a one-shot process with -EncodedCommand and the UTF-8 prelude', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.runRaw('Write-Output "hi"', { timeoutMs: 1000 })
    await flush()
    expect(children).toHaveLength(1)
    const child = children[0]!
    expect(child.options).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const args = child.args
    expect(args.slice(0, 7)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text'])
    expect(args[7]).toBe('-EncodedCommand')
    const decoded = Buffer.from(args[8]!, 'base64').toString('utf16le')
    expect(decoded.startsWith(PS_PRELUDE)).toBe(true)
    expect(decoded).toContain('Write-Output "hi"')
    child.stdout.write('hi\r\n')
    child.stderr.write('#< CLIXML\n<Objs><S S="Error">warn_x000D__x000A_</S></Objs>')
    await flush()
    child.exit(0)
    const result = await promise
    expect(result).toMatchObject({ stdout: 'hi\r\n', stderr: 'warn', exitCode: 0, timedOut: false })
  })

  it('writes large scripts to a BOM-prefixed temp .ps1 and removes it afterwards', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const script = `Write-Output 'ä'\n${'# filler\n'.repeat(1500)}`
    const promise = host.runRaw(script)
    await waitUntil(() => children.length === 1)
    const child = children[0]!
    const fileIndex = child.args.indexOf('-File')
    expect(fileIndex).toBeGreaterThan(0)
    const file = child.args[fileIndex + 1]!
    expect(file).toMatch(/flowy-.*\.ps1$/)
    const content = fs.readFileSync(file, 'utf8')
    expect(content.charCodeAt(0)).toBe(0xfeff)
    expect(content).toContain("Write-Output 'ä'")
    child.exit(3)
    const result = await promise
    expect(result.exitCode).toBe(3)
    await waitUntil(() => !fs.existsSync(file))
  })

  it('kills the process tree on timeout', async () => {
    const { spawn, children, kills } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.runRaw('Start-Sleep 60', { timeoutMs: 500 })
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(kills).toHaveLength(1)
    expect(kills[0]!.args).toEqual(['/PID', '4242', '/T', '/F'])
    children[0]!.exit(null)
    const result = await promise
    expect(result).toMatchObject({ timedOut: true, exitCode: -1 })
    expect(result.stderr).toMatch(/Zeitüberschreitung/)
  })

  it('rejects when the executable cannot be started', async () => {
    const { spawn, children } = fakeSpawn()
    const host = makeHost(spawn)
    const promise = host.runRaw('x')
    await flush()
    children[0]!.emit('error', new Error('ENOENT'))
    await expect(promise).rejects.toThrow(/PowerShell konnte nicht gestartet werden: ENOENT/)
  })
})
