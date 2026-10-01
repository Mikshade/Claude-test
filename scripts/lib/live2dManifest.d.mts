export type ManifestFileKind =
  | 'moc'
  | 'texture'
  | 'physics'
  | 'pose'
  | 'displayInfo'
  | 'userData'
  | 'motionSync'
  | 'expression'
  | 'motion'
  | 'sound'
  | 'other'

export interface ManifestEntry {
  path: string
  kind: ManifestFileKind
}

export interface SampleModelSource {
  model: string
  tag: string
  manifest: string
  primary: string
  fallback: string
  licenseUrl: string
  repoUrl: string
}

export const SAMPLE_TAG: string
export const SAMPLE_REPO: string
export const SAMPLE_RESOURCES_PATH: string
export const SAMPLE_MODELS: readonly string[]
export const DEFAULT_MODEL: string
export const CUBISM_CORE_URL: string
export const CUBISM_CORE_FILE: string
export const CUBISM_CORE_HEADER_MARKERS: readonly string[]
export const CUBISM_EULA_URL: string
export const FREE_MATERIAL_LICENSE_URL: string
export const SAMPLE_MODEL_TERMS_URL: string
export const SDK_RELEASE_LICENSE_URL: string
export const SAMPLE_CREDIT_LINE: string

export function normalizeModelName(input: unknown): string | null
export function sampleModelSources(model: string, tag?: string): SampleModelSource
export function normalizeRelativePath(p: string): string
export function isSafeRelativePath(p: string): boolean
export function collectManifestFiles(manifest: unknown): ManifestEntry[]
export function manifestFilePaths(manifest: unknown): string[]
export function fileUrl(base: string, relative: string): string
export function hasCubismCoreHeader(text: string): boolean
export function licenseNotice(source: Pick<SampleModelSource, 'model' | 'tag' | 'repoUrl'>): string
export function sourceNotice(
  source: Pick<SampleModelSource, 'model' | 'tag' | 'primary' | 'fallback' | 'repoUrl'>,
  files: string[],
  now?: Date,
): string
