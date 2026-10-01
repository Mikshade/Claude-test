/**
 * Microphone recorder (AudioWorklet → 16 kHz mono 16-bit WAV) with energy VAD auto-stop.
 *
 * Pipeline: getUserMedia → MediaStreamAudioSourceNode → AudioWorkletNode('flowy-recorder', loaded from
 * ../recorder-worklet.js in the public dir; fallback ScriptProcessorNode) → Float32 frames → VAD +
 * level meter → on stop: concat, resample to 16 kHz when the context could not be opened at that rate,
 * encode as PCM16 WAV.
 *
 * The AudioContext is created once and reused across recordings (the worklet module is loaded once);
 * each recording acquires its own MediaStream and releases the tracks when it stops (mic indicator off).
 *
 * OWNER: audio agent. Contract: ./types.ts. Pure helpers (exported, tested in recorder.test.ts):
 * buildConstraints, describeMediaError, levelFromRms, smoothLevel, buildRecording, workletModuleUrl.
 */
import type { Language } from '@shared/config'
import type { RecordedAudio } from '@shared/ipc'
import type { Recorder, RecorderOptions } from './types'
import { createVad, type Vad, type VadDecision } from './vad'
import { STT_SAMPLE_RATE, concatFloat32, encodeWav, resample, rms } from './wav'

export interface RecorderExtras {
  /** Language for the error messages thrown by start(). Default 'de'. */
  language?: Language
  /** Override the worklet module URL (tests / custom bundling). Default: ../recorder-worklet.js next to the page. */
  workletUrl?: string
}

/** The contract plus the extras this implementation understands (a plain `Recorder` for callers that do not care). */
export interface FlowyRecorder extends Recorder {
  setOptions(options: Partial<Pick<RecorderOptions, 'deviceId' | 'silenceTimeoutMs' | 'maxRecordingMs'>> & RecorderExtras): void
}

/** Name registered by src/renderer/public/recorder-worklet.js. */
export const WORKLET_PROCESSOR_NAME = 'flowy-recorder'
/** Frame length the worklet batches to (seconds). */
export const FRAME_SECONDS = 0.02
/** Recordings shorter than this are discarded (accidental taps). */
export const MIN_RECORDING_MS = 300
/** Minimum interval between onLevel() calls (~20 Hz). */
export const LEVEL_INTERVAL_MS = 45
/** Level meter smoothing: fast attack, slower release. */
export const LEVEL_ATTACK = 0.5
export const LEVEL_RELEASE = 0.2
/** ScriptProcessorNode buffer size for the fallback path (≈21 ms at 48 kHz, 64 ms at 16 kHz). */
export const SCRIPT_PROCESSOR_BUFFER = 1024

// ---- i18n -------------------------------------------------------------------------------------

const STRINGS = {
  de: {
    denied: 'Mikrofonzugriff verweigert – Windows-Einstellungen → Datenschutz → Mikrofon',
    notFound: 'Kein Mikrofon gefunden',
    busy: 'Mikrofon ist belegt oder nicht verfügbar',
    noAudio: 'Audiosystem nicht verfügbar',
    generic: 'Mikrofon konnte nicht gestartet werden',
  },
  en: {
    denied: 'Microphone access denied – Windows Settings → Privacy → Microphone',
    notFound: 'No microphone found',
    busy: 'Microphone is busy or unavailable',
    noAudio: 'Audio system unavailable',
    generic: 'Could not start the microphone',
  },
} as const

type StringKey = keyof (typeof STRINGS)['de']

function t(language: Language | undefined, key: StringKey): string {
  return (language && STRINGS[language] ? STRINGS[language] : STRINGS.de)[key]
}

// ---- pure helpers -----------------------------------------------------------------------------

/** getUserMedia constraints: exact device when one is configured, mono with the Chromium voice processing on. */
export function buildConstraints(deviceId: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true, // keeps her own TTS (played through the speakers) out of the recording
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  }
  if (deviceId) audio.deviceId = { exact: deviceId }
  return { audio, video: false }
}

/** Map a getUserMedia / AudioContext failure to a readable, localised Error (the original is `cause`). */
export function describeMediaError(err: unknown, language: Language = 'de'): Error {
  const named = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  const name = err instanceof Error ? err.name : String(named ?? '')
  const message = err instanceof Error ? err.message : String(err)
  let text: string
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      text = t(language, 'denied')
      break
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      text = t(language, 'notFound')
      break
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      text = t(language, 'busy')
      break
    case 'NotSupportedError':
      text = t(language, 'noAudio')
      break
    default:
      text = message ? `${t(language, 'generic')}: ${message}` : t(language, 'generic')
  }
  const out = new Error(text, { cause: err })
  out.name = 'RecorderError'
  return out
}

/** Perceptual 0..1 meter value from a frame RMS (≈0.19 at the speech threshold, 1 from rms ≈ 0.33). */
export function levelFromRms(frameRms: number): number {
  if (!(frameRms > 0)) return 0
  return Math.min(1, Math.sqrt(frameRms * 3))
}

/** Asymmetric smoothing for the meter: jumps up quickly, falls back slowly. */
export function smoothLevel(previous: number, target: number, attack = LEVEL_ATTACK, release = LEVEL_RELEASE): number {
  const k = target > previous ? attack : release
  const next = previous + (target - previous) * k
  return next < 0.005 ? 0 : next
}

/**
 * Turn captured frames into the IPC payload: resample to 16 kHz when needed, encode WAV.
 * Returns null when nothing usable was captured (too short or no speech detected).
 */
export function buildRecording(frames: readonly Float32Array[], captureRate: number, hadSpeech: boolean): RecordedAudio | null {
  let samples = concatFloat32(frames)
  const durationMs = Math.round((samples.length / captureRate) * 1000)
  if (durationMs < MIN_RECORDING_MS || !hadSpeech) return null
  if (captureRate !== STT_SAMPLE_RATE) samples = resample(samples, captureRate, STT_SAMPLE_RATE)
  const wav = encodeWav(samples, STT_SAMPLE_RATE, 1)
  return { data: wav.buffer, mimeType: 'audio/wav', durationMs }
}

/** URL of the worklet module relative to the page (public dir is served at the renderer root; the page is one level down). */
export function workletModuleUrl(baseUri?: string): string {
  baseUri ??= typeof document !== 'undefined' ? document.baseURI : undefined
  if (!baseUri) return 'recorder-worklet.js'
  try {
    return new URL('../recorder-worklet.js', baseUri).href
  } catch {
    return 'recorder-worklet.js'
  }
}

// ---- recorder ---------------------------------------------------------------------------------

interface Session {
  id: number
  vad: Vad
  frames: Float32Array[]
  stream: MediaStream | null
  nodes: AudioNode[]
  worklet: AudioWorkletNode | null
  level: number
  lastLevelAt: number
  /** Set by cancel(): discard everything, even if start() is still awaiting the mic. */
  cancelled: boolean
  /** Resolves when start() finished (successfully or not); stop() waits for it. */
  ready: Promise<void>
}

/**
 * Create the recorder. Throws synchronously only when the Web Audio / media APIs are missing
 * entirely (the overlay then falls back to a no-op recorder).
 */
export function createRecorder(options: RecorderOptions & RecorderExtras): FlowyRecorder {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof AudioContext === 'undefined') {
    throw new Error('Web Audio / mediaDevices unavailable')
  }

  let deviceId = options.deviceId
  let silenceTimeoutMs = options.silenceTimeoutMs
  let maxRecordingMs = options.maxRecordingMs
  let language = options.language ?? 'de'
  const workletUrl = options.workletUrl ?? workletModuleUrl()

  let ctx: AudioContext | null = null
  let captureRate = STT_SAMPLE_RATE
  let workletLoaded: Promise<boolean> | null = null
  let session: Session | null = null
  let sessionSeq = 0
  let disposed = false

  // ---- context / worklet (created once) --------------------------------------------------------

  function ensureContext(): AudioContext {
    if (ctx && ctx.state !== 'closed') return ctx
    try {
      ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE, latencyHint: 'interactive' })
      captureRate = ctx.sampleRate || STT_SAMPLE_RATE
    } catch (err) {
      console.warn('[recorder] 16 kHz AudioContext unavailable, capturing at the device rate', err)
      ctx = new AudioContext({ latencyHint: 'interactive' })
      captureRate = ctx.sampleRate
    }
    workletLoaded = null
    return ctx
  }

  function loadWorklet(context: AudioContext): Promise<boolean> {
    workletLoaded ??= (async () => {
      try {
        if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false
        await context.audioWorklet.addModule(workletUrl)
        return true
      } catch (err) {
        console.warn('[recorder] AudioWorklet unavailable, falling back to ScriptProcessorNode', err)
        return false
      }
    })()
    return workletLoaded
  }

  // ---- frames -----------------------------------------------------------------------------------

  function onFrame(s: Session, frame: Float32Array): void {
    if (session !== s || s.cancelled || frame.length === 0) return
    s.frames.push(frame)
    const now = performance.now()
    const frameRms = rms(frame)
    s.level = smoothLevel(s.level, levelFromRms(frameRms))
    if (options.onLevel && now - s.lastLevelAt >= LEVEL_INTERVAL_MS) {
      s.lastLevelAt = now
      options.onLevel(s.level)
    }
    const decision = s.vad.feed(frameRms, now)
    if (decision !== 'continue') autoStop(s, decision)
  }

  function autoStop(s: Session, reason: VadDecision): void {
    if (session !== s) return
    console.info(`[recorder] auto-stop (${reason}) after ${Math.round(s.vad.elapsedMs())} ms`)
    const audio = finish(s)
    options.onAutoStop?.(audio)
  }

  // ---- graph ------------------------------------------------------------------------------------

  async function attachTap(context: AudioContext, s: Session): Promise<void> {
    const stream = s.stream
    if (!stream) return
    const source = context.createMediaStreamSource(stream)
    s.nodes.push(source)
    // A muted gain keeps the graph "pulled" by the destination (required for ScriptProcessorNode, and
    // the safe choice for a worklet with an output) without the mic ever reaching the speakers.
    const mute = context.createGain()
    mute.gain.value = 0
    s.nodes.push(mute)

    const useWorklet = await loadWorklet(context)
    if (session !== s || s.cancelled) return

    if (useWorklet) {
      const node = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { frameSize: Math.round(captureRate * FRAME_SECONDS) },
      })
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof Float32Array) onFrame(s, event.data)
      }
      s.worklet = node
      s.nodes.push(node)
      source.connect(node)
      node.connect(mute)
    } else {
      const node = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1)
      node.onaudioprocess = (event: AudioProcessingEvent) => {
        // The input buffer is reused by the engine – copy it.
        onFrame(s, new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      s.nodes.push(node)
      source.connect(node)
      node.connect(mute)
    }
    mute.connect(context.destination)
  }

  function stopTracks(stream: MediaStream | null): void {
    if (!stream) return
    for (const track of stream.getTracks()) {
      try {
        track.stop()
      } catch {
        /* already stopped */
      }
    }
  }

  function teardown(s: Session): void {
    s.cancelled = true
    if (s.worklet) {
      try {
        s.worklet.port.onmessage = null
        s.worklet.port.postMessage('stop')
      } catch {
        /* port closed */
      }
      s.worklet = null
    }
    for (const node of s.nodes) {
      try {
        if ('onaudioprocess' in node) (node as ScriptProcessorNode).onaudioprocess = null
        node.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    s.nodes = []
    stopTracks(s.stream)
    s.stream = null
    if (session === s) session = null
  }

  /** Finalise a session: tear it down and build the WAV (null when unusable). */
  function finish(s: Session): RecordedAudio | null {
    const frames = s.frames
    const hadSpeech = s.vad.hadSpeech()
    teardown(s)
    options.onLevel?.(0)
    const audio = buildRecording(frames, captureRate, hadSpeech)
    if (!audio) console.info(`[recorder] discarded recording (${frames.length} frames, speech=${hadSpeech})`)
    return audio
  }

  async function acquireStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(buildConstraints(deviceId))
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      // The configured microphone is gone (unplugged) – retry once with the system default.
      if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'ConstraintNotSatisfiedError')) {
        console.warn(`[recorder] microphone ${deviceId} unavailable, using the default device`)
        return navigator.mediaDevices.getUserMedia(buildConstraints(''))
      }
      throw err
    }
  }

  // ---- public API -------------------------------------------------------------------------------

  async function start(): Promise<void> {
    if (disposed) throw new Error('recorder disposed')
    if (session) return session.ready
    const s: Session = {
      id: ++sessionSeq,
      vad: createVad({ silenceTimeoutMs, maxRecordingMs }),
      frames: [],
      stream: null,
      nodes: [],
      worklet: null,
      level: 0,
      lastLevelAt: 0,
      cancelled: false,
      ready: Promise.resolve(),
    }
    session = s
    s.ready = (async () => {
      try {
        const stream = await acquireStream()
        if (s.cancelled) {
          stopTracks(stream)
          return
        }
        s.stream = stream
        const context = ensureContext()
        if (context.state !== 'running') await context.resume()
        if (s.cancelled) {
          stopTracks(stream)
          return
        }
        await attachTap(context, s)
        if (s.cancelled) {
          teardown(s)
          return
        }
        s.vad.reset(performance.now())
        console.info(`[recorder] started (${captureRate} Hz, ${s.worklet ? 'worklet' : 'script-processor'})`)
      } catch (err) {
        teardown(s)
        throw describeMediaError(err, language)
      }
    })()
    return s.ready
  }

  async function stop(): Promise<RecordedAudio | null> {
    const s = session
    if (!s) return null
    await s.ready.catch(() => undefined)
    if (session !== s) return null // auto-stopped or cancelled while we waited
    return finish(s)
  }

  function cancel(): void {
    const s = session
    if (!s) return
    teardown(s)
    options.onLevel?.(0)
  }

  const setOptions: FlowyRecorder['setOptions'] = (next) => {
    if (next.deviceId !== undefined) deviceId = next.deviceId
    if (next.silenceTimeoutMs !== undefined) silenceTimeoutMs = next.silenceTimeoutMs
    if (next.maxRecordingMs !== undefined) maxRecordingMs = next.maxRecordingMs
    if (next.language !== undefined) language = next.language
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancel()
    const context = ctx
    ctx = null
    workletLoaded = null
    if (context && context.state !== 'closed') void context.close().catch(() => undefined)
  }

  return {
    start,
    stop,
    cancel,
    isRecording: () => session !== null,
    setOptions,
    dispose,
  }
}
