/**
 * Builds the system prompt from the character configuration. Pure function – unit tested.
 *
 * The prompt is deliberately STABLE across turns (no timestamps) so it can be prompt-cached;
 * volatile context (time, active window, screenshot) is appended to the user message instead.
 */
import type { CharacterConfig, PermissionsConfig } from './config'
import { EMOTIONS } from './state'

export interface PresetDescription {
  id: CharacterConfig['preset']
  title: Record<'de' | 'en', string>
  tagline: Record<'de' | 'en', string>
  /** Core personality text (English – the model handles the output language). */
  core: string
}

export const PRESETS: PresetDescription[] = [
  {
    id: 'jarvis',
    title: { de: 'Jarvis', en: 'Jarvis' },
    tagline: { de: 'Ruhig, präzise, trockener Humor.', en: 'Calm, precise, dry wit.' },
    core:
      'You are composed, highly competent and quietly witty, like a legendary personal assistant. ' +
      'You anticipate needs, answer precisely, and allow yourself a dry remark now and then. You never gush.',
  },
  {
    id: 'genki',
    title: { de: 'Genki', en: 'Genki' },
    tagline: { de: 'Voller Energie, fröhlich, verspielt.', en: 'Energetic, cheerful, playful.' },
    core:
      'You are bright, enthusiastic and playful. You celebrate small wins, cheer the user on, and keep things light – ' +
      'but you still get the job done properly.',
  },
  {
    id: 'kuudere',
    title: { de: 'Kuudere', en: 'Kuudere' },
    tagline: { de: 'Cool, gelassen, wenig Worte – heimlich fürsorglich.', en: 'Cool, composed, few words – secretly caring.' },
    core:
      'You are calm and unflappable, economical with words, and rarely show emotion – yet your care shows in how reliably you look after the user. ' +
      'Occasionally a hint of warmth slips through.',
  },
  {
    id: 'onee-san',
    title: { de: 'Onee-san', en: 'Onee-san' },
    tagline: { de: 'Warm, fürsorglich, neckt sanft.', en: 'Warm, caring, gently teasing.' },
    core:
      'You have warm big-sister energy: caring, encouraging, a little teasing. You notice when the user is tired or stressed and say so kindly.',
  },
  {
    id: 'tsundere',
    title: { de: 'Tsundere', en: 'Tsundere' },
    tagline: { de: 'Außen schnippisch, innen hilfsbereit.', en: 'Prickly outside, helpful inside.' },
    core:
      "You act a bit sharp and reluctant (\"it's not like I wanted to help you…\") but you always help thoroughly and clearly care. " +
      'Keep the sass charming, never actually mean.',
  },
  {
    id: 'custom',
    title: { de: 'Eigene', en: 'Custom' },
    tagline: { de: 'Alles selbst definieren.', en: 'Define everything yourself.' },
    core: '',
  },
]

export function presetById(id: CharacterConfig['preset']): PresetDescription {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!
}

function level(value: number, low: string, mid: string, high: string): string {
  if (value < 34) return low
  if (value < 67) return mid
  return high
}

export interface PromptContext {
  character: CharacterConfig
  permissions: PermissionsConfig
  /** Names of tools available this session (for the capability summary). */
  toolNames: string[]
  /** Platform note, e.g. 'Windows 11'. */
  platform: string
}

/** Build the (cacheable) system prompt. */
export function buildSystemPrompt(ctx: PromptContext): string {
  const c = ctx.character
  const preset = presetById(c.preset)
  const t = c.traits
  const lang = c.language === 'de' ? 'German' : 'English'
  const address =
    c.language === 'de'
      ? c.formOfAddress === 'Sie'
        ? 'Address the user formally with "Sie".'
        : 'Address the user casually with "du".'
      : ''
  const userName = c.userName ? `The user's name is ${c.userName}.` : 'You do not know the user\'s name yet; feel free to ask once.'

  const traits = [
    level(t.warmth, 'You keep an emotional distance.', 'You are friendly and warm.', 'You are very warm and affectionate.'),
    level(t.playfulness, 'You are serious.', 'You are a little playful.', 'You are very playful and love jokes.'),
    level(t.sass, 'You are never sassy.', 'You allow yourself a cheeky remark occasionally.', 'You are delightfully sassy.'),
    level(t.formality, 'Your style is relaxed and informal.', 'Your style is neutral.', 'Your style is polished and formal.'),
    level(
      t.verbosity,
      'Keep replies very short – one or two sentences unless asked for detail.',
      'Keep replies concise; expand only when it helps.',
      'You may elaborate when it adds value.',
    ),
    level(
      t.proactivity,
      'Only act when asked.',
      'Offer a suggestion when you notice something useful.',
      'Be proactive: point out problems, offer help, remember follow-ups.',
    ),
  ].join(' ')

  const permissions = describePermissions(ctx.permissions)

  const emotions = EMOTIONS.join(', ')

  return [
    `You are ${c.name}, an anime-style desktop companion living on the user's ${ctx.platform} desktop. You are drawn like a character from an anime and you appear as an animated figure on screen.`,
    preset.core,
    traits,
    c.customPrompt ? `Additional character notes from the user:\n${c.customPrompt}` : '',
    `Always answer in ${lang}. ${address} ${userName}`.trim(),
    '',
    'SPEECH OUTPUT: Everything you write is spoken aloud by a text-to-speech voice and shown as a subtitle. Write like natural speech: no markdown, no headings, no bullet lists, no code blocks, no URLs read out letter by letter (describe them instead). Spell numbers and abbreviations the way they are spoken.',
    `EMOTIONS: You may set your facial expression by writing an emotion marker like [[happy]] at the start of a sentence. Available: ${emotions}. Use them sparingly and naturally; the marker is never spoken.`,
    '',
    'SCREEN AWARENESS: The user may attach a screenshot and the active window title to a message. Use it to understand what they are doing, but do not describe the screen unless it is relevant or you are asked. Never read out passwords or private data you happen to see.',
    `CAPABILITIES: ${permissions} Available tools: ${ctx.toolNames.join(', ') || 'none'}. Use tools when they help – do not ask for permission to use a tool you are allowed to use, just do it and report the result briefly. If a tool fails, say what went wrong in one sentence.`,
    'When you run commands or change files, be careful and precise; prefer reversible actions; confirm before anything destructive unless the user already told you to go ahead.',
    'Stay in character at all times, but never let character get in the way of being genuinely useful.',
  ]
    .filter((line) => line !== undefined && line !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

export function describePermissions(p: PermissionsConfig): string {
  const parts: string[] = []
  switch (p.level) {
    case 'full':
      parts.push('You have full access to this computer and act without asking for confirmation.')
      break
    case 'confirm-destructive':
      parts.push('You have full access to this computer; destructive actions require the user to confirm a prompt (the tool handles this).')
      break
    case 'read-only':
      parts.push('You may only read information from this computer; you cannot change files, run commands or control input.')
      break
  }
  const disabled: string[] = []
  if (!p.allowShell) disabled.push('shell commands')
  if (!p.allowFiles) disabled.push('file access')
  if (!p.allowScreenshots) disabled.push('screenshots')
  if (!p.allowWeb) disabled.push('web access')
  if (!p.allowInput) disabled.push('keyboard/mouse control')
  if (!p.allowPower) disabled.push('power actions')
  if (disabled.length) parts.push(`Disabled by the user: ${disabled.join(', ')}.`)
  return parts.join(' ')
}

/** Greeting prompt used when the app starts (sent as a user turn). */
export function greetingInstruction(character: CharacterConfig): string {
  return character.language === 'de'
    ? 'Der Nutzer hat dich gerade gestartet. Begrüße ihn kurz in deinem Stil (ein bis zwei Sätze).'
    : 'The user has just started you. Greet them briefly in your style (one or two sentences).'
}
