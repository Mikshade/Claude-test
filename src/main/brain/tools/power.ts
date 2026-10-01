/**
 * Power tools: lock the workstation, sleep/hibernate/shutdown/restart. All destructive.
 */
import { z } from 'zod'
import { requireSystem } from './apps'
import { type AnyFlowyTool, defineTool, ok } from './gating'
import type { ToolServices } from './registry'

export const POWER_ACTIONS = ['sleep', 'hibernate', 'shutdown', 'restart'] as const
export type PowerAction = (typeof POWER_ACTIONS)[number]

export const POWER_LABELS: Record<PowerAction, string> = {
  sleep: 'Energie sparen',
  hibernate: 'Ruhezustand',
  shutdown: 'Herunterfahren',
  restart: 'Neustart',
}

export function powerTools(services: ToolServices): AnyFlowyTool[] {
  const lock = defineTool({
    name: 'lock_screen',
    category: 'power',
    destructive: true,
    readOnly: false,
    description: 'Lock the Windows session (like Win+L). The user has to log in again.',
    inputSchema: z.object({}),
    summarize: () => 'Bildschirm sperren',
    confirmation: () => ({ title: 'Bildschirm sperren?', detail: 'Die Sitzung wird gesperrt.' }),
    async execute() {
      await requireSystem(services).lockWorkstation()
      return ok('Bildschirm gesperrt.')
    },
  })

  const power = defineTool({
    name: 'power_action',
    category: 'power',
    destructive: true,
    readOnly: false,
    description:
      'Sleep, hibernate, shut down or restart the PC. Always the right tool for these – never use shutdown/Stop-Computer ' +
      'through run_powershell. Unsaved work in open apps may be lost on shutdown/restart; say so before using it.',
    inputSchema: z.object({ action: z.enum(POWER_ACTIONS).describe('sleep | hibernate | shutdown | restart') }),
    summarize: (input) => `Energie: ${POWER_LABELS[input.action]}`,
    confirmation: (input) => ({
      title: `${POWER_LABELS[input.action]}?`,
      detail:
        input.action === 'shutdown' || input.action === 'restart'
          ? `Der PC wird ${input.action === 'shutdown' ? 'heruntergefahren' : 'neu gestartet'} – ungespeicherte Arbeit geht verloren.`
          : `Der PC wechselt in: ${POWER_LABELS[input.action]}.`,
    }),
    async execute(input) {
      await requireSystem(services).power(input.action)
      return ok(`${POWER_LABELS[input.action]} ausgelöst.`)
    },
  })

  return [lock, power]
}
