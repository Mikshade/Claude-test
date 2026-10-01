import { describe, expect, it } from 'vitest'
import {
  audioBytes,
  concatFloat32,
  DEFAULT_PCM_SAMPLE_RATE,
  encodeWav,
  float32ToPcm16,
  floatToWav,
  mimeForFormat,
  parseWavHeader,
  playableFromTestAudio,
  resampleLinear,
  rms,
  wrapPcm16,
} from './wav'

describe('float32ToPcm16', () => {
  it('scales and clamps', () => {
    const out = float32ToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]))
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, 32767, -32768])
  })
})

describe('resampleLinear', () => {
  it('returns the input when rates match', () => {
    const s = new Float32Array([1, 2, 3])
    expect(resampleLinear(s, 16000, 16000)).toBe(s)
  })
  it('halves the length from 32 kHz to 16 kHz and interpolates', () => {
    const s = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    const out = resampleLinear(s, 32000, 16000)
    expect(out.length).toBe(4)
    expect(Array.from(out)).toEqual([0, 2, 4, 6])
    const up = resampleLinear(new Float32Array([0, 1]), 8000, 16000)
    expect(up.length).toBe(4)
    expect(up[1]).toBeCloseTo(0.5)
  })
})

describe('concatFloat32 / rms', () => {
  it('concatenates and measures', () => {
    const all = concatFloat32([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])])
    expect(Array.from(all)).toEqual([1, 2, 3])
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
    expect(rms(new Float32Array(0))).toBe(0)
  })
})

describe('WAV encoding', () => {
  it('writes a canonical 44-byte header', () => {
    const pcm = new Int16Array([1, -1, 1000, -1000])
    const wav = encodeWav(pcm, 16000, 1)
    expect(wav.byteLength).toBe(44 + 8)
    expect(parseWavHeader(wav)).toEqual({ channels: 1, sampleRate: 16000, bitsPerSample: 16, dataLength: 8 })
    const view = new DataView(wav)
    expect(view.getUint32(4, true)).toBe(36 + 8)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint32(28, true)).toBe(32000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getInt16(44, true)).toBe(1)
    expect(view.getInt16(46, true)).toBe(-1)
    expect(view.getInt16(48, true)).toBe(1000)
  })

  it('wraps raw bytes and drops a dangling odd byte', () => {
    const wav = wrapPcm16(new Uint8Array([0x10, 0x00, 0x20, 0x00, 0xff]), 24000)
    expect(parseWavHeader(wav)?.dataLength).toBe(4)
    expect(parseWavHeader(wav)?.sampleRate).toBe(24000)
    expect(new DataView(wav).getInt16(44, true)).toBe(16)
  })

  it('floatToWav resamples to 16 kHz mono', () => {
    const wav = floatToWav(new Float32Array(48000).fill(0.25), 48000)
    const info = parseWavHeader(wav)
    expect(info?.sampleRate).toBe(16000)
    expect(info?.dataLength).toBe(16000 * 2)
  })

  it('parseWavHeader rejects junk', () => {
    expect(parseWavHeader(new ArrayBuffer(10))).toBeNull()
    expect(parseWavHeader(new ArrayBuffer(64))).toBeNull()
  })
})

describe('IPC audio helpers', () => {
  it('audioBytes accepts ArrayBuffer and views', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer
    expect(Array.from(audioBytes(buf))).toEqual([1, 2, 3])
    expect(Array.from(audioBytes(new Uint8Array(buf, 1)))).toEqual([2, 3])
    expect(audioBytes('nope').length).toBe(0)
  })
  it('mimeForFormat', () => {
    expect(mimeForFormat('mp3')).toBe('audio/mpeg')
    expect(mimeForFormat('wav')).toBe('audio/wav')
    expect(mimeForFormat('pcm')).toBe('audio/wav')
  })
  it('playableFromTestAudio wraps pcm into WAV and passes mp3 through', () => {
    const pcm = playableFromTestAudio({ data: new Uint8Array([0, 0, 0, 0]).buffer, format: 'pcm', sampleRate: 16000 })
    expect(pcm.mime).toBe('audio/wav')
    expect(parseWavHeader(pcm.bytes.buffer as ArrayBuffer)?.sampleRate).toBe(16000)
    const pcmDefault = playableFromTestAudio({ data: new Uint8Array([0, 0]).buffer, format: 'pcm' })
    expect(parseWavHeader(pcmDefault.bytes.buffer as ArrayBuffer)?.sampleRate).toBe(DEFAULT_PCM_SAMPLE_RATE)
    const mp3 = playableFromTestAudio({ data: new Uint8Array([0xff, 0xfb]).buffer, format: 'mp3' })
    expect(mp3.mime).toBe('audio/mpeg')
    expect(Array.from(mp3.bytes)).toEqual([0xff, 0xfb])
  })
})
