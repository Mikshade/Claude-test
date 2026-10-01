#!/usr/bin/env node
/**
 * `npm run setup:live2d` – downloads the two Live2D pieces Flowy cannot ship in the repository:
 *
 *   1. Cubism Core (`live2dcubismcore.min.js`, proprietary "Redistributable Code")
 *      → src/renderer/public/vendor/live2dcubismcore.min.js
 *   2. An official sample model (default Hiyori) from Live2D/CubismWebSamples @ 5-r.5
 *      → resources/models/default/ (+ LICENSE.txt, SOURCE.txt)
 *
 * Node 22 ESM, no dependencies, Windows/macOS/Linux. Idempotent: existing files are skipped unless
 * --force. Both targets are git-ignored. Run with --help for the options.
 *
 * Pure logic lives in scripts/lib/*.mjs (unit-tested); this file is the I/O shell.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { acceptedByEnv, helpText, isAffirmative, parseSetupArgs, pickLanguage, translator } from './lib/cli.mjs'
import { DownloadError, fetchBytes, fetchWithFallback, formatBytes, runPool } from './lib/download.mjs'
import {
  collectManifestFiles,
  CUBISM_CORE_FILE,
  CUBISM_CORE_URL,
  CUBISM_EULA_URL,
  fileUrl,
  FREE_MATERIAL_LICENSE_URL,
  hasCubismCoreHeader,
  licenseNotice,
  SAMPLE_CREDIT_LINE,
  SAMPLE_MODEL_TERMS_URL,
  sampleModelSources,
  sourceNotice,
} from './lib/live2dManifest.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE_DIR = path.join(REPO_ROOT, 'src', 'renderer', 'public', 'vendor')
const MODEL_DIR = path.join(REPO_ROOT, 'resources', 'models', 'default')
const CONCURRENCY = 4

const out = (/** @type {string} */ line = '') => process.stdout.write(`${line}\n`)
const err = (/** @type {string} */ line = '') => process.stderr.write(`${line}\n`)

/** @param {string} file */
async function exists(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** Write atomically (tmp + rename) so an interrupted download never leaves a truncated file behind. */
/** @param {string} file @param {Uint8Array | string} data */
async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.part`
  await writeFile(tmp, data)
  await rename(tmp, file)
}

/** @param {string} p */
function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/')
}

/**
 * @param {ReturnType<typeof translator>} t
 * @param {string} model
 */
function printLicenseSummary(t, model) {
  out(`${t('title')}`)
  out('='.repeat(t('title').length))
  out()
  out(t('intro'))
  out()
  out(t('coreHeading'))
  out(t('coreBody'))
  out(`   -> ${CUBISM_EULA_URL}`)
  out()
  out(t('modelHeading', { model }))
  out(t('modelBody'))
  out()
  out(`   "${SAMPLE_CREDIT_LINE}"`)
  out()
  if (model === 'Natori') {
    out(t('natoriNote'))
    out()
  }
  out(t('links'))
  out(`   ${FREE_MATERIAL_LICENSE_URL}`)
  out(`   ${SAMPLE_MODEL_TERMS_URL}`)
  out()
}

/**
 * @param {ReturnType<typeof translator>} t
 * @param {boolean} preAccepted
 * @returns {Promise<boolean>}
 */
async function askConsent(t, preAccepted) {
  if (preAccepted) {
    out(t('acceptedByFlag'))
    return true
  }
  if (!process.stdin.isTTY) {
    err(t('notInteractive'))
    return false
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(t('question'))
    return isAffirmative(answer)
  } finally {
    rl.close()
  }
}

/**
 * @param {ReturnType<typeof translator>} t
 * @param {boolean} force
 */
async function setupCore(t, force) {
  const target = path.join(CORE_DIR, CUBISM_CORE_FILE)
  if (!force && (await exists(target))) {
    out(t('coreExists'))
    const existing = await readFile(target, 'utf8')
    if (!hasCubismCoreHeader(existing)) out(t('coreExistingBadHeader'))
    return
  }
  out(t('downloadingCore'))
  const bytes = await fetchBytes(CUBISM_CORE_URL)
  const text = Buffer.from(bytes).toString('utf8')
  if (!hasCubismCoreHeader(text)) throw new Error(t('coreBadHeader'))
  await writeAtomic(target, bytes)
  out(t('coreDone', { path: rel(target), size: formatBytes(bytes.byteLength) }))
}

/**
 * @param {ReturnType<typeof translator>} t
 * @param {string} model
 * @param {boolean} force
 */
async function setupModel(t, model, force) {
  const source = sampleModelSources(model)
  out(t('fetchingManifest', { file: source.manifest }))
  const manifestUrls = [fileUrl(source.primary, source.manifest), fileUrl(source.fallback, source.manifest)]
  const manifest = await fetchWithFallback(manifestUrls)
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(manifest.bytes).toString('utf8'))
  } catch (cause) {
    throw new Error(`${source.manifest} is not valid JSON (${manifest.url})`, { cause })
  }
  const entries = collectManifestFiles(parsed)
  const files = [source.manifest, ...entries.map((e) => e.path)]
  out(t('filesToDownload', { count: files.length, model: source.model, dir: rel(MODEL_DIR) }))
  out(t('downloading'))

  const width = String(files.length).length
  let downloaded = 0
  let skipped = 0
  let totalBytes = 0
  await runPool(files, CONCURRENCY, async (relative, index) => {
    const target = path.join(MODEL_DIR, ...relative.split('/'))
    const label = `[${String(index + 1).padStart(width)}/${files.length}] ${relative}`
    if (!force && (await exists(target))) {
      skipped++
      out(`  ${label}  (${t('skipped')})`)
      return
    }
    let bytes
    if (relative === source.manifest) {
      bytes = manifest.bytes
    } else {
      const result = await fetchWithFallback([fileUrl(source.primary, relative), fileUrl(source.fallback, relative)])
      bytes = result.bytes
    }
    await writeAtomic(target, bytes)
    downloaded++
    totalBytes += bytes.byteLength
    out(`  ${label}  ${t('ok')} (${formatBytes(bytes.byteLength)})`)
  })
  out(t('modelDone', { downloaded, skipped, size: formatBytes(totalBytes) }))

  await writeAtomic(path.join(MODEL_DIR, 'LICENSE.txt'), licenseNotice(source))
  await writeAtomic(path.join(MODEL_DIR, 'SOURCE.txt'), sourceNotice(source, files))
  // Upstream license file (best effort – the notice above is what matters).
  const upstream = path.join(MODEL_DIR, 'LICENSE.upstream.md')
  if (force || !(await exists(upstream))) {
    try {
      await writeAtomic(upstream, await fetchBytes(source.licenseUrl, { retries: 0 }))
    } catch {
      /* optional */
    }
  }
  out(t('noticeWritten'))
}

async function main() {
  let args
  try {
    args = parseSetupArgs(process.argv.slice(2))
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
    err()
    err(helpText())
    return 1
  }
  if (args.help) {
    out(helpText())
    return 0
  }
  const t = translator(pickLanguage(args.lang, process.env))

  printLicenseSummary(t, args.model)
  const accepted = await askConsent(t, args.yes || acceptedByEnv(process.env))
  if (!accepted) {
    err(t('declined'))
    return 1
  }
  out()

  try {
    if (args.skipCore) out(t('skipCore'))
    else await setupCore(t, args.force)
    out()
    if (args.skipModel) out(t('skipModel'))
    else await setupModel(t, args.model, args.force)
    out()
    out(t('done'))
    out(t('gitIgnored'))
    return 0
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    err()
    err(t('failed', { message }))
    if (e instanceof DownloadError || /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|timeout/i.test(message)) err(t('hint'))
    return 1
  }
}

process.exitCode = await main()
