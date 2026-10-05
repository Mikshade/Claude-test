import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type DeepPartial, type FlowyConfig, mergeConfig, parseConfig } from '@shared/config'
import type { PushChannel } from '@shared/ipc'
import type { SpeechChunk } from '@shared/state'
import type { Agent, AgentCallbacks, AgentResult, TurnInput } from './brain/agent'
import type { ConfigStore } from './config/store'
import type { NotesStore } from './memory/notes'
import {
  canSeeScreen,
  createOrchestrator,
  inQuietHours,
  LISTENING_GRACE_MS,
  type Orchestrator,
  type OrchestratorDeps,
  PLAYBACK_TIMEOUT_MIN_MS,
  playbackTimeoutMs,
  wantsScreenshot,
} from './orchestrator'
import type { SttClient } from './stt/types'
import type { TtsClient } from './tts/types'
import type { WindowsSystem } from './system/windows'
import type { OverlayWindow } from './windows/overlay'

type Sent = { channel: PushChannel; payload: unknown }

function fakeStore(patch: DeepPartial<FlowyConfig> = {}): ConfigStore {
  let config = parseConfig(mergeConfig(DEFAULT_CONFIG, { setupCompleted: true, ...patch }))
  const listeners = new Set<(c: FlowyConfig, p: FlowyConfig) => void>()
  return {
    get: () => structuredClone(config),
    patch: (p: DeepPartial<FlowyConfig>) => {
      const prev = config
      config = parseConfig(mergeConfig(config, p))
      for (const l of listeners) l(config, prev)
      return config
    },
    onChange: (l: (c: FlowyConfig, p: FlowyConfig) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  } as unknown as ConfigStore
}

function fakeOverlay(sent: Sent[], visible: { value: boolean } = { value: true }): OverlayWindow {
  return {
    send: (channel: PushChannel, payload: unknown) => sent.push({ channel, payload }),
    isVisible: () => visible.value,
  } as unknown as OverlayWindow
}

interface AgentScript {
  deltas: string[]
  stopReason?: string
  aborted?: boolean
  throws?: string
  /** Delay between deltas in ms (fake timers). */
  delayMs?: number
}

function fakeAgent(script: AgentScript, calls: TurnInput[] = []): Agent {
  return {
    async run(input: TurnInput, callbacks: AgentCallbacks, signal: AbortSignal): Promise<AgentResult> {
      calls.push(input)
      if (script.throws) throw new Error(script.throws)
      let text = ''
      for (const delta of script.deltas) {
        if (signal.aborted) return { text, stopReason: 'aborted', aborted: true, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
        if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs))
        if (signal.aborted) return { text, stopReason: 'aborted', aborted: true, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
        text += delta
        callbacks.onText(delta)
      }
      return {
        text,
        stopReason: script.stopReason ?? 'end_turn',
        aborted: script.aborted ?? false,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      }
    },
    test: async () => ({ ok: true, message: 'ok' }),
    update: () => undefined,
  }
}

function fakeTts(): TtsClient & { calls: string[] } {
  const calls: string[] = []
  return {
    name: 'fake',
    calls,
    async synthesize(text) {
      calls.push(text)
      await new Promise((r) => setTimeout(r, 5))
      return { data: new TextEncoder().encode(text).buffer as ArrayBuffer, format: 'wav' }
    },
    test: async () => ({ ok: true, message: 'ok' }),
  }
}

function fakeStt(text: string | Error): SttClient {
  return {
    name: 'fake-stt',
    async transcribe() {
      if (text instanceof Error) throw text
      return text
    },
    test: async () => ({ ok: true, message: 'ok' }),
  }
}

const system = {
  getActiveWindow: async () => ({ title: 'Editor – main.ts', processName: 'Code', exePath: '', pid: 1 }),
} as unknown as WindowsSystem

const notes = { digest: () => '- mag Katzen' } as unknown as NotesStore

function setup(opts: {
  agent?: Agent
  tts?: TtsClient | null
  stt?: SttClient | null
  config?: DeepPartial<FlowyConfig>
  capture?: OrchestratorDeps['captureScreen']
} = {}) {
  const sent: Sent[] = []
  const visible = { value: true }
  const store = fakeStore(opts.config)
  const deps: OrchestratorDeps = {
    store,
    overlay: () => fakeOverlay(sent, visible),
    agent: () => opts.agent ?? fakeAgent({ deltas: ['Hallo, schön dich zu sehen! ', 'Wie geht es dir heute?'] }),
    tts: () => (opts.tts === undefined ? fakeTts() : opts.tts),
    stt: () => (opts.stt === undefined ? fakeStt('Wie spät ist es?') : opts.stt),
    system,
    notes,
    captureScreen:
      opts.capture ??
      (async () => ({ base64: 'AAAA', mediaType: 'image/jpeg' as const, width: 10, height: 10, bytes: 3 })),
  }
  const orchestrator = createOrchestrator(deps)
  const states: string[] = []
  orchestrator.onState((s) => states.push(s))
  return { orchestrator, sent, states, store, visible }
}

function channels(sent: Sent[]): string[] {
  return sent.map((s) => s.channel)
}

async function settle(ms = 50): Promise<void> {
  for (let i = 0; i < ms; i++) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1)
  }
}

describe('orchestrator', () => {
  let orchestrator: Orchestrator | null = null
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    orchestrator?.dispose()
    orchestrator = null
    vi.useRealTimers()
  })

  it('runs a text turn: user text, deltas, ordered speech chunks, then idle after playback', async () => {
    const s = setup()
    orchestrator = s.orchestrator
    const turnPromise = orchestrator.submitText('Hallo')
    await settle(100)
    const chunks = s.sent.filter((x) => x.channel === 'speech:chunk').map((x) => x.payload as SpeechChunk)
    expect(chunks.map((c) => c.text)).toEqual(['Hallo, schön dich zu sehen!', 'Wie geht es dir heute?'])
    expect(chunks.map((c) => c.seq)).toEqual([0, 1])
    expect(chunks[1]!.last).toBe(true)
    expect(channels(s.sent)).toContain('turn:userText')
    expect(channels(s.sent)).toContain('turn:assistantDelta')
    expect(s.sent.find((x) => x.channel === 'turn:assistantDone')?.payload).toMatchObject({
      text: 'Hallo, schön dich zu sehen! Wie geht es dir heute?',
    })
    expect(orchestrator.state()).toBe('speaking')
    const turnId = chunks[0]!.turnId
    orchestrator.playbackFinished(turnId)
    await settle(5)
    expect(await turnPromise).toBe(turnId)
    expect(orchestrator.state()).toBe('idle')
    expect(s.states).toEqual(['thinking', 'speaking', 'idle'])
  })

  it('attaches context (time, active window, memory) and a screenshot in always mode', async () => {
    const calls: TurnInput[] = []
    const agent = fakeAgent({ deltas: ['Ok.'] }, calls)
    const s = setup({ agent, config: { screenAwareness: { mode: 'always' } } })
    orchestrator = s.orchestrator
    void orchestrator.submitText('Was siehst du?')
    await settle(60)
    expect(calls).toHaveLength(1)
    const input = calls[0]!
    expect(input.source).toBe('text')
    expect(input.screenshot?.base64).toBe('AAAA')
    expect(input.context?.['active_window']).toContain('Editor')
    expect(input.context?.['memory']).toContain('Katzen')
    expect(input.context?.['time']).toBeTruthy()
  })

  it('on-demand mode only captures for screen questions; off never does', async () => {
    const calls: TurnInput[] = []
    const capture = vi.fn(async () => ({ base64: 'B', mediaType: 'image/jpeg' as const, width: 1, height: 1, bytes: 1 }))
    const s = setup({ agent: fakeAgent({ deltas: ['Ok.'] }, calls), capture, config: { screenAwareness: { mode: 'on-demand' } } })
    orchestrator = s.orchestrator
    void orchestrator.submitText('Wie spät ist es?')
    await settle(60)
    expect(capture).not.toHaveBeenCalled()
    orchestrator.interrupt()
    void orchestrator.submitText('Was steht auf dem Bildschirm?')
    await settle(60)
    expect(capture).toHaveBeenCalledTimes(1)
    orchestrator.interrupt()

    const s2 = setup({ agent: fakeAgent({ deltas: ['Ok.'] }), capture, config: { screenAwareness: { mode: 'off' } } })
    void s2.orchestrator.submitText('Was steht auf dem Bildschirm?')
    await settle(60)
    expect(capture).toHaveBeenCalledTimes(1)
    s2.orchestrator.dispose()
  })

  it('interrupt aborts the agent and the pipeline and pushes speech:stop', async () => {
    const s = setup({ agent: fakeAgent({ deltas: ['Eins. ', 'Zwei. ', 'Drei. '], delayMs: 20 }) })
    orchestrator = s.orchestrator
    const p = orchestrator.submitText('Zähle')
    await settle(30)
    expect(orchestrator.state()).toBe('thinking')
    orchestrator.interrupt()
    expect(orchestrator.state()).toBe('idle')
    expect(channels(s.sent)).toContain('speech:stop')
    await settle(100)
    await p
    const chunksAfterStop = s.sent.slice(s.sent.findIndex((x) => x.channel === 'speech:stop')).filter((x) => x.channel === 'speech:chunk')
    expect(chunksAfterStop).toHaveLength(0)
  })

  it('push-to-talk toggles listening and a new press while speaking interrupts and listens again', async () => {
    const s = setup()
    orchestrator = s.orchestrator
    orchestrator.pushToTalk()
    expect(orchestrator.state()).toBe('listening')
    expect(channels(s.sent)).toContain('ptt:start')
    orchestrator.pushToTalk()
    expect(channels(s.sent)).toContain('ptt:stop')
    expect(orchestrator.state()).toBe('listening')
    // Nothing arrives → falls back to idle.
    await vi.advanceTimersByTimeAsync(9_000)
    expect(orchestrator.state()).toBe('idle')

    void orchestrator.submitText('Hallo')
    await settle(60)
    expect(orchestrator.state()).toBe('speaking')
    orchestrator.pushToTalk()
    expect(orchestrator.state()).toBe('listening')
    expect(channels(s.sent).filter((c) => c === 'speech:stop')).toHaveLength(1)
  })

  it('voice turn: transcribes, then runs the brain with the transcript; empty transcript goes back to idle', async () => {
    const calls: TurnInput[] = []
    const s = setup({ agent: fakeAgent({ deltas: ['Es ist spät.'] }, calls) })
    orchestrator = s.orchestrator
    orchestrator.pushToTalk()
    const turnId = (s.sent.find((x) => x.channel === 'ptt:start')?.payload as { turnId: string }).turnId
    const audio = { data: new ArrayBuffer(10), mimeType: 'audio/wav' as const, durationMs: 1000 }
    const p = orchestrator.submitAudio(audio)
    await settle(60)
    expect(calls[0]?.text).toBe('Wie spät ist es?')
    expect(calls[0]?.source).toBe('voice')
    expect(calls[0]?.turnId).toBe(turnId)
    expect(s.states.slice(0, 3)).toEqual(['listening', 'transcribing', 'thinking'])
    expect(orchestrator.state()).toBe('speaking')
    orchestrator.playbackFinished(turnId)
    expect(await p).toBe(turnId)
    expect(orchestrator.state()).toBe('idle')

    const s2 = setup({ stt: fakeStt('   ') })
    s2.orchestrator.pushToTalk()
    await s2.orchestrator.submitAudio(audio)
    expect(s2.orchestrator.state()).toBe('idle')
    expect(s2.sent.find((x) => x.channel === 'turn:error')?.payload).toMatchObject({ stage: 'stt' })
    s2.orchestrator.dispose()
  })

  it('reports STT failures and a missing STT client', async () => {
    const s = setup({ stt: fakeStt(new Error('Fish Audio API-Key ungültig')) })
    orchestrator = s.orchestrator
    await orchestrator.submitAudio({ data: new ArrayBuffer(2), mimeType: 'audio/wav', durationMs: 500 })
    expect(s.sent.find((x) => x.channel === 'turn:error')?.payload).toMatchObject({ stage: 'stt', message: 'Fish Audio API-Key ungültig' })
    expect(orchestrator.state()).toBe('idle')

    const s2 = setup({ stt: null })
    await s2.orchestrator.submitAudio({ data: new ArrayBuffer(2), mimeType: 'audio/wav', durationMs: 500 })
    expect(s2.sent.find((x) => x.channel === 'turn:error')?.payload).toMatchObject({ stage: 'stt' })
    s2.orchestrator.dispose()
  })

  it('brain errors are reported and the state recovers to idle', async () => {
    const s = setup({ agent: fakeAgent({ deltas: [], throws: 'API-Key ungültig' }) })
    orchestrator = s.orchestrator
    await orchestrator.submitText('Hi')
    await settle(5)
    expect(s.sent.find((x) => x.channel === 'turn:error')?.payload).toMatchObject({ stage: 'llm', message: 'API-Key ungültig' })
    expect(orchestrator.state()).toBe('error')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(orchestrator.state()).toBe('idle')
  })

  it('without TTS (or muted) the turn ends after the text', async () => {
    const s = setup({ tts: null })
    orchestrator = s.orchestrator
    await orchestrator.submitText('Hi')
    await settle(10)
    expect(channels(s.sent)).not.toContain('speech:chunk')
    expect(orchestrator.state()).toBe('idle')

    const s2 = setup()
    s2.orchestrator.setMuted(true)
    await s2.orchestrator.submitText('Hi')
    await settle(10)
    expect(channels(s2.sent)).not.toContain('speech:chunk')
    expect(s2.orchestrator.state()).toBe('idle')
    s2.orchestrator.dispose()
  })

  it('speaks a short decline on refusal', async () => {
    const s = setup({ agent: fakeAgent({ deltas: [], stopReason: 'refusal' }) })
    orchestrator = s.orchestrator
    void orchestrator.submitText('…')
    await settle(60)
    const chunks = s.sent.filter((x) => x.channel === 'speech:chunk').map((x) => x.payload as SpeechChunk)
    expect(chunks[0]?.text).toContain('nicht helfen')
    expect(chunks[0]?.emotion).toBe('shy')
  })

  it('proactive turns are skipped while busy and stay silent on the silence marker', async () => {
    const calls: TurnInput[] = []
    const s = setup({ agent: fakeAgent({ deltas: ['[[silence]]'] }, calls) })
    orchestrator = s.orchestrator
    const id = await orchestrator.proactive('greeting')
    await settle(20)
    expect(id).not.toBe('')
    expect(calls[0]?.source).toBe('proactive')
    expect(calls[0]?.screenshot).toBeTruthy() // proactive always looks at the screen when allowed
    expect(channels(s.sent)).not.toContain('turn:userText')
    expect(channels(s.sent)).not.toContain('speech:chunk')
    expect(orchestrator.state()).toBe('idle')

    orchestrator.pushToTalk()
    expect(await orchestrator.proactive('greeting')).toBe('')
  })

  it('confirm resolves with the answer, or false after the timeout', async () => {
    const s = setup()
    orchestrator = s.orchestrator
    const p1 = orchestrator.confirm({ title: 'Löschen?', detail: 'x', danger: true })
    const req = s.sent.find((x) => x.channel === 'confirm:request')?.payload as { id: string }
    expect(req.id).toBeTruthy()
    orchestrator.answerConfirm(req.id, true)
    expect(await p1).toBe(true)
    expect(channels(s.sent)).toContain('confirm:resolved')

    const p2 = orchestrator.confirm({ title: 'Nochmal?', detail: 'y', danger: false })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await p2).toBe(false)
  })

  it('periodic proactive comments respect quiet hours and idle time', async () => {
    const calls: TurnInput[] = []
    const s = setup({
      agent: fakeAgent({ deltas: ['[[silence]]'] }, calls),
      config: { behavior: { proactive: { enabled: true, intervalMinutes: 2, quietHoursStart: 0, quietHoursEnd: 0 } } },
    })
    orchestrator = s.orchestrator
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 10)
    await settle(20)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toContain('[[silence]]')
  })

  it('periodic proactive comments are skipped when she cannot see the screen', async () => {
    const calls: TurnInput[] = []
    const s = setup({
      agent: fakeAgent({ deltas: ['[[silence]]'] }, calls),
      config: {
        screenAwareness: { mode: 'off' },
        behavior: { proactive: { enabled: true, intervalMinutes: 2, quietHoursStart: 0, quietHoursEnd: 0 } },
      },
    })
    orchestrator = s.orchestrator
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 10)
    await settle(20)
    expect(calls).toHaveLength(0)
  })

  it('an empty recording (null) only ends the listening state', async () => {
    const s = setup()
    orchestrator = s.orchestrator
    orchestrator.pushToTalk()
    expect(orchestrator.state()).toBe('listening')
    expect(await orchestrator.submitAudio(null)).toBe('')
    expect(orchestrator.state()).toBe('idle')
    expect(channels(s.sent)).not.toContain('turn:error')
    // a second press starts a fresh recording instead of "stopping" a stale one
    orchestrator.pushToTalk()
    expect(channels(s.sent).filter((c) => c === 'ptt:start')).toHaveLength(2)
    orchestrator.interrupt()
    // null while idle is a harmless no-op
    expect(await orchestrator.submitAudio(null)).toBe('')
    expect(orchestrator.state()).toBe('idle')
  })

  it('interrupt during transcription aborts the STT request, returns to idle and starts no brain turn', async () => {
    let aborted = false
    const slowStt: SttClient = {
      name: 'slow-stt',
      transcribe: (_audio, _language, signal) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve('zu spät'), 1_000)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            aborted = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        }),
      test: async () => ({ ok: true, message: 'ok' }),
    }
    const calls: TurnInput[] = []
    const s = setup({ stt: slowStt, agent: fakeAgent({ deltas: ['x'] }, calls) })
    orchestrator = s.orchestrator
    orchestrator.pushToTalk()
    const p = orchestrator.submitAudio({ data: new ArrayBuffer(2), mimeType: 'audio/wav', durationMs: 500 })
    await settle(5)
    expect(orchestrator.state()).toBe('transcribing')
    orchestrator.interrupt()
    expect(orchestrator.state()).toBe('idle')
    await p
    await settle(5)
    expect(aborted).toBe(true)
    expect(calls).toHaveLength(0)
    expect(channels(s.sent)).not.toContain('turn:error')
  })

  it('never attaches a screenshot when screen awareness is off – not even for proactive turns', async () => {
    const calls: TurnInput[] = []
    const s = setup({ tts: null, agent: fakeAgent({ deltas: ['Hi!'] }, calls), config: { screenAwareness: { mode: 'off' } } })
    orchestrator = s.orchestrator
    await orchestrator.proactive('greeting')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.screenshot).toBeUndefined()
    expect(calls[0]?.context?.['screenshot']).toBeUndefined()

    const off = s.store.get()
    expect(canSeeScreen(off)).toBe(false)
    expect(wantsScreenshot(off, 'Was siehst du auf dem Bildschirm?', 'text')).toBe(false)
    const onDemand = parseConfig(mergeConfig(DEFAULT_CONFIG, { screenAwareness: { mode: 'on-demand' } }))
    expect(wantsScreenshot(onDemand, 'Was siehst du?', 'text')).toBe(true)
    expect(wantsScreenshot(onDemand, 'Erzähl einen Witz', 'voice')).toBe(false)
    // greeting / reminders never look at the screen in on-demand mode; the periodic glance asks explicitly
    expect(wantsScreenshot(onDemand, 'Was siehst du?', 'proactive')).toBe(false)
    expect(wantsScreenshot(onDemand, 'x', 'proactive', true)).toBe(true)
    const noPermission = parseConfig(mergeConfig(DEFAULT_CONFIG, { permissions: { allowScreenshots: false } }))
    expect(wantsScreenshot(noPermission, 'Was siehst du?', 'text')).toBe(false)
  })
})

describe('orchestrator review fixes', () => {
  let orchestrator: Orchestrator | null = null
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    orchestrator?.dispose()
    orchestrator = null
    vi.useRealTimers()
  })

  it('PIPE-1: a new turn waits until the interrupted run finished writing its history', async () => {
    const events: string[] = []
    let runs = 0
    const agent: Agent = {
      async run(input, callbacks, signal) {
        const n = ++runs
        events.push(`start:${n}`)
        callbacks.onText('Moment. ')
        // The interrupted run keeps going for a while after the abort (late history appends).
        await new Promise<void>((resolve) => {
          const done = (): void => {
            setTimeout(() => {
              events.push(`end:${n}`)
              resolve()
            }, 40)
          }
          if (signal.aborted) done()
          else signal.addEventListener('abort', done)
          if (n > 1) setTimeout(done, 1)
        })
        return { text: input.text, stopReason: 'end_turn', aborted: signal.aborted, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
      },
      test: async () => ({ ok: true, message: 'ok' }),
      update: () => undefined,
    }
    const s = setup({ agent, tts: null, config: { screenAwareness: { mode: 'off', includeActiveWindow: false } } })
    orchestrator = s.orchestrator
    void orchestrator.submitText('erste Frage')
    await settle(5)
    void orchestrator.submitText('zweite Frage')
    await settle(120)
    expect(events.indexOf('start:2')).toBeGreaterThan(events.indexOf('end:1'))
  })

  it('PIPE-2: interrupt denies an open confirm prompt and closes it in the renderer', async () => {
    const s = setup()
    orchestrator = s.orchestrator
    const answer = orchestrator.confirm({ title: 'Ordner löschen?', detail: 'C:\\Projekt', danger: true })
    const req = s.sent.find((x) => x.channel === 'confirm:request')?.payload as { id: string }
    orchestrator.interrupt()
    expect(await answer).toBe(false)
    expect(s.sent.find((x) => x.channel === 'confirm:resolved')?.payload).toEqual({ id: req.id })
    // a late "Ja" from the stale panel is ignored
    orchestrator.answerConfirm(req.id, true)
    expect(await answer).toBe(false)
  })

  it('PIPE-3: in on-demand mode the greeting and reminders carry no screenshot', async () => {
    const calls: TurnInput[] = []
    const capture = vi.fn(async () => ({ base64: 'B', mediaType: 'image/jpeg' as const, width: 1, height: 1, bytes: 1 }))
    const s = setup({ agent: fakeAgent({ deltas: ['Hi!'] }, calls), tts: null, capture, config: { screenAwareness: { mode: 'on-demand' } } })
    orchestrator = s.orchestrator
    await orchestrator.proactive('greeting')
    await orchestrator.proactive('Eine Erinnerung ist fällig: "Tee". Was siehst du?')
    expect(calls).toHaveLength(2)
    expect(capture).not.toHaveBeenCalled()
    await orchestrator.proactive('glance', { screen: true })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('PIPE-4: no proactive turn while she is hidden', async () => {
    const calls: TurnInput[] = []
    const s = setup({
      agent: fakeAgent({ deltas: ['Hi!'] }, calls),
      config: { behavior: { proactive: { enabled: true, intervalMinutes: 2, quietHoursStart: 0, quietHoursEnd: 0 } } },
    })
    orchestrator = s.orchestrator
    s.visible.value = false
    expect(await orchestrator.proactive('greeting')).toBe('')
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 10)
    await settle(20)
    expect(calls).toHaveLength(0)
  })

  it('PIPE-5: a push-to-talk press while transcribing keeps the utterance', async () => {
    let release: (text: string) => void = () => undefined
    const stt: SttClient = {
      name: 'slow',
      transcribe: () => new Promise<string>((resolve) => (release = resolve)),
      test: async () => ({ ok: true, message: 'ok' }),
    }
    const calls: TurnInput[] = []
    const s = setup({ stt, tts: null, agent: fakeAgent({ deltas: ['Ok.'] }, calls) })
    orchestrator = s.orchestrator
    orchestrator.pushToTalk()
    const p = orchestrator.submitAudio({ data: new ArrayBuffer(4), mimeType: 'audio/wav', durationMs: 900 })
    await settle(2)
    expect(orchestrator.state()).toBe('transcribing')
    orchestrator.pushToTalk()
    expect(orchestrator.state()).toBe('transcribing')
    expect(channels(s.sent).filter((c) => c === 'ptt:start')).toHaveLength(1)
    release('Mach das Fenster zu')
    await p
    await settle(10)
    expect(calls[0]?.text).toBe('Mach das Fenster zu')
  })

  it('PIPE-6: a quiet glance that stays silent leaves no trace; one that speaks shows the UI', async () => {
    const silent = setup({ agent: fakeAgent({ deltas: ['[[sil', 'ence]]'] }) })
    orchestrator = silent.orchestrator
    await orchestrator.proactive('glance', { screen: true, quiet: true })
    await settle(20)
    expect(silent.states).toEqual([])
    expect(channels(silent.sent)).not.toContain('turn:started')
    expect(channels(silent.sent)).not.toContain('turn:assistantDone')
    expect(channels(silent.sent)).not.toContain('speech:chunk')
    orchestrator.dispose()

    const talking = setup({ agent: fakeAgent({ deltas: ['[[happy]] ', 'Schöner Code da!'] }) })
    orchestrator = talking.orchestrator
    void orchestrator.proactive('glance', { screen: true, quiet: true })
    await settle(60)
    expect(talking.states[0]).toBe('thinking')
    expect(channels(talking.sent)).toContain('turn:started')
    const deltas = talking.sent.filter((x) => x.channel === 'turn:assistantDelta').map((x) => (x.payload as { delta: string }).delta)
    expect(deltas.join('')).toContain('Schöner Code da!')
    expect(channels(talking.sent)).toContain('speech:chunk')
  })

  it('PIPE-7: the listening safety net follows stt.maxRecordingMs', async () => {
    const s = setup({ config: { stt: { maxRecordingMs: 60_000 } } })
    orchestrator = s.orchestrator
    orchestrator.pushToTalk()
    await vi.advanceTimersByTimeAsync(50_000)
    expect(orchestrator.state()).toBe('listening')
    await vi.advanceTimersByTimeAsync(10_000 + LISTENING_GRACE_MS)
    expect(orchestrator.state()).toBe('idle')
  })

  it('PIPE-8: state is speaking from the first chunk; muting silences her but keeps the text', async () => {
    const s = setup({ agent: fakeAgent({ deltas: ['Erster langer Satz hier. ', 'Zweiter Satz kommt. ', 'Dritter Satz.'], delayMs: 30 }) })
    orchestrator = s.orchestrator
    void orchestrator.submitText('Erzähl was')
    await settle(70)
    expect(channels(s.sent)).toContain('speech:chunk')
    expect(orchestrator.state()).toBe('speaking')
    orchestrator.setMuted(true)
    expect(channels(s.sent)).toContain('speech:stop')
    const chunksBefore = s.sent.filter((x) => x.channel === 'speech:chunk').length
    await settle(150)
    expect(s.sent.filter((x) => x.channel === 'speech:chunk').length).toBe(chunksBefore)
    expect(s.sent.find((x) => x.channel === 'turn:assistantDone')?.payload).toMatchObject({ text: expect.stringContaining('Dritter Satz.') })
    expect(orchestrator.state()).toBe('idle')
  })

  it('PIPE-10: the playback safety net grows with the amount of text', () => {
    expect(playbackTimeoutMs(10)).toBe(PLAYBACK_TIMEOUT_MIN_MS)
    // ~6 minutes of speech (≈ 5000 characters) must not be cut off after 3 minutes
    expect(playbackTimeoutMs(5000)).toBeGreaterThan(6 * 60_000)
  })
})

describe('inQuietHours', () => {
  it('handles ranges that wrap midnight', () => {
    expect(inQuietHours(23, 23, 8)).toBe(true)
    expect(inQuietHours(3, 23, 8)).toBe(true)
    expect(inQuietHours(12, 23, 8)).toBe(false)
    expect(inQuietHours(9, 8, 17)).toBe(true)
    expect(inQuietHours(20, 8, 17)).toBe(false)
    expect(inQuietHours(5, 5, 5)).toBe(false)
  })
})
