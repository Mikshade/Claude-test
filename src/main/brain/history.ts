/**
 * Conversation history persisted to disk, with safe trimming.
 *
 * OWNER: brain agent. Rules:
 *  - store Anthropic MessageParam objects verbatim (assistant content arrays incl. thinking blocks)
 *  - trimming must never split a tool_use / tool_result pair and must keep the first message a 'user'
 *  - `view()` returns a flattened text view for the chat UI
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatMessageView } from '@shared/ipc'

export interface ConversationHistory {
  messages(): Anthropic.MessageParam[]
  append(message: Anthropic.MessageParam): void
  /** Keep at most `maxTurns` user turns (older ones are dropped or summarized). */
  trim(maxTurns: number): void
  /** Replace everything older than the last `keepTurns` turns with a summary text (as a user+assistant pair). */
  compact(summary: string, keepTurns: number): void
  clear(): void
  view(limit?: number): ChatMessageView[]
  /** Flush to disk. */
  save(): void
}

export function createHistory(_filePath: string): ConversationHistory {
  throw new Error('not implemented: createHistory (src/main/brain/history.ts)')
}
