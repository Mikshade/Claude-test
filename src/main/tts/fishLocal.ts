/**
 * Local Fish Speech server provider (`python tools/api_server.py`, default http://127.0.0.1:8080).
 *
 * Same /v1/tts route as the cloud, but the open-source pydantic schema is strict: only wav|mp3 produce audio,
 * chunk_length must be an int in 100..300, temperature/top_p in 0.1..1 – and cloud-only fields (latency,
 * prosody, sample_rate, …) are deliberately NOT sent. The realistic local checkpoint is S1-mini, so emotion
 * cues use the S1 parentheses style.
 */
import { readFile as fsReadFile } from 'node:fs/promises'
import type { TtsConfig } from '@shared/config'
import type { TestResult } from '@shared/ipc'
import { createLogger } from '../log'
import {
  FishAudioHttpError,
  fishLocalHealth,
  fishTts,
  type FishClientOptions,
  type FishReferenceAudio,
  type FishTtsRequestBody,
} from '../net/fishAudio'
import { defaultSleep, isAbortError, prepareText, toError, withSingleRetry, type SleepFn } from './common'
import type { SynthesizeOptions, TtsAudio, TtsClient } from './types'

const log = createLogger('tts:local')

export const LOCAL_CHUNK_LENGTH = 200
export const LOCAL_CHUNK_LENGTH_MIN = 100
export const LOCAL_CHUNK_LENGTH_MAX = 300
export const LOCAL_TEMPERATURE = 0.8
export const LOCAL_TOP_P = 0.8
export const LOCAL_REPETITION_PENALTY = 1.1

export const LOCAL_KEY_INVALID_MESSAGE = 'Fish Speech API-Key ungültig (der Server wurde mit --api-key gestartet)'

export function serverUnreachableMessage(baseUrl: string): string {
  return `Fish Speech Server nicht erreichbar unter ${baseUrl} – läuft \`tools/api_server.py\`?`
}

export interface FishLocalDeps {
  fetchImpl?: typeof fetch
  /** Reads the clone sample file (defaults to fs.readFile). */
  readFile?: (path: string) => Promise<Uint8Array>
  sleep?: SleepFn
  /** Override for chunk_length (clamped to 100..300, rounded to an int). Default 200. */
  chunkLength?: number
}

/** The local schema wants a strict int in 100..300. */
export function clampChunkLength(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return LOCAL_CHUNK_LENGTH
  return Math.min(LOCAL_CHUNK_LENGTH_MAX, Math.max(LOCAL_CHUNK_LENGTH_MIN, Math.round(value)))
}

/** The open-source server only produces wav/mp3 (pcm/opus → HTTP 500). */
export function normalizeLocalFormat(format: string): 'wav' | 'mp3' {
  return format === 'mp3' ? 'mp3' : 'wav'
}

export function createFishLocalTts(config: TtsConfig, deps: FishLocalDeps = {}): TtsClient {
  const local = config.fishLocal
  const baseUrl = local.baseUrl.trim().replace(/\/+$/, '')
  const opts: FishClientOptions = { baseUrl, fetchImpl: deps.fetchImpl }
  if (local.apiKey.trim()) opts.apiKey = local.apiKey.trim()
  const sleep = deps.sleep ?? defaultSleep
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path))
  const format = normalizeLocalFormat(local.format)
  const chunkLength = clampChunkLength(deps.chunkLength)
  const referenceId = local.referenceId.trim() || null
  if (local.format !== format) log.warn(`format '${local.format}' is not supported by the local server – using '${format}'`)

  let referencesPromise: Promise<FishReferenceAudio[] | null> | null = null
  function loadReferences(): Promise<FishReferenceAudio[] | null> {
    const audioPath = local.cloneSample.audioPath.trim()
    if (!audioPath) return Promise.resolve(null)
    referencesPromise ??= readFile(audioPath).then(
      (bytes) => {
        if (!bytes.byteLength) {
          log.warn(`clone sample ${audioPath} is empty – using reference_id instead`)
          return null
        }
        if (!local.cloneSample.transcript.trim()) log.warn('clone sample has no transcript – cloning quality will suffer')
        log.info(`clone sample loaded (${bytes.byteLength} bytes)`)
        return [{ audio: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), text: local.cloneSample.transcript }]
      },
      (err: unknown) => {
        log.warn(`clone sample ${audioPath} not readable (${toError(err).message}) – using reference_id instead`)
        return null
      },
    )
    return referencesPromise
  }

  async function buildBody(text: string): Promise<FishTtsRequestBody> {
    const body: FishTtsRequestBody = {
      text,
      format,
      chunk_length: chunkLength,
      temperature: LOCAL_TEMPERATURE,
      top_p: LOCAL_TOP_P,
      repetition_penalty: LOCAL_REPETITION_PENALTY,
      normalize: true,
      streaming: false,
    }
    const references = await loadReferences()
    if (references) {
      body.references = references
      body.use_memory_cache = 'on'
    } else {
      body.reference_id = referenceId
    }
    return body
  }

  async function synthesize(text: string, options: SynthesizeOptions = {}): Promise<TtsAudio> {
    const spoken = prepareText(text, options.emotion, 'S1', config.emotionCues)
    const body = await buildBody(spoken)
    let data: ArrayBuffer
    try {
      data = await withSingleRetry(() => fishTts(opts, body, options.signal), options.signal, sleep, log)
    } catch (err) {
      if (isAbortError(err)) throw err
      if (err instanceof FishAudioHttpError) {
        if (err.isAuth) throw new Error(LOCAL_KEY_INVALID_MESSAGE, { cause: err })
        throw err
      }
      // fetch itself failed (ECONNREFUSED, DNS, …): the server is not running.
      throw new Error(`${serverUnreachableMessage(baseUrl)} (${toError(err).message})`, { cause: err })
    }
    return { data, format }
  }

  async function test(sampleText: string): Promise<TestResult> {
    const health = await fishLocalHealth(opts)
    if (!health.up) return { ok: false, message: serverUnreachableMessage(baseUrl) }
    if (health.authError) return { ok: false, message: LOCAL_KEY_INVALID_MESSAGE }
    try {
      const audio = await synthesize(sampleText)
      return { ok: true, message: `OK – Fish Speech Server unter ${baseUrl} antwortet`, audio }
    } catch (err) {
      const message = toError(err).message
      log.warn('test synthesis failed', message)
      return { ok: false, message: message === 'empty' ? 'Kein sprechbarer Text.' : message }
    }
  }

  return { name: 'fish-local', synthesize, test }
}
