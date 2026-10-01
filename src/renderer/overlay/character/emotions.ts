/**
 * Emotion → Live2D expression / motion-group mapping, and the face presets of the procedural
 * fallback character. Pure data + matching helpers (unit-tested in emotions.test.ts).
 *
 * Models name their expressions freely ("F01", "exp_03", "Smile", "angry"...). We keyword-match the
 * model's expression list against per-emotion candidate patterns (first pattern that matches any
 * name wins, names are tried in the model's order). Index-style names (F01/exp_01) are a last resort
 * guess based on the usual order of Live2D sample models.
 */
import { EMOTIONS, type Emotion } from '@shared/state'

/** Candidate expression-name patterns per emotion, most specific first. */
export const EXPRESSION_PATTERNS: Readonly<Record<Emotion, readonly RegExp[]>> = {
  neutral: [/^(normal|neutral|default|none|idle)$/i, /normal|neutral|default/i],
  happy: [/happy|smile|joy|glad|cheer|laugh|^fun$/i, /^f0?1$/i, /^exp_?0?1$/i],
  excited: [/excit|sparkl|star|wow|hype|energ|yay/i, /happy|smile|joy|laugh/i, /^f0?3$/i, /^exp_?0?3$/i],
  shy: [/shy|blush|embarrass|bashful|flush|timid/i, /^f0?2$/i, /^exp_?0?2$/i],
  sad: [/sad|cry|tear|sorrow|unhappy|depress|gloom|^down$/i, /^f0?4$/i, /^exp_?0?4$/i],
  surprised: [/surpris|shock|amaz|astonish|gasp|startl/i, /^f0?5$/i, /^exp_?0?5$/i],
  angry: [/angry|anger|^mad$|rage|annoy|grumpy|pout|furious/i, /^f0?6$/i, /^exp_?0?6$/i],
  thinking: [/think|ponder|hmm|curious|wonder|doubt|puzzl/i, /^f0?7$/i, /^exp_?0?7$/i],
  smug: [/smug|smirk|proud|confident|teas|grin|mischie|sly/i, /^f0?8$/i, /^exp_?0?8$/i],
  sleepy: [/sleep|tired|yawn|drows|doze|closed|relax/i],
}

/** Candidate motion-group patterns per emotion (used when the model has no matching expression). */
export const MOTION_GROUP_PATTERNS: Readonly<Record<Emotion, readonly RegExp[]>> = {
  neutral: [],
  happy: [/happy|smile|joy/i, /^tap(body)?$/i, /^tap/i, /flick/i],
  excited: [/excit|happy|joy/i, /^tap(body)?$/i, /^tap/i, /flick/i, /shake/i],
  shy: [/shy|blush/i, /^tap(body)?$/i, /^tap/i],
  sad: [/sad|cry/i, /flick(down)?/i, /^tap/i],
  surprised: [/surpris|shock/i, /flick(up)?/i, /^tap(body)?$/i, /^tap/i, /shake/i],
  angry: [/angry|anger/i, /shake/i, /flick/i, /^tap/i],
  thinking: [/think|hmm/i, /^tap(head)?$/i],
  smug: [/smug|proud/i, /^tap(body)?$/i, /^tap/i],
  sleepy: [/sleep|tired|yawn/i],
}

/** Expression used while she listens to the user (the "I'm all ears" look). */
export const ATTENTIVE_PATTERNS: readonly RegExp[] = [/attent|listen|curious|interest|focus/i, /smile/i, /happy|joy/i]

function firstMatch(patterns: readonly RegExp[], names: readonly string[]): string | null {
  for (const pattern of patterns) {
    const hit = names.find((name) => pattern.test(name))
    if (hit !== undefined) return hit
  }
  return null
}

/** Name of the model expression that best fits `emotion`, or null (also for neutral). */
export function matchExpression(emotion: Emotion, names: readonly string[]): string | null {
  if (emotion === 'neutral') return null
  return firstMatch(EXPRESSION_PATTERNS[emotion], names)
}

/** Motion group of the model that best fits `emotion`, or null. */
export function matchMotionGroup(emotion: Emotion, groups: readonly string[]): string | null {
  return firstMatch(MOTION_GROUP_PATTERNS[emotion], groups)
}

/** Expression to show while listening, or null when the model offers nothing suitable. */
export function matchAttentiveExpression(names: readonly string[]): string | null {
  return firstMatch(ATTENTIVE_PATTERNS, names)
}

/** Emotions that deserve a body motion in addition to / instead of a facial expression. */
export const LIVELY_EMOTIONS: ReadonlySet<Emotion> = new Set<Emotion>(['excited', 'surprised', 'angry'])

/** Face preset of the procedural fallback character. All values are 0..1 unless noted. */
export interface FacePreset {
  /** Eyelid openness (1 = wide open, 0 = closed). */
  eyeOpen: number
  /** Eyebrow tilt in radians (positive = inner ends down → angry, negative = inner ends up → sad). */
  browAngle: number
  /** Eyebrow lift (positive = raised). */
  browRaise: number
  /** Mouth curve -1 (frown) .. 1 (smile). */
  mouthCurve: number
  /** Mouth width relative to the default. */
  mouthWidth: number
  /** Cheek blush intensity. */
  blush: number
  /** Head tilt in radians (small). */
  headTilt: number
  /** Draw sparkles around her. */
  sparkle: boolean
  /** Draw a sweat drop. */
  sweat: boolean
}

export const FACE_PRESETS: Readonly<Record<Emotion, FacePreset>> = {
  neutral: { eyeOpen: 1, browAngle: 0, browRaise: 0, mouthCurve: 0.35, mouthWidth: 1, blush: 0.15, headTilt: 0, sparkle: false, sweat: false },
  happy: { eyeOpen: 0.85, browAngle: 0, browRaise: 0.3, mouthCurve: 1, mouthWidth: 1.2, blush: 0.45, headTilt: 0.05, sparkle: false, sweat: false },
  excited: { eyeOpen: 1, browAngle: 0, browRaise: 0.8, mouthCurve: 1, mouthWidth: 1.35, blush: 0.5, headTilt: -0.06, sparkle: true, sweat: false },
  shy: { eyeOpen: 0.6, browAngle: -0.25, browRaise: 0.2, mouthCurve: 0.3, mouthWidth: 0.7, blush: 1, headTilt: 0.1, sparkle: false, sweat: false },
  sad: { eyeOpen: 0.7, browAngle: -0.45, browRaise: 0.1, mouthCurve: -0.8, mouthWidth: 0.8, blush: 0.1, headTilt: 0.08, sparkle: false, sweat: false },
  surprised: { eyeOpen: 1, browAngle: 0, browRaise: 1, mouthCurve: 0.1, mouthWidth: 0.75, blush: 0.25, headTilt: 0, sparkle: false, sweat: false },
  angry: { eyeOpen: 0.75, browAngle: 0.55, browRaise: -0.3, mouthCurve: -0.6, mouthWidth: 0.9, blush: 0.3, headTilt: 0, sparkle: false, sweat: false },
  thinking: { eyeOpen: 0.8, browAngle: 0.15, browRaise: 0.35, mouthCurve: 0, mouthWidth: 0.7, blush: 0.15, headTilt: 0.12, sparkle: false, sweat: false },
  smug: { eyeOpen: 0.55, browAngle: 0.2, browRaise: 0.1, mouthCurve: 0.8, mouthWidth: 1.05, blush: 0.2, headTilt: -0.08, sparkle: false, sweat: false },
  sleepy: { eyeOpen: 0.3, browAngle: -0.1, browRaise: -0.1, mouthCurve: 0.2, mouthWidth: 0.8, blush: 0.2, headTilt: 0.15, sparkle: false, sweat: false },
}

/** True when every emotion has a preset (sanity check used by tests). */
export function hasAllPresets(): boolean {
  return EMOTIONS.every((e) => FACE_PRESETS[e] !== undefined)
}
