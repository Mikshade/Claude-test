export interface SetupArgs {
  help: boolean
  yes: boolean
  force: boolean
  skipCore: boolean
  skipModel: boolean
  model: string
  lang: 'de' | 'en' | undefined
}

export type StringKey =
  | 'title'
  | 'intro'
  | 'coreHeading'
  | 'coreBody'
  | 'modelHeading'
  | 'modelBody'
  | 'natoriNote'
  | 'links'
  | 'question'
  | 'declined'
  | 'notInteractive'
  | 'acceptedByFlag'
  | 'downloadingCore'
  | 'coreExists'
  | 'coreBadHeader'
  | 'coreExistingBadHeader'
  | 'coreDone'
  | 'fetchingManifest'
  | 'filesToDownload'
  | 'downloading'
  | 'skipped'
  | 'ok'
  | 'modelDone'
  | 'noticeWritten'
  | 'done'
  | 'gitIgnored'
  | 'failed'
  | 'hint'
  | 'skipCore'
  | 'skipModel'

export const STRINGS: Readonly<Record<'de' | 'en', Readonly<Record<StringKey, string | readonly string[]>>>>

export function parseSetupArgs(argv: string[]): SetupArgs
export function pickLanguage(explicit: 'de' | 'en' | undefined, env: Record<string, string | undefined>): 'de' | 'en'
export function acceptedByEnv(env: Record<string, string | undefined>): boolean
export function isAffirmative(answer: string): boolean
export function translator(lang: 'de' | 'en'): (key: StringKey, vars?: Record<string, string | number>) => string
export function helpText(): string
