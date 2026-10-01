/**
 * Argument parsing + the tiny i18n table for scripts/setup-live2d.mjs. Pure, unit-tested.
 */
import { parseArgs } from 'node:util'
import { DEFAULT_MODEL, normalizeModelName, SAMPLE_MODELS } from './live2dManifest.mjs'

/**
 * @typedef {object} SetupArgs
 * @property {boolean} help
 * @property {boolean} yes
 * @property {boolean} force
 * @property {boolean} skipCore
 * @property {boolean} skipModel
 * @property {string} model Canonical sample model name.
 * @property {'de' | 'en' | undefined} lang Explicit language, if given.
 */

/**
 * Parse `process.argv.slice(2)`. Throws an Error with a readable message on unknown options or models.
 * @param {string[]} argv
 * @returns {SetupArgs}
 */
export function parseSetupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', short: 'f', default: false },
      'skip-core': { type: 'boolean', default: false },
      'skip-model': { type: 'boolean', default: false },
      model: { type: 'string', short: 'm', default: DEFAULT_MODEL },
      lang: { type: 'string' },
    },
  })
  const model = normalizeModelName(values.model)
  if (!model) throw new Error(`Unknown --model "${String(values.model)}". Available: ${SAMPLE_MODELS.join(', ')}`)
  let lang
  if (values.lang !== undefined) {
    const l = values.lang.trim().toLowerCase()
    if (l !== 'de' && l !== 'en') throw new Error(`Unknown --lang "${values.lang}" (de|en)`)
    lang = l
  }
  return {
    help: values.help === true,
    yes: values.yes === true,
    force: values.force === true,
    skipCore: values['skip-core'] === true,
    skipModel: values['skip-model'] === true,
    model,
    lang,
  }
}

/**
 * German is the default; English when asked for explicitly (`--lang en`, `FLOWY_LANG=en`) or when the
 * shell locale is English (`LANG`/`LC_ALL` starting with "en").
 * @param {'de' | 'en' | undefined} explicit
 * @param {Record<string, string | undefined>} env
 * @returns {'de' | 'en'}
 */
export function pickLanguage(explicit, env) {
  if (explicit) return explicit
  const fromEnv = (env.FLOWY_LANG ?? '').trim().toLowerCase()
  if (fromEnv === 'en' || fromEnv === 'de') return fromEnv
  const locale = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').trim().toLowerCase()
  return locale.startsWith('en') ? 'en' : 'de'
}

/**
 * `FLOWY_ACCEPT_LIVE2D=1|true|yes` counts as having accepted both licenses (CI / non-interactive installs).
 * @param {Record<string, string | undefined>} env
 */
export function acceptedByEnv(env) {
  const v = (env.FLOWY_ACCEPT_LIVE2D ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/** "y", "yes", "j", "ja" (case-insensitive, trimmed) accept; everything else declines. */
/** @param {string} answer */
export function isAffirmative(answer) {
  const a = answer.trim().toLowerCase()
  return a === 'y' || a === 'yes' || a === 'j' || a === 'ja'
}

export const STRINGS = Object.freeze({
  de: {
    title: 'Flowy – Live2D Setup',
    intro:
      'Dieses Skript lädt zwei Dinge, die Flowy nicht mitliefern darf, ohne dass du die Lizenzen akzeptierst:',
    coreHeading: '1) Live2D Cubism Core (live2dcubismcore.min.js)',
    coreBody: [
      'Proprietäre Laufzeit von Live2D Inc. Die Datei gilt als "Redistributable Code" der',
      'Live2D Proprietary Software License Agreement: Du darfst sie als Teil von Flowy nutzen und',
      'weitergeben, aber nicht verändern, dekompilieren oder einzeln verbreiten. Der Lizenz-Header',
      'in der Datei bleibt unangetastet. Für Privatpersonen und Kleinunternehmen (Jahresumsatz unter',
      '10 Mio. JPY) ist die Nutzung kostenlos; größere Firmen brauchen eine Cubism SDK Release License.',
      'Achtung: Die Ausnahme gilt nicht für "Expandable Applications" (Apps, die beliebig viele',
      'fremde Modelle laden) – siehe README, Abschnitt Live2D.',
    ],
    modelHeading: '2) Beispielmodell "{model}" (Live2D Free Material License)',
    modelBody: [
      'Offizielles Live2D-Sample. Erlaubt für private Nutzung und Kleinunternehmen (unter 10 Mio. JPY',
      'Jahresumsatz), auch eingebettet in Flowy. NICHT erlaubt: die rohen Modelldateien weitergeben',
      '(kein "Model Pack", kein Upload des Ordners), das Design verändern, Copyright-Hinweise entfernen.',
      'Pflicht-Credit, der in Flowy (Über-Seite) und README angezeigt wird:',
    ],
    natoriNote: 'Hinweis: "Natori" ist ein Kollaborations-Charakter – nur nicht-kommerziell, keine Änderungen.',
    links: 'Lizenztexte:',
    question: 'Akzeptierst du beide Lizenzen? [y/N] ',
    declined: 'Abgebrochen – ohne Zustimmung wird nichts heruntergeladen.',
    notInteractive:
      'Keine interaktive Konsole. Starte mit --yes (oder setze FLOWY_ACCEPT_LIVE2D=1), um beide Lizenzen zu akzeptieren.',
    acceptedByFlag: 'Lizenzen akzeptiert (--yes / FLOWY_ACCEPT_LIVE2D).',
    downloadingCore: 'Lade Cubism Core …',
    coreExists: 'Cubism Core ist schon da – übersprungen (mit --force neu laden).',
    coreBadHeader: 'Die heruntergeladene Datei hat nicht den erwarteten Live2D-Lizenz-Header – abgebrochen.',
    coreExistingBadHeader: 'Warnung: die vorhandene Core-Datei hat keinen Live2D-Lizenz-Header. Mit --force neu laden.',
    coreDone: 'Cubism Core gespeichert: {path} ({size})',
    fetchingManifest: 'Lade Manifest {file} …',
    filesToDownload: '{count} Dateien ({model}) nach {dir}',
    downloading: 'Lade Modelldateien …',
    skipped: 'übersprungen',
    ok: 'ok',
    modelDone: 'Modell fertig: {downloaded} geladen, {skipped} übersprungen ({size})',
    noticeWritten: 'Lizenz- und Quellenhinweise geschrieben: LICENSE.txt, SOURCE.txt',
    done: 'Fertig. Starte jetzt `npm run dev` – Flowy benutzt das Modell automatisch.',
    gitIgnored: 'Beide Downloads sind in .gitignore ausgeschlossen und landen nicht im Repository.',
    failed: 'Fehler: {message}',
    hint: 'Tipp: Prüfe deine Internetverbindung / den Proxy und starte das Skript erneut (es macht da weiter, wo es war).',
    skipCore: 'Cubism Core übersprungen (--skip-core).',
    skipModel: 'Modell übersprungen (--skip-model).',
  },
  en: {
    title: 'Flowy – Live2D setup',
    intro: 'This script downloads two things Flowy cannot ship without you accepting their licenses:',
    coreHeading: '1) Live2D Cubism Core (live2dcubismcore.min.js)',
    coreBody: [
      'Proprietary runtime by Live2D Inc. The file is "Redistributable Code" under the Live2D',
      'Proprietary Software License Agreement: you may use and redistribute it as part of Flowy, but',
      'not modify, decompile or distribute it on its own. The license header inside the file stays',
      'intact. Individuals and small businesses (annual sales below 10 million JPY) use it for free;',
      'larger companies need a Cubism SDK Release License.',
      'Note: that exemption does not cover "Expandable Applications" (apps that load an indefinite',
      'number of third-party models) – see README, section Live2D.',
    ],
    modelHeading: '2) Sample model "{model}" (Live2D Free Material License)',
    modelBody: [
      'Official Live2D sample. Allowed for personal use and small businesses (below 10 million JPY',
      'annual sales), including embedded in Flowy. NOT allowed: redistributing the raw model files',
      '(no "model packs", no uploads of the folder), altering the design, removing copyright notices.',
      'Required credit line, shown on Flowy\'s About page and in the README:',
    ],
    natoriNote: 'Note: "Natori" is a collaboration character – non-commercial only, no alterations.',
    links: 'License texts:',
    question: 'Do you accept both licenses? [y/N] ',
    declined: 'Aborted – nothing is downloaded without your consent.',
    notInteractive: 'No interactive console. Run with --yes (or set FLOWY_ACCEPT_LIVE2D=1) to accept both licenses.',
    acceptedByFlag: 'Licenses accepted (--yes / FLOWY_ACCEPT_LIVE2D).',
    downloadingCore: 'Downloading Cubism Core …',
    coreExists: 'Cubism Core already present – skipped (use --force to re-download).',
    coreBadHeader: 'The downloaded file does not start with the expected Live2D license header – aborting.',
    coreExistingBadHeader: 'Warning: the existing Core file has no Live2D license header. Re-download with --force.',
    coreDone: 'Cubism Core saved: {path} ({size})',
    fetchingManifest: 'Fetching manifest {file} …',
    filesToDownload: '{count} files ({model}) into {dir}',
    downloading: 'Downloading model files …',
    skipped: 'skipped',
    ok: 'ok',
    modelDone: 'Model done: {downloaded} downloaded, {skipped} skipped ({size})',
    noticeWritten: 'License and source notices written: LICENSE.txt, SOURCE.txt',
    done: 'Done. Run `npm run dev` – Flowy picks up the model automatically.',
    gitIgnored: 'Both downloads are excluded via .gitignore and never end up in the repository.',
    failed: 'Error: {message}',
    hint: 'Hint: check your internet connection / proxy and run the script again (it resumes where it stopped).',
    skipCore: 'Cubism Core skipped (--skip-core).',
    skipModel: 'Model skipped (--skip-model).',
  },
})

/**
 * @param {'de' | 'en'} lang
 * @returns {(key: keyof typeof STRINGS.de, vars?: Record<string, string | number>) => string}
 */
export function translator(lang) {
  const table = STRINGS[lang] ?? STRINGS.de
  return (key, vars = {}) => {
    const raw = table[key] ?? STRINGS.de[key] ?? key
    const text = Array.isArray(raw) ? raw.join('\n') : String(raw)
    return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
  }
}

/**
 * Help text (bilingual on purpose – it is short).
 * @returns {string}
 */
export function helpText() {
  return [
    'Usage: node scripts/setup-live2d.mjs [options]',
    '',
    'Downloads the Live2D Cubism Core runtime and an official sample model for Flowy.',
    'Lädt die Live2D Cubism Core Laufzeit und ein offizielles Beispielmodell für Flowy.',
    '',
    'Options:',
    '  -y, --yes            accept both licenses without asking (also: FLOWY_ACCEPT_LIVE2D=1)',
    `  -m, --model <name>   sample model: ${SAMPLE_MODELS.join(' | ')} (default: ${DEFAULT_MODEL})`,
    '  -f, --force          re-download files that already exist',
    '      --skip-core      do not download live2dcubismcore.min.js',
    '      --skip-model     do not download the sample model',
    '      --lang de|en     language of the messages (default: de, or FLOWY_LANG / LANG)',
    '  -h, --help           show this help',
    '',
    'Targets:',
    '  src/renderer/public/vendor/live2dcubismcore.min.js',
    '  resources/models/default/   (+ LICENSE.txt, SOURCE.txt)',
    '',
    'Exit codes: 0 ok, 1 error or license declined.',
  ].join('\n')
}
