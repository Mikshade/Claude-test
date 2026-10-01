import { describe, expect, it } from 'vitest'
import { fakeContext, fakeServices, runTool, textOf, toolByName } from './fakes.test'
import { inputTools } from './input'
import { formatNote, memoryTools } from './memory'
import { POWER_LABELS, powerTools } from './power'
import { screenTools } from './screen'

describe('input tools', () => {
  it('are destructive input-category tools that forward to the system service', async () => {
    const services = fakeServices()
    const tools = inputTools(services)
    for (const tool of tools) {
      expect(tool.category).toBe('input')
      expect(tool.destructive).toBe(true)
      expect(tool.readOnly).toBe(false)
    }
    expect((await runTool(toolByName(tools, 'type_text'), { text: 'Hallo\n' })).content).toBe('Getippt: 6 Zeichen.')
    expect((await runTool(toolByName(tools, 'press_keys'), { combo: ' Ctrl+S ' })).content).toBe('Gedrückt:  Ctrl+S ')
    expect((await runTool(toolByName(tools, 'click_at'), { x: 10, y: 20 })).content).toBe('Geklickt (left) bei (10, 20).')
    expect((await runTool(toolByName(tools, 'click_at'), { x: 1, y: 2, button: 'double' })).content).toBe('Geklickt (double) bei (1, 2).')
    expect(services.system.calls).toEqual([
      { method: 'typeText', args: ['Hallo\n'] },
      { method: 'pressKeys', args: ['Ctrl+S'] },
      { method: 'clickAt', args: [10, 20, 'left'] },
      { method: 'clickAt', args: [1, 2, 'double'] },
    ])
  })

  it('validates inputs and has German summaries', () => {
    const tools = inputTools(fakeServices())
    expect(toolByName(tools, 'type_text').inputSchema.safeParse({ text: '' }).success).toBe(false)
    expect(toolByName(tools, 'click_at').inputSchema.safeParse({ x: 1.5, y: 2 }).success).toBe(false)
    expect(toolByName(tools, 'click_at').inputSchema.safeParse({ x: 1, y: 2, button: 'middle' }).success).toBe(false)
    expect(toolByName(tools, 'press_keys').summarize?.({ combo: 'Alt+F4' })).toBe('Tastenkombination: Alt+F4')
    expect(toolByName(tools, 'click_at').summarize?.({ x: 5, y: 6, button: 'right' })).toBe('Rechtsklick bei (5, 6)')
    expect(toolByName(tools, 'type_text').summarize?.({ text: 'Lorem ipsum' })).toBe('Tippe Text: Lorem ipsum')
  })
})

describe('power tools', () => {
  it('lock and power actions are destructive power-category tools with strong confirmations', async () => {
    const services = fakeServices()
    const tools = powerTools(services)
    expect(tools.map((t) => `${t.name}:${t.category}:${t.destructive}`)).toEqual(['lock_screen:power:true', 'power_action:power:true'])
    expect((await runTool(toolByName(tools, 'lock_screen'), {})).content).toBe('Bildschirm gesperrt.')
    expect((await runTool(toolByName(tools, 'power_action'), { action: 'shutdown' })).content).toBe('Herunterfahren ausgelöst.')
    expect(services.system.calls).toEqual([{ method: 'lockWorkstation', args: [] }, { method: 'power', args: ['shutdown'] }])
    const power = toolByName(tools, 'power_action')
    expect(power.inputSchema.safeParse({ action: 'logoff' }).success).toBe(false)
    expect(power.confirmation?.({ action: 'restart' })).toEqual({ title: 'Neustart?', detail: 'Der PC wird neu gestartet – ungespeicherte Arbeit geht verloren.' })
    expect(power.confirmation?.({ action: 'sleep' })?.detail).toContain(POWER_LABELS.sleep)
    expect(power.summarize?.({ action: 'hibernate' })).toBe('Energie: Ruhezustand')
    expect(power.description).toContain('run_powershell')
  })
})

describe('take_screenshot', () => {
  it('returns an image block plus a text block using the config defaults', async () => {
    const services = fakeServices()
    const tool = toolByName(screenTools(services), 'take_screenshot')
    expect(tool.category).toBe('screen')
    expect(tool.readOnly).toBe(true)
    const ctx = fakeContext({ screenAwareness: { maxLongEdge: 1024, jpegQuality: 55 } })
    const result = await runTool(tool, {}, ctx)
    expect(result.content).toEqual([
      { type: 'image', mediaType: 'image/jpeg', base64: 'AAAA' },
      { type: 'text', text: 'Screenshot 1280×720 (1 KB)' },
    ])
    expect(services.screenshot.calls[0]).toEqual({ display: 'primary', maxLongEdge: 1024, format: 'jpeg', jpegQuality: 55 })
    await runTool(tool, { display: 2, maxLongEdge: 640 }, ctx)
    expect(services.screenshot.calls[1]).toMatchObject({ display: 2, maxLongEdge: 640 })
    expect(tool.inputSchema.safeParse({ display: 'secondary' }).success).toBe(false)
    expect(tool.summarize?.({ display: 'primary' })).toBe('Screenshot aufnehmen')
    services.screenshot.failure = new Error('Bildschirmaufnahme fehlgeschlagen')
    await expect(runTool(tool, {}, ctx)).rejects.toThrow('Bildschirmaufnahme fehlgeschlagen')
  })
})

describe('memory tools', () => {
  it('remembers, recalls and forgets through the notes store', async () => {
    const services = fakeServices()
    const tools = memoryTools(services)
    const remembered = await runTool(toolByName(tools, 'remember'), { text: '  Max trinkt Kaffee schwarz ', tags: ['essen'] })
    expect(remembered.content).toBe('Gemerkt (n1): Max trinkt Kaffee schwarz')
    expect(services.notes.notes[0]).toMatchObject({ text: 'Max trinkt Kaffee schwarz', tags: ['essen'] })
    const found = textOf((await runTool(toolByName(tools, 'recall'), { query: 'kaffee' })).content)
    expect(found).toMatch(/^1 Notiz\(en\):\nn1 \(\d{4}-\d{2}-\d{2}\) \[essen\]: Max trinkt Kaffee schwarz$/)
    expect((await runTool(toolByName(tools, 'recall'), { query: 'tee' })).content).toBe('Keine Notizen zu "tee".')
    expect((await runTool(toolByName(tools, 'forget'), { id: 'n1' })).content).toBe('Notiz n1 gelöscht.')
    expect((await runTool(toolByName(tools, 'forget'), { id: 'n1' })).isError).toBe(true)
  })

  it('validates inputs', () => {
    const tools = memoryTools(fakeServices())
    expect(toolByName(tools, 'remember').inputSchema.safeParse({ text: '   ' }).success).toBe(false)
    expect(toolByName(tools, 'remember').inputSchema.safeParse({ text: 'x', tags: [''] }).success).toBe(false)
    expect(toolByName(tools, 'recall').inputSchema.safeParse({ query: 'x', limit: 0 }).success).toBe(false)
    expect(toolByName(tools, 'recall').inputSchema.safeParse({ query: 'x' }).data).toEqual({ query: 'x', limit: 10 })
    expect(toolByName(tools, 'remember').summarize?.({ text: 'Der User mag Katzen' })).toBe('Merke: Der User mag Katzen')
    expect(formatNote({ id: 'n9', text: 't', tags: [], createdAt: 0 })).toBe('n9 (?): t')
  })
})
