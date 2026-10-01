/**
 * Flowy configuration schema (single source of truth).
 *
 * - Validated with zod on load/save (`FlowyConfigSchema`).
 * - `DEFAULT_CONFIG` is what a fresh install starts with (wizard not completed yet).
 * - Secrets (API keys) are stored encrypted at rest by the main-process ConfigStore
 *   (Electron safeStorage / DPAPI); in memory they are plain strings.
 */
import { z } from 'zod'

export const LANGUAGES = ['de', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

export const PERSONALITY_PRESETS = [
  'jarvis', // calm, precise, dry wit – the butler/assistant archetype
  'genki', // energetic, cheerful, playful
  'kuudere', // cool, composed, minimal words, secretly caring
  'onee-san', // warm, caring, gently teasing big-sister energy
  'tsundere', // prickly on the outside, helpful underneath
  'custom',
] as const
export type PersonalityPreset = (typeof PERSONALITY_PRESETS)[number]

export const PERMISSION_LEVELS = ['full', 'confirm-destructive', 'read-only'] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]

export const TTS_PROVIDERS = ['fish-cloud', 'fish-local', 'none'] as const
export type TtsProvider = (typeof TTS_PROVIDERS)[number]

export const STT_PROVIDERS = ['fish-cloud', 'openai-compatible', 'none'] as const
export type SttProvider = (typeof STT_PROVIDERS)[number]

export const SCREEN_AWARENESS_MODES = ['always', 'on-demand', 'off'] as const
export type ScreenAwarenessMode = (typeof SCREEN_AWARENESS_MODES)[number]

export const LLM_EFFORTS = ['low', 'medium', 'high'] as const
export type LlmEffort = (typeof LLM_EFFORTS)[number]

const Percent = z.number().int().min(0).max(100)

export const CharacterConfigSchema = z.object({
  /** Her name – used in the system prompt and the UI. */
  name: z.string().min(1).max(40).default('Yui'),
  /** How she addresses the user. Empty = she asks / uses no name. */
  userName: z.string().max(60).default(''),
  language: z.enum(LANGUAGES).default('de'),
  /** German formality: 'du' (casual) or 'Sie' (formal). Ignored for English. */
  formOfAddress: z.enum(['du', 'Sie']).default('du'),
  preset: z.enum(PERSONALITY_PRESETS).default('jarvis'),
  /** Fine-tuning sliders 0..100, applied on top of the preset. */
  traits: z
    .object({
      warmth: Percent.default(70),
      playfulness: Percent.default(50),
      sass: Percent.default(30),
      formality: Percent.default(30),
      verbosity: Percent.default(30),
      proactivity: Percent.default(40),
    })
    .prefault({}),
  /** Free text appended to the system prompt (backstory, quirks, rules). */
  customPrompt: z.string().max(8000).default(''),
})

export const LlmConfigSchema = z.object({
  provider: z.literal('anthropic').default('anthropic'),
  /** Stored encrypted at rest. */
  apiKey: z.string().default(''),
  model: z.string().min(1).default('claude-opus-5-5'),
  effort: z.enum(LLM_EFFORTS).default('low'),
  /** Enable server-side refusal fallbacks (beta) so a policy decline is retried on a fallback model. */
  refusalFallback: z.boolean().default(true),
  /** Maximum number of user/assistant turns kept in context before older ones are summarized. */
  maxHistoryTurns: z.number().int().min(4).max(400).default(60),
  /** Hard cap on tool-use iterations per user turn. */
  maxToolIterations: z.number().int().min(1).max(100).default(25),
})

/** Fish Audio cloud TTS models (sent as the `model` HTTP header). Unknown names silently fall back to s2.1-pro (billed!). */
export const FISH_CLOUD_MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1'] as const
export type FishCloudModel = (typeof FISH_CLOUD_MODELS)[number]

/** Optional zero-shot voice cloning sample (10–30 s of clean speech + exact transcript). */
export const CloneSampleSchema = z.object({
  audioPath: z.string().default(''),
  transcript: z.string().default(''),
})

export const TtsConfigSchema = z.object({
  provider: z.enum(TTS_PROVIDERS).default('fish-cloud'),
  fishCloud: z
    .object({
      /** Stored encrypted at rest. Shared with STT when provider is fish-cloud. */
      apiKey: z.string().default(''),
      /** Voice model id from https://fish.audio/m/<id> (the "reference_id"). Empty = provider default voice. */
      referenceId: z.string().default(''),
      model: z.enum(FISH_CLOUD_MODELS).default('s2.1-pro-free'),
      format: z.enum(['mp3', 'wav', 'pcm']).default('mp3'),
      latency: z.enum(['normal', 'balanced', 'low']).default('balanced'),
      cloneSample: CloneSampleSchema.prefault({}),
    })
    .prefault({}),
  fishLocal: z
    .object({
      baseUrl: z.string().url().default('http://127.0.0.1:8080'),
      /** Only when the server was started with --api-key. */
      apiKey: z.string().default(''),
      /** Folder name under the server's references/ directory. */
      referenceId: z.string().default(''),
      /** The open-source server only produces wav/mp3 (pcm/opus fail). */
      format: z.enum(['wav', 'mp3']).default('wav'),
      cloneSample: CloneSampleSchema.prefault({}),
    })
    .prefault({}),
  /** Translate [[emotion]] markers into Fish Audio delivery cues ("[happy]" for S2, "(happy)" for S1). */
  emotionCues: z.boolean().default(true),
  /** Playback speed multiplier (1 = normal). */
  speed: z.number().min(0.5).max(2).default(1),
  /** Output volume 0..100. */
  volume: Percent.default(80),
  /** Preferred audio output device id (empty = system default). */
  outputDeviceId: z.string().default(''),
})

export const SttConfigSchema = z.object({
  provider: z.enum(STT_PROVIDERS).default('fish-cloud'),
  openaiCompatible: z
    .object({
      baseUrl: z.string().url().default('https://api.openai.com/v1'),
      /** Stored encrypted at rest. */
      apiKey: z.string().default(''),
      model: z.string().default('whisper-1'),
    })
    .prefault({}),
  /** BCP-47-ish language hint for the recognizer; empty = auto. */
  language: z.string().default(''),
  /** Preferred microphone device id (empty = system default). */
  inputDeviceId: z.string().default(''),
  /** Auto-stop recording after this many ms of silence (0 = manual stop only). */
  silenceTimeoutMs: z.number().int().min(0).max(10000).default(1400),
  /** Hard cap on a single recording in ms. */
  maxRecordingMs: z.number().int().min(1000).max(120000).default(30000),
})

/** Electron accelerator strings. */
export const HotkeysConfigSchema = z.object({
  pushToTalk: z.string().default('CommandOrControl+Shift+Space'),
  toggleVisibility: z.string().default('CommandOrControl+Shift+H'),
  openChat: z.string().default('CommandOrControl+Shift+Enter'),
  /** Empty = disabled. A bare global 'Escape' would steal Escape from every app; use e.g. 'CommandOrControl+Shift+Escape'. */
  interrupt: z.string().default(''),
})

export const PermissionsConfigSchema = z.object({
  level: z.enum(PERMISSION_LEVELS).default('full'),
  allowShell: z.boolean().default(true),
  allowFiles: z.boolean().default(true),
  allowScreenshots: z.boolean().default(true),
  allowWeb: z.boolean().default(true),
  allowInput: z.boolean().default(true), // typing / key presses / mouse
  allowPower: z.boolean().default(true), // lock / sleep / shutdown
})

export const ScreenAwarenessConfigSchema = z.object({
  mode: z.enum(SCREEN_AWARENESS_MODES).default('always'),
  includeActiveWindow: z.boolean().default(true),
  /** Screenshots are downscaled so the long edge is at most this many px before being sent. */
  maxLongEdge: z.number().int().min(640).max(2048).default(1280),
  jpegQuality: z.number().int().min(30).max(95).default(70),
})

export const WebConfigSchema = z.object({
  /** 'brave' needs an API key (https://brave.com/search/api/); 'duckduckgo' scrapes the HTML endpoint (best effort, may be blocked). */
  searchProvider: z.enum(['duckduckgo', 'brave']).default('duckduckgo'),
  /** Stored encrypted at rest. */
  braveApiKey: z.string().default(''),
  /** Max characters of extracted page text returned to the model. */
  maxPageChars: z.number().int().min(2000).max(200000).default(20000),
})

export const AvatarConfigSchema = z.object({
  /** Absolute path to a Live2D `*.model3.json` (or Cubism 2 `*.model.json`). Empty = bundled default / fallback. */
  modelPath: z.string().default(''),
  /** Rendered height of the character in CSS px. */
  height: z.number().int().min(150).max(1200).default(480),
  mirror: z.boolean().default(false),
  /** Initial anchor corner. */
  anchor: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).default('bottom-right'),
  avoidance: z
    .object({
      enabled: z.boolean().default(true),
      /** Cursor distance (px) at which she flies away. */
      radius: z.number().int().min(40).max(600).default(170),
      /** Flight duration in ms. */
      durationMs: z.number().int().min(150).max(3000).default(650),
      /** Hold this key to approach her without triggering flight. */
      holdKeyToInteract: z.enum(['Control', 'Alt', 'Shift']).default('Control'),
    })
    .prefault({}),
  /** Idle head/eye tracking of the cursor. */
  lookAtCursor: z.boolean().default(true),
  /** Pinned = never moves (also toggled from the tray). */
  pinned: z.boolean().default(false),
})

export const AppearanceConfigSchema = z.object({
  showSubtitles: z.boolean().default(true),
  bubbleFontSize: z.number().int().min(10).max(32).default(15),
  theme: z.enum(['auto', 'light', 'dark']).default('auto'),
  /** Overlay opacity when idle 0..100 (she fades slightly when not talking). */
  idleOpacity: Percent.default(100),
})

export const BehaviorConfigSchema = z.object({
  greetOnStart: z.boolean().default(true),
  /** Occasionally comment on what you're doing (uses screen awareness). */
  proactive: z
    .object({
      enabled: z.boolean().default(false),
      intervalMinutes: z.number().int().min(2).max(240).default(20),
      quietHoursStart: z.number().int().min(0).max(23).default(23),
      quietHoursEnd: z.number().int().min(0).max(23).default(8),
    })
    .prefault({}),
})

export const FlowyConfigSchema = z.object({
  version: z.literal(1).default(1),
  setupCompleted: z.boolean().default(false),
  character: CharacterConfigSchema.prefault({}),
  llm: LlmConfigSchema.prefault({}),
  tts: TtsConfigSchema.prefault({}),
  stt: SttConfigSchema.prefault({}),
  hotkeys: HotkeysConfigSchema.prefault({}),
  permissions: PermissionsConfigSchema.prefault({}),
  screenAwareness: ScreenAwarenessConfigSchema.prefault({}),
  web: WebConfigSchema.prefault({}),
  avatar: AvatarConfigSchema.prefault({}),
  appearance: AppearanceConfigSchema.prefault({}),
  behavior: BehaviorConfigSchema.prefault({}),
  /** Which display the overlay covers: 'primary' or a numeric Electron display id. */
  display: z.union([z.literal('primary'), z.number().int()]).default('primary'),
  autostart: z.boolean().default(false),
})

export type FlowyConfig = z.infer<typeof FlowyConfigSchema>
export type CharacterConfig = z.infer<typeof CharacterConfigSchema>
export type LlmConfig = z.infer<typeof LlmConfigSchema>
export type TtsConfig = z.infer<typeof TtsConfigSchema>
export type SttConfig = z.infer<typeof SttConfigSchema>
export type HotkeysConfig = z.infer<typeof HotkeysConfigSchema>
export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>
export type ScreenAwarenessConfig = z.infer<typeof ScreenAwarenessConfigSchema>
export type WebConfig = z.infer<typeof WebConfigSchema>
export type AvatarConfig = z.infer<typeof AvatarConfigSchema>
export type AppearanceConfig = z.infer<typeof AppearanceConfigSchema>
export type BehaviorConfig = z.infer<typeof BehaviorConfigSchema>

/** Recursive partial used for config patches over IPC. */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export const DEFAULT_CONFIG: FlowyConfig = FlowyConfigSchema.parse({})

/** Dot-paths of fields that must be encrypted at rest and never sent to the renderer in clear text
 *  except through the explicit settings page (which the user opened). */
export const SECRET_PATHS = ['llm.apiKey', 'tts.fishCloud.apiKey', 'stt.openaiCompatible.apiKey', 'web.braveApiKey'] as const

/** Deep-merge a patch into a config object (arrays are replaced, objects merged). */
export function mergeConfig<T extends object>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    const current = out[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = mergeConfig(current as object, value as DeepPartial<object>)
    } else {
      out[key] = value
    }
  }
  return out as T
}

/** Parse unknown JSON into a valid config, filling defaults. Throws ZodError on hard violations. */
export function parseConfig(raw: unknown): FlowyConfig {
  return FlowyConfigSchema.parse(raw ?? {})
}

/** Returns a copy with secret fields masked (for logging / sending to the overlay renderer). */
export function redactConfig(config: FlowyConfig): FlowyConfig {
  const copy = structuredClone(config)
  copy.llm.apiKey = mask(copy.llm.apiKey)
  copy.tts.fishCloud.apiKey = mask(copy.tts.fishCloud.apiKey)
  copy.stt.openaiCompatible.apiKey = mask(copy.stt.openaiCompatible.apiKey)
  copy.web.braveApiKey = mask(copy.web.braveApiKey)
  return copy
}

function mask(secret: string): string {
  if (!secret) return ''
  return secret.length <= 8 ? '••••' : `${secret.slice(0, 4)}…${secret.slice(-4)}`
}
