/**
 * Shared fakes for the tool tests (vitest picks every *.test.ts up, hence the smoke tests at the end).
 *
 * The fakes implement the system interfaces as of now and are cast through `unknown`, so a new optional
 * diagnostic member on PowerShellHost/WindowsSystem does not break every tool test.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type DeepPartial, type FlowyConfig, mergeConfig } from '@shared/config'
import type { ActiveWindowInfo } from '@shared/state'
import type { Note, NotesStore } from '../../memory/notes'
import type { PowerShellHost, PsResult, PsRunOptions } from '../../system/powershell'
import type { Capture, CaptureOptions } from '../../system/screenshot'
import type { InstalledApp, SystemInfo, WindowInfo, WindowsSystem } from '../../system/windows'
import type { AnyFlowyTool } from './gating'
import type { ToolServices } from './registry'
import type { AnyTool, ToolContext, ToolResult } from './types'

export interface FakePowerShell extends PowerShellHost {
  calls: Array<{ kind: 'run' | 'runRaw'; script: string; options: PsRunOptions | undefined }>
  /** Next results (FIFO); when empty `defaultResult` is returned. */
  queue: Array<Partial<PsResult> | Error>
  defaultResult: PsResult
}

export function fakePowerShell(): FakePowerShell {
  const base: PsResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false, durationMs: 1 }
  const host = {
    calls: [] as FakePowerShell['calls'],
    queue: [] as FakePowerShell['queue'],
    defaultResult: base,
    async run(script: string, options?: PsRunOptions): Promise<PsResult> {
      host.calls.push({ kind: 'run', script, options })
      return next()
    },
    async runRaw(script: string, options?: PsRunOptions): Promise<PsResult> {
      host.calls.push({ kind: 'runRaw', script, options })
      return next()
    },
    executable: () => 'powershell',
    dispose: () => undefined,
    isRunning: () => true,
  }
  function next(): PsResult {
    const item = host.queue.shift()
    if (item instanceof Error) throw item
    return { ...host.defaultResult, ...(item ?? {}) }
  }
  return host as unknown as FakePowerShell
}

export interface FakeNotes extends NotesStore {
  notes: Note[]
}

export function fakeNotes(initial: Note[] = []): FakeNotes {
  let counter = 0
  const store: FakeNotes = {
    notes: [...initial],
    add(text, tags) {
      const note: Note = { id: `n${++counter}`, text: text.trim(), tags: tags ?? [], createdAt: Date.now() }
      store.notes.push(note)
      return note
    },
    remove(id) {
      const index = store.notes.findIndex((n) => n.id === id)
      if (index < 0) return false
      store.notes.splice(index, 1)
      return true
    },
    search(query, limit = 10) {
      const q = query.toLowerCase()
      return store.notes.filter((n) => n.text.toLowerCase().includes(q)).slice(0, limit)
    },
    all: () => [...store.notes],
    digest: () => store.notes.map((n) => `- ${n.text}`).join('\n'),
  }
  return store
}

export interface FakeSystem extends WindowsSystem {
  calls: Array<{ method: keyof WindowsSystem; args: unknown[] }>
  windows: WindowInfo[]
  apps: InstalledApp[]
  active: ActiveWindowInfo | null
  volume: { percent: number; muted: boolean }
  brightness: number | null
  info: SystemInfo
  /** When set, every mutating call rejects with this error (simulates a non-Windows host). */
  failure: Error | null
}

export function fakeSystem(): FakeSystem {
  const record = (method: keyof WindowsSystem, ...args: unknown[]): void => {
    system.calls.push({ method, args })
    if (system.failure) throw system.failure
  }
  const system = {
    calls: [] as FakeSystem['calls'],
    windows: [{ hwnd: 1, title: 'Editor – notes.txt', processName: 'notepad', pid: 100 }] as WindowInfo[],
    apps: [
      { name: 'Spotify', launch: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
      { name: 'Notepad', launch: 'C:\\Windows\\notepad.exe' },
    ] as InstalledApp[],
    active: { title: 'Editor – notes.txt', processName: 'notepad', exePath: 'C:\\Windows\\notepad.exe', pid: 100 } as ActiveWindowInfo | null,
    volume: { percent: 40, muted: false },
    brightness: 70 as number | null,
    info: { os: 'Windows 11 Pro 23H2', hostname: 'PC', user: 'max', cpu: 'Ryzen 7', memoryGb: 32, uptimeMinutes: 125 } as SystemInfo,
    failure: null as Error | null,
    async getActiveWindow() {
      record('getActiveWindow')
      return system.active
    },
    async listWindows() {
      record('listWindows')
      return system.windows
    },
    async focusWindow(query: { hwnd?: number; titleContains?: string; processName?: string }) {
      record('focusWindow', query)
      return system.windows.some((w) => matches(w, query))
    },
    async minimizeWindow(query: { hwnd?: number; titleContains?: string }) {
      record('minimizeWindow', query)
      return true
    },
    async closeWindow(query: { hwnd?: number; titleContains?: string; processName?: string }) {
      record('closeWindow', query)
      return system.windows.some((w) => matches(w, query))
    },
    async listInstalledApps() {
      record('listInstalledApps')
      return system.apps
    },
    async launchApp(nameOrPath: string, args?: string[]) {
      record('launchApp', nameOrPath, args)
      return nameOrPath
    },
    async getVolume() {
      record('getVolume')
      return { ...system.volume }
    },
    async setVolume(percent: number) {
      record('setVolume', percent)
      system.volume.percent = percent
    },
    async setMuted(muted: boolean) {
      record('setMuted', muted)
      system.volume.muted = muted
    },
    async mediaKey(key: 'play-pause' | 'next' | 'previous' | 'stop') {
      record('mediaKey', key)
    },
    async getBrightness() {
      record('getBrightness')
      return system.brightness
    },
    async setBrightness(percent: number) {
      record('setBrightness', percent)
      system.brightness = percent
    },
    async typeText(text: string) {
      record('typeText', text)
    },
    async pressKeys(combo: string) {
      record('pressKeys', combo)
    },
    async clickAt(x: number, y: number, button?: 'left' | 'right' | 'double') {
      record('clickAt', x, y, button)
    },
    async lockWorkstation() {
      record('lockWorkstation')
    },
    async power(action: 'sleep' | 'hibernate' | 'shutdown' | 'restart') {
      record('power', action)
    },
    async isElevated() {
      record('isElevated')
      return false
    },
    async getSystemInfo() {
      record('getSystemInfo')
      return system.info
    },
    async warmup() {
      record('warmup')
    },
  }
  return system as unknown as FakeSystem
}

function matches(w: WindowInfo, query: { hwnd?: number; titleContains?: string; processName?: string }): boolean {
  if (query.hwnd !== undefined) return w.hwnd === query.hwnd
  if (query.titleContains !== undefined) return w.title.toLowerCase().includes(query.titleContains.toLowerCase())
  if (query.processName !== undefined) return w.processName.toLowerCase() === query.processName.toLowerCase()
  return false
}

export interface FakeScreenshot {
  captureScreen(options?: CaptureOptions): Promise<Capture>
  calls: CaptureOptions[]
  failure: Error | null
}

export function fakeScreenshot(): FakeScreenshot {
  const shot: FakeScreenshot = {
    calls: [],
    failure: null,
    async captureScreen(options: CaptureOptions = {}): Promise<Capture> {
      shot.calls.push(options)
      if (shot.failure) throw shot.failure
      return { base64: 'AAAA', mediaType: 'image/jpeg', width: 1280, height: 720, bytes: 1234 }
    },
  }
  return shot
}

export interface FakeServices extends ToolServices {
  powershell: FakePowerShell
  notes: FakeNotes
  system: FakeSystem
  screenshot: FakeScreenshot
  reminders: string[]
}

export function fakeServices(overrides: Partial<FakeServices> = {}): FakeServices {
  const reminders: string[] = []
  return {
    powershell: fakePowerShell(),
    notes: fakeNotes(),
    system: fakeSystem(),
    screenshot: fakeScreenshot(),
    platform: 'win32',
    onReminder: (message) => {
      reminders.push(message)
    },
    reminders,
    ...overrides,
  }
}

export function makeConfig(patch: DeepPartial<FlowyConfig> = {}): FlowyConfig {
  return mergeConfig(structuredClone(DEFAULT_CONFIG), patch)
}

export interface FakeContext extends ToolContext {
  confirm: ReturnType<typeof vi.fn<ToolContext['confirm']>>
  progress: ReturnType<typeof vi.fn<ToolContext['progress']>>
}

export function fakeContext(patch: DeepPartial<FlowyConfig> = {}, options: { approve?: boolean; signal?: AbortSignal } = {}): FakeContext {
  return {
    config: makeConfig(patch),
    signal: options.signal ?? new AbortController().signal,
    confirm: vi.fn<ToolContext['confirm']>(async () => options.approve ?? true),
    progress: vi.fn<ToolContext['progress']>(),
  }
}

export function toolByName<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool
}

/** Validate like the agent does, then execute. Throws on invalid input so tests notice schema drift. */
export async function runTool(tool: AnyFlowyTool | AnyTool, input: unknown, ctx: ToolContext = fakeContext()): Promise<ToolResult> {
  const parsed = tool.inputSchema.safeParse(input)
  if (!parsed.success) throw new Error(`invalid input for ${tool.name}: ${parsed.error.message}`)
  return tool.execute(parsed.data, ctx)
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } => (part as { type?: string }).type === 'text')
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

/** A minimal Response for vi.fn() fetches. */
export function fakeResponse(
  body: string | Uint8Array,
  init: { status?: number; headers?: Record<string, string>; url?: string; statusText?: string } = {},
): Response {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const response = new Response(bytes, {
    status: init.status ?? 200,
    statusText: init.statusText ?? '',
    headers: init.headers ?? { 'content-type': 'text/html; charset=utf-8' },
  })
  if (init.url) Object.defineProperty(response, 'url', { value: init.url })
  return response
}

describe('fakes', () => {
  it('fake PowerShell host records calls and serves queued results', async () => {
    const host = fakePowerShell()
    host.queue.push({ stdout: 'hi', exitCode: 3 }, new Error('boom'))
    await expect(host.run('a')).resolves.toMatchObject({ stdout: 'hi', exitCode: 3, timedOut: false })
    await expect(host.runRaw('b')).rejects.toThrow('boom')
    await expect(host.run('c')).resolves.toMatchObject({ stdout: '', exitCode: 0 })
    expect(host.calls.map((c) => `${c.kind}:${c.script}`)).toEqual(['run:a', 'runRaw:b', 'run:c'])
  })

  it('fake system answers window queries and records mutations', async () => {
    const system = fakeSystem()
    expect(await system.focusWindow({ titleContains: 'notes' })).toBe(true)
    expect(await system.closeWindow({ processName: 'chrome' })).toBe(false)
    await system.setVolume(55)
    expect(system.volume.percent).toBe(55)
    expect(system.calls.map((c) => c.method)).toEqual(['focusWindow', 'closeWindow', 'setVolume'])
  })

  it('fakeContext builds a valid config with patches', () => {
    const ctx = fakeContext({ permissions: { level: 'read-only' } })
    expect(ctx.config.permissions.level).toBe('read-only')
    expect(ctx.config.web.maxPageChars).toBe(DEFAULT_CONFIG.web.maxPageChars)
  })
})
