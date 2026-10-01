/**
 * Permission gating + shared helpers for tool definitions.
 *
 * `wrapTool()` turns a `FlowyTool` into the `AnyTool` the agent executes:
 *  - permissions.level 'read-only'   → non-readOnly tools are refused (and never offered, see registry.ts)
 *  - 'confirm-destructive'           → destructive tools ask the user through ctx.confirm()
 *  - 'full'                          → no prompt, EXCEPT catastrophic shell scripts (see `isCatastrophic`)
 *  - every thrown error becomes `{ isError: true, content: '<readable German message>' }`.
 *
 * The catastrophic-pattern list is a guardrail against obvious disasters, not a security boundary:
 * deny-list heuristics are bypassable by obfuscation, so they only ever *escalate* to a confirmation.
 */
import type { z } from 'zod'
import type { PermissionLevel } from '@shared/config'
import { createLogger } from '../../log'
import { type AnyTool, isToolAllowed, type ToolContent, type ToolDefinition, type ToolResult } from './types'

const log = createLogger('tools')

export const DENIED_MESSAGE = 'Vom Nutzer abgelehnt.'

export interface ConfirmText {
  title: string
  detail: string
  preview?: string
}

/** A tool definition with optional hooks the gating layer uses. */
export interface FlowyTool<S extends z.ZodTypeAny = z.ZodTypeAny> extends ToolDefinition<S> {
  /** Text for the confirmation prompt of destructive tools (defaults to name + summary). */
  confirmation?(input: z.infer<S>): ConfirmText
  /** Shell-like tools: the script that is checked against the catastrophic patterns. */
  scriptOf?(input: z.infer<S>): string
}

export type AnyFlowyTool = FlowyTool<z.ZodTypeAny>

/** Identity helper that keeps zod inference for `execute`/`summarize` inputs. */
export function defineTool<S extends z.ZodTypeAny>(tool: FlowyTool<S>): FlowyTool<S> {
  return tool
}

// ---------------------------------------------------------------------------------------------
// Result helpers

export function ok(content: ToolContent): ToolResult {
  return { content }
}

export function fail(message: string): ToolResult {
  return { isError: true, content: message }
}

/** Human-readable (German) message for any thrown value; Node fs errors get their path. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code?: unknown }).code ?? '')
    const target = String((err as { path?: unknown }).path ?? (err as { dest?: unknown }).dest ?? '')
    const where = target ? `: ${target}` : ''
    switch (code) {
      case 'ENOENT':
        return `Datei oder Ordner nicht gefunden${where}`
      case 'EACCES':
      case 'EPERM':
        return `Zugriff verweigert${where}`
      case 'EEXIST':
        return `Existiert bereits${where}`
      case 'EISDIR':
        return `Ist ein Ordner, keine Datei${where}`
      case 'ENOTDIR':
        return `Ist kein Ordner${where}`
      case 'ENOTEMPTY':
        return `Ordner ist nicht leer${where}`
      case 'EBUSY':
        return `Datei wird gerade verwendet${where}`
      case 'EMFILE':
      case 'ENFILE':
        return 'Zu viele offene Dateien'
      case 'ABORT_ERR':
        return 'Abgebrochen'
      default:
        break
    }
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'Abgebrochen'
    if (err.name === 'TimeoutError') return 'Zeitüberschreitung'
    return err.message || err.name
  }
  return String(err)
}

/** Cap a text at `max` characters with a tail marker. */
export function truncateText(text: string, max: number, what = 'Zeichen'): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[gekürzt, ${text.length - max} ${what} ausgelassen]`
}

/** One-line excerpt for UI summaries. */
export function shorten(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/** Windows check with a test seam (`services.platform`); Windows-only tools degrade with a readable error elsewhere. */
export function isWindows(services: { platform?: NodeJS.Platform }): boolean {
  return (services.platform ?? process.platform) === 'win32'
}

export const NOT_WINDOWS_MESSAGE = 'Nur unter Windows verfügbar.'

// ---------------------------------------------------------------------------------------------
// Catastrophic shell patterns

export const CATASTROPHIC_GUARD_DESCRIPTION =
  'Guardrail: a few catastrophic patterns (formatting disks/diskpart, recursive deletion of a drive root, ' +
  'the Windows/Program Files directory or the user profile, deleting HKLM registry keys, shutdown/restart ' +
  'commands – use the power_action tool instead –, cipher /w, bcdedit, deleting shadow copies) always ask the user ' +
  'for confirmation, even at the "full" permission level.'

const DELETE_VERB = /(^|[\s;|&({])(remove-item|ri|rm|rmdir|rd|del|erase)(?=\s|$)/
const RECURSE_FLAG = /(^|\s)(-r(ec[a-z]*|f)?|-fr|\/s)(:\$true)?(?=\s|$)/
/** Whole-token catastrophic delete targets (drive roots, system/program dirs, profile roots). */
const ROOT_TARGET = new RegExp(
  '(^|[\\s"\'(,=])(' +
    [
      '[a-z]:[\\\\/]?(\\*)?', // c:  c:\  c:\*
      '[\\\\/](\\*)?', // \  \*
      '[a-z]:[\\\\/]windows([\\\\/]system32)?([\\\\/]\\*?)?', // c:\windows  c:\windows\*  c:\windows\system32\*
      '[a-z]:[\\\\/]program files( \\(x86\\))?([\\\\/]\\*?)?',
      '[a-z]:[\\\\/]users([\\\\/]\\*?)?',
      '\\$env:(systemroot|windir|systemdrive|programfiles|programfiles\\(x86\\)|userprofile|homepath)([\\\\/]\\*?)?',
      '\\$home([\\\\/]\\*?)?',
      '~([\\\\/]\\*?)?',
    ].join('|') +
    ')(?=$|[\\s"\'),;|])',
)

const ALWAYS_CATASTROPHIC: RegExp[] = [
  /(^|[\s;|&({])(format-volume|clear-disk|initialize-disk|remove-partition)(?=\s|$)/,
  /(^|[\s;|&({])format(\.com|\.exe)?\s+[a-z]:/,
  /(^|[\s;|&({])diskpart(\.exe)?(?=\s|$)/,
  /(^|[\s;|&({])bcdedit(\.exe)?(?=\s|$)/,
  /(^|[\s;|&({])cipher(\.exe)?\s+\/w/,
  /(^|[\s;|&({])(stop-computer|restart-computer)(?=\s|$)/,
  /(^|[\s;|&({])shutdown(\.exe)?\s+[-/][srhpfig]/,
  /(^|[\s;|&({])reg(\.exe)?\s+delete\s+["']?(hklm|hkey_local_machine)/,
  /(^|[\s;|&({])remove-item(property)?\b[^;\n]*hklm:/,
  /(^|[\s;|&({])vssadmin(\.exe)?\s+delete\s+shadows/,
  /(^|[\s;|&({])wmic(\.exe)?\s+shadowcopy\s+delete/,
]

/**
 * Pure check for scripts that would wreck the machine. Case-insensitive, whitespace-normalized;
 * recursive deletes are evaluated per statement (split on `;`/newlines, pipelines stay together so
 * `Get-ChildItem C:\ -Recurse | Remove-Item` is caught too).
 */
export function isCatastrophic(script: string): boolean {
  const normalized = script.toLowerCase().replace(/[\t\r ]+/g, ' ')
  if (ALWAYS_CATASTROPHIC.some((re) => re.test(normalized))) return true
  for (const raw of normalized.split(/[;\n]|&&/)) {
    const statement = raw.trim()
    if (!statement) continue
    if (DELETE_VERB.test(statement) && RECURSE_FLAG.test(statement) && ROOT_TARGET.test(statement)) return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------
// Gating

function notAllowedMessage(tool: AnyFlowyTool, level: PermissionLevel): string {
  if (level === 'read-only' && !tool.readOnly) return 'Im Nur-Lese-Modus nicht erlaubt.'
  return `Werkzeug "${tool.name}" ist in den Berechtigungen deaktiviert (${tool.category}).`
}

function defaultConfirmation(tool: AnyFlowyTool, input: unknown): ConfirmText {
  let summary = tool.name
  try {
    summary = tool.summarize?.(input) ?? tool.name
  } catch {
    /* keep the name */
  }
  return { title: 'Aktion bestätigen', detail: summary, preview: safePreview(input) }
}

function safePreview(input: unknown): string | undefined {
  try {
    const json = JSON.stringify(input)
    return json && json !== '{}' ? shorten(json, 300) : undefined
  } catch {
    return undefined
  }
}

/** Wrap a tool with permission checks, confirmation prompts and error capture. */
export function wrapTool(tool: AnyFlowyTool): AnyTool {
  const { confirmation: _confirmation, scriptOf: _scriptOf, ...definition } = tool
  return {
    ...definition,
    async execute(input, ctx) {
      try {
        const permissions = ctx.config.permissions
        if (!isToolAllowed(tool, permissions)) return fail(notAllowedMessage(tool, permissions.level))
        const script = tool.scriptOf?.(input)
        const catastrophic = script !== undefined && isCatastrophic(script)
        const needsConfirm = catastrophic || (permissions.level === 'confirm-destructive' && tool.destructive)
        if (needsConfirm) {
          const text = tool.confirmation?.(input) ?? defaultConfirmation(tool, input)
          const request = catastrophic
            ? { ...text, title: 'Gefährlichen Befehl bestätigen', detail: `⚠ Potenziell zerstörerisch: ${text.detail}` }
            : text
          const approved = await ctx.confirm({ ...request, danger: true })
          if (!approved) {
            log.info(`tool ${tool.name} denied by the user`)
            return fail(DENIED_MESSAGE)
          }
        }
        return await tool.execute(input, ctx)
      } catch (err) {
        log.warn(`tool ${tool.name} failed`, err instanceof Error ? err.message : err)
        return fail(errorMessage(err))
      }
    },
  }
}
