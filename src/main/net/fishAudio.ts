/**
 * Low-level Fish Audio HTTP client, shared by TTS (cloud + local Fish Speech server) and STT.
 *
 * Verified against the Fish Audio OpenAPI spec (docs.fish.audio) and the open-source
 * fish-speech server sources (tools/server/views.py). Key facts:
 *  - Auth: `Authorization: Bearer <key>`; the TTS/ASR model is the `model` HTTP HEADER, not a body field.
 *  - POST /v1/tts accepts application/json or application/msgpack; inline `references` (voice cloning
 *    audio bytes) require msgpack. Response = raw audio bytes in the requested `format` (chunked).
 *  - POST /v1/asr accepts multipart/form-data (field `audio`) or msgpack; never JSON+base64.
 *  - GET /model (no /v1 prefix) lists voices; GET /wallet/self/api-credit validates a key.
 *  - The local server: same /v1/tts, only wav|mp3 work, `latency` must be normal|balanced,
 *    strict ranges (chunk_length 100..300 int, top_p/temperature 0.1..1), GET /v1/health → {status:'ok'}.
 */
import { encode as msgpackEncode } from '@msgpack/msgpack'

export const FISH_CLOUD_BASE_URL = 'https://api.fish.audio'

export class FishAudioHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Fish Audio HTTP ${status}: ${describeBody(body)}`)
    this.name = 'FishAudioHttpError'
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
  get isOutOfCredits(): boolean {
    return this.status === 402
  }
  get isRateLimited(): boolean {
    return this.status === 429
  }
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

function describeBody(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 300)
  if (body && typeof body === 'object' && 'message' in body) return String((body as { message: unknown }).message)
  try {
    return JSON.stringify(body).slice(0, 300)
  } catch {
    return String(body)
  }
}

export interface FishClientOptions {
  /** `https://api.fish.audio` or e.g. `http://127.0.0.1:8080` for the local server. */
  baseUrl: string
  apiKey?: string
  /** Cloud TTS/ASR model header (ignored by the local server). */
  model?: string
  fetchImpl?: typeof fetch
}

export interface FishReferenceAudio {
  /** Raw wav/mp3/flac bytes of 10–30 s clean speech. */
  audio: Uint8Array
  /** Exact transcript of the sample. */
  text: string
}

/** Mirrors the TTSRequest schema (cloud) ∪ ServeTTSRequest (local). Only `text` is required. */
export interface FishTtsRequestBody {
  text: string
  reference_id?: string | null
  references?: FishReferenceAudio[]
  format?: 'mp3' | 'wav' | 'pcm' | 'opus'
  sample_rate?: number
  mp3_bitrate?: 64 | 128 | 192
  latency?: 'normal' | 'balanced' | 'low'
  chunk_length?: number
  min_chunk_length?: number
  normalize?: boolean
  temperature?: number
  top_p?: number
  repetition_penalty?: number
  max_new_tokens?: number
  prosody?: { speed?: number; volume?: number; normalize_loudness?: boolean }
  /** local only */
  streaming?: boolean
  use_memory_cache?: 'on' | 'off'
  seed?: number | null
}

export interface FishAsrResult {
  text: string
  duration: number
  segments: Array<{ text: string; start: number; end: number }>
  language_code?: string | null
  language?: string | null
}

export interface FishVoiceModel {
  _id: string
  type: 'svc' | 'tts'
  title: string
  description: string
  cover_image: string
  state: 'created' | 'training' | 'trained' | 'failed'
  tags: string[]
  languages: string[]
  visibility: 'public' | 'unlist' | 'private'
  samples: Array<{ title: string; text: string; task_id: string; audio: string }>
  author: { _id: string; nickname: string; avatar: string }
  like_count: number
  task_count: number
}

export interface FishVoiceList {
  total: number
  items: FishVoiceModel[]
  has_more?: boolean | null
}

export interface FishVoiceQuery {
  title?: string
  tag?: string | string[]
  language?: string | string[]
  sort_by?: 'score' | 'task_count' | 'created_at'
  page_size?: number
  page_number?: number
  self?: boolean
  licensed?: boolean
}

export function isCloudBase(baseUrl: string): boolean {
  return /^https:\/\/api\.fish\.audio\/?$/i.test(baseUrl.trim())
}

function base(opts: FishClientOptions): string {
  return opts.baseUrl.replace(/\/+$/, '')
}

function authHeaders(opts: FishClientOptions, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  if (opts.apiKey) h['Authorization'] = `Bearer ${opts.apiKey}`
  if (opts.model) h['model'] = opts.model
  return h
}

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Copy a (possibly offset) view into a standalone ArrayBuffer (needed for fetch/Blob with TS 5.7+ types). */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

/**
 * POST /v1/tts → complete audio bytes in `body.format`.
 * Uses JSON unless inline `references` are present (then msgpack, as the API requires).
 */
export async function fishTts(opts: FishClientOptions, body: FishTtsRequestBody, signal?: AbortSignal): Promise<ArrayBuffer> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const useMsgpack = Array.isArray(body.references) && body.references.length > 0
  const payload: string | ArrayBuffer = useMsgpack
    ? toArrayBuffer(msgpackEncode(body, { ignoreUndefined: true }))
    : JSON.stringify(stripUndefined(body))
  const res = await fetchImpl(`${base(opts)}/v1/tts`, {
    method: 'POST',
    headers: authHeaders(opts, { 'Content-Type': useMsgpack ? 'application/msgpack' : 'application/json' }),
    body: payload,
    signal,
  })
  if (!res.ok) throw new FishAudioHttpError(res.status, await readErrorBody(res))
  return res.arrayBuffer()
}

export interface FishAsrOptions {
  language?: string
  ignoreTimestamps?: boolean
  mimeType?: string
  filename?: string
}

/** POST /v1/asr (multipart). Cloud only – the local server has no ASR. */
export async function fishAsr(
  opts: FishClientOptions,
  audio: Uint8Array,
  asr: FishAsrOptions = {},
  signal?: AbortSignal,
): Promise<FishAsrResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const form = new FormData()
  form.append('audio', new Blob([toArrayBuffer(audio)], { type: asr.mimeType ?? 'audio/wav' }), asr.filename ?? 'speech.wav')
  if (asr.language) form.append('language', asr.language)
  form.append('ignore_timestamps', String(asr.ignoreTimestamps ?? true))
  const res = await fetchImpl(`${base(opts)}/v1/asr`, {
    method: 'POST',
    headers: authHeaders(opts), // fetch sets the multipart boundary
    body: form,
    signal,
  })
  if (!res.ok) throw new FishAudioHttpError(res.status, await readErrorBody(res))
  return (await res.json()) as FishAsrResult
}

/** GET /model – list/search voices (cloud). */
export async function fishListVoices(opts: FishClientOptions, query: FishVoiceQuery = {}, signal?: AbortSignal): Promise<FishVoiceList> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = new URL(`${base(opts)}/model`)
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)))
    else url.searchParams.set(k, String(v))
  }
  const res = await fetchImpl(url.toString(), { headers: authHeaders(opts), signal })
  if (!res.ok) throw new FishAudioHttpError(res.status, await readErrorBody(res))
  return (await res.json()) as FishVoiceList
}

/** GET /model/{id} – validate a reference id (404 when unknown). */
export async function fishGetVoice(opts: FishClientOptions, id: string, signal?: AbortSignal): Promise<FishVoiceModel> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(`${base(opts)}/model/${encodeURIComponent(id)}`, { headers: authHeaders(opts), signal })
  if (!res.ok) throw new FishAudioHttpError(res.status, await readErrorBody(res))
  return (await res.json()) as FishVoiceModel
}

export interface FishCredit {
  credit: string
  cumulative_top_up: string
  has_free_credit?: boolean | null
}

/** GET /wallet/self/api-credit – cheapest way to validate a cloud key (401 on a bad key). */
export async function fishGetCredit(opts: FishClientOptions, signal?: AbortSignal): Promise<FishCredit> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(`${base(opts)}/wallet/self/api-credit?check_free_credit=true`, { headers: authHeaders(opts), signal })
  if (!res.ok) throw new FishAudioHttpError(res.status, await readErrorBody(res))
  return (await res.json()) as FishCredit
}

/** GET /v1/health on the local server → true when `{status:'ok'}` (401 also means "process is up"). */
export async function fishLocalHealth(opts: FishClientOptions, signal?: AbortSignal): Promise<{ up: boolean; authError: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`${base(opts)}/v1/health`, { headers: authHeaders(opts), signal })
    if (res.status === 401) return { up: true, authError: true }
    if (!res.ok) return { up: false, authError: false }
    const json = (await res.json().catch(() => null)) as { status?: string } | null
    return { up: json?.status === 'ok', authError: false }
  } catch {
    return { up: false, authError: false }
  }
}

/** Accepts a bare 32-hex id or a https://fish.audio/m/<id> URL. */
export function parseReferenceId(input: string): string | null {
  const m = input.trim().match(/([0-9a-f]{32})/i)
  return m ? m[1]!.toLowerCase() : null
}

/** Strip `<|speaker:N|>` and `[cue]` markers that transcribe-1-pro embeds in ASR text. */
export function stripAsrMarkers(text: string): string {
  return text
    .replace(/<\|speaker:\d+\|>/g, ' ')
    .replace(/\[[^\]]{1,40}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}
