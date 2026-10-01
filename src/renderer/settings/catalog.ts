/**
 * Static option tables for the settings page (models, presets) + small parsers. Pure – tested in
 * catalog.test.ts.
 *
 * OWNER: settings-ui agent.
 */
import type { FishCloudModel, LlmEffort } from '@shared/config'
import type { StringKey } from './i18n'

export interface ModelOption<T extends string> {
  id: T
  label: string
  descriptionKey: StringKey
}

/** Fish Audio cloud TTS models (the `model` header). Order = order in the select. */
export const TTS_CLOUD_MODELS: ReadonlyArray<ModelOption<FishCloudModel>> = [
  { id: 's2.1-pro-free', label: 's2.1-pro-free (kostenlos / free)', descriptionKey: 'model.s21free' },
  { id: 's2.1-pro', label: 's2.1-pro', descriptionKey: 'model.s21pro' },
  { id: 's2-pro', label: 's2-pro', descriptionKey: 'model.s2pro' },
  { id: 's1', label: 's1', descriptionKey: 'model.s1' },
]

export const LLM_CUSTOM = 'custom' as const

export const LLM_MODELS: ReadonlyArray<ModelOption<string>> = [
  { id: 'claude-opus-5-5', label: 'claude-opus-5-5', descriptionKey: 'llm.opus' },
  { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', descriptionKey: 'llm.sonnet' },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', descriptionKey: 'llm.haiku' },
]

export function isKnownLlmModel(id: string): boolean {
  return LLM_MODELS.some((m) => m.id === id)
}

export const LLM_EFFORT_KEYS: Record<LlmEffort, StringKey> = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
}

export interface SttPreset {
  id: 'openai' | 'groq' | 'local'
  labelKey: StringKey
  baseUrl: string
  model: string
}

/** OpenAI-compatible transcription presets. */
export const STT_PRESETS: readonly SttPreset[] = [
  { id: 'openai', labelKey: 'ears.presetOpenai', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  { id: 'groq', labelKey: 'ears.presetGroq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  { id: 'local', labelKey: 'ears.presetLocal', baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1' },
]

/** The preset matching a base url (ignoring trailing slashes), if any. */
export function matchSttPreset(baseUrl: string): SttPreset | null {
  const norm = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  return STT_PRESETS.find((p) => p.baseUrl.toLowerCase() === norm) ?? null
}

/**
 * Accept a Fish Audio voice id as a bare 32-hex id, a `fish.audio/m/<id>` page link or a
 * `?modelId=<id>` link. Returns null when nothing id-like is found. Empty input → ''.
 */
export function parseFishReferenceId(input: string): string | null {
  const text = input.trim()
  if (!text) return ''
  if (/^[0-9a-f]{32}$/i.test(text)) return text.toLowerCase()
  const fromPath = /fish\.audio\/(?:m|models?)\/([0-9a-f]{32})/i.exec(text)
  if (fromPath) return fromPath[1]!.toLowerCase()
  const fromQuery = /[?&]modelId=([0-9a-f]{32})/i.exec(text)
  if (fromQuery) return fromQuery[1]!.toLowerCase()
  return null
}

export const LINKS = {
  fishApiKeys: 'https://fish.audio/app/api-keys',
  fishBilling: 'https://fish.audio/app/developers/billing/',
  fishVoices: 'https://fish.audio/',
  anthropicConsole: 'https://console.anthropic.com',
  anthropicKeys: 'https://console.anthropic.com/settings/keys',
  live2d: 'https://www.live2d.com/en/',
  live2dLicense: 'https://www.live2d.com/en/terms/live2d-open-software-license-agreement/',
  groqKeys: 'https://console.groq.com/keys',
  openaiKeys: 'https://platform.openai.com/api-keys',
  braveSearch: 'https://brave.com/search/api/',
  fishSpeechRepo: 'https://github.com/fishaudio/fish-speech',
} as const

/** Pad a number to two digits (quiet-hour selects). */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** Format a duration in ms as seconds with one decimal (1400 → '1.4 s'). */
export function formatSeconds(ms: number, lang: 'de' | 'en'): string {
  const seconds = (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)
  return `${lang === 'de' ? seconds.replace('.', ',') : seconds} s`
}
