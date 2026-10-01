# resources/ps – persistent PowerShell host

`flowy-host.ps1` is the worker process behind `src/main/system/powershell.ts`. It is shipped as a
plain file (electron-builder `extraResources` → `<resources>/ps/flowy-host.ps1`) rather than as an
`-EncodedCommand` blob because AV/EDR heuristics flag encoded launches from unsigned apps, and because
a file is auditable.

## Why a persistent host

A one-shot `powershell.exe` costs ~150–350 ms to start (pwsh: 250–600 ms) **plus 0.5–3 s for every
`Add-Type` compile** – unacceptable for polling the active window or chaining tool calls. The host
starts once, compiles the Win32/CoreAudio interop once (lazily, on first use) and then executes each
request in a few milliseconds.

## Launch

```
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -File flowy-host.ps1
```

- Default binary: Windows PowerShell 5.1 (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`),
  present on every Windows 10/11. `pwsh.exe` (PowerShell 7) is used only when `preferPwsh` is set and it
  is installed (`%ProgramFiles%\PowerShell\7\pwsh.exe`, the Store alias, or `where.exe pwsh`).
  5.1 is preferred because `Get-StartApps` and friends run natively there.
- Spawned with `windowsHide: true` (`CREATE_NO_WINDOW`). If the readiness marker does not arrive within
  8 s (or the process exits early), the host is respawned once with `windowsHide: false` plus
  `-WindowStyle Hidden` (a reported Windows PowerShell 5.1 quirk; the fallback is then sticky).
- `-OutputFormat Text` is always passed; without it PowerShell writes stderr as CLIXML when stdin/stderr
  are redirected. `decodeClixml()` in powershell.ts remains as a safety net.

## Protocol (JSON lines over stdio)

Node → host (one ASCII line per request, so the console input encoding never matters):

```json
{"id":"<uuid>","script":"<base64 of the UTF-8 script>","timeoutMs":30000}
```

Host → Node:

```
##FLOWY-READY##                       (once, after the runspace is open)
##FLOWY## {"id":"…","stdout":"…","stderr":"…","exitCode":0,"timedOut":false,"fatal":false,"durationMs":12}
```

Every other stdout line is diagnostics and ignored (logged at debug level). Replies are written as raw
UTF-8 bytes to the stdout stream, independent of the console code page. EOF on stdin ends the host.

- `stdout` = pipeline output (`Out-String -Width 4096`) + the information stream (`Write-Host`).
- `stderr` = error stream records (with position), a terminating exception, and warnings (`WARNING: …`).
- `exitCode` = `1` on any error, otherwise `$LASTEXITCODE` of a native command, else `0`; `-1` on timeout.
- `timedOut: true` – the script exceeded `timeoutMs`; the host called `PowerShell.Stop()` and stays alive.
- `fatal: true` – the pipeline could not be stopped within 3 s (stuck native call). The host exits with
  code 3; Node kills the process tree (`taskkill /PID <pid> /T /F`) and respawns lazily.

Node adds a hard timeout of `timeoutMs + 5 s`; when it fires the host is killed and the call resolves
with `timedOut: true`. Requests are serialized (single runspace, FIFO); run a second host instance if
you need parallelism.

## Execution model

- One worker runspace: `ApartmentState = STA`, `ThreadOptions = ReuseThread` (COM, CoreAudio and
  WinForms need STA). Session state persists across requests: variables, functions and compiled types.
- Per request: `[PowerShell]::Create()` → `AddScript` → `BeginInvoke` → `WaitOne(timeoutMs)`.
- The worker runspace provides two functions that scripts call before using the interop types:
  - `Initialize-FlowyWin32` – guarded `Add-Type` of `FlowyWin32` (user32/dwmapi/powrprof P/Invoke:
    foreground window, window enumeration incl. DWM cloaking, UWP CoreWindow resolution, focus with the
    Alt-tap workaround, `keybd_event`, `SendInput` with `KEYEVENTF_UNICODE`, cursor/mouse, DPI awareness,
    `LockWorkStation`, `SetSuspendState`). Also calls `SetProcessDPIAware()` once so coordinates are
    physical pixels.
  - `Initialize-FlowyAudio` – guarded `Add-Type` of `FlowyAudio` (CoreAudio `IAudioEndpointVolume`
    master volume + mute, re-acquired per call so a changed default device is honoured).
  The C# is C# 5 only (PS 5.1 compiles with csc.exe): no string interpolation, no `?.`, no `out var`.
- `src/main/system/scripts.ts` builds the scripts that `windows.ts` sends; `windows.ts` validates the
  JSON they print. Scripts use `ConvertTo-Json -Compress -Depth 4 -InputObject @(…)` so single-element
  arrays stay arrays (PS 5.1 quirk).

## Notes and caveats

- Apps started via `Start-Process` from inside the host are children of the host; a later tree kill
  (timeout) would take them down. `windows.ts` therefore launches AppIDs and argument-less paths through
  `explorer.exe` (parent = shell). Only launches with arguments and bare command names use `Start-Process`.
- Sleep/hibernate run `SetSuspendState` in a detached PowerShell process because the call blocks until
  the machine resumes.
- Brightness via `WmiMonitorBrightness` works for internal (laptop) panels only; external monitors would
  need DDC/CI (native code) and report "not supported".
- The file is intentionally pure ASCII: Windows PowerShell 5.1 reads BOM-less `.ps1` files as ANSI.
- Constrained Language Mode (AppLocker/WDAC) breaks `Add-Type`; the typed tools then fail with a readable
  error while the pure PowerShell tools keep working.
