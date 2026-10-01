/**
 * Persistent PowerShell host: one long-lived `powershell.exe`/`pwsh` process that executes scripts
 * sequentially with a delimiter-based request/response protocol over stdio (avoids ~200ms startup per call).
 *
 * OWNER: system agent.
 * Requirements:
 *  - UTF-8 in/out ([Console]::OutputEncoding / $OutputEncoding / -InputFormat Text)
 *  - per-call timeout; on timeout kill the host (taskkill /T /F) and respawn lazily
 *  - never let a script's output be confused with the protocol delimiters (use a random per-call token)
 *  - `runRaw` for a one-off separate process (needed for elevated / interactive commands)
 *  - On non-Windows platforms the host must fail gracefully (clear error, no crash) so dev on Linux works.
 */

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
}

export function createPowerShellHost(): PowerShellHost {
  throw new Error('not implemented: createPowerShellHost (src/main/system/powershell.ts)')
}
