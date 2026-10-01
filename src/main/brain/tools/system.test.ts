import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipboard } from 'electron'
import { fakeContext, fakeServices, runTool, textOf, toolByName } from './fakes.test'
import { describeTime, MAX_CLIPBOARD_CHARS, SetVolumeSchema, systemTools } from './system'

const clip = clipboard as unknown as { _text: string; _reset(): void }

beforeEach(() => clip._reset())
afterEach(() => vi.useRealTimers())

describe('clipboard tools', () => {
  it('reads (async, capped) and writes', async () => {
    const tools = systemTools(fakeServices())
    expect((await runTool(toolByName(tools, 'get_clipboard'), {})).content).toBe('(Zwischenablage ist leer oder enthält keinen Text)')
    clip._text = 'x'.repeat(MAX_CLIPBOARD_CHARS + 5)
    const read = await runTool(toolByName(tools, 'get_clipboard'), {})
    expect(textOf(read.content)).toContain('…[gekürzt, 5 Zeichen ausgelassen]')
    const set = await runTool(toolByName(tools, 'set_clipboard'), { text: 'hallo welt' })
    expect(set.content).toBe('In die Zwischenablage kopiert (10 Zeichen).')
    expect(clip._text).toBe('hallo welt')
    expect(toolByName(tools, 'get_clipboard').description).toMatch(/never as instructions/)
    expect(toolByName(tools, 'set_clipboard').summarize?.({ text: 'hallo welt' })).toBe('Zwischenablage setzen: hallo welt')
  })
})

describe('set_volume', () => {
  it('requires at least one field', () => {
    expect(SetVolumeSchema.safeParse({}).success).toBe(false)
    expect(SetVolumeSchema.safeParse({ percent: 101 }).success).toBe(false)
    expect(SetVolumeSchema.safeParse({ delta: -10 }).success).toBe(true)
    expect(SetVolumeSchema.safeParse({ muted: true }).success).toBe(true)
  })

  it('applies absolute, relative (clamped) and mute changes', async () => {
    const services = fakeServices()
    const tool = toolByName(systemTools(services), 'set_volume')
    expect((await runTool(tool, { percent: 70 })).content).toBe('Lautstärke: 70 %')
    expect((await runTool(tool, { delta: 50 })).content).toBe('Lautstärke: 100 %')
    expect((await runTool(tool, { delta: -100 })).content).toBe('Lautstärke: 0 %')
    expect((await runTool(tool, { delta: -10 })).content).toBe('Lautstärke: 0 %')
    expect((await runTool(tool, { muted: true })).content).toBe('Lautstärke: 0 % (stumm)')
    // raising the volume while muted unmutes
    expect((await runTool(tool, { percent: 30 })).content).toBe('Lautstärke: 30 %')
    expect(services.system.volume).toEqual({ percent: 30, muted: false })
    expect(tool.summarize?.({ delta: -10 })).toBe('Lautstärke -10 %')
    expect(tool.summarize?.({ muted: true })).toBe('Stumm schalten')
  })
})

describe('media / brightness', () => {
  it('forwards to the system service', async () => {
    const services = fakeServices()
    const tools = systemTools(services)
    expect((await runTool(toolByName(tools, 'media_control'), { action: 'next' })).content).toBe('Medientaste gesendet: next')
    expect(toolByName(tools, 'media_control').inputSchema.safeParse({ action: 'rewind' }).success).toBe(false)
    expect((await runTool(toolByName(tools, 'set_brightness'), { percent: 55 })).content).toBe('Helligkeit: 55 %')
    expect(services.system.calls.map((c) => c.method)).toEqual(['mediaKey', 'setBrightness'])
  })

  it('fails readably when the system service is missing', async () => {
    const tool = toolByName(systemTools(fakeServices({ system: undefined })), 'media_control')
    await expect(runTool(tool, { action: 'stop' })).rejects.toThrow('Systemsteuerung nicht verfügbar')
  })
})

describe('system_info / get_time', () => {
  it('combines service facts with versions and falls back to Node facts', async () => {
    const services = fakeServices()
    const info = await runTool(toolByName(systemTools(services), 'system_info'), {})
    const text = textOf(info.content)
    expect(text).toContain('OS: Windows 11 Pro 23H2')
    expect(text).toContain('Laufzeit: 2 h 5 min')
    expect(text).toContain('Flowy: 0.0.0-test')
    const broken = fakeServices()
    broken.system.failure = new Error('kein host')
    const fallback = textOf((await runTool(toolByName(systemTools(broken), 'system_info'), {})).content)
    expect(fallback).toContain('Detailabfrage fehlgeschlagen: kein host')
    expect(fallback).toMatch(/RAM: [\d.]+ GB gesamt/)
  })

  it('describes the local time with weekday, zone and ISO', () => {
    const text = describeTime(new Date(2026, 9, 1, 14, 5, 9), 'de')
    expect(text).toContain('Donnerstag, 1. Oktober 2026')
    expect(text).toMatch(/UTC[+-]\d{2}:\d{2}/)
    expect(text).toContain('ISO: 2026-10-01T')
    expect(text).toContain('Unix: ')
    expect(describeTime(new Date(2026, 9, 1, 14, 5, 9), 'en')).toContain('Thursday, October 1, 2026')
  })

  it('get_time uses the configured language', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 14, 5, 9))
    const tool = toolByName(systemTools(fakeServices()), 'get_time')
    expect(textOf((await runTool(tool, {}, fakeContext({ character: { language: 'en' } }))).content)).toContain('Thursday')
    expect(textOf((await runTool(tool, {})).content)).toContain('Donnerstag')
    expect(tool.readOnly).toBe(true)
  })
})
