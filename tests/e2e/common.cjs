// Shared helpers for the Electron end-to-end scripts.
const path = require('node:path')
const fs = require('node:fs')

const REPO = path.resolve(__dirname, '..', '..')
const OUT = path.join(REPO, 'test-results', 'e2e')
fs.mkdirSync(OUT, { recursive: true })

/** Path of the Electron binary installed in node_modules (require('electron') returns it in Node). */
function electronPath() {
  return require(path.join(REPO, 'node_modules', 'electron'))
}

/**
 * Command line for launching the app like `npm start` does (`electron .`), with a throw-away profile.
 * CI machines and Xvfb have no GPU: allow software WebGL so the Live2D renderer can be exercised.
 */
function appArgs(userData, extra = []) {
  const args = ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', `--user-data-dir=${userData}`, ...extra]
  if (process.platform === 'linux') args.unshift('--no-sandbox', '--use-angle=swiftshader')
  return [...args, REPO]
}

module.exports = { REPO, OUT, electronPath, appArgs }
