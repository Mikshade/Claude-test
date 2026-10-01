/**
 * Shell tools: run_powershell (persistent host, optional UAC elevation) and run_cmd (cmd.exe one-liners).
 */
import { z } from 'zod'
import {
  type AnyFlowyTool,
  CATASTROPHIC_GUARD_DESCRIPTION,
  defineTool,
  fail,
  isWindows,
  NOT_WINDOWS_MESSAGE,
  ok,
  shorten,
  truncateText,
} from './gating'
import type { ToolServices } from './registry'

export const MAX_OUTPUT_CHARS = 30_000
export const DEFAULT_TIMEOUT_SECONDS = 60
export const MAX_TIMEOUT_SECONDS = 300
/** Extra time the elevated wrapper may wait for the UAC dialog on top of the script timeout. */
export const UAC_GRACE_MS = 120_000
export const ELEVATED_MARKER = 'FLOWY_ELEVATED_RESULT:'

/** Prepended to every script run on the host. */
export const PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$ConfirmPreference = 'None'",
].join('\n')

export function buildScript(script: string): string {
  return `${PRELUDE}\n${script.trim()}\n`
}

/** `cmd.exe /d /c <command>` via PowerShell; the command travels base64-encoded so quoting cannot break. */
export function buildCmdScript(command: string): string {
  const b64 = Buffer.from(command.trim(), 'utf8').toString('base64')
  return [
    PRELUDE,
    `$__flowyCmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    '$null | & $env:ComSpec /d /c $__flowyCmd',
    'exit $LASTEXITCODE',
    '',
  ].join('\n')
}

/**
 * Wrapper for elevated execution: writes the script to a temp .ps1 (UTF-8 BOM), starts it with
 * `Start-Process -Verb RunAs` (UAC prompt), waits with a timeout and reads stdout/stderr/exit code back
 * from temp files (`-Verb` cannot be combined with output redirection). Prints one JSON line with
 * `ELEVATED_MARKER`. A cancelled UAC prompt (Win32 error 1223) is reported as `cancelled`.
 */
export function buildElevatedScript(script: string, timeoutSeconds: number): string {
  const inner = [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$ConfirmPreference = 'None'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    '$__flowyCode = 0',
    'try {',
    '  & {',
    script.trim(),
    "  } 2> '__FLOWY_ERR__' | Out-String -Width 4096 | Set-Content -LiteralPath '__FLOWY_OUT__' -Encoding UTF8",
    '  if ($LASTEXITCODE) { $__flowyCode = [int]$LASTEXITCODE }',
    '} catch {',
    "  Add-Content -LiteralPath '__FLOWY_ERR__' -Value ($_ | Out-String) -Encoding UTF8",
    '  $__flowyCode = 1',
    '}',
    "Set-Content -LiteralPath '__FLOWY_CODE__' -Value $__flowyCode",
    'exit $__flowyCode',
  ].join('\n')
  const b64 = Buffer.from(inner, 'utf8').toString('base64')
  const waitMs = Math.max(1, Math.floor(timeoutSeconds)) * 1000
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$__base = Join-Path $env:TEMP ('flowy-elev-' + [guid]::NewGuid().ToString('n'))",
    '$__ps1 = "$__base.ps1"; $__out = "$__base.out"; $__err = "$__base.err"; $__code = "$__base.code"',
    `$__inner = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    "$__inner = $__inner.Replace('__FLOWY_OUT__', $__out).Replace('__FLOWY_ERR__', $__err).Replace('__FLOWY_CODE__', $__code)",
    '[IO.File]::WriteAllText($__ps1, $__inner, (New-Object System.Text.UTF8Encoding $true))',
    '$__exe = $null; try { $__exe = (Get-Process -Id $PID).Path } catch {}',
    "if (-not $__exe) { $__exe = 'powershell.exe' }",
    "$__result = @{ ok = $false; cancelled = $false; timedOut = $false; exitCode = -1; out = ''; err = '' }",
    'try {',
    "  $__args = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('\"' + $__ps1 + '\"'))",
    '  $__p = Start-Process -FilePath $__exe -ArgumentList $__args -Verb RunAs -PassThru',
    `  if ($__p.WaitForExit(${waitMs})) { $__result.exitCode = $__p.ExitCode; $__result.ok = ($__p.ExitCode -eq 0) }`,
    '  else { try { $__p.Kill() } catch {}; $__result.timedOut = $true }',
    '} catch {',
    '  $__native = $null',
    '  foreach ($__e in @($_.Exception, $_.Exception.InnerException)) {',
    "    if ($__e -and $__e.PSObject.Properties['NativeErrorCode']) { $__native = $__e.NativeErrorCode }",
    '  }',
    '  $__result.cancelled = ($__native -eq 1223)',
    '  $__result.err = [string]$_.Exception.Message',
    '}',
    'try {',
    '  if (Test-Path -LiteralPath $__out) { $__result.out = [IO.File]::ReadAllText($__out) }',
    '  if (Test-Path -LiteralPath $__err) { $__result.err = ([string]$__result.err + [IO.File]::ReadAllText($__err)).Trim() }',
    '  if (Test-Path -LiteralPath $__code) { $__result.exitCode = [int]((Get-Content -LiteralPath $__code -Raw).Trim()) }',
    '} catch {}',
    'Remove-Item -LiteralPath $__ps1, $__out, $__err, $__code -Force -ErrorAction SilentlyContinue',
    `Write-Output ('${ELEVATED_MARKER}' + (ConvertTo-Json -Compress -InputObject $__result))`,
    '',
  ].join('\n')
}

const ElevatedResultSchema = z.object({
  ok: z.boolean().default(false),
  cancelled: z.boolean().default(false),
  timedOut: z.boolean().default(false),
  exitCode: z.number().default(-1),
  out: z.string().nullable().default(''),
  err: z.string().nullable().default(''),
})

export interface ElevatedResult {
  ok: boolean
  cancelled: boolean
  timedOut: boolean
  exitCode: number
  out: string
  err: string
}

/** Finds the JSON line printed by the elevated wrapper; null when the wrapper itself failed. */
export function parseElevatedResult(stdout: string): ElevatedResult | null {
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    const at = line.indexOf(ELEVATED_MARKER)
    if (at < 0) continue
    try {
      const parsed = ElevatedResultSchema.safeParse(JSON.parse(line.slice(at + ELEVATED_MARKER.length)))
      if (!parsed.success) return null
      return { ...parsed.data, out: parsed.data.out ?? '', err: parsed.data.err ?? '' }
    } catch {
      return null
    }
  }
  return null
}

export interface ShellOutput {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

/** Text block the model receives: exit code, stdout (capped, tail marker) and stderr. */
export function formatShellOutput(result: ShellOutput, maxChars = MAX_OUTPUT_CHARS): string {
  const parts: string[] = []
  const timeoutNote = result.timedOut ? ' (Zeitüberschreitung – Skript wurde abgebrochen)' : ''
  parts.push(`exit code: ${result.exitCode}${timeoutNote}`)
  const stdout = result.stdout.replace(/\s+$/, '')
  parts.push('--- stdout ---')
  parts.push(stdout ? truncateText(stdout, maxChars) : '(keine Ausgabe)')
  const stderr = result.stderr.replace(/\s+$/, '')
  if (stderr) {
    parts.push('--- stderr ---')
    parts.push(truncateText(stderr, Math.min(maxChars, 8000)))
  }
  return parts.join('\n')
}

const RunPowerShellSchema = z.object({
  script: z
    .string()
    .min(1)
    .describe(
      'PowerShell script to run (Windows PowerShell 5.1 syntax; multi-line allowed). Runs non-interactively on a ' +
        'persistent host, so never use Read-Host or anything that prompts. Variables and the working directory may ' +
        'persist between calls.',
    ),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SECONDS)
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe(`Abort the script after this many seconds (1–${MAX_TIMEOUT_SECONDS}, default ${DEFAULT_TIMEOUT_SECONDS}).`),
  elevated: z
    .boolean()
    .default(false)
    .describe(
      'Run as administrator in a separate process. This shows a Windows UAC prompt the user has to accept; ' +
        'only set it when the task genuinely needs admin rights (installing drivers, system services, protected files).',
    ),
})

const RunCmdSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('A cmd.exe command line (batch syntax, e.g. "dir C:\\Users /b" or "ipconfig /all"). Non-interactive.'),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SECONDS)
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe(`Abort after this many seconds (1–${MAX_TIMEOUT_SECONDS}, default ${DEFAULT_TIMEOUT_SECONDS}).`),
})

export function shellTools(services: ToolServices): AnyFlowyTool[] {
  const runPowerShell = defineTool({
    name: 'run_powershell',
    category: 'shell',
    destructive: true,
    readOnly: false,
    description:
      'Run a PowerShell script on this Windows PC and get stdout, stderr and the exit code back. Use it for anything ' +
      'no dedicated tool covers (processes, services, registry reads, network, winget installs, scripting). Prefer the ' +
      'typed tools (read_file, list_directory, launch_app, set_volume, …) when they fit – they are safer and more precise. ' +
      `Output is capped at ${MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters (the tail is dropped with a marker), so ` +
      'filter in the script (Select-Object -First, -Property) instead of dumping everything. ' +
      CATASTROPHIC_GUARD_DESCRIPTION,
    inputSchema: RunPowerShellSchema,
    summarize: (input) => `PowerShell${input.elevated ? ' (Admin)' : ''}: ${shorten(input.script)}`,
    scriptOf: (input) => input.script,
    confirmation: (input) => ({
      title: input.elevated ? 'PowerShell als Administrator ausführen?' : 'PowerShell-Skript ausführen?',
      detail: shorten(input.script, 120),
      preview: input.script.length > 2000 ? `${input.script.slice(0, 2000)}…` : input.script,
    }),
    async execute(input, ctx) {
      if (!isWindows(services)) return fail(`PowerShell: ${NOT_WINDOWS_MESSAGE}`)
      const timeoutMs = input.timeoutSeconds * 1000
      if (input.elevated) {
        ctx.progress('Warte auf UAC-Bestätigung …')
        const raw = await services.powershell.runRaw(buildElevatedScript(input.script, input.timeoutSeconds), {
          timeoutMs: timeoutMs + UAC_GRACE_MS,
          maxOutputChars: MAX_OUTPUT_CHARS + 4_000,
          signal: ctx.signal,
        })
        if (raw.timedOut) return fail('Zeitüberschreitung: keine Antwort der erhöhten PowerShell (UAC-Dialog offen?).')
        const parsed = parseElevatedResult(raw.stdout)
        if (!parsed) {
          const detail = shorten(raw.stderr || raw.stdout, 500) || 'keine Antwort'
          return fail(`Erhöhte Ausführung fehlgeschlagen: ${detail}`)
        }
        if (parsed.cancelled) return fail('UAC-Abfrage abgebrochen – der Befehl wurde nicht ausgeführt.')
        if (parsed.timedOut) {
          return fail(`Zeitüberschreitung: der erhöhte Befehl wurde nach ${input.timeoutSeconds} s beendet.`)
        }
        const text = formatShellOutput({ stdout: parsed.out, stderr: parsed.err, exitCode: parsed.exitCode, timedOut: false })
        return parsed.exitCode === 0 ? ok(text) : fail(text)
      }
      const result = await services.powershell.run(buildScript(input.script), {
        timeoutMs,
        maxOutputChars: MAX_OUTPUT_CHARS,
        signal: ctx.signal,
      })
      const text = formatShellOutput(result)
      return result.timedOut || result.exitCode !== 0 ? fail(text) : ok(text)
    },
  })

  const runCmd = defineTool({
    name: 'run_cmd',
    category: 'shell',
    destructive: true,
    readOnly: false,
    description:
      'Run a classic cmd.exe command line (batch syntax: dir, copy, ipconfig, .bat files) and get stdout, stderr and ' +
      'the exit code. Use run_powershell for anything beyond simple one-liners. Same output cap and guardrails as ' +
      'run_powershell.',
    inputSchema: RunCmdSchema,
    summarize: (input) => `CMD: ${shorten(input.command)}`,
    scriptOf: (input) => input.command,
    confirmation: (input) => ({ title: 'CMD-Befehl ausführen?', detail: shorten(input.command, 120), preview: input.command }),
    async execute(input, ctx) {
      if (!isWindows(services)) return fail(`cmd.exe: ${NOT_WINDOWS_MESSAGE}`)
      const result = await services.powershell.run(buildCmdScript(input.command), {
        timeoutMs: input.timeoutSeconds * 1000,
        maxOutputChars: MAX_OUTPUT_CHARS,
        signal: ctx.signal,
      })
      const text = formatShellOutput(result)
      return result.timedOut || result.exitCode !== 0 ? fail(text) : ok(text)
    },
  })

  return [runPowerShell, runCmd]
}
