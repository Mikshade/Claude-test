/**
 * Tool registry: builds the list of tools available for a given config. The agent converts them to
 * Anthropic tool definitions (JSON schema generated from zod) and validates inputs before `execute`.
 *
 * OWNER: tools agent. Implementations live in sibling files (shell.ts, files.ts, screen.ts, web.ts,
 * apps.ts, input.ts, power.ts, memory.ts, system.ts, misc.ts); gating.ts wraps every tool with the
 * permission checks and error capture.
 *
 * Invariant: the tool factories only *capture* `services` – they never dereference it while building
 * definitions, so `TOOL_NAMES` can be computed without live services.
 */
import type { FlowyConfig } from '@shared/config'
import type { NotesStore } from '../../memory/notes'
import type { PowerShellHost } from '../../system/powershell'
import type { WindowsSystem } from '../../system/windows'
import { appTools } from './apps'
import { fileTools } from './files'
import { type AnyFlowyTool, wrapTool } from './gating'
import { inputTools } from './input'
import { memoryTools } from './memory'
import { disposeReminders, miscTools } from './misc'
import { powerTools } from './power'
import { screenTools } from './screen'
import { shellTools } from './shell'
import { systemTools } from './system'
import { type AnyTool, isToolAllowed } from './types'
import { webTools } from './web'

export interface ToolServices {
  /** Shared PowerShell host (see src/main/system/powershell.ts). */
  powershell: PowerShellHost
  /** Screenshot capture (see src/main/system/screenshot.ts); the whole module satisfies this. */
  screenshot: { captureScreen: typeof import('../../system/screenshot').captureScreen }
  /** Long-term memory notes. */
  notes: NotesStore
  /**
   * Window/app/volume/input/power control (see src/main/system/windows.ts). Optional only so that the
   * bootstrap keeps compiling; without it the apps/input/system/power tools answer with a readable error.
   */
  system?: WindowsSystem
  /** Called when a reminder set with `set_reminder` is due (the orchestrator should start a proactive turn). */
  onReminder?: (message: string) => void
  /** Platform override for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** fetch override for the web tools; defaults to Electron `net.fetch`, then the global fetch. */
  fetch?: typeof fetch
}

/** Every tool definition (unwrapped), in module order. */
export function rawTools(services: ToolServices): AnyFlowyTool[] {
  return [
    ...shellTools(services),
    ...fileTools(services),
    ...appTools(services),
    ...screenTools(services),
    ...systemTools(services),
    ...powerTools(services),
    ...inputTools(services),
    ...webTools(services),
    ...memoryTools(services),
    ...miscTools(services),
  ]
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** All tools that exist, regardless of permissions – wrapped with gating, sorted by name. */
export function allTools(services: ToolServices): AnyTool[] {
  return rawTools(services).map(wrapTool).sort(byName)
}

/** Tools filtered by the current permissions (category flags; non-readOnly tools vanish at 'read-only'). */
export function availableTools(services: ToolServices, config: FlowyConfig): AnyTool[] {
  return allTools(services).filter((tool) => isToolAllowed(tool, config.permissions))
}

/** Cancels pending reminders etc. Call on app quit. */
export function disposeTools(services: ToolServices): void {
  disposeReminders(services)
}

/** Placeholder used only to enumerate names (factories never touch services while defining tools). */
const PLACEHOLDER_SERVICES = {
  powershell: null as unknown as PowerShellHost,
  screenshot: null as unknown as ToolServices['screenshot'],
  notes: null as unknown as NotesStore,
} satisfies ToolServices

/** Names of every tool, sorted (for the system prompt / docs). */
export const TOOL_NAMES: readonly string[] = Object.freeze(
  rawTools(PLACEHOLDER_SERVICES)
    .map((tool) => tool.name)
    .sort(),
)
