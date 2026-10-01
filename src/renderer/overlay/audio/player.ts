/**
 * Gapless speech chunk player with lip-sync analysis.
 *
 * Graph: AudioBufferSourceNode(s) → AnalyserNode (fftSize 1024, lip sync) → GainNode (volume) → destination.
 * The analyser sits before the gain so the mouth movement does not depend on the user's volume.
 *
 * Per turn the chunks are decoded strictly in `seq` order through a promise chain ('wav'/'mp3' via
 * decodeAudioData on a copy, 'pcm' = s16le mono via pcm.ts with odd-byte carry) and scheduled back
 * to back: start = max(ctx.currentTime + SCHEDULE_LEAD_S, end of the previous chunk). The 'ended'
 * event of the last chunk's source finishes the turn; stop() finishes it with stopped=true.
 *
 * OWNER: audio agent. Contract: ./types.ts. Pure helpers (exported, tested in player.test.ts):
 * nextStartTime, mouthTarget, smoothMouth.
 */
import type { SpeechChunk } from '@shared/state'
import { audioBytes, createPcm16Decoder, type Pcm16Decoder } from './pcm'
import type { Player, PlayerOptions } from './types'
import { rms } from './wav'

/** Minimum lead time before a freshly scheduled chunk starts (lets the render thread pick it up). */
export const SCHEDULE_LEAD_S = 0.02
/** Volume ramp duration (avoids clicks). */
export const VOLUME_RAMP_S = 0.03
export const ANALYSER_FFT_SIZE = 1024
/** mouth = min(1, rms * MOUTH_GAIN) before smoothing. */
export const MOUTH_GAIN = 6
export const MOUTH_ATTACK = 0.5
export const MOUTH_RELEASE = 0.15
/** Fish Audio's default PCM rate when a chunk does not say. */
export const DEFAULT_PCM_RATE = 44_100
/** How many finished turn ids are remembered so late chunks of them are ignored. */
const REMEMBERED_TURNS = 16

// ---- pure helpers -----------------------------------------------------------------------------

/** Where the next chunk starts: right after the previous one, but never earlier than now + lead. */
export function nextStartTime(currentTime: number, lastEnd: number, lead = SCHEDULE_LEAD_S): number {
  return Math.max(currentTime + lead, lastEnd)
}

/** Raw mouth openness 0..1 from the analyser RMS. */
export function mouthTarget(frameRms: number): number {
  if (!(frameRms > 0)) return 0
  return Math.min(1, frameRms * MOUTH_GAIN)
}

/** Fast attack / slower release smoothing; snaps to 0 when nearly closed. */
export function smoothMouth(previous: number, target: number, attack = MOUTH_ATTACK, release = MOUTH_RELEASE): number {
  const k = target > previous ? attack : release
  const next = previous + (target - previous) * k
  return next < 0.005 ? 0 : Math.min(1, next)
}

// ---- player -----------------------------------------------------------------------------------

interface Turn {
  id: string
  pcm: Pcm16Decoder
  /** Context time at which the last scheduled buffer ends (0 = nothing scheduled yet). */
  lastEnd: number
  sources: Set<AudioBufferSourceNode>
  timers: Set<ReturnType<typeof setTimeout>>
  /** Sequential decode → schedule chain. */
  chain: Promise<void>
  /** Chunks accepted but not yet scheduled (or dropped). */
  pendingChunks: number
  /** The `last` chunk was seen. */
  ended: boolean
  finished: boolean
}

type SinkCapableContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Create the player. Throws synchronously when Web Audio is unavailable (the overlay then uses a
 * no-op player).
 */
export function createPlayer(options: PlayerOptions): Player {
  if (typeof AudioContext === 'undefined') throw new Error('Web Audio unavailable')

  const ctx: SinkCapableContext = new AudioContext({ latencyHint: 'interactive' })
  const analyser = ctx.createAnalyser()
  analyser.fftSize = ANALYSER_FFT_SIZE
  analyser.smoothingTimeConstant = 0
  const gain = ctx.createGain()
  gain.gain.value = clampVolume(options.volume)
  analyser.connect(gain)
  gain.connect(ctx.destination)
  const timeData = new Float32Array(analyser.fftSize)

  let active: Turn | null = null
  const finishedTurns: string[] = []
  let mouth = 0
  let mouthFrame: number | null = null
  /** True between the first scheduled chunk of a turn and the onMouth(0) that closes it. */
  let mouthActive = false
  let disposed = false

  if (options.outputDeviceId) {
    void setOutputDevice(options.outputDeviceId).catch((err: unknown) => console.warn('[player] setSinkId failed', err))
  }

  function clampVolume(v: number): number {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
  }

  function rememberFinished(id: string): void {
    finishedTurns.push(id)
    if (finishedTurns.length > REMEMBERED_TURNS) finishedTurns.shift()
  }

  // ---- lip sync ---------------------------------------------------------------------------------

  function mouthLoop(): void {
    mouthFrame = null
    if (!active || disposed) {
      stopMouthLoop()
      return
    }
    analyser.getFloatTimeDomainData(timeData)
    mouth = smoothMouth(mouth, mouthTarget(rms(timeData)))
    options.onMouth(mouth)
    mouthFrame = requestAnimationFrame(mouthLoop)
  }

  function ensureMouthLoop(): void {
    mouthActive = true
    if (mouthFrame === null && typeof requestAnimationFrame === 'function') mouthFrame = requestAnimationFrame(mouthLoop)
  }

  /** Cancel the rAF loop and report a closed mouth exactly once per playback. */
  function stopMouthLoop(): void {
    if (mouthFrame !== null) {
      cancelAnimationFrame(mouthFrame)
      mouthFrame = null
    }
    mouth = 0
    if (mouthActive) {
      mouthActive = false
      options.onMouth(0)
    }
  }

  // ---- turns ------------------------------------------------------------------------------------

  function newTurn(id: string): Turn {
    return {
      id,
      pcm: createPcm16Decoder(),
      lastEnd: 0,
      sources: new Set(),
      timers: new Set(),
      chain: Promise.resolve(),
      pendingChunks: 0,
      ended: false,
      finished: false,
    }
  }

  function finishTurn(turn: Turn, stopped: boolean): void {
    if (turn.finished) return
    turn.finished = true
    for (const timer of turn.timers) clearTimeout(timer)
    turn.timers.clear()
    for (const src of turn.sources) {
      src.onended = null
      try {
        src.stop()
      } catch {
        /* not started / already stopped */
      }
      try {
        src.disconnect()
      } catch {
        /* ignore */
      }
    }
    turn.sources.clear()
    rememberFinished(turn.id)
    if (active === turn) active = null
    stopMouthLoop()
    options.onTurnFinished(turn.id, stopped)
  }

  /** Finish naturally when the last chunk was seen and nothing is pending or playing. */
  function maybeFinish(turn: Turn): void {
    if (turn.finished || !turn.ended) return
    if (turn.pendingChunks === 0 && turn.sources.size === 0) finishTurn(turn, false)
  }

  async function decode(turn: Turn, chunk: SpeechChunk, bytes: Uint8Array): Promise<AudioBuffer | null> {
    if (chunk.format === 'pcm') {
      const samples = turn.pcm.decode(bytes)
      if (samples.length === 0) return null
      const rate = chunk.sampleRate ?? DEFAULT_PCM_RATE
      const buffer = ctx.createBuffer(1, samples.length, rate)
      buffer.copyToChannel(samples, 0)
      return buffer
    }
    // decodeAudioData detaches the ArrayBuffer – hand it a copy so the chunk stays usable.
    return ctx.decodeAudioData(bytes.slice().buffer)
  }

  function schedule(turn: Turn, chunk: SpeechChunk, buffer: AudioBuffer): void {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(analyser)
    const when = nextStartTime(ctx.currentTime, turn.lastEnd)
    turn.lastEnd = when + buffer.duration
    turn.sources.add(src)
    src.onended = () => {
      src.onended = null
      try {
        src.disconnect()
      } catch {
        /* ignore */
      }
      turn.sources.delete(src)
      maybeFinish(turn)
    }
    src.start(when)
    if (options.onChunkStart) {
      const delayMs = Math.max(0, (when - ctx.currentTime) * 1000)
      const timer = setTimeout(() => {
        turn.timers.delete(timer)
        if (!turn.finished) options.onChunkStart?.(chunk)
      }, delayMs)
      turn.timers.add(timer)
    }
    ensureMouthLoop()
  }

  async function processChunk(turn: Turn, chunk: SpeechChunk): Promise<void> {
    if (turn.finished) return
    const bytes = audioBytes(chunk.audio)
    let buffer: AudioBuffer | null = null
    if (bytes.byteLength > 0) {
      try {
        buffer = await decode(turn, chunk, bytes)
      } catch (err) {
        console.warn(`[player] decode failed (turn ${chunk.turnId} seq ${chunk.seq}, ${chunk.format})`, err)
        options.onError?.(toError(err), chunk)
      }
    }
    if (turn.finished) return
    if (buffer) schedule(turn, chunk, buffer)
  }

  function enqueue(chunk: SpeechChunk): void {
    if (disposed) return
    if (active && active.id !== chunk.turnId) finishTurn(active, true)
    if (!active) {
      if (finishedTurns.includes(chunk.turnId)) return // late chunk of a turn that already ended
      active = newTurn(chunk.turnId)
      if (ctx.state !== 'running') void ctx.resume().catch((err: unknown) => console.warn('[player] resume failed', err))
    }
    const turn = active
    if (turn.ended) return // chunks after `last` are ignored
    if (chunk.last) turn.ended = true
    turn.pendingChunks++
    turn.chain = turn.chain
      .then(() => processChunk(turn, chunk))
      .catch((err: unknown) => {
        console.warn('[player] chunk processing failed', err)
        options.onError?.(toError(err), chunk)
      })
      .then(() => {
        turn.pendingChunks--
        maybeFinish(turn)
      })
  }

  function stop(): void {
    if (active) finishTurn(active, true)
  }

  function setVolume(volume: number): void {
    const target = clampVolume(volume)
    const now = ctx.currentTime
    const param = gain.gain
    try {
      param.cancelScheduledValues(now)
      param.setValueAtTime(param.value, now)
      param.linearRampToValueAtTime(target, now + VOLUME_RAMP_S)
    } catch {
      param.value = target
    }
  }

  async function setOutputDevice(deviceId: string): Promise<void> {
    if (typeof ctx.setSinkId !== 'function') {
      if (deviceId) throw new Error('AudioContext.setSinkId is not supported')
      return
    }
    await ctx.setSinkId(deviceId)
  }

  function dispose(): void {
    if (disposed) return
    stop()
    disposed = true
    stopMouthLoop()
    try {
      analyser.disconnect()
      gain.disconnect()
    } catch {
      /* ignore */
    }
    if (ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }

  return {
    enqueue,
    stop,
    isPlaying: () => active !== null,
    setVolume,
    setOutputDevice,
    currentTurn: () => active?.id ?? null,
    dispose,
  }
}
