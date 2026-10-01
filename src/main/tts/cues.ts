/**
 * Emotion → Fish Audio delivery cue mapping.
 *
 * The S2 model family (s2-pro, s2.1-pro, s2.1-pro-free) understands square-bracket cues (`[happy] …`),
 * the S1 family (cloud `s1`, local S1-mini) the same words in parentheses (`(happy) …`).
 * Cues are plain text for the model: a sentence gets at most one prefix.
 */
import type { Emotion } from '@shared/state'

export type CueStyle = 'S1' | 'S2'

const CUE_WORDS: Record<Emotion, string> = {
  neutral: '',
  happy: 'happy',
  excited: 'excited',
  sad: 'sad',
  surprised: 'surprised',
  angry: 'angry',
  shy: 'soft tone',
  smug: 'playful',
  sleepy: 'sleepy',
  thinking: 'calm',
}

/** Returns the cue prefix (with trailing space) for `emotion`, or '' for neutral / unknown emotions. */
export function cueFor(emotion: Emotion, model: CueStyle): string {
  const word: string | undefined = CUE_WORDS[emotion]
  if (!word) return ''
  return model === 'S2' ? `[${word}] ` : `(${word}) `
}

/** Cloud `model` header → cue style: `s1*` speaks parentheses, everything else is S2 family. */
export function cueStyleForCloudModel(model: string): CueStyle {
  return model.trim().toLowerCase().startsWith('s1') ? 'S1' : 'S2'
}

/** Prefix `text` with the cue for `emotion` (once); returns `text` unchanged when cues are disabled or neutral. */
export function applyCue(text: string, emotion: Emotion | undefined, model: CueStyle, enabled: boolean): string {
  if (!enabled || !emotion) return text
  return `${cueFor(emotion, model)}${text}`
}
