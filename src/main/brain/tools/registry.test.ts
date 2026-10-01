import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fakeServices, makeConfig } from './fakes.test'
import { allTools, availableTools, rawTools, TOOL_NAMES } from './registry'

const EXPECTED_NAMES = [
  'append_file',
  'cancel_reminder',
  'click_at',
  'close_window',
  'create_directory',
  'delete_path',
  'file_info',
  'focus_window',
  'forget',
  'get_active_window',
  'get_clipboard',
  'get_time',
  'launch_app',
  'list_directory',
  'list_installed_apps',
  'list_reminders',
  'list_windows',
  'lock_screen',
  'media_control',
  'move_path',
  'notify',
  'open_path',
  'open_url',
  'power_action',
  'press_keys',
  'read_file',
  'recall',
  'remember',
  'run_cmd',
  'run_powershell',
  'search_files',
  'set_brightness',
  'set_clipboard',
  'set_reminder',
  'set_volume',
  'system_info',
  'take_screenshot',
  'type_text',
  'web_fetch',
  'web_search',
  'write_file',
]

describe('registry', () => {
  it('lists every tool exactly once, sorted by name', () => {
    const names = allTools(fakeServices()).map((t) => t.name)
    expect(names).toEqual(EXPECTED_NAMES)
    expect(new Set(names).size).toBe(names.length)
    expect([...TOOL_NAMES]).toEqual(EXPECTED_NAMES)
  })

  it('every tool has a description, an object schema with described fields, and a German summary', () => {
    for (const tool of rawTools(fakeServices())) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40)
      expect(tool.summarize, tool.name).toBeTypeOf('function')
      const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as { type?: string; properties?: Record<string, { description?: string }> }
      expect(schema.type, tool.name).toBe('object')
      for (const [field, def] of Object.entries(schema.properties ?? {})) {
        expect(def.description, `${tool.name}.${field}`).toBeTruthy()
      }
      // read-only tools are never destructive
      if (tool.readOnly) expect(tool.destructive, tool.name).toBe(false)
    }
  })

  it('drops non-readOnly tools at read-only', () => {
    const tools = availableTools(fakeServices(), makeConfig({ permissions: { level: 'read-only' } }))
    expect(tools.every((t) => t.readOnly)).toBe(true)
    const names = tools.map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('get_time')
    expect(names).toContain('take_screenshot')
    expect(names).not.toContain('run_powershell')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('open_url')
    expect(names).not.toContain('set_clipboard')
  })

  it('honours the category flags', () => {
    const names = availableTools(
      fakeServices(),
      makeConfig({ permissions: { allowShell: false, allowFiles: false, allowScreenshots: false, allowWeb: false, allowInput: false, allowPower: false } }),
    ).map((t) => t.name)
    for (const banned of ['run_powershell', 'run_cmd', 'read_file', 'write_file', 'take_screenshot', 'web_fetch', 'web_search', 'type_text', 'press_keys', 'click_at', 'lock_screen', 'power_action']) {
      expect(names).not.toContain(banned)
    }
    for (const kept of ['open_path', 'launch_app', 'get_clipboard', 'set_volume', 'remember', 'notify', 'set_reminder', 'get_active_window']) {
      expect(names).toContain(kept)
    }
  })

  it('keeps everything at full with all flags on', () => {
    expect(availableTools(fakeServices(), makeConfig()).map((t) => t.name)).toEqual(EXPECTED_NAMES)
  })

  it('wrapped tools no longer expose gating hooks', () => {
    for (const tool of allTools(fakeServices())) {
      expect('scriptOf' in tool).toBe(false)
      expect('confirmation' in tool).toBe(false)
    }
  })
})
