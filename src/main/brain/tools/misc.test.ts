import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Notification } from 'electron'
import { fakeServices, runTool, textOf, toolByName } from './fakes.test'
import { describeDelay, disposeReminders, MAX_REMINDER_MS, miscTools, pendingReminders, resolveReminderTime } from './misc'

const notification = Notification as unknown as { _shown: Array<Record<string, unknown>>; _reset(): void }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 1, 14, 0, 0))
  notification._reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveReminderTime', () => {
  const now = new Date(2026, 9, 1, 14, 0, 0)

  it('handles minutes, ISO and HH:MM (today or tomorrow)', () => {
    expect(resolveReminderTime({ minutes: 15 }, now)).toEqual({ ok: true, dueAt: now.getTime() + 15 * 60_000 })
    expect(resolveReminderTime({ minutes: 0.5 }, now)).toEqual({ ok: true, dueAt: now.getTime() + 30_000 })
    expect(resolveReminderTime({ at: '2026-10-01T15:30' }, now)).toEqual({ ok: true, dueAt: new Date(2026, 9, 1, 15, 30).getTime() })
    expect(resolveReminderTime({ at: '15:30' }, now)).toEqual({ ok: true, dueAt: new Date(2026, 9, 1, 15, 30).getTime() })
    expect(resolveReminderTime({ at: '09:00' }, now)).toEqual({ ok: true, dueAt: new Date(2026, 9, 2, 9, 0).getTime() })
  })

  it('rejects the past, more than 24 h and garbage', () => {
    expect(resolveReminderTime({ at: '2026-10-01T13:00' }, now)).toMatchObject({ ok: false, error: expect.stringContaining('Vergangenheit') })
    expect(resolveReminderTime({ minutes: 25 * 60 }, now)).toMatchObject({ ok: false, error: expect.stringContaining('24 Stunden') })
    expect(resolveReminderTime({ at: 'morgen irgendwann' }, now)).toMatchObject({ ok: false })
    expect(resolveReminderTime({ at: '25:99' }, now)).toMatchObject({ ok: false })
    expect(resolveReminderTime({ minutes: -1 }, now)).toMatchObject({ ok: false })
    expect(resolveReminderTime({}, now)).toMatchObject({ ok: false })
    expect(MAX_REMINDER_MS).toBe(86_400_000)
  })

  it('describes delays', () => {
    expect(describeDelay(20_000)).toBe('unter einer Minute')
    expect(describeDelay(5 * 60_000)).toBe('5 min')
    expect(describeDelay(125 * 60_000)).toBe('2 h 5 min')
    expect(describeDelay(120 * 60_000)).toBe('2 h')
  })
})

describe('reminder tools', () => {
  it('fires onReminder after the delay and keeps a list until then', async () => {
    const services = fakeServices()
    const tools = miscTools(services)
    const set = await runTool(toolByName(tools, 'set_reminder'), { minutes: 10, message: 'Tee abgießen' })
    expect(set.isError).toBeUndefined()
    expect(set.content).toMatch(/^Erinnerung r\w+ gesetzt für 01\.10\. 14:10 \(in 10 min\): Tee abgießen$/)
    const id = pendingReminders(services)[0]!.id
    const list = await runTool(toolByName(tools, 'list_reminders'), {})
    expect(textOf(list.content)).toContain(`${id} – 01.10. 14:10 (in 10 min): Tee abgießen`)
    vi.advanceTimersByTime(9 * 60_000)
    expect(services.reminders).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(services.reminders).toEqual(['Tee abgießen'])
    expect(pendingReminders(services)).toEqual([])
    expect(textOf((await runTool(toolByName(tools, 'list_reminders'), {})).content)).toBe('Keine Erinnerungen gesetzt.')
  })

  it('shows a notification when no handler is wired', async () => {
    const services = fakeServices({ onReminder: undefined })
    await runTool(toolByName(miscTools(services), 'set_reminder'), { at: '14:01', message: 'Hallo' })
    vi.advanceTimersByTime(61_000)
    expect(notification._shown).toEqual([{ title: 'Erinnerung', body: 'Hallo' }])
  })

  it('cancels reminders and survives tool rebuilds', async () => {
    const services = fakeServices()
    await runTool(toolByName(miscTools(services), 'set_reminder'), { minutes: 5, message: 'A' })
    const id = pendingReminders(services)[0]!.id
    const rebuilt = miscTools(services) // a new agent build sees the same reminders
    expect(textOf((await runTool(toolByName(rebuilt, 'list_reminders'), {})).content)).toContain('A')
    const cancelled = await runTool(toolByName(rebuilt, 'cancel_reminder'), { id })
    expect(cancelled.content).toBe(`Erinnerung ${id} abgebrochen: A`)
    expect((await runTool(toolByName(rebuilt, 'cancel_reminder'), { id })).isError).toBe(true)
    vi.advanceTimersByTime(10 * 60_000)
    expect(services.reminders).toEqual([])
  })

  it('validates the schema (exactly one of minutes/at) and caps 24 h', async () => {
    const tool = toolByName(miscTools(fakeServices()), 'set_reminder')
    expect(tool.inputSchema.safeParse({ message: 'x' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ minutes: 1, at: '10:00', message: 'x' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ minutes: 1, message: '' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ minutes: 2000, message: 'x' }).success).toBe(false)
    const past = await runTool(tool, { at: '2020-01-01T00:00', message: 'x' })
    expect(past.isError).toBe(true)
    expect(tool.summarize?.({ minutes: 90, message: 'Meeting' })).toBe('Erinnerung in 1 h 30 min: Meeting')
    expect(tool.summarize?.({ at: '15:00', message: 'Meeting' })).toBe('Erinnerung um 15:00: Meeting')
  })

  it('disposeReminders clears every timer', async () => {
    const services = fakeServices()
    const tools = miscTools(services)
    await runTool(toolByName(tools, 'set_reminder'), { minutes: 1, message: 'A' })
    await runTool(toolByName(tools, 'set_reminder'), { minutes: 2, message: 'B' })
    expect(pendingReminders(services)).toHaveLength(2)
    disposeReminders(services)
    expect(pendingReminders(services)).toEqual([])
    vi.advanceTimersByTime(5 * 60_000)
    expect(services.reminders).toEqual([])
  })
})

describe('notify', () => {
  it('shows a toast through Electron Notification', async () => {
    const tool = toolByName(miscTools(fakeServices()), 'notify')
    const result = await runTool(tool, { title: 'Hi', body: 'Da bin ich' })
    expect(result.content).toBe('Benachrichtigung gezeigt: Hi')
    expect(notification._shown).toEqual([{ title: 'Hi', body: 'Da bin ich' }])
    expect(tool.inputSchema.safeParse({ title: '', body: 'x' }).success).toBe(false)
    expect(tool.summarize?.({ title: 'Hi', body: 'x' })).toBe('Benachrichtigung: Hi')
    expect(tool.category).toBe('misc')
  })
})
