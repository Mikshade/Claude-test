/**
 * Tool registry: builds the list of tools available for a given config and converts them to
 * Anthropic tool definitions (JSON schema generated from zod).
 *
 * OWNER: tools agent. Implementations live in sibling files (shell.ts, files.ts, screen.ts, web.ts,
 * apps.ts, input.ts, power.ts, memory.ts, system.ts).
 */
import type { FlowyConfig } from '@shared/config'
import type { AnyTool } from './types'

export interface ToolServices {
  /** Shared PowerShell host (see src/main/system/powershell.ts). */
  powershell: import('../../system/powershell').PowerShellHost
  /** Screenshot capture (see src/main/system/screenshot.ts). */
  screenshot: typeof import('../../system/screenshot')
  /** Long-term memory notes. */
  notes: import('../../memory/notes').NotesStore
}

/** All tools that exist, regardless of permissions. */
export function allTools(_services: ToolServices): AnyTool[] {
  throw new Error('not implemented: allTools (src/main/brain/tools/registry.ts)')
}

/** Tools filtered by the current permissions. */
export function availableTools(services: ToolServices, config: FlowyConfig): AnyTool[] {
  const { isToolAllowed } = require('./types') as typeof import('./types')
  return allTools(services).filter((t) => isToolAllowed(t, config.permissions))
}
