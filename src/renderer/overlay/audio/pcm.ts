/**
 * Raw PCM helpers for the player: signed 16-bit little-endian mono → Float32, tolerant of chunks
 * that split a sample in half (the odd trailing byte is carried into the next chunk of the turn).
 *
 * OWNER: audio agent. Pure – unit-tested in pcm.test.ts.
 */

export interface Pcm16Result {
  samples: Float32Array<ArrayBuffer>
  /** The dangling low byte of a half sample (0..255), to be passed into the next call. */
  carry?: number
}

/**
 * Convert s16le bytes to Float32 [-1, 1). `carry` is the low byte left over from the previous chunk;
 * the result carries the new leftover (if any) back out.
 */
export function pcm16ToFloat32(bytes: Uint8Array, carry?: number): Pcm16Result {
  const hasCarry = carry !== undefined
  const total = bytes.length + (hasCarry ? 1 : 0)
  const frames = Math.floor(total / 2)
  const samples = new Float32Array(frames)
  let frame = 0
  let i = 0
  if (hasCarry && bytes.length > 0) {
    samples[frame++] = int16(carry, bytes[0] ?? 0)
    i = 1
  }
  for (; i + 1 < bytes.length; i += 2) {
    samples[frame++] = int16(bytes[i] ?? 0, bytes[i + 1] ?? 0)
  }
  const result: Pcm16Result = { samples }
  if (i < bytes.length) result.carry = bytes[i]
  else if (hasCarry && bytes.length === 0) result.carry = carry
  return result
}

function int16(lo: number, hi: number): number {
  // Sign-extend the 16-bit value, then normalise so that -32768 → -1.
  const v = ((hi << 8) | lo) << 16 >> 16
  return v / 0x8000
}

export interface Pcm16Decoder {
  /** Decode a chunk; a split sample at the end is kept and completed by the next call. */
  decode(bytes: Uint8Array): Float32Array<ArrayBuffer>
  /** Number of pending bytes (0 or 1). */
  pending(): number
  /** Drop a pending byte (start of a new turn / stream). */
  reset(): void
}

/** Stateful wrapper over pcm16ToFloat32 – one per turn in the player. */
export function createPcm16Decoder(): Pcm16Decoder {
  let carry: number | undefined
  return {
    decode(bytes) {
      const result = pcm16ToFloat32(bytes, carry)
      carry = result.carry
      return result.samples
    },
    pending: () => (carry === undefined ? 0 : 1),
    reset() {
      carry = undefined
    },
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
