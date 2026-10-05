// First-start e2e: fresh profile → settings wizard + overlay open, the Live2D model (or the fallback)
// renders, every settings page renders without errors, the wizard can be completed.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { _electron: electron } = require('playwright-core')
const { appArgs, electronPath, OUT } = require('./common.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`)
  if (!ok) failures.push(label)
}
const PAGES = ['character', 'voice', 'brain', 'ears', 'look', 'permissions', 'hotkeys', 'behavior', 'about']

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flowy-first-'))
  const app = await electron.launch({ executablePath: electronPath(), args: appArgs(userData), timeout: 60_000 })
  const errors = []
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${page.url()}: console.error ${m.text().slice(0, 200)}`)
      if (/Live2D model ready|fallback character/.test(m.text())) console.log(`      [${m.type()}] ${m.text().slice(0, 160)}`)
    })
  }
  app.on('window', watch)
  for (const w of app.windows()) watch(w)

  const deadline = Date.now() + 20_000
  while (app.windows().length < 2 && Date.now() < deadline) await sleep(200)
  const settings = app.windows().find((w) => w.url().includes('settings'))
  const overlay = app.windows().find((w) => w.url().includes('overlay'))
  check(!!settings && !!overlay, 'first start opens the wizard and the overlay', app.windows().map((w) => w.url()))
  if (!settings || !overlay) throw new Error('windows missing')

  await sleep(5000) // character load (Live2D model, textures)
  const character = await overlay.evaluate(() => ({
    kind: document.body.dataset.character,
    canvas: !!document.querySelector('#stage canvas'),
    core: typeof window.Live2DCubismCore,
  }))
  check(character.canvas && (character.kind === 'live2d' || character.kind === 'fallback'), 'the character renders', character)
  await overlay.screenshot({ path: path.join(OUT, 'firstrun-overlay.png') })

  const wizardText = await settings.evaluate(() => document.body.innerText)
  check(/Willkommen bei Flowy/.test(wizardText), 'the wizard welcomes the user', wizardText.slice(0, 60))
  await settings.screenshot({ path: path.join(OUT, 'firstrun-wizard.png') })

  for (const page of PAGES) {
    await settings.evaluate((p) => (location.hash = p), page)
    await sleep(500)
    const h1 = await settings.evaluate(() => document.querySelector('.page-header h1')?.textContent ?? '')
    check(h1.length > 0, `settings page "${page}" renders`, h1)
    await settings.screenshot({ path: path.join(OUT, `settings-${page}.png`) })
  }

  // Character name change is persisted through config:patch (debounced) and reaches the overlay.
  await settings.evaluate(() => window.flowy.invoke('config:patch', { character: { name: 'Aiko' } }))
  const overlayName = await overlay.evaluate(() => window.flowy.invoke('config:get').then((c) => c.character.name))
  check(overlayName === 'Aiko', 'settings changes reach the rest of the app', overlayName)

  // Completing the wizard is persisted.
  await settings.evaluate(() => window.flowy.invoke('config:completeSetup'))
  const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'))
  check(cfg.setupCompleted === true && cfg.character.name === 'Aiko', 'config.json persisted', { setupCompleted: cfg.setupCompleted, name: cfg.character.name })

  check(errors.length === 0, 'no renderer errors', errors.slice(0, 5))
  await app.close()
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' | ')}` : '\nALL PASSED')
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.log('FATAL', e.stack || e.message)
  process.exit(2)
})
