/**
 * The brain: an Anthropic Messages API streaming loop with tool use.
 *
 * OWNER: brain agent. Must follow the `claude-api` skill (typescript/claude-api/tool-use.md
 * "Streaming Manual Loop"): client.messages.stream(), finalMessage(), tool_result blocks for ALL
 * tool_use blocks in ONE user message, is_error on failures, stop on refusal/max_tokens, append
 * response.content verbatim to history (keeps thinking blocks), prompt caching on system + tools.
 */
import type { FlowyConfig } from '@shared/config'
import type { Emotion } from '@shared/state'
import type { ConversationHistory } from './history'
import type { AnyTool, ToolContext } from './tools/types'

export interface TurnInput {
  turnId: string
  /** What the user said/typed (already transcribed). */
  text: string
  /** Optional screenshot (JPEG/PNG) to attach for screen awareness. */
  screenshot?: { mediaType: 'image/png' | 'image/jpeg'; base64: string }
  /** Volatile context appended to the user message (time, active window, ...). Never in the system prompt. */
  context?: Record<string, string>
  source: 'voice' | 'text' | 'proactive'
}

export interface AgentCallbacks {
  /** Streamed assistant text (may contain [[emotion]] markers). */
  onText(delta: string): void
  onToolCall(name: string, summary: string): void
  onToolResult(name: string, ok: boolean): void
  onEmotion?(emotion: Emotion): void
}

export interface AgentResult {
  /** Full assistant text of the final message (markers included). */
  text: string
  stopReason: string
  aborted: boolean
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

export interface AgentOptions {
  config: FlowyConfig
  history: ConversationHistory
  tools: AnyTool[]
  /** Builds a ToolContext for a run (confirm/progress wiring is the orchestrator's job). */
  toolContextFactory(signal: AbortSignal, callbacks: AgentCallbacks): ToolContext
  /** Stable system prompt (built by shared/personality.ts). */
  systemPrompt: string
  /** Test seam: build the Anthropic client (defaults to `new Anthropic({ apiKey })`). */
  createClient?: (apiKey: string) => import('@anthropic-ai/sdk').default
}

export interface Agent {
  run(input: TurnInput, callbacks: AgentCallbacks, signal: AbortSignal): Promise<AgentResult>
  /** Cheap connectivity/auth check used by the settings page. */
  test(): Promise<{ ok: boolean; message: string }>
  /** Swap config/tools/system prompt without losing history. */
  update(options: Partial<Omit<AgentOptions, 'history'>>): void
}

export function createAgent(_options: AgentOptions): Agent {
  throw new Error('not implemented: createAgent (src/main/brain/agent.ts)')
}
