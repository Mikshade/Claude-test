/**
 * Misc tools: desktop notifications and in-process reminders (set/list/cancel).
 *
 * Reminders live per ToolServices instance (WeakMap) so they survive agent rebuilds; `disposeReminders`
 * cancels them on quit. A due reminder calls `services.onReminder(message)` (the orchestrator starts a
 * proactive turn); without a handler a desktop notification is shown instead.
 */
import { Notification } from 'electron'
import { z } from 'zod'
import { shortId } from '@shared/text'
import { createLogger } from '../../log'
import { type AnyFlowyTool, defineTool, fail, ok, shorten } from './gating'
import type { ToolServices } from './registry'

const log = createLogger('tools:misc')

export const MAX_REMINDER_MS = 24 * 60 * 60 * 1000
export const MAX_REMINDERS = 50

export interface Reminder {
  id: string
  message: string
  dueAt: number
  createdAt: number
}

interface ActiveReminder extends Reminder {
  timer: ReturnType<typeof setTimeout>
}

const stores = new WeakMap<object, Map<string, ActiveReminder>>()

function storeFor(services: ToolServices): Map<string, ActiveReminder> {
  let store = stores.get(services)
  if (!store) {
    store = new Map()
    stores.set(services, store)
  }
  return store
}

/** Pending reminders (sorted by due time) – exported for the orchestrator/tray if ever needed. */
export function pendingReminders(services: ToolServices): Reminder[] {
  return [...storeFor(services).values()]
    .map(({ timer: _timer, ...rest }) => rest)
    .sort((a, b) => a.dueAt - b.dueAt)
}

export function disposeReminders(services: ToolServices): void {
  const store = stores.get(services)
  if (!store) return
  for (const reminder of store.values()) clearTimeout(reminder.timer)
  store.clear()
}

export type ReminderTime = { ok: true; dueAt: number } | { ok: false; error: string }

/**
 * Resolve `minutes` (relative) or `at` (ISO date-time, or "HH:MM" today/tomorrow) into a due timestamp.
 * Pure; capped at 24 h.
 */
export function resolveReminderTime(input: { minutes?: number; at?: string }, now: Date): ReminderTime {
  const base = now.getTime()
  let dueAt: number
  if (input.minutes !== undefined) {
    if (!Number.isFinite(input.minutes) || input.minutes <= 0) return { ok: false, error: 'minutes muss größer als 0 sein.' }
    dueAt = base + Math.round(input.minutes * 60_000)
  } else if (input.at !== undefined) {
    const at = input.at.trim()
    const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(at)
    if (clock) {
      const hours = Number(clock[1])
      const minutes = Number(clock[2])
      const seconds = Number(clock[3] ?? '0')
      if (hours > 23 || minutes > 59 || seconds > 59) return { ok: false, error: `Ungültige Uhrzeit: ${at}` }
      const candidate = new Date(now)
      candidate.setHours(hours, minutes, seconds, 0)
      if (candidate.getTime() <= base) candidate.setDate(candidate.getDate() + 1)
      dueAt = candidate.getTime()
    } else {
      const parsed = new Date(at)
      if (Number.isNaN(parsed.getTime())) return { ok: false, error: `Ungültiger Zeitpunkt: ${at} (ISO 8601 oder HH:MM erwartet).` }
      dueAt = parsed.getTime()
    }
  } else return { ok: false, error: 'minutes oder at angeben.' }
  if (dueAt <= base) return { ok: false, error: 'Der Zeitpunkt liegt in der Vergangenheit.' }
  if (dueAt - base > MAX_REMINDER_MS) return { ok: false, error: 'Erinnerungen sind auf 24 Stunden begrenzt.' }
  return { ok: true, dueAt }
}

export function describeDelay(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'unter einer Minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

function formatDue(dueAt: number): string {
  const d = new Date(dueAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface NotificationCtor {
  isSupported?: () => boolean
  new (options: { title: string; body: string }): { show(): void }
}

export function showNotification(title: string, body: string): boolean {
  try {
    const ctor = Notification as unknown as NotificationCtor
    if (typeof ctor.isSupported === 'function' && !ctor.isSupported()) return false
    new ctor({ title, body }).show()
    return true
  } catch (err) {
    log.warn('notification failed', err instanceof Error ? err.message : err)
    return false
  }
}

export function miscTools(services: ToolServices): AnyFlowyTool[] {
  const notify = defineTool({
    name: 'notify',
    category: 'misc',
    destructive: false,
    readOnly: false,
    description:
      'Show a Windows desktop notification (toast) with a title and body. For things the user should notice even when ' +
      'not looking at you.',
    inputSchema: z.object({
      title: z.string().trim().min(1).max(100).describe('Short title.'),
      body: z.string().trim().min(1).max(500).describe('Message text.'),
    }),
    summarize: (input) => `Benachrichtigung: ${shorten(input.title, 40)}`,
    async execute(input) {
      return showNotification(input.title, input.body)
        ? ok(`Benachrichtigung gezeigt: ${input.title}`)
        : fail('Benachrichtigungen sind auf diesem System nicht verfügbar.')
    },
  })

  const setReminder = defineTool({
    name: 'set_reminder',
    category: 'misc',
    destructive: false,
    readOnly: false,
    description:
      'Set a one-shot reminder: after `minutes` or at a time (`at`: ISO 8601 like "2026-10-01T15:30" or "15:30" for today/tomorrow) ' +
      'you will be woken up with the message and tell the user. Maximum 24 hours ahead; reminders do not survive an app restart.',
    inputSchema: z
      .object({
        minutes: z.number().positive().max(24 * 60).optional().describe('Delay in minutes (fractions allowed).'),
        at: z.string().trim().min(1).optional().describe('Absolute time: ISO 8601 or "HH:MM" (local time).'),
        message: z.string().trim().min(1).max(500).describe('What to remind the user of, in their words.'),
      })
      .refine((v) => (v.minutes !== undefined) !== (v.at !== undefined), { message: 'Entweder minutes oder at angeben (nicht beides).' }),
    summarize: (input) =>
      input.minutes !== undefined
        ? `Erinnerung in ${describeDelay(input.minutes * 60_000)}: ${shorten(input.message, 40)}`
        : `Erinnerung um ${input.at ?? '?'}: ${shorten(input.message, 40)}`,
    async execute(input) {
      const store = storeFor(services)
      if (store.size >= MAX_REMINDERS) return fail(`Zu viele Erinnerungen (max. ${MAX_REMINDERS}).`)
      const now = new Date()
      const resolved = resolveReminderTime(input, now)
      if (!resolved.ok) return fail(resolved.error)
      const id = shortId('r')
      const delay = resolved.dueAt - now.getTime()
      const timer = setTimeout(() => {
        store.delete(id)
        log.info(`reminder ${id} due: ${input.message}`)
        if (services.onReminder) {
          try {
            services.onReminder(input.message)
          } catch (err) {
            log.error('onReminder handler failed', err)
          }
        } else showNotification('Erinnerung', input.message)
      }, delay)
      timer.unref?.()
      store.set(id, { id, message: input.message, dueAt: resolved.dueAt, createdAt: now.getTime(), timer })
      return ok(`Erinnerung ${id} gesetzt für ${formatDue(resolved.dueAt)} (in ${describeDelay(delay)}): ${input.message}`)
    },
  })

  const listReminders = defineTool({
    name: 'list_reminders',
    category: 'misc',
    destructive: false,
    readOnly: true,
    description: 'List pending reminders with id, due time and message.',
    inputSchema: z.object({}),
    summarize: () => 'Erinnerungen auflisten',
    async execute() {
      const pending = pendingReminders(services)
      if (pending.length === 0) return ok('Keine Erinnerungen gesetzt.')
      const now = Date.now()
      return ok(pending.map((r) => `${r.id} – ${formatDue(r.dueAt)} (in ${describeDelay(r.dueAt - now)}): ${r.message}`).join('\n'))
    },
  })

  const cancelReminder = defineTool({
    name: 'cancel_reminder',
    category: 'misc',
    destructive: false,
    readOnly: false,
    description: 'Cancel a pending reminder by id (see list_reminders).',
    inputSchema: z.object({ id: z.string().trim().min(1).describe('Reminder id.') }),
    summarize: (input) => `Erinnerung abbrechen: ${input.id}`,
    async execute(input) {
      const store = storeFor(services)
      const reminder = store.get(input.id)
      if (!reminder) return fail(`Keine Erinnerung mit der id ${input.id}.`)
      clearTimeout(reminder.timer)
      store.delete(input.id)
      return ok(`Erinnerung ${input.id} abgebrochen: ${reminder.message}`)
    },
  })

  return [notify, setReminder, listReminders, cancelReminder]
}
