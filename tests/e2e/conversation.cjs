// Full pipeline e2e against local mock servers (no API keys, no costs): greeting, typed turn with a
// tool round trip, push-to-talk with a fake microphone, interrupt, cursor avoidance, secret redaction.
// Run after `npm run build`:  npm run test:e2e   (Linux needs a display: xvfb-run -a npm run test:e2e)
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { _electron: electron } = require('playwright-core')
const { server, wav, requests } = require('./mock-server.cjs')
const { appArgs, electronPath, REPO, OUT } = require('./common.cjs')

let BASE = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`)
  if (!ok) failures.push(label)
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await sleep(100)
  }
  console.log(`timeout waiting for ${label}`)
  return false
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  BASE = `http://127.0.0.1:${server.address().port}`
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-conv-'))
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      setupCompleted: true,
      llm: { apiKey: 'sk-ant-e2e-test' },
      tts: { provider: 'fish-local', fishLocal: { baseUrl: BASE, format: 'wav' } },
      stt: { provider: 'openai-compatible', openaiCompatible: { baseUrl: `${BASE}/v1`, model: 'whisper-1' }, silenceTimeoutMs: 800 },
      behavior: { greetOnStart: true },
      screenAwareness: { mode: 'always' },
    }),
  )
  // A "spoken" fake microphone input: 1.2 s tone then silence (the VAD needs energy, then silence to auto-stop).
  const micWav = path.join(userData, 'mic.wav')
  fs.writeFileSync(micWav, wav(1.2, 48000, 220, 4))

  const app = await electron.launch({
    executablePath: electronPath(),
    args: appArgs(userData, [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${micWav}`,
    ]),
    cwd: REPO,
    env: { ...process.env, ANTHROPIC_BASE_URL: BASE, FLOWY_E2E: '1' },
    timeout: 60_000,
  })
  const errors = []
  app.process().stderr.on('data', (d) => {
    const s = String(d)
    if (/Uncaught|PAGEERROR|TypeError|ReferenceError/.test(s)) errors.push(s.trim())
  })

  const overlay = await app.firstWindow()
  await waitFor(async () => overlay.url().includes('overlay'), 10_000, 'overlay window')
  overlay.on('pageerror', (e) => errors.push(`overlay pageerror: ${e.message}`))
  overlay.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[overlay:${m.type()}] ${m.text().slice(0, 300)}`)
  })
  await overlay.waitForLoadState('domcontentloaded')
  await overlay.evaluate(() => {
    const w = window
    w.__e2e = { states: [], chunks: 0, errors: [], deltas: '' }
    w.flowy.on('state:changed', (s) => w.__e2e.states.push(s))
    w.flowy.on('speech:chunk', () => w.__e2e.chunks++)
    w.flowy.on('turn:error', (e) => w.__e2e.errors.push(e))
    w.flowy.on('turn:assistantDelta', (d) => (w.__e2e.deltas += d.delta))
  })
  const e2e = () => overlay.evaluate(() => window.__e2e)

  // 1) Greeting on start (proactive turn, no tool) – plays and returns to idle.
  const greeted = await waitFor(async () => (await e2e()).states.includes('speaking') && (await e2e()).states.at(-1) === 'idle', 20_000, 'greeting')
  let s = await e2e()
  check(greeted, 'greeting turn spoke and returned to idle', s.states)
  await overlay.screenshot({ path: path.join(OUT, 'conv-1-greeting.png') })

  // 2) Typed question → tool_use(get_time) → tool_result → final answer, spoken.
  await overlay.evaluate(() => {
    window.__e2e.states = []
    window.__e2e.chunks = 0
    window.__e2e.deltas = ''
  })
  await overlay.evaluate(() => window.flowy.invoke('turn:submitText', 'Wie spät ist es?'))
  await sleep(600)
  await overlay.screenshot({ path: path.join(OUT, 'conv-2-thinking.png') })
  const answered = await waitFor(async () => {
    const x = await e2e()
    return x.states.includes('speaking') && x.states.at(-1) === 'idle'
  }, 25_000, 'typed turn')
  s = await e2e()
  check(answered, 'typed turn finished (thinking → speaking → idle)', s.states)
  check(s.chunks >= 2, 'speech chunks were played', s.chunks)
  check(s.deltas.includes('nachgesehen'), 'final answer streamed after the tool call', s.deltas.slice(0, 120))
  check(s.errors.length === 0, 'no turn errors', s.errors)
  const msgReqs = requests.filter((r) => r.path.startsWith('/v1/messages'))
  check(msgReqs.some((r) => r.lastTypes.includes('tool_result')), 'second request carried the tool_result', msgReqs.map((r) => r.lastTypes))
  check(msgReqs.every((r) => r.tools > 20), 'tools were offered to the model', msgReqs.map((r) => r.tools))
  check(msgReqs.some((r) => r.hasImage), 'a screenshot was attached in "always" mode', msgReqs.map((r) => r.hasImage))
  check(msgReqs.every((r) => r.thinking && r.thinking.type === 'adaptive'), 'adaptive thinking requested', msgReqs[0] && msgReqs[0].thinking)
  const ttsReqs = requests.filter((r) => r.path === '/v1/tts')
  check(ttsReqs.length >= 3, 'TTS was called per sentence', ttsReqs.map((r) => r.text))

  // 3) Push-to-talk: start, the fake mic "speaks", the VAD auto-stops, STT → brain → speech.
  await overlay.evaluate(() => {
    window.__e2e.states = []
    window.__e2e.deltas = ''
  })
  await app.evaluate(() => globalThis.__flowyE2E.orchestrator.pushToTalk())
  await sleep(500)
  await overlay.screenshot({ path: path.join(OUT, 'conv-3-listening.png') })
  const voiceDone = await waitFor(async () => {
    const x = await e2e()
    return x.states.includes('transcribing') && x.states.includes('speaking') && x.states.at(-1) === 'idle'
  }, 30_000, 'voice turn')
  s = await e2e()
  check(voiceDone, 'voice turn: listening → transcribing → thinking → speaking → idle', s.states)
  const sttReqs = requests.filter((r) => r.path === '/v1/audio/transcriptions')
  check(sttReqs.length === 1 && sttReqs[0].bytes > 10_000, 'recording was uploaded for transcription', sttReqs)
  check(s.deltas.includes('laut und deutlich'), 'brain answered the transcript', s.deltas.slice(0, 100))
  await overlay.screenshot({ path: path.join(OUT, 'conv-4-after-voice.png') })

  // 4) Interrupt mid-answer, then a new question must still work (history consistency).
  await overlay.evaluate(() => {
    window.__e2e.states = []
  })
  await overlay.evaluate(() => window.flowy.invoke('turn:submitText', 'Erzähl mir was'))
  await sleep(300)
  await overlay.evaluate(() => window.flowy.invoke('turn:interrupt'))
  await sleep(300)
  await overlay.evaluate(() => window.flowy.invoke('turn:submitText', 'Wie spät ist es jetzt?'))
  const afterInterrupt = await waitFor(async () => (await e2e()).states.at(-1) === 'idle' && (await e2e()).states.includes('speaking'), 25_000, 'turn after interrupt')
  s = await e2e()
  check(afterInterrupt, 'a turn after an interrupt completes', s.states)
  check(s.errors.length === 0, 'still no turn errors', s.errors)
  const roles = requests.filter((r) => r.path.startsWith('/v1/messages')).map((r) => r.roles)
  check(roles.every((r) => !/assistant,assistant/.test(r)), 'history never has two assistant messages in a row', roles.at(-1))

  // 4b) Cursor avoidance: put the cursor right next to her – she must fly to another spot.
  const pos = () => overlay.evaluate(() => {
    const el = document.querySelector('#stage > *')
    const r = el ? el.getBoundingClientRect() : null
    return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null
  })
  const before = await pos()
  await app.evaluate(({ BrowserWindow }, p) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('overlay')) w.webContents.send('cursor:position', p)
  }, { x: before.x - 30, y: before.y + before.h / 2 })
  await sleep(1500)
  const after = await pos()
  const moved = Math.hypot(after.x - before.x, after.y - before.y)
  check(moved > 150, 'she flies away when the cursor approaches', { before, after, moved: Math.round(moved) })
  const view = await overlay.evaluate(() => [innerWidth, innerHeight])
  check(after.x >= 0 && after.y >= 0 && after.x + after.w <= view[0] + 1 && after.y + after.h <= view[1] + 1, 'she stays inside the screen', { after, view })
  await overlay.screenshot({ path: path.join(OUT, 'conv-5-after-flee.png') })

  // 5) Settings window opens from main and shows the redacted/unredacted key correctly.
  const overlayCfg = await overlay.evaluate(() => window.flowy.invoke('config:get'))
  check(!String(overlayCfg.llm.apiKey).includes('e2e-test'), 'overlay never receives the clear-text API key', overlayCfg.llm.apiKey)

  check(errors.length === 0, 'no uncaught renderer errors', errors.slice(0, 5))
  const historyFile = path.join(userData, 'history.json')
  const history = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8') : ''
  check(history.length > 0 && !history.includes('"type":"image"'), 'history.json persisted without screenshot data', history.length)

  await app.close()
  server.close()
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.log('FATAL', e.stack || e.message)
  process.exit(2)
})
