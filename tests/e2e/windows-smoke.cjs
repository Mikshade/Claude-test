// Windows integration smoke test (run on a real Windows machine / windows-latest CI after `npm run build`):
// persistent PowerShell host incl. UTF-8, Win32 interop (active window, window list, Start menu apps,
// elevation, system info, volume), desktopCapturer screenshot and a handful of real tools.
// Hard checks fail the run; soft checks (hardware-dependent on CI VMs) only warn.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { _electron: electron } = require('playwright-core')
const { appArgs, electronPath, OUT } = require('./common.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const report = []
const check = (ok, label, detail, soft = false) => {
  const tag = ok ? 'PASS' : soft ? 'WARN' : 'FAIL'
  const line = `${tag}  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''}`
  console.log(line)
  report.push(line)
  if (!ok && !soft) failures.push(label)
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP  windows-smoke only runs on Windows')
    return
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-win-'))
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({ setupCompleted: true, behavior: { greetOnStart: false }, tts: { provider: 'none' }, stt: { provider: 'none' } }),
  )
  const app = await electron.launch({
    executablePath: electronPath(),
    args: appArgs(userData),
    env: { ...process.env, FLOWY_E2E: '1' },
    timeout: 60_000,
  })
  await app.firstWindow()
  await sleep(4000)
  const call = (fn, arg) => app.evaluate(fn, arg).then((value) => ({ ok: true, value }), (err) => ({ ok: false, error: String(err && err.message ? err.message : err) }))

  // PowerShell host: UTF-8 round trip through the persistent process, twice (second call reuses it).
  const ps1 = await call(async () => globalThis.__flowyE2E.powershell.run('$x = "Grüße äöüß"; Write-Output $x; $PSVersionTable.PSVersion.ToString()', { timeoutMs: 60_000 }))
  check(ps1.ok && ps1.value.exitCode === 0 && ps1.value.stdout.includes('Grüße äöüß'), 'PowerShell host runs scripts with UTF-8 output', ps1)
  const ps2 = await call(async () => globalThis.__flowyE2E.powershell.run('1..3 | ForEach-Object { $_ * 2 }', { timeoutMs: 30_000 }))
  check(ps2.ok && /2\s+4\s+6/.test(ps2.value.stdout), 'PowerShell host is reused for a second script', ps2)
  const psErr = await call(async () => globalThis.__flowyE2E.powershell.run('Get-Item C:\\does-not-exist-flowy', { timeoutMs: 30_000 }))
  check(psErr.ok && psErr.value.exitCode !== 0 && psErr.value.stderr.length > 0, 'PowerShell errors are reported on stderr', psErr)
  const psTimeout = await call(async () => globalThis.__flowyE2E.powershell.run('Start-Sleep -Seconds 30', { timeoutMs: 1500 }))
  check(psTimeout.ok && psTimeout.value.timedOut === true, 'a hanging script times out', psTimeout)
  const psAfter = await call(async () => globalThis.__flowyE2E.powershell.run('Write-Output ok', { timeoutMs: 60_000 }))
  check(psAfter.ok && psAfter.value.stdout.includes('ok'), 'the host recovers after a timeout', psAfter)

  // Win32 interop through the host.
  const warm = await call(async () => globalThis.__flowyE2E.system.warmup())
  check(warm.ok, 'interop types compile (Add-Type FlowyWin32/FlowyAudio)', warm)
  const info = await call(async () => globalThis.__flowyE2E.system.getSystemInfo())
  check(info.ok && /Windows/i.test(info.value.os), 'system info', info)
  const elevated = await call(async () => globalThis.__flowyE2E.system.isElevated())
  check(elevated.ok && typeof elevated.value === 'boolean', 'elevation check', elevated)
  const wins = await call(async () => globalThis.__flowyE2E.system.listWindows())
  check(wins.ok && Array.isArray(wins.value), 'window list', wins.ok ? wins.value.slice(0, 5) : wins)
  const active = await call(async () => globalThis.__flowyE2E.system.getActiveWindow())
  check(active.ok, 'active window query', active)
  const apps = await call(async () => globalThis.__flowyE2E.system.listInstalledApps())
  check(apps.ok && apps.value.length > 0, 'Start menu apps', apps.ok ? apps.value.length : apps)
  const volume = await call(async () => globalThis.__flowyE2E.system.getVolume())
  check(volume.ok && typeof volume.value.percent === 'number', 'master volume (CoreAudio)', volume, true)

  // Real tools as the brain would run them.
  const runTool = (name, input) => call(async (_e, a) => globalThis.__flowyE2E.runTool(a.name, a.input), { name, input })
  const shot = await runTool('take_screenshot', {})
  check(shot.ok && !shot.value.isError && JSON.stringify(shot.value.content).includes('"image"'), 'take_screenshot tool', shot.ok ? { isError: shot.value.isError } : shot)
  const ps = await runTool('run_powershell', { script: 'Get-Date -Format o' })
  check(ps.ok && !ps.value.isError, 'run_powershell tool', ps)
  const dir = await runTool('list_directory', { path: 'C:\\' })
  check(dir.ok && !dir.value.isError && /Windows/i.test(JSON.stringify(dir.value.content)), 'list_directory tool', dir.ok ? String(dir.value.content).slice(0, 200) : dir)
  const tmpFile = path.join(os.tmpdir(), `flowy-smoke-${Date.now()}.txt`)
  const write = await runTool('write_file', { path: tmpFile, content: 'Hallo von Flowy – äöü' })
  const read = await runTool('read_file', { path: tmpFile })
  check(write.ok && read.ok && JSON.stringify(read.value.content).includes('Hallo von Flowy'), 'write_file + read_file tools', read)
  const del = await runTool('delete_path', { path: tmpFile })
  check(del.ok && !del.value.isError && !fs.existsSync(tmpFile), 'delete_path moves to the Recycle Bin', del, true)
  const clip = await runTool('set_clipboard', { text: 'flowy-clipboard-test' })
  const clipRead = await runTool('get_clipboard', {})
  check(clip.ok && clipRead.ok && JSON.stringify(clipRead.value.content).includes('flowy-clipboard-test'), 'clipboard tools', clipRead, true)
  const sysTool = await runTool('system_info', {})
  check(sysTool.ok && !sysTool.value.isError, 'system_info tool', sysTool)
  const winTool = await runTool('get_active_window', {})
  check(winTool.ok, 'get_active_window tool', winTool, true)

  await app.close()
  fs.writeFileSync(path.join(OUT, 'windows-smoke.txt'), report.join('\n'))
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.log('FATAL', e.stack || e.message)
  process.exit(2)
})
