/**
 * Soft validation of the configuration: warnings shown on the pages and in the wizard summary.
 * Nothing here blocks saving – the zod schema in main does the hard validation.
 * Pure – unit-tested in validation.test.ts.
 *
 * OWNER: settings-ui agent.
 */
import type { FlowyConfig } from '@shared/config'
import type { StringKey } from './i18n'
import type { PageId } from './nav'

export interface ConfigWarning {
  page: PageId
  key: StringKey
  /** 'error' = she will not work without it, 'hint' = nice to fix. */
  severity: 'error' | 'hint'
}

export function collectWarnings(config: FlowyConfig): ConfigWarning[] {
  const out: ConfigWarning[] = []
  if (!config.character.name.trim()) out.push({ page: 'character', key: 'warn.nameEmpty', severity: 'error' })
  if (!config.llm.apiKey.trim()) out.push({ page: 'brain', key: 'warn.llmKeyMissing', severity: 'error' })

  const fishKey = config.tts.fishCloud.apiKey.trim()
  if (config.tts.provider === 'fish-cloud') {
    if (!fishKey) out.push({ page: 'voice', key: 'warn.ttsKeyMissing', severity: 'error' })
    else if (!config.tts.fishCloud.referenceId.trim()) out.push({ page: 'voice', key: 'warn.noVoice', severity: 'hint' })
  }

  if (config.stt.provider === 'fish-cloud' && !fishKey) out.push({ page: 'ears', key: 'warn.sttNeedsFishKey', severity: 'error' })
  if (config.stt.provider === 'openai-compatible' && !config.stt.openaiCompatible.apiKey.trim()) {
    out.push({ page: 'ears', key: 'warn.sttOpenaiKeyMissing', severity: 'hint' })
  }
  if (config.stt.provider !== 'none' && !config.hotkeys.pushToTalk.trim()) {
    out.push({ page: 'hotkeys', key: 'warn.noPushToTalk', severity: 'hint' })
  }
  return out
}

export function warningsFor(config: FlowyConfig, page: PageId): ConfigWarning[] {
  return collectWarnings(config).filter((w) => w.page === page)
}
