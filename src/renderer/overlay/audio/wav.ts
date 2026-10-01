/**
 * Pure PCM helpers for the recorder: Float32 concat / resample / RMS and the 16-bit PCM WAV encoder.
 *
 * OWNER: audio agent. No DOM access – unit-tested in wav.test.ts.
 */

/** Sample rate every STT backend is happiest with (and what the capture AudioContext is opened at). */
export const STT_SAMPLE_RATE = 16_000
/** Size of the canonical RIFF/fmt/data header written by encodeWav. */
export const WAV_HEADER_BYTES = 44

/** Concatenate Float32 blocks into one contiguous array (always a fresh buffer). */
export function concatFloat32(chunks: readonly Float32Array[]): Float32Array<ArrayBuffer> {
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

/**
 * Linear-interpolation resampler. Only used when the capture AudioContext could not be opened at
 * 16 kHz (Chromium otherwise resamples the microphone stream to the context rate for us).
 * Output length is round(n * to / from); equal rates return a copy.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array<ArrayBuffer> {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error(`resample: invalid rates ${fromRate} -> ${toRate}`)
  if (fromRate === toRate || input.length === 0) return new Float32Array(input)
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Float32Array(outLength)
  const lastIndex = input.length - 1
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const i0 = Math.min(Math.floor(pos), lastIndex)
    const i1 = Math.min(i0 + 1, lastIndex)
    const frac = pos - i0
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac
  }
  return out
}

/** Root mean square of one block (0 for an empty block). */
export function rms(block: Float32Array): number {
  if (block.length === 0) return 0
  let sum = 0
  for (let i = 0; i < block.length; i++) {
    const v = block[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / block.length)
}

/** Float sample [-1, 1] (clamped) → signed 16-bit integer. */
export function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
}

/**
 * Float32 mono samples → 16-bit signed little-endian PCM WAV (44-byte RIFF header + data).
 * The returned view covers its whole (freshly allocated) ArrayBuffer, so `.buffer` can be handed
 * over IPC as-is.
 */
export function encodeWav(samples: Float32Array, sampleRate: number, numChannels = 1): Uint8Array<ArrayBuffer> {
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataLength = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataLength)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true) // byte rate
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataLength, true)
  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, floatToInt16(samples[i] ?? 0), true)
  }
  return new Uint8Array(buffer)
}
