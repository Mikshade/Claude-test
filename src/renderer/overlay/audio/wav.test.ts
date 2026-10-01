import { describe, expect, it } from 'vitest'
import { STT_SAMPLE_RATE, WAV_HEADER_BYTES, concatFloat32, encodeWav, floatToInt16, resample, rms } from './wav'

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

describe('encodeWav', () => {
  it('writes a canonical 44-byte RIFF/fmt/data header for 16 kHz mono PCM16', () => {
    const samples = new Float32Array(320)
    const wav = encodeWav(samples, STT_SAMPLE_RATE)
    const view = new DataView(wav.buffer)
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + 640)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 640)
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(640)
  })

  it('encodes samples as clamped little-endian int16', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]), 16000)
    const view = new DataView(wav.buffer)
    const values = Array.from({ length: 7 }, (_, i) => view.getInt16(WAV_HEADER_BYTES + i * 2, true))
    expect(values).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768])
    // little-endian: 32767 = 0xFF 0x7F
    expect(wav[WAV_HEADER_BYTES + 2]).toBe(0xff)
    expect(wav[WAV_HEADER_BYTES + 3]).toBe(0x7f)
  })

  it('returns a view over its own, exactly sized buffer (safe to hand over IPC)', () => {
    const wav = encodeWav(new Float32Array(10), 16000)
    expect(wav.byteOffset).toBe(0)
    expect(wav.buffer.byteLength).toBe(wav.byteLength)
  })

  it('handles an empty recording (header only)', () => {
    const wav = encodeWav(new Float32Array(0), 16000)
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES)
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0)
  })

  it('supports other rates and channel counts in the header', () => {
    const view = new DataView(encodeWav(new Float32Array(4), 48000, 2).buffer)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(28, true)).toBe(48000 * 4)
    expect(view.getUint16(32, true)).toBe(4)
  })
})

describe('floatToInt16', () => {
  it('maps the full range symmetrically and clamps', () => {
    expect(floatToInt16(0)).toBe(0)
    expect(floatToInt16(1)).toBe(32767)
    expect(floatToInt16(-1)).toBe(-32768)
    expect(floatToInt16(1.5)).toBe(32767)
    expect(floatToInt16(-7)).toBe(-32768)
    expect(floatToInt16(Number.NaN)).toBe(0)
  })
})

describe('resample', () => {
  it('halves the length when downsampling 2:1 and keeps every other sample', () => {
    const out = resample(new Float32Array([0, 1, 2, 3]), 4, 2)
    expect(Array.from(out)).toEqual([0, 2])
  })

  it('interpolates linearly when upsampling', () => {
    const out = resample(new Float32Array([0, 1]), 1, 2)
    expect(Array.from(out)).toEqual([0, 0.5, 1, 1])
  })

  it('produces round(n * to / from) samples for real-world rates', () => {
    expect(resample(new Float32Array(480), 48000, 16000).length).toBe(160)
    expect(resample(new Float32Array(441), 44100, 16000).length).toBe(160)
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000)
    expect(resample(new Float32Array(1), 48000, 16000).length).toBe(1)
  })

  it('preserves a ramp when converting 48 kHz → 16 kHz', () => {
    const input = new Float32Array(480)
    for (let i = 0; i < input.length; i++) input[i] = i / 480
    const out = resample(input, 48000, 16000)
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo((i * 3) / 480, 6)
  })

  it('returns a copy when the rates are equal', () => {
    const input = new Float32Array([0.1, 0.2])
    const out = resample(input, 16000, 16000)
    expect(out).not.toBe(input)
    expect(Array.from(out)).toEqual(Array.from(input))
  })

  it('rejects invalid rates', () => {
    expect(() => resample(new Float32Array(2), 0, 16000)).toThrow()
  })
})

describe('concatFloat32 / rms', () => {
  it('concatenates blocks in order', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array(0), new Float32Array([3])])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('computes the root mean square', () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
    expect(rms(new Float32Array([0, 0]))).toBe(0)
    expect(rms(new Float32Array(0))).toBe(0)
  })
})
