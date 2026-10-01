/**
 * Pure text utilities shared by main (TTS pipeline) and renderer (subtitles).
 *
 * The brain streams text that may contain inline emotion markers like `[[happy]]`.
 * `SentenceChunker` consumes deltas and emits speakable sentences with the marker stripped
 * and the emotion attached, so TTS can start on the first sentence while the model is still writing.
 */
import { type Emotion, isEmotion } from './state'

export interface Sentence {
  text: string
  emotion: Emotion
}

const MARKER_RE = /\[\[([^\]]*)\]\]/g
/** Sentence boundary: terminal punctuation (optionally followed by closing quotes/brackets) then whitespace or end. */
const BOUNDARY_RE = /([.!?…]+["'”’)\]]*)(\s+|$)/

export interface ChunkerOptions {
  /** Emit a chunk once this many characters have accumulated even without punctuation (keeps latency low on long sentences). */
  maxChars?: number
  /** Don't emit on punctuation before this many characters (avoids "Hi." / "Dr." micro-chunks). */
  minChars?: number
}

export class SentenceChunker {
  private buffer = ''
  private currentEmotion: Emotion = 'neutral'
  private readonly maxChars: number
  private readonly minChars: number

  constructor(options: ChunkerOptions = {}) {
    this.maxChars = options.maxChars ?? 220
    this.minChars = options.minChars ?? 12
  }

  /** Feed a streamed delta; returns zero or more complete sentences. */
  push(delta: string): Sentence[] {
    this.buffer += delta
    const out: Sentence[] = []
    // Process markers first: a marker switches the emotion for the text that follows it.
    // We keep the buffer intact and only split at sentence boundaries.
    let guard = 0
    while (guard++ < 1000) {
      const { text, emotion, consumed } = this.scanForSentence()
      if (consumed === 0) break
      this.buffer = this.buffer.slice(consumed)
      if (text) out.push({ text, emotion })
    }
    return out
  }

  /** Flush whatever is left (end of stream). */
  flush(): Sentence[] {
    const out: Sentence[] = []
    let guard = 0
    while (this.buffer.length > 0 && guard++ < 1000) {
      const { text, emotion, consumed } = this.scanForSentence(true)
      if (consumed === 0) break
      this.buffer = this.buffer.slice(consumed)
      if (text) out.push({ text, emotion })
    }
    this.buffer = ''
    return out
  }

  get emotion(): Emotion {
    return this.currentEmotion
  }

  reset(): void {
    this.buffer = ''
    this.currentEmotion = 'neutral'
  }

  /**
   * Scan the buffer for the next emittable sentence.
   * Returns consumed=0 when nothing can be emitted yet.
   */
  private scanForSentence(force = false): { text: string; emotion: Emotion; consumed: number } {
    const wait = { text: '', emotion: this.currentEmotion, consumed: 0 }
    const emit = (raw: string, consumed: number): { text: string; emotion: Emotion; consumed: number } => ({
      text: stripMarkers(raw).replace(/\s+/g, ' ').trim(),
      emotion: this.currentEmotion,
      consumed,
    })

    // 1. Leading markers switch the emotion before any text.
    const lead = this.buffer.match(/^\s*\[\[([^\]]*)\]\]/)
    if (lead) {
      const name = lead[1]!.trim().toLowerCase()
      if (isEmotion(name)) this.currentEmotion = name
      return { text: '', emotion: this.currentEmotion, consumed: lead[0].length }
    }

    // 2. A partial marker at the end ("[[hap") must wait for more input – exclude it from the scan.
    const openAt = this.buffer.lastIndexOf('[[')
    const unterminated = openAt >= 0 && this.buffer.indexOf(']]', openAt) < 0
    const searchable = unterminated ? this.buffer.slice(0, openAt) : this.buffer

    // 3. A marker in the middle ends the current sentence (text before it keeps the old emotion).
    const midMarker = searchable.indexOf('[[')
    if (midMarker > 0) return emit(searchable.slice(0, midMarker), midMarker)
    if (midMarker === 0) return wait // only possible for an unterminated marker at index 0

    // 4. First sentence boundary that leaves at least minChars.
    const re = new RegExp(BOUNDARY_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(searchable)) !== null) {
      const end = m.index + m[1]!.length
      if (end >= this.minChars) return emit(searchable.slice(0, end), end + (m[2]?.length ?? 0))
      if ((m[2]?.length ?? 0) === 0) break // matched at the very end
    }

    // 5. Too long without punctuation: split at the last whitespace before maxChars.
    if (searchable.length >= this.maxChars) {
      const head = searchable.slice(0, this.maxChars)
      const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf(' '))
      const end = cut > this.maxChars / 2 ? cut + 1 : this.maxChars
      return emit(searchable.slice(0, end), end)
    }

    // 6. End of stream: emit what is left (an unterminated marker is dropped).
    if (force) return emit(searchable, this.buffer.length)
    return wait
  }
}

/** Remove all `[[emotion]]` markers. */
export function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, '')
}

/** Extract the last emotion marker in a text, if any. */
export function lastEmotionIn(text: string): Emotion | null {
  let found: Emotion | null = null
  for (const m of text.matchAll(MARKER_RE)) {
    const name = m[1]!.toLowerCase()
    if (isEmotion(name)) found = name
  }
  return found
}

/** Prepare text for TTS: strip markdown-ish noise the model may emit. */
export function cleanForSpeech(text: string): string {
  return stripMarkers(text)
    .replace(/```[\s\S]*?```/g, ' (Code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/\s+/g, ' ')
    .trim()
}

let counter = 0
/** Short unique id (good enough for turn/request ids inside one process). */
export function shortId(prefix = ''): string {
  counter = (counter + 1) % 1_000_000
  return `${prefix}${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}`
}
