/**
 * The conversation turn pipeline and state machine:
 *
 *   hotkey → 'ptt:start' → renderer records → 'turn:submitAudio' → STT → brain (streaming)
 *   → SentenceChunker → SpeechPipeline (TTS) → 'speech:chunk' → renderer plays → 'turn:playbackFinished'
 *
 * Also: text turns, interruption (abort LLM + TTS, 'speech:stop'), confirm prompts for destructive tools,
 * screen awareness context (screenshot + active window) and proactive comments.
 *
 * OWNER: integration agent (written last, after modules exist). Keep it free of provider details.
 */
import type { ConfigStore } from './config/store'
import type { RecordedAudio } from '@shared/ipc'
import type { CompanionState } from '@shared/state'
import type { Agent } from './brain/agent'
import type { TtsClient } from './tts/types'
import type { SttClient } from './stt/types'
import type { OverlayWindow } from './windows/overlay'
import type { WindowsSystem } from './system/windows'

export interface OrchestratorDeps {
  store: ConfigStore
  overlay: () => OverlayWindow | null
  agent: () => Agent
  tts: () => TtsClient | null
  stt: () => SttClient | null
  system: WindowsSystem
  captureScreen: typeof import('./system/screenshot').captureScreen
}

export interface Orchestrator {
  state(): CompanionState
  /** Hotkey pressed: start listening, or stop listening if already listening, or interrupt if speaking. */
  pushToTalk(): void
  submitAudio(audio: RecordedAudio): Promise<string>
  submitText(text: string): Promise<string>
  interrupt(): void
  playbackFinished(turnId: string): void
  answerConfirm(id: string, approved: boolean): void
  /** Greeting / proactive comment entry point. */
  proactive(instruction: string): Promise<string>
  setMuted(muted: boolean): void
  isMuted(): boolean
  onState(listener: (state: CompanionState) => void): () => void
  dispose(): void
}

export function createOrchestrator(_deps: OrchestratorDeps): Orchestrator {
  throw new Error('not implemented: createOrchestrator (src/main/orchestrator.ts)')
}
