/**
 * Fish Audio cloud TTS provider (api.fish.audio) on top of src/main/net/fishAudio.ts.
 *
 * - `model` goes into the HTTP header, the voice is `reference_id` (or inline `references` when a clone
 *   sample is configured – those force a msgpack body, handled by fishTts).
 * - pcm output is requested at 24 kHz so the renderer can feed it straight into Web Audio.
 * - One retry on 429/5xx, abort via AbortSignal, cleanForSpeech + emotion cue on every sentence.
 */
import { readFile as fsReadFile } from 'node:fs/promises'
import type { TtsConfig } from '@shared/config'
import type { TestResult, VoiceInfo } from '@shared/ipc'
import { createLogger } from '../log'
import {
  FISH_CLOUD_BASE_URL,
  FishAudioHttpError,
  fishGetCredit,
  fishGetVoice,
  fishListVoices,
  fishTts,
  parseReferenceId,
  type FishClientOptions,
  type FishReferenceAudio,
  type FishTtsRequestBody,
  type FishVoiceModel,
} from '../net/fishAudio'
import { defaultSleep, isAbortError, prepareText, toError, withSingleRetry, type SleepFn } from './common'
import { cueStyleForCloudModel } from './cues'
import type { SynthesizeOptions, TtsAudio, TtsClient } from './types'

const log = createLogger('tts:cloud')

export const CLOUD_PCM_SAMPLE_RATE = 24000
export const CLOUD_MP3_BITRATE = 128
export const CLOUD_CHUNK_LENGTH = 150
export const CLOUD_MIN_CHUNK_LENGTH = 30
export const VOICE_SEARCH_PAGE_SIZE = 30

export const KEY_INVALID_MESSAGE = 'Fish Audio API-Key ungültig'
export const NO_CREDITS_MESSAGE = 'Fish Audio Guthaben aufgebraucht – bitte unter fish.audio/app/developers/billing aufladen'

export interface FishCloudDeps {
  fetchImpl?: typeof fetch
  /** Reads the clone sample file (defaults to fs.readFile). */
  readFile?: (path: string) => Promise<Uint8Array>
  sleep?: SleepFn
}

/** Map Fish voice models to the IPC VoiceInfo shape, keeping only usable (tts + trained) voices. */
export function toVoiceInfos(items: FishVoiceModel[]): VoiceInfo[] {
  return items
    .filter((v) => v.type === 'tts' && v.state === 'trained')
    .map((v) => {
      const info: VoiceInfo = {
        id: v._id,
        title: v.title ?? '',
        description: v.description ?? '',
        languages: v.languages ?? [],
        tags: v.tags ?? [],
        author: v.author?.nickname ?? '',
        popularity: v.task_count ?? 0,
      }
      const sample = v.samples?.[0]?.audio
      if (sample) info.sampleUrl = sample
      if (v.cover_image) info.coverImage = v.cover_image
      return info
    })
}

/** Human-readable German message for a failed cloud call. */
export function describeCloudError(err: unknown): string {
  if (err instanceof FishAudioHttpError) {
    if (err.isAuth) return KEY_INVALID_MESSAGE
    if (err.isOutOfCredits) return NO_CREDITS_MESSAGE
    return `Fish Audio Fehler (HTTP ${err.status}): ${err.message}`
  }
  const e = toError(err)
  if (e.message === 'empty') return 'Kein sprechbarer Text.'
  if (isAbortError(e)) return 'Abgebrochen.'
  return `Fish Audio nicht erreichbar: ${e.message}`
}

export function createFishCloudTts(config: TtsConfig, deps: FishCloudDeps = {}): TtsClient {
  const cloud = config.fishCloud
  const opts: FishClientOptions = {
    baseUrl: FISH_CLOUD_BASE_URL,
    apiKey: cloud.apiKey,
    model: cloud.model,
    fetchImpl: deps.fetchImpl,
  }
  const sleep = deps.sleep ?? defaultSleep
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path))
  const cueStyle = cueStyleForCloudModel(cloud.model)
  const referenceId = cloud.referenceId.trim() ? (parseReferenceId(cloud.referenceId) ?? cloud.referenceId.trim()) : null

  // The clone sample is read once per client and cached (also when unreadable → fall back to reference_id).
  let referencesPromise: Promise<FishReferenceAudio[] | null> | null = null
  function loadReferences(): Promise<FishReferenceAudio[] | null> {
    const audioPath = cloud.cloneSample.audioPath.trim()
    if (!audioPath) return Promise.resolve(null)
    referencesPromise ??= readFile(audioPath).then(
      (bytes) => {
        if (!bytes.byteLength) {
          log.warn(`clone sample ${audioPath} is empty – using reference_id instead`)
          return null
        }
        if (!cloud.cloneSample.transcript.trim()) log.warn('clone sample has no transcript – cloning quality will suffer')
        log.info(`clone sample loaded (${bytes.byteLength} bytes)`)
        return [{ audio: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), text: cloud.cloneSample.transcript }]
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
      format: cloud.format,
      latency: cloud.latency,
      chunk_length: CLOUD_CHUNK_LENGTH,
      min_chunk_length: CLOUD_MIN_CHUNK_LENGTH,
      normalize: true,
      prosody: { speed: config.speed, volume: 0 },
    }
    const references = await loadReferences()
    if (references) body.references = references
    else body.reference_id = referenceId
    if (cloud.format === 'pcm') body.sample_rate = CLOUD_PCM_SAMPLE_RATE
    if (cloud.format === 'mp3') body.mp3_bitrate = CLOUD_MP3_BITRATE
    return body
  }

  function toAudio(data: ArrayBuffer): TtsAudio {
    const audio: TtsAudio = { data, format: cloud.format }
    if (cloud.format === 'pcm') audio.sampleRate = CLOUD_PCM_SAMPLE_RATE
    return audio
  }

  async function synthesize(text: string, options: SynthesizeOptions = {}): Promise<TtsAudio> {
    const spoken = prepareText(text, options.emotion, cueStyle, config.emotionCues)
    const body = await buildBody(spoken)
    const data = await withSingleRetry(() => fishTts(opts, body, options.signal), options.signal, sleep, log)
    return toAudio(data)
  }

  async function test(sampleText: string): Promise<TestResult> {
    let credit: string
    try {
      credit = (await fishGetCredit(opts)).credit
    } catch (err) {
      log.warn('credit check failed', toError(err).message)
      return { ok: false, message: describeCloudError(err) }
    }
    try {
      const audio = await synthesize(sampleText)
      return { ok: true, message: `OK – Guthaben: ${formatCredit(credit)} USD`, audio }
    } catch (err) {
      log.warn('test synthesis failed', toError(err).message)
      return { ok: false, message: describeCloudError(err) }
    }
  }

  async function searchVoices(query: string): Promise<VoiceInfo[]> {
    const id = parseReferenceId(query)
    if (id) {
      try {
        return toVoiceInfos([await fishGetVoice(opts, id)])
      } catch (err) {
        if (err instanceof FishAudioHttpError && err.status === 404) return []
        throw err
      }
    }
    const title = query.trim()
    const list = await fishListVoices(opts, {
      title: title || undefined,
      sort_by: 'task_count',
      page_size: VOICE_SEARCH_PAGE_SIZE,
    })
    return toVoiceInfos(list.items ?? [])
  }

  return { name: 'fish-cloud', synthesize, test, searchVoices }
}

function formatCredit(credit: string): string {
  const n = Number(credit)
  return Number.isFinite(n) ? n.toFixed(2) : credit
}
