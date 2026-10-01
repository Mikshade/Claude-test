/**
 * Pure helpers around Live2D Cubism `*.model3.json` manifests and the official sample models.
 *
 * No I/O in here – everything is unit-tested from scripts/live2dManifest.test.ts. The setup script
 * (scripts/setup-live2d.mjs) combines these with scripts/lib/download.mjs.
 *
 * A model3.json looks like this (only the parts that reference files matter here):
 *
 *   {
 *     "Version": 3,
 *     "FileReferences": {
 *       "Moc": "Hiyori.moc3",
 *       "Textures": ["Hiyori.2048/texture_00.png", ...],
 *       "Physics": "Hiyori.physics3.json",
 *       "Pose": "Hiyori.pose3.json",
 *       "DisplayInfo": "Hiyori.cdi3.json",
 *       "UserData": "Hiyori.userdata3.json",
 *       "Expressions": [{ "Name": "F01", "File": "expressions/F01.exp3.json" }, ...],
 *       "Motions": { "Idle": [{ "File": "motions/x.motion3.json", "Sound": "sounds/x.wav" }], ... }
 *     }
 *   }
 */

/** Git tag of Live2D/CubismWebSamples the sample models are fetched from. */
export const SAMPLE_TAG = '5-r.5'
export const SAMPLE_REPO = 'Live2D/CubismWebSamples'
/** Path inside the repository that holds the sample model folders. */
export const SAMPLE_RESOURCES_PATH = 'Samples/Resources'

/** Models offered by `--model` (all under the Free Material License; Natori is non-commercial only). */
export const SAMPLE_MODELS = Object.freeze(['Hiyori', 'Haru', 'Mao', 'Natori'])
export const DEFAULT_MODEL = 'Hiyori'

export const CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
export const CUBISM_CORE_FILE = 'live2dcubismcore.min.js'
/** The license header the official Core file starts with – it must stay intact (EULA section 6). */
export const CUBISM_CORE_HEADER_MARKERS = Object.freeze(['Live2D Cubism Core', 'Redistributable Code'])

export const CUBISM_EULA_URL = 'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html'
export const FREE_MATERIAL_LICENSE_URL = 'https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html'
export const SAMPLE_MODEL_TERMS_URL = 'https://www.live2d.com/eula/live2d-sample-model-terms_en.html'
export const SDK_RELEASE_LICENSE_URL = 'https://www.live2d.com/en/download/cubism-sdk/release-license/'

/** Credit line Live2D requires when sample data is used (full form). */
export const SAMPLE_CREDIT_LINE =
  'This content uses sample data owned and copyrighted by Live2D Inc. ' +
  'The sample data are utilized in accordance with conditions and terms set by Live2D Inc.'

/**
 * @typedef {'moc' | 'texture' | 'physics' | 'pose' | 'displayInfo' | 'userData' | 'motionSync' |
 *           'expression' | 'motion' | 'sound' | 'other'} ManifestFileKind
 * @typedef {{ path: string, kind: ManifestFileKind }} ManifestEntry
 */

/** Known single-file keys of FileReferences and the kind they map to. */
const SINGLE_FILE_KEYS = Object.freeze({
  Moc: 'moc',
  Physics: 'physics',
  Pose: 'pose',
  DisplayInfo: 'displayInfo',
  UserData: 'userData',
  MotionSync: 'motionSync',
})

/**
 * Canonical sample model name for user input (`hiyori`, ` Haru `, …) or `null` when unknown.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeModelName(input) {
  if (typeof input !== 'string') return null
  const wanted = input.trim().toLowerCase()
  if (!wanted) return null
  return SAMPLE_MODELS.find((m) => m.toLowerCase() === wanted) ?? null
}

/**
 * Where a sample model's files live. `primary` is the jsDelivr CDN (proper MIME types, pinned to the tag),
 * `fallback` is raw.githubusercontent.com. Both end with a slash so relative paths can be appended.
 * @param {string} model
 * @param {string} [tag]
 * @returns {{ model: string, tag: string, manifest: string, primary: string, fallback: string, licenseUrl: string, repoUrl: string }}
 */
export function sampleModelSources(model, tag = SAMPLE_TAG) {
  const name = normalizeModelName(model)
  if (!name) throw new Error(`Unknown sample model "${String(model)}" – choose one of ${SAMPLE_MODELS.join(', ')}`)
  const dir = `${SAMPLE_RESOURCES_PATH}/${name}/`
  return {
    model: name,
    tag,
    manifest: `${name}.model3.json`,
    primary: `https://cdn.jsdelivr.net/gh/${SAMPLE_REPO}@${tag}/${dir}`,
    fallback: `https://raw.githubusercontent.com/${SAMPLE_REPO}/${tag}/${dir}`,
    licenseUrl: `https://cdn.jsdelivr.net/gh/${SAMPLE_REPO}@${tag}/LICENSE.md`,
    repoUrl: `https://github.com/${SAMPLE_REPO}/tree/${tag}/${SAMPLE_RESOURCES_PATH}/${name}`,
  }
}

/**
 * Normalise a manifest path: backslashes → slashes, leading `./` removed, repeated slashes collapsed.
 * @param {string} p
 * @returns {string}
 */
export function normalizeRelativePath(p) {
  let out = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

/**
 * True when `p` (already normalised) is a relative path that stays inside the model directory:
 * no absolute paths, drive letters / URL schemes (any `:`), `..` segments, NUL bytes or empty segments.
 * @param {string} p
 * @returns {boolean}
 */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false
  // ':' covers drive letters (C:), URL schemes (https:) and NTFS alternate data streams – never valid here.
  if (p.startsWith('/') || p.includes(':')) return false
  const segments = p.split('/')
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..')
}

/**
 * Walk `FileReferences` and list every file the model needs, in a deterministic order, deduplicated.
 * Throws a readable Error on a malformed manifest or an unsafe path (../, absolute, URL).
 * @param {unknown} manifest Parsed model3.json.
 * @returns {ManifestEntry[]}
 */
export function collectManifestFiles(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('model3.json is not a JSON object')
  const refs = /** @type {Record<string, unknown>} */ (manifest).FileReferences
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('model3.json has no "FileReferences" object')

  /** @type {ManifestEntry[]} */
  const entries = []
  const seen = new Set()

  /** @param {unknown} raw @param {ManifestFileKind} kind @param {string} where */
  const add = (raw, kind, where) => {
    if (raw === undefined || raw === null || raw === '') return
    if (typeof raw !== 'string') throw new Error(`FileReferences.${where} must be a string, got ${typeof raw}`)
    const p = normalizeRelativePath(raw)
    if (!isSafeRelativePath(p)) throw new Error(`FileReferences.${where} points outside the model directory: "${raw}"`)
    if (seen.has(p)) return
    seen.add(p)
    entries.push({ path: p, kind })
  }

  /** @param {unknown} list @param {ManifestFileKind} kind @param {string} where */
  const addList = (list, kind, where) => {
    if (list === undefined || list === null) return
    if (!Array.isArray(list)) throw new Error(`FileReferences.${where} must be an array`)
    list.forEach((item, i) => {
      if (typeof item === 'string') add(item, kind, `${where}[${i}]`)
      else if (item && typeof item === 'object') {
        const obj = /** @type {Record<string, unknown>} */ (item)
        add(obj.File, kind, `${where}[${i}].File`)
        add(obj.Sound, 'sound', `${where}[${i}].Sound`)
      } else throw new Error(`FileReferences.${where}[${i}] has an unexpected shape`)
    })
  }

  const r = /** @type {Record<string, unknown>} */ (refs)
  // Known keys first, in a fixed order, so the download order is stable across runs.
  add(r.Moc, 'moc', 'Moc')
  addList(r.Textures, 'texture', 'Textures')
  add(r.Physics, 'physics', 'Physics')
  add(r.Pose, 'pose', 'Pose')
  add(r.DisplayInfo, 'displayInfo', 'DisplayInfo')
  add(r.UserData, 'userData', 'UserData')
  add(r.MotionSync, 'motionSync', 'MotionSync')
  addList(r.Expressions, 'expression', 'Expressions')
  if (r.Motions !== undefined && r.Motions !== null) {
    if (typeof r.Motions !== 'object' || Array.isArray(r.Motions)) throw new Error('FileReferences.Motions must be an object of groups')
    for (const [group, list] of Object.entries(/** @type {Record<string, unknown>} */ (r.Motions))) {
      addList(list, 'motion', `Motions.${group}`)
    }
  }
  // Unknown keys (future SDK versions): accept strings and arrays of strings / {File} objects.
  const known = new Set([...Object.keys(SINGLE_FILE_KEYS), 'Textures', 'Expressions', 'Motions'])
  for (const [key, value] of Object.entries(r)) {
    if (known.has(key)) continue
    if (typeof value === 'string') add(value, 'other', key)
    else if (Array.isArray(value)) addList(value, 'other', key)
    // objects/numbers/booleans are ignored – they do not reference files
  }
  return entries
}

/**
 * Just the relative paths (unique, same order as `collectManifestFiles`).
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function manifestFilePaths(manifest) {
  return collectManifestFiles(manifest).map((e) => e.path)
}

/**
 * Append a relative path to a base URL (ending with `/`), percent-encoding each segment.
 * @param {string} base
 * @param {string} relative
 * @returns {string}
 */
export function fileUrl(base, relative) {
  const root = base.endsWith('/') ? base : `${base}/`
  return root + normalizeRelativePath(relative).split('/').map(encodeURIComponent).join('/')
}

/**
 * True when `text` starts with the official Cubism Core license header (within the first 600 chars).
 * @param {string} text
 * @returns {boolean}
 */
export function hasCubismCoreHeader(text) {
  const head = text.slice(0, 600)
  return CUBISM_CORE_HEADER_MARKERS.every((m) => head.includes(m))
}

/**
 * Text of resources/models/default/LICENSE.txt.
 * @param {{ model: string, tag: string, repoUrl: string }} source
 * @returns {string}
 */
export function licenseNotice(source) {
  const natori =
    source.model === 'Natori'
      ? '\nNOTE: "Natori" (Jin Natori) is a Live2D collaboration character: non-commercial use only,\n' +
        'no alterations and no redistribution (Sample Data Terms of Use).\n'
      : ''
  return (
    `Live2D sample model "${source.model}"\n` +
    `======================================\n\n` +
    `Copyright (c) Live2D Inc. All rights reserved.\n\n` +
    `This folder contains sample data owned and copyrighted by Live2D Inc., downloaded from\n` +
    `${source.repoUrl} (tag ${source.tag}) by \`npm run setup:live2d\`.\n\n` +
    `The sample data is licensed under the Live2D Free Material License Agreement\n` +
    `  ${FREE_MATERIAL_LICENSE_URL}\n` +
    `and the Sample Data Terms of Use\n` +
    `  ${SAMPLE_MODEL_TERMS_URL}\n\n` +
    `Summary (the agreements above prevail):\n` +
    `  - Free for "General Users" and "Small-Scale Enterprises" (annual sales below 10 million JPY).\n` +
    `  - May be embedded in a derivative work such as Flowy; the raw model files themselves must NOT be\n` +
    `    redistributed (no "model packs", no uploads of this folder).\n` +
    `  - No design alterations of the character, no removal of copyright notices.\n` +
    `  - Larger businesses need a Cubism SDK Release License: ${SDK_RELEASE_LICENSE_URL}\n` +
    natori +
    `\nRequired credit line (shown in Flowy's About page and README):\n\n` +
    `  ${SAMPLE_CREDIT_LINE}\n`
  )
}

/**
 * Text of resources/models/default/SOURCE.txt.
 * @param {{ model: string, tag: string, primary: string, fallback: string, repoUrl: string }} source
 * @param {string[]} files
 * @param {Date} [now]
 * @returns {string}
 */
export function sourceNotice(source, files, now = new Date()) {
  return (
    `model: ${source.model}\n` +
    `repository: https://github.com/${SAMPLE_REPO}\n` +
    `tag: ${source.tag}\n` +
    `path: ${SAMPLE_RESOURCES_PATH}/${source.model}/\n` +
    `cdn: ${source.primary}\n` +
    `fallback: ${source.fallback}\n` +
    `downloaded: ${now.toISOString()}\n` +
    `files:\n${files.map((f) => `  ${f}\n`).join('')}`
  )
}
