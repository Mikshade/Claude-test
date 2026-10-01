import { describe, expect, it } from 'vitest'
import { audioBytes, createPcm16Decoder, pcm16ToFloat32 } from './pcm'

/** Little-endian int16 samples → bytes. */
function s16le(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2)
  const view = new DataView(out.buffer)
  values.forEach((v, i) => view.setInt16(i * 2, v, true))
  return out
}

describe('pcm16ToFloat32', () => {
  it('converts little-endian int16 to floats with -32768 → -1', () => {
    const { samples, carry } = pcm16ToFloat32(s16le([0, 32767, -32768, -1, 16384]))
    expect(Array.from(samples)).toEqual([0, 32767 / 32768, -1, -1 / 32768, 0.5])
    expect(carry).toBeUndefined()
  })

  it('returns the dangling byte of a split sample as carry', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x34]) // 0x4000 = 16384, then half of the next sample
    const { samples, carry } = pcm16ToFloat32(bytes)
    expect(Array.from(samples)).toEqual([0.5])
    expect(carry).toBe(0x34)
  })

  it('completes the split sample with the carry from the previous chunk', () => {
    const { samples, carry } = pcm16ToFloat32(new Uint8Array([0x12, 0x00, 0x80]), 0x34)
    // carry 0x34 + 0x12 → 0x1234 = 4660; then 0x8000 = -32768
    expect(Array.from(samples)).toEqual([4660 / 32768, -1])
    expect(carry).toBeUndefined()
  })

  it('keeps the carry across an empty chunk and handles a single-byte chunk', () => {
    expect(pcm16ToFloat32(new Uint8Array(0), 0x34)).toEqual({ samples: new Float32Array(0), carry: 0x34 })
    expect(pcm16ToFloat32(new Uint8Array([0x12]), 0x34)).toEqual({ samples: new Float32Array([4660 / 32768]) })
    expect(pcm16ToFloat32(new Uint8Array([0x12]))).toEqual({ samples: new Float32Array(0), carry: 0x12 })
    expect(pcm16ToFloat32(new Uint8Array(0))).toEqual({ samples: new Float32Array(0) })
  })

  it('honours the byte offset of a view', () => {
    const backing = new Uint8Array([0xaa, 0xaa, 0x00, 0x40])
    const view = new Uint8Array(backing.buffer, 2, 2)
    expect(Array.from(pcm16ToFloat32(view).samples)).toEqual([0.5])
  })
})

describe('createPcm16Decoder', () => {
  it('carries the odd trailing byte into the next chunk of the same stream', () => {
    const decoder = createPcm16Decoder()
    const all = s16le([100, 200, 300, 400, 500])
    const a = decoder.decode(all.subarray(0, 3))
    expect(decoder.pending()).toBe(1)
    const b = decoder.decode(all.subarray(3, 6))
    const c = decoder.decode(all.subarray(6))
    expect(decoder.pending()).toBe(0)
    const joined = [...a, ...b, ...c].map((v) => Math.round(v * 32768))
    expect(joined).toEqual([100, 200, 300, 400, 500])
    expect(a.length + b.length + c.length).toBe(5)
  })

  it('reset() drops a pending byte', () => {
    const decoder = createPcm16Decoder()
    decoder.decode(new Uint8Array([0x01]))
    expect(decoder.pending()).toBe(1)
    decoder.reset()
    expect(decoder.pending()).toBe(0)
    expect(Array.from(decoder.decode(s16le([-32768])))).toEqual([-1])
  })
})

describe('audioBytes', () => {
  it('accepts ArrayBuffers and any typed-array view (with offset, other element types)', () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer
    expect(Array.from(audioBytes(buf))).toEqual([1, 2, 3, 4])
    expect(Array.from(audioBytes(new Uint8Array(buf, 1, 2)))).toEqual([2, 3])
    expect(Array.from(audioBytes(new Int8Array([9, 8])))).toEqual([9, 8])
    expect(Array.from(audioBytes(new DataView(buf, 2)))).toEqual([3, 4])
    expect(Array.from(audioBytes(new Int16Array([0x0201]).buffer))).toEqual([1, 2])
  })

  it('treats anything else as empty', () => {
    expect(audioBytes(undefined).byteLength).toBe(0)
    expect(audioBytes(null).byteLength).toBe(0)
    expect(audioBytes('nope').byteLength).toBe(0)
  })
})
