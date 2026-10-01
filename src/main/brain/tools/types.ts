/**
 * Tool contract for the brain. Each tool is a zod-validated function the LLM can call.
 */
import type { z } from 'zod'
import type { FlowyConfig, PermissionsConfig } from '@shared/config'
import type { ConfirmRequest } from '@shared/state'

export type ToolCategory = 'shell' | 'files' | 'screen' | 'web' | 'input' | 'power' | 'apps' | 'memory' | 'system' | 'misc'

/** Content a tool can return: plain text, or text + images (e.g. a screenshot). */
export type ToolContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; base64: string }>

export interface ToolResult {
  content: ToolContent
  isError?: boolean
}

export interface ToolContext {
  config: FlowyConfig
  signal: AbortSignal
  /** Ask the user to approve a destructive action (resolves false on timeout / cancel). */
  confirm(request: Omit<ConfirmRequest, 'id'>): Promise<boolean>
  /** Emit a short human-readable progress note (shown as "🛠 ..." in the bubble). */
  progress(summary: string): void
}

export interface ToolDefinition<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  category: ToolCategory
  /** Destructive tools go through `ctx.confirm` when permissions.level === 'confirm-destructive'. */
  destructive: boolean
  /** Read-only tools stay available at permissions.level === 'read-only'. */
  readOnly: boolean
  inputSchema: Schema
  execute(input: z.infer<Schema>, ctx: ToolContext): Promise<ToolResult>
  /** One-line summary for the UI, e.g. 'Running: Get-Process'. */
  summarize?(input: z.infer<Schema>): string
}

export type AnyTool = ToolDefinition<z.ZodTypeAny>

/** Decide whether a tool is available under the given permissions. */
export function isToolAllowed(tool: AnyTool, p: PermissionsConfig): boolean {
  if (p.level === 'read-only' && !tool.readOnly) return false
  switch (tool.category) {
    case 'shell':
      return p.allowShell
    case 'files':
      return p.allowFiles
    case 'screen':
      return p.allowScreenshots
    case 'web':
      return p.allowWeb
    case 'input':
      return p.allowInput
    case 'power':
      return p.allowPower
    default:
      return true
  }
}
