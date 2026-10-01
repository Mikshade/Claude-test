/**
 * Typed IPC contract between main, preload and the two renderer pages.
 *
 * Renderer -> main calls are `invoke` (request/response) under `Invoke`.
 * Main -> renderer pushes are `send` under `Push`.
 * The preload exposes `window.flowy: FlowyApi` (see src/preload/index.ts and src/preload/api.d.ts).
 */
import type { DeepPartial, FlowyConfig } from './config'
import type { ActiveWindowInfo, CompanionState, ConfirmRequest, Emotion, Point, Rect, SpeechChunk, TurnError } from './state'

export interface RecordedAudio {
  /** 16 kHz mono 16-bit PCM WAV container, or webm/opus. */
  data: ArrayBuffer
  mimeType: 'audio/wav' | 'audio/webm'
  durationMs: number
}

export interface VoiceInfo {
  id: string
  title: string
  description: string
  languages: string[]
  tags: string[]
  author: string
  /** Preview audio url if the provider offers one. */
  sampleUrl?: string
  coverImage?: string
  /** Popularity hint (e.g. task_count) for sorting. */
  popularity?: number
}

export interface TestResult {
  ok: boolean
  message: string
  /** e.g. synthesized audio for a TTS test so the settings page can play it. */
  audio?: { data: ArrayBuffer; format: 'wav' | 'mp3' | 'pcm'; sampleRate?: number }
}

export interface ChatMessageView {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: number
}

export interface DisplayInfo {
  id: number
  label: string
  bounds: Rect
  primary: boolean
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface AppInfo {
  version: string
  platform: 'win32' | 'darwin' | 'linux' | string
  elevated: boolean
  userDataPath: string
  defaultModelPath: string
  /** Whether the Cubism Core runtime was found locally. */
  live2dCoreAvailable: boolean
}

/** Renderer -> main request/response channels. */
export interface Invoke {
  'app:getInfo': { args: []; result: AppInfo }
  'app:quit': { args: []; result: void }
  'app:openSettings': { args: [page?: string]; result: void }
  'app:relaunchElevated': { args: []; result: void }
  'app:openExternal': { args: [url: string]; result: void }
  'app:getDisplays': { args: []; result: DisplayInfo[] }
  'app:closeSettings': { args: []; result: void }

  'config:get': { args: []; result: FlowyConfig }
  'config:patch': { args: [patch: DeepPartial<FlowyConfig>]; result: FlowyConfig }
  'config:completeSetup': { args: []; result: FlowyConfig }
  'config:testLlm': { args: []; result: TestResult }
  'config:testTts': { args: [text?: string]; result: TestResult }
  'config:testStt': { args: [audio: RecordedAudio]; result: TestResult }
  'config:searchVoices': { args: [query: string]; result: VoiceInfo[] }
  'config:pickModelFile': { args: []; result: string | null }
  /** Generic open-file dialog (e.g. for a voice clone sample). */
  'config:pickFile': { args: [filters?: FileFilter[]]; result: string | null }

  /** Overlay tells main whether the cursor is over the character (controls click-through). */
  'overlay:setInteractive': { args: [interactive: boolean]; result: void }
  /** Overlay needs keyboard focus (chat input open) or gives it back to the previous app. */
  'overlay:setFocus': { args: [focused: boolean]; result: void }
  /** Overlay reports the character's current screen rect (for context menus / bubbles). */
  'overlay:reportBounds': { args: [rect: Rect]; result: void }
  'overlay:showContextMenu': { args: []; result: void }

  /** Recording finished in the renderer; main runs STT + brain + TTS. Returns the turn id. */
  'turn:submitAudio': { args: [audio: RecordedAudio]; result: string }
  /** Typed text from the chat input. Returns the turn id. */
  'turn:submitText': { args: [text: string]; result: string }
  /** Stop speaking / cancel the current turn. */
  'turn:interrupt': { args: []; result: void }
  /** Renderer finished playing all chunks of a turn (or playback was stopped). */
  'turn:playbackFinished': { args: [turnId: string]; result: void }
  /** Answer to a ConfirmRequest. */
  'confirm:answer': { args: [id: string, approved: boolean]; result: void }

  'chat:getHistory': { args: [limit?: number]; result: ChatMessageView[] }
  'chat:clearHistory': { args: []; result: void }
}

/** Main -> renderer push channels. */
export interface Push {
  'cursor:position': Point
  'state:changed': CompanionState
  'config:changed': FlowyConfig
  'turn:started': { turnId: string; source: 'voice' | 'text' | 'proactive' }
  'turn:userText': { turnId: string; text: string }
  'turn:assistantDelta': { turnId: string; delta: string }
  'turn:assistantDone': { turnId: string; text: string }
  'turn:toolCall': { turnId: string; name: string; summary: string }
  'turn:error': TurnError
  'speech:chunk': SpeechChunk
  'speech:stop': { turnId?: string }
  'ptt:start': { turnId: string }
  'ptt:stop': Record<string, never>
  'emotion:set': { emotion: Emotion; holdMs?: number }
  'avatar:fly': { reason: 'cursor' | 'user' | 'window' }
  'avatar:setVisible': boolean
  'confirm:request': ConfirmRequest
  'confirm:resolved': { id: string }
  'activeWindow:changed': ActiveWindowInfo
}

export type InvokeChannel = keyof Invoke
export type PushChannel = keyof Push

/** The API surface the preload script exposes as `window.flowy`. */
export interface FlowyApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: Invoke[C]['args']): Promise<Invoke[C]['result']>
  /** Subscribe to a push channel. Returns an unsubscribe function. */
  on<C extends PushChannel>(channel: C, listener: (payload: Push[C]) => void): () => void
  /** Which page this renderer is ('overlay' | 'settings'), derived from the URL by the preload. */
  page: 'overlay' | 'settings'
}

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'app:getInfo',
  'app:quit',
  'app:openSettings',
  'app:relaunchElevated',
  'app:openExternal',
  'app:getDisplays',
  'app:closeSettings',
  'config:get',
  'config:patch',
  'config:completeSetup',
  'config:testLlm',
  'config:testTts',
  'config:testStt',
  'config:searchVoices',
  'config:pickModelFile',
  'config:pickFile',
  'overlay:setInteractive',
  'overlay:setFocus',
  'overlay:reportBounds',
  'overlay:showContextMenu',
  'turn:submitAudio',
  'turn:submitText',
  'turn:interrupt',
  'turn:playbackFinished',
  'confirm:answer',
  'chat:getHistory',
  'chat:clearHistory',
]

export const PUSH_CHANNELS: readonly PushChannel[] = [
  'cursor:position',
  'state:changed',
  'config:changed',
  'turn:started',
  'turn:userText',
  'turn:assistantDelta',
  'turn:assistantDone',
  'turn:toolCall',
  'turn:error',
  'speech:chunk',
  'speech:stop',
  'ptt:start',
  'ptt:stop',
  'emotion:set',
  'avatar:fly',
  'avatar:setVisible',
  'confirm:request',
  'confirm:resolved',
  'activeWindow:changed',
]
