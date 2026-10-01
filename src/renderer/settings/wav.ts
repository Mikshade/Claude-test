/**
 * Small audio helpers for the settings page: WAV encoding for the microphone test and for playing
 * raw PCM returned by a TTS test. Pure – unit-tested in wav.test.ts.
 *
 * OWNER: settings-ui agent.
 */
import type { TestResult } from '@shared/ipc'

/** Sample rate the STT providers expect. */
export const STT_SAMPLE_RATE = 16000

/** Float32 [-1, 1] → signed 16-bit PCM (clamped). */
export function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

/** Linear-interpolation resampler (good enough for speech going into an ASR). */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples
  const ratio = fromRate / toRate
  const length = Math.max(1, Math.round(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * ratio
    const index = Math.floor(pos)
    const frac = pos - index
    const a = samples[index] ?? 0
    const b = samples[index + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** RMS of a Float32 frame (0..1). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0
    sum += s * s
  }
  return Math.sqrt(sum / samples.length)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** Wrap raw little-endian 16-bit PCM bytes into a 44-byte-header WAV container. */
export function wrapPcm16(pcmBytes: Uint8Array, sampleRate: number, channels = 1): ArrayBuffer {
  const dataLength = pcmBytes.byteLength - (pcmBytes.byteLength % 2)
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const blockAlign = channels * 2
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataLength, true)
  new Uint8Array(buffer, 44).set(pcmBytes.subarray(0, dataLength))
  return buffer
}

/** Encode Int16 samples as a mono/stereo WAV. */
export function encodeWav(pcm: Int16Array, sampleRate: number, channels = 1): ArrayBuffer {
  return wrapPcm16(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate, channels)
}

/** Float32 capture → resampled 16 kHz mono 16-bit WAV (what the STT clients want). */
export function floatToWav(samples: Float32Array, captureRate: number, targetRate = STT_SAMPLE_RATE): ArrayBuffer {
  return encodeWav(float32ToPcm16(resampleLinear(samples, captureRate, targetRate)), targetRate, 1)
}

export interface WavInfo {
  channels: number
  sampleRate: number
  bitsPerSample: number
  dataLength: number
}

/** Parse the canonical 44-byte header (returns null for anything else). */
export function parseWavHeader(buffer: ArrayBuffer): WavInfo | null {
  if (buffer.byteLength < 44) return null
  const view = new DataView(buffer)
  const tag = (offset: number): string => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return null
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataLength: view.getUint32(40, true),
  }
}

/**
 * Bytes of an IPC audio payload. Main sends ArrayBuffers, but a Node Buffer/Uint8Array survives
 * structured clone as a Uint8Array view – accept both (and anything else as empty).
 */
export function audioBytes(audio: unknown): Uint8Array {
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio)
  if (ArrayBuffer.isView(audio)) return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
  return new Uint8Array(0)
}

export function mimeForFormat(format: 'wav' | 'mp3' | 'pcm'): string {
  switch (format) {
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
    case 'pcm':
      return 'audio/wav'
  }
}

export interface PlayableAudio {
  bytes: Uint8Array
  mime: string
}

/** Default sample rate the Fish cloud client uses for raw PCM (see tts/fishCloud.ts). */
export const DEFAULT_PCM_SAMPLE_RATE = 24000

/** Turn a TestResult audio payload into bytes + mime a `<audio>` element can play (pcm → WAV). */
export function playableFromTestAudio(audio: NonNullable<TestResult['audio']>): PlayableAudio {
  const bytes = audioBytes(audio.data)
  if (audio.format === 'pcm') {
    return { bytes: new Uint8Array(wrapPcm16(bytes, audio.sampleRate ?? DEFAULT_PCM_SAMPLE_RATE)), mime: 'audio/wav' }
  }
  return { bytes, mime: mimeForFormat(audio.format) }
}
