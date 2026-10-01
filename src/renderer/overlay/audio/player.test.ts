/**
 * Player tests: pure helpers plus the turn/queue state machine against a fake AudioContext whose
 * sources are ended by hand (vitest fake timers drive the onChunkStart timers and the rAF loop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechChunk } from '@shared/state'
import {
  ANALYSER_FFT_SIZE,
  DEFAULT_PCM_RATE,
  MOUTH_ATTACK,
  MOUTH_RELEASE,
  SCHEDULE_LEAD_S,
  VOLUME_RAMP_S,
  createPlayer,
  mouthTarget,
  nextStartTime,
  smoothMouth,
} from './player'

// ---- pure helpers -----------------------------------------------------------------------------

describe('nextStartTime', () => {
  it('starts right after the previous chunk, but never earlier than now + lead', () => {
    expect(nextStartTime(10, 0)).toBeCloseTo(10 + SCHEDULE_LEAD_S)
    expect(nextStartTime(10, 10.5)).toBe(10.5)
    expect(nextStartTime(10, 10.01)).toBeCloseTo(10.02)
    expect(nextStartTime(10, 0, 0.1)).toBeCloseTo(10.1)
  })
})

describe('mouthTarget / smoothMouth', () => {
  it('scales rms by 6 and clamps to 1', () => {
    expect(mouthTarget(0)).toBe(0)
    expect(mouthTarget(0.05)).toBeCloseTo(0.3)
    expect(mouthTarget(0.5)).toBe(1)
    expect(mouthTarget(Number.NaN)).toBe(0)
  })

  it('opens fast and closes slowly, snapping shut at the end', () => {
    expect(smoothMouth(0, 1)).toBe(MOUTH_ATTACK)
    expect(smoothMouth(1, 0)).toBeCloseTo(1 - MOUTH_RELEASE)
    let v = 1
    for (let i = 0; i < 60; i++) v = smoothMouth(v, 0)
    expect(v).toBe(0)
    expect(smoothMouth(0.9, 5)).toBeLessThanOrEqual(1)
  })
})

// ---- fake Web Audio ---------------------------------------------------------------------------

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

class FakeParam {
  value = 1
  readonly calls: string[] = []
  cancelScheduledValues(t: number): void {
    this.calls.push(`cancel@${t}`)
  }
  setValueAtTime(v: number, t: number): void {
    this.calls.push(`set ${v}@${t}`)
    this.value = v
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.calls.push(`ramp ${v}@${t}`)
    this.value = v
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048
  smoothingTimeConstant = 0.8
  level = 0
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(this.level)
  }
}

interface FakeBuffer {
  length: number
  sampleRate: number
  duration: number
  data: Float32Array
  copyToChannel(src: Float32Array, ch: number): void
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null
  onended: (() => void) | null = null
  startedAt: number | null = null
  stopped = false
  start(when: number): void {
    this.startedAt = when
  }
  stop(): void {
    this.stopped = true
  }
  /** Simulate the engine reaching the end of this buffer. */
  end(): void {
    this.onended?.()
  }
}

class FakeAudioContext {
  currentTime = 100
  state: 'suspended' | 'running' | 'closed' = 'suspended'
  readonly destination = new FakeNode()
  readonly sources: FakeSource[] = []
  readonly decoded: ArrayBuffer[] = []
  analyser: FakeAnalyser | null = null
  gain: (FakeNode & { gain: FakeParam }) | null = null
  resumeCalls = 0
  setSinkId: ((id: string) => Promise<void>) | undefined = vi.fn(async (id: string) => {
    if (id === 'missing') throw Object.assign(new Error('nope'), { name: 'NotFoundError' })
  })

  constructor() {
    env.contexts.push(this)
  }
  async resume(): Promise<void> {
    this.resumeCalls++
    this.state = 'running'
  }
  async close(): Promise<void> {
    this.state = 'closed'
  }
  createAnalyser(): FakeAnalyser {
    this.analyser = new FakeAnalyser()
    return this.analyser
  }
  createGain(): FakeNode & { gain: FakeParam } {
    this.gain = Object.assign(new FakeNode(), { gain: new FakeParam() })
    return this.gain
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    if (!(length > 0)) throw Object.assign(new Error('length'), { name: 'NotSupportedError' })
    const data = new Float32Array(length)
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      data,
      copyToChannel: (src) => data.set(src),
    }
  }
  createBufferSource(): FakeSource {
    const src = new FakeSource()
    this.sources.push(src)
    return src
  }
  async decodeAudioData(buffer: ArrayBuffer): Promise<FakeBuffer> {
    this.decoded.push(buffer)
    const bytes = new Uint8Array(buffer)
    if (bytes[0] === 0xff) throw Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' })
    // Pretend every byte is one millisecond of audio at 48 kHz.
    return this.createBuffer(1, bytes.length * 48, 48000)
  }
}

const env: { contexts: FakeAudioContext[]; rafCallbacks: Map<number, FrameRequestCallback>; rafSeq: number } = {
  contexts: [],
  rafCallbacks: new Map(),
  rafSeq: 0,
}

function installFakes(): void {
  env.contexts = []
  env.rafCallbacks = new Map()
  env.rafSeq = 0
  Object.assign(globalThis, {
    AudioContext: FakeAudioContext,
    requestAnimationFrame: (cb: FrameRequestCallback): number => {
      const id = ++env.rafSeq
      env.rafCallbacks.set(id, cb)
      return id
    },
    cancelAnimationFrame: (id: number): void => {
      env.rafCallbacks.delete(id)
    },
  })
}

function uninstallFakes(): void {
  const g = globalThis as Record<string, unknown>
  delete g['AudioContext']
  delete g['requestAnimationFrame']
  delete g['cancelAnimationFrame']
}

/** Run every pending rAF callback once. */
function tickFrame(): void {
  const pending = [...env.rafCallbacks.entries()]
  env.rafCallbacks.clear()
  for (const [, cb] of pending) cb(performance.now())
}

function pcmChunk(turnId: string, seq: number, bytes: number[], last = false, sampleRate = 16000): SpeechChunk {
  return { turnId, seq, text: `s${seq}`, emotion: 'neutral', audio: new Uint8Array(bytes).buffer, format: 'pcm', sampleRate, last }
}

function mp3Chunk(turnId: string, seq: number, byteLength: number, last = false, firstByte = 0x49): SpeechChunk {
  const bytes = new Uint8Array(byteLength)
  if (byteLength > 0) bytes[0] = firstByte
  return { turnId, seq, text: `s${seq}`, emotion: 'happy', audio: bytes.buffer, format: 'mp3', last }
}

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

function setup(overrides: Partial<Parameters<typeof createPlayer>[0]> = {}) {
  const onMouth = vi.fn()
  const onChunkStart = vi.fn()
  const onTurnFinished = vi.fn()
  const onError = vi.fn()
  const player = createPlayer({ volume: 0.8, outputDeviceId: '', onMouth, onChunkStart, onTurnFinished, onError, ...overrides })
  const ctx = env.contexts.at(-1)!
  return { player, ctx, onMouth, onChunkStart, onTurnFinished, onError }
}

// ---- player -----------------------------------------------------------------------------------

describe('createPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installFakes()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    uninstallFakes()
  })

  it('throws synchronously without Web Audio', () => {
    uninstallFakes()
    expect(() => createPlayer({ volume: 1, outputDeviceId: '', onMouth: () => undefined, onTurnFinished: () => undefined })).toThrow()
  })

  it('builds analyser → gain → destination with the configured volume', () => {
    const { ctx } = setup({ volume: 0.8 })
    expect(ctx.analyser?.fftSize).toBe(ANALYSER_FFT_SIZE)
    expect(ctx.analyser?.smoothingTimeConstant).toBe(0)
    expect(ctx.analyser?.connections).toContain(ctx.gain)
    expect(ctx.gain?.connections).toContain(ctx.destination)
    expect(ctx.gain?.gain.value).toBe(0.8)
  })

  it('schedules pcm chunks gaplessly and finishes the turn when the last source ends', async () => {
    const { player, ctx, onChunkStart, onTurnFinished, onMouth } = setup()
    const a = pcmChunk('t1', 0, Array.from({ length: 3200 }, () => 0)) // 1600 samples = 100 ms @16k
    const b = pcmChunk('t1', 1, Array.from({ length: 1600 }, () => 0), true) // 50 ms
    player.enqueue(a)
    expect(ctx.resumeCalls).toBe(1)
    expect(player.isPlaying()).toBe(true)
    expect(player.currentTurn()).toBe('t1')
    player.enqueue(b)
    await settle()

    expect(ctx.sources).toHaveLength(2)
    const [s0, s1] = ctx.sources as [FakeSource, FakeSource]
    expect(s0.startedAt).toBeCloseTo(100 + SCHEDULE_LEAD_S)
    expect(s0.buffer?.sampleRate).toBe(16000)
    expect(s0.buffer?.length).toBe(1600)
    expect(s1.startedAt).toBeCloseTo(100 + SCHEDULE_LEAD_S + 0.1)
    expect(s0.connections).toContain(ctx.analyser)

    // onChunkStart fires at the scheduled times (timers), in order.
    expect(onChunkStart).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(21)
    expect(onChunkStart).toHaveBeenCalledTimes(1)
    expect(onChunkStart.mock.calls[0]?.[0]).toBe(a)
    await vi.advanceTimersByTimeAsync(100)
    expect(onChunkStart).toHaveBeenCalledTimes(2)
    expect(onChunkStart.mock.calls[1]?.[0]).toBe(b)

    s0.end()
    expect(onTurnFinished).not.toHaveBeenCalled()
    s1.end()
    expect(onTurnFinished).toHaveBeenCalledWith('t1', false)
    expect(player.isPlaying()).toBe(false)
    expect(player.currentTurn()).toBeNull()
    expect(onMouth).toHaveBeenLastCalledWith(0)
  })

  it('carries an odd trailing pcm byte into the next chunk of the same turn', async () => {
    const { player, ctx } = setup()
    player.enqueue(pcmChunk('t1', 0, [0x00, 0x40, 0x34]))
    player.enqueue(pcmChunk('t1', 1, [0x12, 0x00, 0x80], true))
    await settle()
    expect(ctx.sources[0]?.buffer?.length).toBe(1)
    expect(ctx.sources[1]?.buffer?.length).toBe(2)
    expect(ctx.sources[1]?.buffer?.data[0]).toBeCloseTo(0x1234 / 32768)
    expect(ctx.sources[1]?.buffer?.data[1]).toBe(-1)
  })

  it('uses 44.1 kHz for pcm chunks without a sampleRate', async () => {
    const { player, ctx } = setup()
    player.enqueue({ ...pcmChunk('t1', 0, [0, 0, 0, 0]), sampleRate: undefined })
    await settle()
    expect(ctx.sources[0]?.buffer?.sampleRate).toBe(DEFAULT_PCM_RATE)
  })

  it('decodes wav/mp3 through decodeAudioData on a copy of the bytes', async () => {
    const { player, ctx } = setup()
    const chunk = mp3Chunk('t1', 0, 100)
    player.enqueue(chunk)
    await settle()
    expect(ctx.decoded).toHaveLength(1)
    expect(ctx.decoded[0]).not.toBe(chunk.audio)
    expect(new Uint8Array(ctx.decoded[0]!)).toEqual(new Uint8Array(chunk.audio))
    expect(ctx.sources[0]?.buffer?.duration).toBeCloseTo(0.1)
  })

  it('accepts a typed-array view as the audio payload (a Node Buffer after structured clone)', async () => {
    const { player, ctx } = setup()
    const chunk = pcmChunk('t1', 0, [0, 0, 0, 0])
    const view = new Uint8Array(new ArrayBuffer(8), 1, 6) // offset view, like a pooled Buffer slice
    player.enqueue({ ...chunk, audio: view as unknown as ArrayBuffer })
    await settle()
    expect(ctx.sources[0]?.buffer?.length).toBe(3)
  })

  it('an empty last chunk ends the turn after the previous chunk finishes', async () => {
    const { player, ctx, onTurnFinished } = setup()
    player.enqueue(pcmChunk('t1', 0, [0, 0, 0, 0]))
    await settle()
    player.enqueue(pcmChunk('t1', 1, [], true))
    await settle()
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.decoded).toHaveLength(0)
    expect(onTurnFinished).not.toHaveBeenCalled()
    ctx.sources[0]!.end()
    expect(onTurnFinished).toHaveBeenCalledWith('t1', false)
  })

  it('an empty last chunk after everything already played finishes immediately', async () => {
    const { player, ctx, onTurnFinished } = setup()
    player.enqueue(pcmChunk('t1', 0, [0, 0]))
    await settle()
    ctx.sources[0]!.end()
    expect(onTurnFinished).not.toHaveBeenCalled()
    player.enqueue(mp3Chunk('t1', 1, 0, true))
    await settle()
    expect(onTurnFinished).toHaveBeenCalledWith('t1', false)
  })

  it('ignores chunks that arrive after the turn ended', async () => {
    const { player, ctx, onTurnFinished } = setup()
    player.enqueue(pcmChunk('t1', 0, [0, 0], true))
    await settle()
    player.enqueue(pcmChunk('t1', 1, [0, 0])) // after `last` but before the end: ignored
    await settle()
    expect(ctx.sources).toHaveLength(1)
    ctx.sources[0]!.end()
    expect(onTurnFinished).toHaveBeenCalledTimes(1)
    player.enqueue(pcmChunk('t1', 2, [0, 0], true)) // after the end: ignored
    await settle()
    expect(ctx.sources).toHaveLength(1)
    expect(player.isPlaying()).toBe(false)
    expect(onTurnFinished).toHaveBeenCalledTimes(1)
  })

  it('a chunk of a different turn stops the active turn first', async () => {
    const { player, ctx, onTurnFinished } = setup()
    player.enqueue(pcmChunk('t1', 0, Array.from({ length: 200 }, () => 0)))
    await settle()
    player.enqueue(pcmChunk('t2', 0, [0, 0], true))
    expect(onTurnFinished).toHaveBeenCalledWith('t1', true)
    expect(ctx.sources[0]?.stopped).toBe(true)
    expect(ctx.sources[0]?.onended).toBeNull()
    expect(player.currentTurn()).toBe('t2')
    await settle()
    expect(ctx.sources).toHaveLength(2)
    // The new turn is scheduled from "now", not after the old turn's end.
    expect(ctx.sources[1]?.startedAt).toBeCloseTo(100 + SCHEDULE_LEAD_S)
    ctx.sources[1]!.end()
    expect(onTurnFinished).toHaveBeenLastCalledWith('t2', false)
  })

  it('stop() cancels sources, pending timers and decodes, and reports stopped=true once', async () => {
    const { player, ctx, onTurnFinished, onChunkStart, onMouth } = setup()
    player.enqueue(pcmChunk('t1', 0, [0, 0, 0, 0]))
    await settle()
    player.enqueue(mp3Chunk('t1', 1, 50)) // decode in flight
    player.stop()
    expect(onTurnFinished).toHaveBeenCalledTimes(1)
    expect(onTurnFinished).toHaveBeenCalledWith('t1', true)
    expect(ctx.sources[0]?.stopped).toBe(true)
    expect(player.isPlaying()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(onChunkStart).not.toHaveBeenCalled()
    expect(ctx.sources).toHaveLength(1) // the in-flight decode was not scheduled
    expect(onMouth).toHaveBeenLastCalledWith(0)
    player.stop() // nothing active → no second callback
    expect(onTurnFinished).toHaveBeenCalledTimes(1)
  })

  it('skips a chunk that fails to decode, reports it and keeps the turn going', async () => {
    const { player, ctx, onError, onTurnFinished } = setup()
    const bad = mp3Chunk('t1', 0, 10, false, 0xff)
    player.enqueue(bad)
    player.enqueue(mp3Chunk('t1', 1, 10, true))
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0]?.[1]).toBe(bad)
    expect(ctx.sources).toHaveLength(1)
    ctx.sources[0]!.end()
    expect(onTurnFinished).toHaveBeenCalledWith('t1', false)
  })

  it('finishes a turn whose last chunk failed to decode once the earlier audio ends', async () => {
    const { player, ctx, onTurnFinished } = setup()
    player.enqueue(mp3Chunk('t1', 0, 10))
    player.enqueue(mp3Chunk('t1', 1, 10, true, 0xff))
    await settle()
    expect(onTurnFinished).not.toHaveBeenCalled()
    ctx.sources[0]!.end()
    expect(onTurnFinished).toHaveBeenCalledWith('t1', false)
  })

  it('drives the mouth from the analyser while playing and closes it once at the end', async () => {
    const { player, ctx, onMouth } = setup()
    player.enqueue(pcmChunk('t1', 0, [0, 0, 0, 0], true))
    await settle()
    ctx.analyser!.level = 0.1 // rms 0.1 → target 0.6
    tickFrame()
    expect(onMouth.mock.calls.at(-1)?.[0]).toBeCloseTo(0.3) // attack 0.5 towards 0.6
    tickFrame()
    expect(onMouth.mock.calls.at(-1)?.[0]).toBeCloseTo(0.45)
    ctx.analyser!.level = 0
    tickFrame()
    expect(onMouth.mock.calls.at(-1)?.[0]).toBeCloseTo(0.45 * (1 - MOUTH_RELEASE))
    const before = onMouth.mock.calls.length
    ctx.sources[0]!.end()
    expect(onMouth.mock.calls.length).toBe(before + 1)
    expect(onMouth).toHaveBeenLastCalledWith(0)
    expect(env.rafCallbacks.size).toBe(0)
    tickFrame()
    expect(onMouth.mock.calls.length).toBe(before + 1)
  })

  it('setVolume ramps the gain over 30 ms and clamps', () => {
    const { player, ctx } = setup()
    player.setVolume(0.5)
    expect(ctx.gain?.gain.calls).toEqual(['cancel@100', 'set 0.8@100', `ramp 0.5@${100 + VOLUME_RAMP_S}`])
    player.setVolume(7)
    expect(ctx.gain?.gain.value).toBe(1)
    player.setVolume(-1)
    expect(ctx.gain?.gain.value).toBe(0)
  })

  it('selects the output device via setSinkId when available', async () => {
    const { player, ctx } = setup({ outputDeviceId: 'spk-1' })
    await settle()
    expect(ctx.setSinkId).toHaveBeenCalledWith('spk-1')
    await player.setOutputDevice('')
    expect(ctx.setSinkId).toHaveBeenLastCalledWith('')
    await expect(player.setOutputDevice('missing')).rejects.toThrow()
    ctx.setSinkId = undefined
    await expect(player.setOutputDevice('')).resolves.toBeUndefined()
    await expect(player.setOutputDevice('spk-2')).rejects.toThrow('setSinkId')
  })

  it('dispose() stops playback, closes the context and ignores later chunks', async () => {
    const { player, ctx, onTurnFinished } = setup()
    player.enqueue(pcmChunk('t1', 0, [0, 0]))
    await settle()
    player.dispose()
    expect(onTurnFinished).toHaveBeenCalledWith('t1', true)
    expect(ctx.state).toBe('closed')
    player.enqueue(pcmChunk('t2', 0, [0, 0]))
    await settle()
    expect(ctx.sources).toHaveLength(1)
    expect(player.isPlaying()).toBe(false)
    player.dispose()
  })
})
