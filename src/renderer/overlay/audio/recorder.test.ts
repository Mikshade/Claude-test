/**
 * Recorder tests: the pure helpers directly, and the capture state machine against a minimal fake of
 * the Web Audio / mediaDevices surface the recorder touches (installed on globalThis per test).
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordedAudio } from '@shared/ipc'
import {
  LEVEL_INTERVAL_MS,
  MIN_RECORDING_MS,
  SCRIPT_PROCESSOR_BUFFER,
  WORKLET_PROCESSOR_NAME,
  buildConstraints,
  buildRecording,
  createRecorder,
  describeMediaError,
  levelFromRms,
  smoothLevel,
  workletModuleUrl,
} from './recorder'
import { STT_SAMPLE_RATE, WAV_HEADER_BYTES } from './wav'

// ---- pure helpers -----------------------------------------------------------------------------

describe('buildConstraints', () => {
  it('asks for a processed mono track and pins the device only when configured', () => {
    const def = buildConstraints('') as { audio: MediaTrackConstraints; video: boolean }
    expect(def.video).toBe(false)
    expect(def.audio).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 })
    const pinned = buildConstraints('mic-1') as { audio: MediaTrackConstraints }
    expect(pinned.audio.deviceId).toEqual({ exact: 'mic-1' })
  })
})

describe('describeMediaError', () => {
  const dom = (name: string): Error => Object.assign(new Error(`${name} happened`), { name })

  it('maps permission and device errors to readable German messages by default', () => {
    expect(describeMediaError(dom('NotAllowedError')).message).toBe(
      'Mikrofonzugriff verweigert – Windows-Einstellungen → Datenschutz → Mikrofon',
    )
    expect(describeMediaError(dom('NotFoundError')).message).toBe('Kein Mikrofon gefunden')
    expect(describeMediaError(dom('OverconstrainedError')).message).toBe('Kein Mikrofon gefunden')
    expect(describeMediaError(dom('NotReadableError')).message).toBe('Mikrofon ist belegt oder nicht verfügbar')
    expect(describeMediaError(dom('NotSupportedError')).message).toBe('Audiosystem nicht verfügbar')
  })

  it('has English variants and keeps the original as cause', () => {
    const err = describeMediaError(dom('NotAllowedError'), 'en')
    expect(err.message).toBe('Microphone access denied – Windows Settings → Privacy → Microphone')
    expect(err.name).toBe('RecorderError')
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error)
    expect(describeMediaError(dom('NotFoundError'), 'en').message).toBe('No microphone found')
  })

  it('falls back to a generic message with the original text', () => {
    expect(describeMediaError(new Error('boom')).message).toBe('Mikrofon konnte nicht gestartet werden: boom')
    expect(describeMediaError('weird', 'en').message).toBe('Could not start the microphone: weird')
    expect(describeMediaError({ name: 'NotFoundError' }).message).toBe('Kein Mikrofon gefunden')
  })
})

describe('levelFromRms / smoothLevel', () => {
  it('maps rms to a 0..1 meter value with a perceptual curve', () => {
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(-1)).toBe(0)
    expect(levelFromRms(Number.NaN)).toBe(0)
    expect(levelFromRms(0.012)).toBeCloseTo(0.19, 2)
    expect(levelFromRms(0.1)).toBeCloseTo(0.548, 2)
    expect(levelFromRms(0.5)).toBe(1)
  })

  it('rises fast, falls slowly and snaps to zero', () => {
    expect(smoothLevel(0, 1)).toBe(0.5)
    expect(smoothLevel(1, 0)).toBe(0.8)
    let v = 1
    for (let i = 0; i < 40; i++) v = smoothLevel(v, 0)
    expect(v).toBe(0)
  })
})

describe('buildRecording', () => {
  const frame = (n: number, value = 0.3): Float32Array => new Float32Array(n).fill(value)

  it('discards recordings shorter than MIN_RECORDING_MS or without speech', () => {
    const short = Math.round((STT_SAMPLE_RATE * (MIN_RECORDING_MS - 20)) / 1000)
    expect(buildRecording([frame(short)], STT_SAMPLE_RATE, true)).toBeNull()
    expect(buildRecording([frame(STT_SAMPLE_RATE)], STT_SAMPLE_RATE, false)).toBeNull()
    expect(buildRecording([], STT_SAMPLE_RATE, true)).toBeNull()
  })

  it('encodes a 16 kHz capture as WAV with the sample-based duration', () => {
    const audio = buildRecording([frame(8000), frame(8000)], STT_SAMPLE_RATE, true)
    expect(audio).not.toBeNull()
    const { data, mimeType, durationMs } = audio as RecordedAudio
    expect(mimeType).toBe('audio/wav')
    expect(durationMs).toBe(1000)
    expect(data).toBeInstanceOf(ArrayBuffer)
    expect(data.byteLength).toBe(WAV_HEADER_BYTES + 16000 * 2)
    expect(new DataView(data).getUint32(24, true)).toBe(16000)
  })

  it('resamples captures made at the device rate down to 16 kHz', () => {
    const audio = buildRecording([frame(48000)], 48000, true) as RecordedAudio
    expect(audio.durationMs).toBe(1000)
    expect(audio.data.byteLength).toBe(WAV_HEADER_BYTES + 16000 * 2)
    expect(new DataView(audio.data).getUint32(24, true)).toBe(16000)
    expect(new DataView(audio.data).getInt16(WAV_HEADER_BYTES, true)).toBe(Math.round(0.3 * 32767))
  })
})

describe('workletModuleUrl', () => {
  it('resolves ../recorder-worklet.js next to the overlay page in dev and prod', () => {
    expect(workletModuleUrl('http://localhost:5173/overlay/index.html')).toBe('http://localhost:5173/recorder-worklet.js')
    expect(workletModuleUrl('file:///C:/app/out/renderer/overlay/index.html')).toBe('file:///C:/app/out/renderer/recorder-worklet.js')
    expect(workletModuleUrl(undefined)).toBe('recorder-worklet.js')
    expect(workletModuleUrl('not a url')).toBe('recorder-worklet.js')
  })
})

// ---- fakes ------------------------------------------------------------------------------------

interface FakeTrack {
  stopped: boolean
  stop(): void
}

function fakeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [
    {
      stopped: false,
      stop() {
        this.stopped = true
      },
    },
  ]
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks }
}

class FakeNode {
  readonly connections: FakeNode[] = []
  connect(target: FakeNode): FakeNode {
    this.connections.push(target)
    return target
  }
  disconnect(): void {
    this.connections.length = 0
  }
}

class FakeScriptProcessor extends FakeNode {
  onaudioprocess: ((e: AudioProcessingEvent) => void) | null = null
  constructor(readonly bufferSize: number) {
    super()
  }
}

class FakePort {
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null
  readonly sent: unknown[] = []
  postMessage(msg: unknown): void {
    this.sent.push(msg)
  }
}

interface FakeContextConfig {
  /** Throw from `new AudioContext({ sampleRate: 16000 })`. */
  reject16k?: boolean
  /** Make audioWorklet.addModule reject. */
  workletFails?: boolean
  deviceRate?: number
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>
type FakeGain = FakeNode & { gain: { value: number } }

const env: {
  config: FakeContextConfig
  contexts: FakeAudioContext[]
  workletNodes: FakeWorkletNode[]
  getUserMedia: Mock<GetUserMedia>
} = { config: {}, contexts: [], workletNodes: [], getUserMedia: vi.fn<GetUserMedia>() }

class FakeWorkletNode extends FakeNode {
  readonly port = new FakePort()
  constructor(
    readonly context: FakeAudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    super()
    env.workletNodes.push(this)
  }
}

class FakeAudioContext {
  readonly sampleRate: number
  state: 'suspended' | 'running' | 'closed' = 'suspended'
  readonly destination = new FakeNode()
  readonly addModule = vi.fn(async (_url: string) => {
    if (env.config.workletFails) throw new Error('CSP')
  })
  readonly audioWorklet = { addModule: this.addModule }
  readonly scriptProcessors: FakeScriptProcessor[] = []
  readonly sources: FakeNode[] = []
  readonly gains: FakeGain[] = []
  resumeCalls = 0

  constructor(options?: AudioContextOptions) {
    if (options?.sampleRate === 16000 && env.config.reject16k) {
      throw Object.assign(new Error('rate'), { name: 'NotSupportedError' })
    }
    this.sampleRate = options?.sampleRate ?? env.config.deviceRate ?? 48000
    env.contexts.push(this)
  }
  async resume(): Promise<void> {
    this.resumeCalls++
    this.state = 'running'
  }
  async close(): Promise<void> {
    this.state = 'closed'
  }
  createMediaStreamSource(): FakeNode {
    const node = new FakeNode()
    this.sources.push(node)
    return node
  }
  createGain(): FakeGain {
    const node: FakeGain = Object.assign(new FakeNode(), { gain: { value: 1 } })
    this.gains.push(node)
    return node
  }
  createScriptProcessor(bufferSize: number): FakeScriptProcessor {
    const node = new FakeScriptProcessor(bufferSize)
    this.scriptProcessors.push(node)
    return node
  }
}

function installFakes(config: FakeContextConfig = {}): void {
  env.config = config
  env.contexts = []
  env.workletNodes = []
  env.getUserMedia = vi.fn<GetUserMedia>(async () => fakeStream().stream)
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: (c: MediaStreamConstraints): Promise<MediaStream> => env.getUserMedia(c) } },
    configurable: true,
  })
  Object.assign(globalThis, { AudioContext: FakeAudioContext, AudioWorkletNode: FakeWorkletNode })
}

function uninstallFakes(): void {
  const g = globalThis as Record<string, unknown>
  delete g['AudioContext']
  delete g['AudioWorkletNode']
  delete g['navigator']
}

/** Pump one frame through the worklet port (or the script processor) and advance the fake clock. */
function makePump(clock: { now: number }) {
  return (value: number, count = 1, samples = 320): void => {
    for (let i = 0; i < count; i++) {
      clock.now += 20
      const frame = new Float32Array(samples).fill(value)
      const worklet = env.workletNodes.at(-1)
      if (worklet?.port.onmessage) {
        worklet.port.onmessage({ data: frame } as MessageEvent<unknown>)
      } else {
        const sp = env.contexts.at(-1)?.scriptProcessors.at(-1)
        sp?.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } } as unknown as AudioProcessingEvent)
      }
    }
  }
}

// ---- recorder state machine -------------------------------------------------------------------

describe('createRecorder', () => {
  const clock = { now: 0 }
  let nowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clock.now = 1000
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    nowSpy.mockRestore()
    vi.restoreAllMocks()
    uninstallFakes()
  })

  it('throws synchronously when Web Audio is missing (overlay falls back to the no-op recorder)', () => {
    uninstallFakes()
    expect(() => createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })).toThrow()
  })

  it('captures through the worklet at 16 kHz and auto-stops after silence with a WAV', async () => {
    installFakes()
    const onAutoStop = vi.fn()
    const onLevel = vi.fn()
    const recorder = createRecorder({
      deviceId: 'mic-7',
      silenceTimeoutMs: 1400,
      maxRecordingMs: 30000,
      onLevel,
      onAutoStop,
      workletUrl: 'test://recorder-worklet.js',
    })
    expect(recorder.isRecording()).toBe(false)
    await recorder.start()
    expect(recorder.isRecording()).toBe(true)

    const ctx = env.contexts[0]!
    expect(ctx.sampleRate).toBe(16000)
    expect(ctx.resumeCalls).toBe(1)
    expect(ctx.addModule).toHaveBeenCalledWith('test://recorder-worklet.js')
    expect(env.getUserMedia.mock.calls[0]?.[0]).toEqual(buildConstraints('mic-7'))
    const worklet = env.workletNodes[0]!
    expect(worklet.name).toBe(WORKLET_PROCESSOR_NAME)
    expect(worklet.options.processorOptions).toEqual({ frameSize: 320 })
    // source → worklet → muted gain → destination (never audible)
    expect(ctx.sources[0]?.connections).toContain(worklet)
    const mute = ctx.gains[0]!
    expect(mute.gain.value).toBe(0)
    expect(worklet.connections).toContain(mute)
    expect(mute.connections).toContain(ctx.destination)

    const pump = makePump(clock)
    pump(0.3, 50) // 1 s of speech
    pump(0.001, 80) // > 1.4 s of silence → auto-stop
    expect(onAutoStop).toHaveBeenCalledTimes(1)
    const audio = onAutoStop.mock.calls[0]?.[0] as RecordedAudio
    expect(audio.mimeType).toBe('audio/wav')
    expect(audio.durationMs).toBeGreaterThanOrEqual(1000 + 1400)
    expect(audio.durationMs).toBeLessThan(1000 + 1400 + 60)
    expect(new DataView(audio.data).getUint32(24, true)).toBe(16000)
    expect(audio.data.byteLength).toBe(WAV_HEADER_BYTES + (audio.durationMs / 1000) * 16000 * 2)

    expect(recorder.isRecording()).toBe(false)
    expect(worklet.port.sent).toContain('stop')
    expect(worklet.port.onmessage).toBeNull()
    // Level meter: throttled to ~20 Hz and closed with a final 0.
    const levels = onLevel.mock.calls.map((c) => c[0] as number)
    expect(levels.length).toBeLessThanOrEqual(Math.ceil((130 * 20) / LEVEL_INTERVAL_MS) + 2)
    expect(Math.max(...levels)).toBeGreaterThan(0.8)
    expect(levels.at(-1)).toBe(0)
    // stop() after an auto-stop yields nothing new.
    expect(await recorder.stop()).toBeNull()
  })

  it('releases the microphone tracks when the recording ends', async () => {
    installFakes()
    const { stream, tracks } = fakeStream()
    env.getUserMedia.mockResolvedValue(stream)
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    await recorder.start()
    expect(tracks[0]?.stopped).toBe(false)
    makePump(clock)(0.3, 30)
    const audio = await recorder.stop()
    expect(audio).not.toBeNull()
    expect(tracks[0]?.stopped).toBe(true)
    // The context is kept for the next recording and only closed on dispose().
    expect(env.contexts[0]?.state).toBe('running')
    recorder.dispose()
    expect(env.contexts[0]?.state).toBe('closed')
  })

  it('returns null for a manual stop without speech or when too short', async () => {
    installFakes()
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    await recorder.start()
    makePump(clock)(0.001, 60)
    expect(await recorder.stop()).toBeNull()
    await recorder.start()
    makePump(clock)(0.3, 5) // 100 ms of speech
    expect(await recorder.stop()).toBeNull()
    expect(await recorder.stop()).toBeNull() // idle
  })

  it('stops at maxRecordingMs even while the user keeps talking', async () => {
    installFakes()
    const onAutoStop = vi.fn()
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 2000, onAutoStop })
    await recorder.start()
    makePump(clock)(0.3, 100)
    expect(onAutoStop).toHaveBeenCalledTimes(1)
    expect((onAutoStop.mock.calls[0]?.[0] as RecordedAudio).durationMs).toBe(2000)
  })

  it('cancel() discards everything without calling onAutoStop', async () => {
    installFakes()
    const { stream, tracks } = fakeStream()
    env.getUserMedia.mockResolvedValue(stream)
    const onAutoStop = vi.fn()
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000, onAutoStop })
    await recorder.start()
    makePump(clock)(0.3, 30)
    recorder.cancel()
    expect(recorder.isRecording()).toBe(false)
    expect(tracks[0]?.stopped).toBe(true)
    makePump(clock)(0.001, 100) // late frames are ignored
    expect(onAutoStop).not.toHaveBeenCalled()
    expect(await recorder.stop()).toBeNull()
  })

  it('rejects start() with a readable German message when the mic is denied', async () => {
    installFakes()
    env.getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    await expect(recorder.start()).rejects.toThrow('Mikrofonzugriff verweigert – Windows-Einstellungen → Datenschutz → Mikrofon')
    expect(recorder.isRecording()).toBe(false)
    // English when configured.
    recorder.setOptions({ language: 'en' })
    await expect(recorder.start()).rejects.toThrow('Microphone access denied')
  })

  it('retries with the default device when the configured microphone is gone', async () => {
    installFakes()
    env.getUserMedia
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'OverconstrainedError' }))
      .mockResolvedValueOnce(fakeStream().stream)
    const recorder = createRecorder({ deviceId: 'old-mic', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    await recorder.start()
    expect(env.getUserMedia).toHaveBeenCalledTimes(2)
    expect(env.getUserMedia.mock.calls[1]?.[0]).toEqual(buildConstraints(''))
    expect(recorder.isRecording()).toBe(true)
    recorder.cancel()
  })

  it('falls back to a ScriptProcessorNode when the worklet module cannot be loaded', async () => {
    installFakes({ workletFails: true })
    const onAutoStop = vi.fn()
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1000, maxRecordingMs: 30000, onAutoStop })
    await recorder.start()
    const ctx = env.contexts[0]!
    expect(env.workletNodes).toHaveLength(0)
    expect(ctx.scriptProcessors[0]?.bufferSize).toBe(SCRIPT_PROCESSOR_BUFFER)
    expect(ctx.scriptProcessors[0]?.connections).toContain(ctx.gains[0])
    const pump = makePump(clock)
    pump(0.3, 40, 1024)
    pump(0.001, 60, 1024)
    expect(onAutoStop).toHaveBeenCalledTimes(1)
    expect(onAutoStop.mock.calls[0]?.[0]).not.toBeNull()
    expect(ctx.scriptProcessors[0]?.onaudioprocess).toBeNull()
    // The failed module load is remembered: a second recording does not retry addModule.
    await recorder.start()
    expect(ctx.addModule).toHaveBeenCalledTimes(1)
    recorder.cancel()
  })

  it('captures at the device rate and resamples when a 16 kHz context is refused', async () => {
    installFakes({ reject16k: true, deviceRate: 48000 })
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    await recorder.start()
    expect(env.contexts.at(-1)?.sampleRate).toBe(48000)
    expect(env.workletNodes[0]?.options.processorOptions).toEqual({ frameSize: 960 })
    makePump(clock)(0.3, 50, 960) // 1 s at 48 kHz
    const audio = (await recorder.stop()) as RecordedAudio
    expect(audio.durationMs).toBe(1000)
    expect(new DataView(audio.data).getUint32(24, true)).toBe(16000)
    expect(audio.data.byteLength).toBe(WAV_HEADER_BYTES + 16000 * 2)
  })

  it('setOptions() applies the new device and VAD timing to the next recording', async () => {
    installFakes()
    const onAutoStop = vi.fn()
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000, onAutoStop })
    recorder.setOptions({ deviceId: 'mic-2', silenceTimeoutMs: 400, maxRecordingMs: 10000 })
    await recorder.start()
    expect(env.getUserMedia.mock.calls[0]?.[0]).toEqual(buildConstraints('mic-2'))
    const pump = makePump(clock)
    pump(0.3, 30)
    pump(0.001, 25) // 500 ms of silence > 400
    expect(onAutoStop).toHaveBeenCalledTimes(1)
  })

  it('start() while starting/recording is idempotent and stop() waits for a pending start', async () => {
    installFakes()
    let release: (stream: MediaStream) => void = () => undefined
    env.getUserMedia.mockImplementation(() => new Promise<MediaStream>((resolve) => (release = resolve)))
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    const first = recorder.start()
    const second = recorder.start()
    expect(recorder.isRecording()).toBe(true)
    const stopping = recorder.stop()
    const { stream, tracks } = fakeStream()
    release(stream)
    await Promise.all([first, second])
    expect(await stopping).toBeNull()
    expect(tracks[0]?.stopped).toBe(true)
    expect(env.getUserMedia).toHaveBeenCalledTimes(1)
    expect(recorder.isRecording()).toBe(false)
  })

  it('cancel() during a pending getUserMedia releases the stream once it arrives', async () => {
    installFakes()
    let release: (stream: MediaStream) => void = () => undefined
    env.getUserMedia.mockImplementation(() => new Promise<MediaStream>((resolve) => (release = resolve)))
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    const starting = recorder.start()
    recorder.cancel()
    const { stream, tracks } = fakeStream()
    release(stream)
    await starting
    expect(tracks[0]?.stopped).toBe(true)
    expect(recorder.isRecording()).toBe(false)
    expect(env.contexts).toHaveLength(0)
  })

  it('dispose() cancels, closes the context and refuses further starts', async () => {
    installFakes()
    const recorder = createRecorder({ deviceId: '', silenceTimeoutMs: 1400, maxRecordingMs: 30000 })
    await recorder.start()
    recorder.dispose()
    expect(recorder.isRecording()).toBe(false)
    expect(env.contexts[0]?.state).toBe('closed')
    await expect(recorder.start()).rejects.toThrow()
    recorder.dispose() // idempotent
  })
})
