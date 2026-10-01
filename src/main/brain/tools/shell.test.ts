import { describe, expect, it } from 'vitest'
import { fakeContext, fakeServices, runTool, toolByName } from './fakes.test'
import {
  buildCmdScript,
  buildElevatedScript,
  buildScript,
  ELEVATED_MARKER,
  formatShellOutput,
  MAX_OUTPUT_CHARS,
  parseElevatedResult,
  PRELUDE,
  shellTools,
  UAC_GRACE_MS,
} from './shell'

describe('script builders', () => {
  it('prepends the prelude', () => {
    const script = buildScript('  Get-Date  ')
    expect(script.startsWith(PRELUDE)).toBe(true)
    expect(script).toContain("$ErrorActionPreference = 'Continue'")
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(script.trim().endsWith('Get-Date')).toBe(true)
  })

  it('base64-encodes cmd commands so quoting cannot break', () => {
    const script = buildCmdScript('dir "C:\\Program Files" /b')
    const b64 = Buffer.from('dir "C:\\Program Files" /b', 'utf8').toString('base64')
    expect(script).toContain(`FromBase64String('${b64}')`)
    expect(script).toContain('& $env:ComSpec /d /c $__flowyCmd')
    expect(script).toContain('exit $LASTEXITCODE')
    expect(script).not.toContain('Program Files')
  })

  it('builds the elevated wrapper with RunAs, timeout and result marker', () => {
    const wrapper = buildElevatedScript('Get-Service | Out-String', 42)
    expect(wrapper).toContain('-Verb RunAs -PassThru')
    expect(wrapper).toContain('WaitForExit(42000)')
    expect(wrapper).toContain(ELEVATED_MARKER)
    expect(wrapper).toContain('1223')
    expect(wrapper).toContain('__FLOWY_OUT__')
    // the user script travels base64-encoded inside the inner script
    const b64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(wrapper)?.[1] ?? ''
    const inner = Buffer.from(b64, 'base64').toString('utf8')
    expect(inner).toContain('Get-Service | Out-String')
    expect(inner).toContain("2> '__FLOWY_ERR__'")
    expect(inner).toContain('exit $__flowyCode')
    expect(wrapper).not.toContain('Get-Service')
  })
})

describe('parseElevatedResult', () => {
  it('parses the last marker line', () => {
    const stdout = `noise\n${ELEVATED_MARKER}{"ok":true,"cancelled":false,"timedOut":false,"exitCode":0,"out":"hello\\r\\n","err":""}\n`
    expect(parseElevatedResult(stdout)).toEqual({ ok: true, cancelled: false, timedOut: false, exitCode: 0, out: 'hello\r\n', err: '' })
  })

  it('tolerates nulls and missing fields', () => {
    expect(parseElevatedResult(`${ELEVATED_MARKER}{"ok":false,"cancelled":true,"out":null,"err":null}`)).toEqual({
      ok: false,
      cancelled: true,
      timedOut: false,
      exitCode: -1,
      out: '',
      err: '',
    })
  })

  it('returns null without a marker or with broken JSON', () => {
    expect(parseElevatedResult('nothing here')).toBeNull()
    expect(parseElevatedResult(`${ELEVATED_MARKER}{oops`)).toBeNull()
  })
})

describe('formatShellOutput', () => {
  it('shows exit code, stdout and stderr', () => {
    const text = formatShellOutput({ stdout: 'a\nb\n', stderr: 'warn\n', exitCode: 0, timedOut: false })
    expect(text).toBe('exit code: 0\n--- stdout ---\na\nb\n--- stderr ---\nwarn')
  })

  it('marks empty output and timeouts', () => {
    const text = formatShellOutput({ stdout: '', stderr: '', exitCode: -1, timedOut: true })
    expect(text).toContain('Zeitüberschreitung')
    expect(text).toContain('(keine Ausgabe)')
  })

  it('caps stdout with a tail marker', () => {
    const text = formatShellOutput({ stdout: 'x'.repeat(MAX_OUTPUT_CHARS + 10), stderr: '', exitCode: 0, timedOut: false })
    expect(text).toContain('…[gekürzt, 10 Zeichen ausgelassen]')
  })
})

describe('run_powershell', () => {
  it('validates the schema', () => {
    const tool = toolByName(shellTools(fakeServices()), 'run_powershell')
    expect(tool.inputSchema.safeParse({ script: 'x' }).data).toEqual({ script: 'x', timeoutSeconds: 60, elevated: false })
    expect(tool.inputSchema.safeParse({ script: '' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ script: 'x', timeoutSeconds: 0 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ script: 'x', timeoutSeconds: 301 }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ script: 'x', timeoutSeconds: 2.5 }).success).toBe(false)
    expect(tool.summarize?.({ script: 'Get-Process | Sort CPU', timeoutSeconds: 60, elevated: true })).toBe(
      'PowerShell (Admin): Get-Process | Sort CPU',
    )
    expect(tool.description).toContain('Guardrail')
  })

  it('runs on the shared host with timeout and output cap', async () => {
    const services = fakeServices()
    services.powershell.queue.push({ stdout: 'out\n', stderr: '', exitCode: 0 })
    const tool = toolByName(shellTools(services), 'run_powershell')
    const result = await runTool(tool, { script: 'Get-Date', timeoutSeconds: 5 })
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('exit code: 0\n--- stdout ---\nout')
    const call = services.powershell.calls[0]!
    expect(call.kind).toBe('run')
    expect(call.script).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(call.script).toContain('Get-Date')
    expect(call.options).toMatchObject({ timeoutMs: 5000, maxOutputChars: MAX_OUTPUT_CHARS })
  })

  it('reports non-zero exit codes and timeouts as errors but keeps the output', async () => {
    const services = fakeServices()
    services.powershell.queue.push({ stdout: 'partial', stderr: 'bad', exitCode: 1 }, { stdout: '', exitCode: -1, timedOut: true })
    const tool = toolByName(shellTools(services), 'run_powershell')
    const failed = await runTool(tool, { script: 'throw "x"' })
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('partial')
    expect(failed.content).toContain('bad')
    const timedOut = await runTool(tool, { script: 'Start-Sleep 999', timeoutSeconds: 1 })
    expect(timedOut.isError).toBe(true)
    expect(timedOut.content).toContain('Zeitüberschreitung')
  })

  it('refuses on non-Windows without touching the host', async () => {
    const services = fakeServices({ platform: 'linux' })
    const tool = toolByName(shellTools(services), 'run_powershell')
    const result = await runTool(tool, { script: 'Get-Date' })
    expect(result).toEqual({ isError: true, content: 'PowerShell: Nur unter Windows verfügbar.' })
    expect(services.powershell.calls).toHaveLength(0)
  })

  it('runs elevated scripts through runRaw and parses the wrapper result', async () => {
    const services = fakeServices()
    services.powershell.queue.push({ stdout: `${ELEVATED_MARKER}{"ok":true,"exitCode":0,"out":"admin ok","err":""}` })
    const tool = toolByName(shellTools(services), 'run_powershell')
    const ctx = fakeContext()
    const result = await runTool(tool, { script: 'Restart-Service spooler', elevated: true, timeoutSeconds: 30 }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('admin ok')
    const call = services.powershell.calls[0]!
    expect(call.kind).toBe('runRaw')
    expect(call.script).toContain('-Verb RunAs')
    expect(call.options?.timeoutMs).toBe(30_000 + UAC_GRACE_MS)
    expect(ctx.progress).toHaveBeenCalledWith('Warte auf UAC-Bestätigung …')
  })

  it('maps a cancelled UAC prompt, inner failures and missing markers to readable errors', async () => {
    const services = fakeServices()
    services.powershell.queue.push(
      { stdout: `${ELEVATED_MARKER}{"ok":false,"cancelled":true,"exitCode":-1,"out":"","err":"canceled"}` },
      { stdout: `${ELEVATED_MARKER}{"ok":false,"exitCode":1,"out":"","err":"Access denied"}` },
      { stdout: '', stderr: 'wrapper exploded' },
      { stdout: '', timedOut: true },
    )
    const tool = toolByName(shellTools(services), 'run_powershell')
    const cancelled = await runTool(tool, { script: 'x', elevated: true })
    expect(cancelled).toEqual({ isError: true, content: 'UAC-Abfrage abgebrochen – der Befehl wurde nicht ausgeführt.' })
    const failed = await runTool(tool, { script: 'x', elevated: true })
    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('Access denied')
    const broken = await runTool(tool, { script: 'x', elevated: true })
    expect(broken.isError).toBe(true)
    expect(broken.content).toContain('wrapper exploded')
    const timedOut = await runTool(tool, { script: 'x', elevated: true })
    expect(timedOut.isError).toBe(true)
    expect(timedOut.content).toContain('Zeitüberschreitung')
  })
})

describe('run_cmd', () => {
  it('wraps the command for cmd.exe and reports the result', async () => {
    const services = fakeServices()
    services.powershell.queue.push({ stdout: 'Volume in drive C', exitCode: 0 })
    const tool = toolByName(shellTools(services), 'run_cmd')
    const result = await runTool(tool, { command: 'dir C:\\ /b' })
    expect(result.content).toContain('Volume in drive C')
    expect(services.powershell.calls[0]!.script).toContain('$env:ComSpec /d /c')
    expect(tool.summarize?.({ command: 'dir', timeoutSeconds: 60 })).toBe('CMD: dir')
    expect(tool.scriptOf?.({ command: 'format c:', timeoutSeconds: 60 })).toBe('format c:')
  })
})
