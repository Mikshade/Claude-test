/**
 * Pure helpers for the overlay entry (main.ts): model URL building, hold-key mapping,
 * interactive / flight-blocked decisions, a streaming marker stripper, the tiny i18n table and
 * no-op stand-ins for optional subsystems. No DOM access – unit-tested in wiring.test.ts.
 */
import type { AvatarConfig, FlowyConfig, Language } from '@shared/config'
import type { CompanionState } from '@shared/state'
import type { BubbleController } from './bubble'
import type { Player, Recorder } from './audio/types'

export const MODEL_URL_PREFIX = 'flowy-model://model/'

/** Last path segment of a Windows or POSIX path. */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/**
 * Candidate `flowy-model://` URLs for a configured model path. `flowy-model://model/` serves the
 * directory that contains the model, so a `*.model3.json` path maps to its basename. When main hands
 * us a directory (the bundled default model folder) we do not know the json's name and probe the
 * usual conventions in order: `<dir>.model3.json`, `model.model3.json`, `default.model3.json`, `index.model3.json`.
 */
export function modelUrlCandidates(modelPath: string): string[] {
  const base = basename(modelPath.trim())
  if (!base) return []
  if (/\.json$/i.test(base)) return [MODEL_URL_PREFIX + encodeURIComponent(base)]
  const names = [`${base}.model3.json`, 'model.model3.json', 'default.model3.json', 'index.model3.json']
  return [...new Set(names)].map((n) => MODEL_URL_PREFIX + encodeURIComponent(n))
}

/** The path to try: the user's model if set, else the bundled default (may be empty). */
export function selectModelPath(modelPath: string, defaultModelPath: string): string {
  return modelPath.trim() || defaultModelPath.trim()
}

export type HoldKey = AvatarConfig['avoidance']['holdKeyToInteract']

export interface ModifierState {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Is the configured hold-to-interact modifier pressed in this mouse/keyboard event? */
export function modifierHeld(event: ModifierState, key: HoldKey): boolean {
  switch (key) {
    case 'Control':
      return event.ctrlKey
    case 'Alt':
      return event.altKey
    case 'Shift':
      return event.shiftKey
    default:
      return false
  }
}

export interface InteractionInputs {
  /** Cursor is over the character's body. */
  hovering: boolean
  /** The hold-to-interact key is pressed. */
  holdKey: boolean
  /** The bubble/chat UI wants real mouse input. */
  bubbleInteractive: boolean
}

/** Should the window stop being click-through? */
export function computeInteractive(i: InteractionInputs): boolean {
  return (i.hovering && i.holdKey) || i.bubbleInteractive
}

export interface BlockInputs {
  pinned: boolean
  holdKey: boolean
  bubbleInteractive: boolean
  state: CompanionState
}

/** Is cursor avoidance (fleeing) suppressed right now? */
export function computeBlocked(b: BlockInputs): boolean {
  return b.pinned || b.holdKey || b.bubbleInteractive || b.state === 'listening'
}

/** Opacity for the character: she fades to `idleOpacity` % when idle and is fully visible otherwise. */
export function opacityForState(state: CompanionState, idleOpacityPercent: number): number {
  const idle = Math.min(100, Math.max(0, idleOpacityPercent)) / 100
  return state === 'idle' || state === 'sleeping' ? idle : 1
}

/**
 * Streaming `[[marker]]` stripper: feed deltas, get back the text safe to display. A marker that is
 * only partially received ("[[hap") is held back until it completes (or `flush()` drops it).
 */
export interface MarkerStripper {
  push(delta: string): string
  flush(): string
  reset(): void
}

export function createMarkerStripper(): MarkerStripper {
  let pending = ''
  return {
    push(delta) {
      let text = pending + delta
      pending = ''
      text = text.replace(/\[\[[^\]]*\]\]/g, '')
      const open = text.lastIndexOf('[[')
      if (open >= 0 && text.indexOf(']]', open) < 0) {
        pending = text.slice(open)
        text = text.slice(0, open)
      } else if (text.endsWith('[')) {
        // could be the first bracket of a marker
        pending = '['
        text = text.slice(0, -1)
      }
      return text
    },
    flush() {
      const out = pending.startsWith('[[') ? '' : pending
      pending = ''
      return out
    },
    reset() {
      pending = ''
    },
  }
}

/** Compare the config sections the overlay cares about and say what needs to happen. */
export interface ConfigDiff {
  rebuildCharacter: boolean
  mirror: boolean
  avoidance: boolean
  anchor: boolean
  lookAtCursor: boolean
  pinned: boolean
  volume: boolean
  outputDevice: boolean
  recorder: boolean
  fontSize: boolean
  language: boolean
  idleOpacity: boolean
  theme: boolean
}

export function diffConfig(prev: FlowyConfig, next: FlowyConfig): ConfigDiff {
  const a = prev.avatar
  const b = next.avatar
  return {
    rebuildCharacter: a.modelPath !== b.modelPath || a.height !== b.height,
    mirror: a.mirror !== b.mirror,
    avoidance: JSON.stringify(a.avoidance) !== JSON.stringify(b.avoidance),
    anchor: a.anchor !== b.anchor,
    lookAtCursor: a.lookAtCursor !== b.lookAtCursor,
    pinned: a.pinned !== b.pinned,
    volume: prev.tts.volume !== next.tts.volume,
    outputDevice: prev.tts.outputDeviceId !== next.tts.outputDeviceId,
    recorder:
      prev.stt.inputDeviceId !== next.stt.inputDeviceId ||
      prev.stt.silenceTimeoutMs !== next.stt.silenceTimeoutMs ||
      prev.stt.maxRecordingMs !== next.stt.maxRecordingMs,
    fontSize: prev.appearance.bubbleFontSize !== next.appearance.bubbleFontSize,
    language: prev.character.language !== next.character.language,
    idleOpacity: prev.appearance.idleOpacity !== next.appearance.idleOpacity,
    theme: prev.appearance.theme !== next.appearance.theme,
  }
}

// ---- i18n -------------------------------------------------------------------------------------

const STRINGS = {
  de: {
    micError: 'Mikrofon konnte nicht gestartet werden.',
    modelError: 'Live2D-Modell konnte nicht geladen werden – Ersatzfigur aktiv.',
    audioError: 'Audio-Wiedergabe fehlgeschlagen.',
    bubbleError: 'Sprechblase konnte nicht initialisiert werden.',
  },
  en: {
    micError: 'Could not start the microphone.',
    modelError: 'Live2D model could not be loaded – using the fallback character.',
    audioError: 'Audio playback failed.',
    bubbleError: 'Speech bubble could not be initialised.',
  },
} as const satisfies Record<Language, Record<string, string>>

export type StringKey = keyof (typeof STRINGS)['de']

export function t(language: Language, key: StringKey): string {
  return (STRINGS[language] ?? STRINGS.de)[key]
}

// ---- no-op stand-ins (used when a subsystem fails to initialise so the character still works) --

export function noopBubble(): BubbleController {
  const noop = (): void => undefined
  return {
    setAnchor: noop,
    setState: noop,
    showListening: noop,
    setInputLevel: noop,
    showUserText: noop,
    startAssistant: noop,
    appendAssistant: noop,
    finishAssistant: noop,
    showSpokenSentence: noop,
    showToolProgress: noop,
    showError: (message) => console.error('[overlay]', message),
    confirm: () => Promise.resolve(false),
    resolveConfirm: noop,
    openChatInput: noop,
    closeChatInput: noop,
    isChatInputOpen: () => false,
    isInteractive: () => false,
    hide: noop,
    setFontSize: noop,
    setLanguage: noop,
    setTheme: noop,
    isConfirmPending: () => false,
    isVisible: () => false,
    dispose: noop,
  }
}

export function noopPlayer(): Player {
  return {
    enqueue: () => undefined,
    stop: () => undefined,
    isPlaying: () => false,
    setVolume: () => undefined,
    setOutputDevice: () => Promise.resolve(),
    currentTurn: () => null,
    dispose: () => undefined,
  }
}

export function noopRecorder(): Recorder {
  return {
    start: () => Promise.reject(new Error('recorder unavailable')),
    stop: () => Promise.resolve(null),
    cancel: () => undefined,
    isRecording: () => false,
    setOptions: () => undefined,
    dispose: () => undefined,
  }
}
