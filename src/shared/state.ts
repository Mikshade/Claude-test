/**
 * Runtime state shared between main and renderer (not persisted).
 */

/** What the companion is doing right now; drives animation + UI. */
export type CompanionState =
  | 'booting' // windows created, model loading
  | 'idle'
  | 'listening' // recording the user's voice
  | 'transcribing'
  | 'thinking' // waiting for / streaming the LLM
  | 'speaking' // TTS playback
  | 'error'
  | 'sleeping' // hidden / muted by user

/** Emotions the brain can express inline via [[emotion]] markers; mapped to Live2D expressions/motions. */
export const EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'shy',
  'sad',
  'surprised',
  'angry',
  'thinking',
  'smug',
  'sleepy',
] as const
export type Emotion = (typeof EMOTIONS)[number]

export function isEmotion(value: string): value is Emotion {
  return (EMOTIONS as readonly string[]).includes(value)
}

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A chunk of synthesized speech, ordered by `seq` within one `turnId`. */
export interface SpeechChunk {
  turnId: string
  seq: number
  /** Text that this audio speaks (for subtitles). */
  text: string
  /** Emotion to show while this chunk plays. */
  emotion: Emotion
  /** Encoded audio bytes (wav/mp3) or raw PCM. */
  audio: ArrayBuffer
  format: 'wav' | 'mp3' | 'pcm'
  /** Only for 'pcm': signed 16-bit little-endian mono. */
  sampleRate?: number
  /** True on the last chunk of a turn. */
  last: boolean
}

/** A request from main to the user (permission prompt, choice). */
export interface ConfirmRequest {
  id: string
  title: string
  detail: string
  /** e.g. the PowerShell command about to run */
  preview?: string
  danger: boolean
}

export interface ActiveWindowInfo {
  title: string
  processName: string
  exePath: string
  pid: number
}

export interface TurnError {
  turnId: string
  stage: 'stt' | 'llm' | 'tts' | 'tool' | 'audio'
  message: string
}
