/**
 * Speech bubble / chat UI next to the character.
 *
 * OWNER: renderer-ui agent. The overlay's main.ts (renderer-core agent) wires this controller:
 * it forwards push events (turn:*, confirm:request, state:changed) and positions the bubble next to
 * the character via setAnchor(). The bubble is the ONLY interactive DOM in the overlay: while it is
 * interactive (chat input open, confirm pending, hovering a button) `onInteractiveChange(true)` must
 * be emitted so main disables click-through; emit false again when it closes.
 */
import type { Language } from '@shared/config'
import type { CompanionState, ConfirmRequest, Rect } from '@shared/state'

export interface BubbleOptions {
  root: HTMLElement
  language: Language
  fontSize: number
  /** The user typed a message and pressed Enter. */
  onSubmitText(text: string): void
  /** The user clicked the stop button / pressed Escape while speaking. */
  onInterrupt(): void
  /** Bubble wants (or no longer needs) real mouse/keyboard input. */
  onInteractiveChange(interactive: boolean): void
  /** Chat input opened/closed – main must focus/blur the overlay window accordingly. */
  onInputFocusChange(focused: boolean): void
}

export interface BubbleController {
  /** Reposition next to the character (window coords). Picks the side with the most free space. */
  setAnchor(characterRect: Rect, workArea: Rect): void
  setState(state: CompanionState): void
  /** Show "listening…" with a level meter (0..1 via setInputLevel). */
  showListening(): void
  setInputLevel(level: number): void
  showUserText(text: string): void
  /** Start a streaming assistant message for a turn. */
  startAssistant(turnId: string): void
  appendAssistant(turnId: string, delta: string): void
  /** Replace the assistant text with the final (marker-stripped) text. */
  finishAssistant(turnId: string, finalText: string): void
  /** Subtitle sync: highlight/show the sentence currently being spoken. */
  showSpokenSentence(turnId: string, text: string): void
  showToolProgress(summary: string): void
  showError(message: string): void
  /** Ask the user; resolves with the answer (false on dismiss/timeout). */
  confirm(request: ConfirmRequest): Promise<boolean>
  /** Resolve a pending confirm from the outside (e.g. main timed out). */
  resolveConfirm(id: string): void
  openChatInput(prefill?: string): void
  closeChatInput(): void
  isChatInputOpen(): boolean
  /** True while the bubble needs real mouse input. */
  isInteractive(): boolean
  /** Hide after a delay (ms) unless new content arrives; 0 = now. */
  hide(delayMs?: number): void
  setFontSize(px: number): void
  setLanguage(language: Language): void
  dispose(): void
}

export function createBubble(_options: BubbleOptions): BubbleController {
  throw new Error('not implemented: createBubble (src/renderer/overlay/bubble.ts)')
}
