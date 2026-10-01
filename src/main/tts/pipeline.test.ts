import { describe, expect, it, vi } from 'vitest'
import type { SpeechChunk } from '@shared/state'
import { createSpeechPipeline } from './pipeline'
import type { SynthesizeOptions, TtsAudio, TtsClient } from './types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface Call {
  text: string
  options: SynthesizeOptions
  d: Deferred<TtsAudio>
}

function fakeClient(): { client: TtsClient; calls: Call[] } {
  const calls: Call[] = []
  const client: TtsClient = {
    name: 'fake',
    synthesize: vi.fn(async (text: string, options: SynthesizeOptions = {}) => {
      const d = deferred<TtsAudio>()
      calls.push({ text, options, d })
      return d.promise
    }),
    test: async () => ({ ok: true, message: 'ok' }),
  }
  return { client, calls }
}

function audio(tag: number, format: TtsAudio['format'] = 'mp3', sampleRate?: number): TtsAudio {
  const out: TtsAudio = { data: new Uint8Array([tag]).buffer, format }
  if (sampleRate !== undefined) out.sampleRate = sampleRate
  return out
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function setup(concurrency?: number) {
  const { client, calls } = fakeClient()
  const chunks: SpeechChunk[] = []
  const errors: Array<{ error: Error; text: string }> = []
  const controller = new AbortController()
  const pipeline = createSpeechPipeline({
    client,
    turnId: 't1',
    onChunk: (c) => chunks.push(c),
    onError: (error, text) => errors.push({ error, text }),
    concurrency,
    signal: controller.signal,
  })
  return { client, calls, chunks, errors, controller, pipeline }
}

describe('createSpeechPipeline', () => {
  it('emits chunks in push order even when synthesis completes out of order', async () => {
    const { calls, chunks, pipeline, client } = setup(2)
    pipeline.push('A.', 'happy')
    pipeline.push('B.', 'sad')
    pipeline.push('C.', 'neutral')
    expect(client.synthesize).toHaveBeenCalledTimes(2) // bounded concurrency
    expect(calls.map((c) => c.text)).toEqual(['A.', 'B.'])
    expect(calls[0]?.options.emotion).toBe('happy')
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal)

    calls[1]!.d.resolve(audio(2))
    await tick()
    expect(chunks).toHaveLength(0) // B must wait for A

    calls[0]!.d.resolve(audio(1))
    await tick()
    expect(chunks.map((c) => [c.seq, c.text, c.last])).toEqual([
      [0, 'A.', false],
      [1, 'B.', false],
    ])
    expect(calls).toHaveLength(3) // C started once a slot freed up

    const finished = pipeline.finish()
    calls[2]!.d.resolve(audio(3, 'pcm', 24000))
    await finished
    expect(chunks).toHaveLength(3)
    expect(chunks[2]).toEqual({
      turnId: 't1',
      seq: 2,
      text: 'C.',
      emotion: 'neutral',
      audio: expect.any(ArrayBuffer),
      format: 'pcm',
      sampleRate: 24000,
      last: true,
    })
    expect(new Uint8Array(chunks[2]!.audio)).toEqual(new Uint8Array([3]))
    expect(chunks[0]!.sampleRate).toBeUndefined()
    expect(chunks.every((c) => c.turnId === 't1')).toBe(true)
  })

  it('reports and skips failed sentences, keeping seq contiguous', async () => {
    const { calls, chunks, errors, pipeline } = setup(3)
    pipeline.push('A.', 'neutral')
    pipeline.push('B.', 'neutral')
    pipeline.push('C.', 'neutral')
    const finished = pipeline.finish()

    calls[1]!.d.reject(new Error('boom'))
    await tick()
    expect(errors).toEqual([{ error: expect.objectContaining({ message: 'boom' }), text: 'B.' }])
    expect(chunks).toHaveLength(0)

    calls[0]!.d.resolve(audio(1))
    calls[2]!.d.resolve(audio(3))
    await finished
    expect(chunks.map((c) => [c.seq, c.text, c.last])).toEqual([
      [0, 'A.', false],
      [1, 'C.', true],
    ])
  })

  it('emits a terminal empty chunk when the last sentence failed', async () => {
    const { calls, chunks, errors, pipeline } = setup()
    pipeline.push('A.', 'excited')
    pipeline.push('B.', 'excited')
    const finished = pipeline.finish()
    calls[0]!.d.resolve(audio(1))
    calls[1]!.d.reject(new Error('503'))
    await finished
    expect(errors).toHaveLength(1)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ seq: 0, text: 'A.', last: false })
    expect(chunks[1]).toEqual({ turnId: 't1', seq: 1, text: '', emotion: 'neutral', audio: expect.any(ArrayBuffer), format: 'wav', last: true })
    expect(chunks[1]!.audio.byteLength).toBe(0)
  })

  it('emits a terminal empty chunk when nothing was pushed', async () => {
    const { chunks, pipeline, client } = setup()
    await pipeline.finish()
    expect(client.synthesize).not.toHaveBeenCalled()
    expect(chunks).toEqual([{ turnId: 't1', seq: 0, text: '', emotion: 'neutral', audio: expect.any(ArrayBuffer), format: 'wav', last: true }])
    expect(chunks[0]!.audio.byteLength).toBe(0)
  })

  it('appends a terminal chunk when the last chunk was already emitted before finish()', async () => {
    const { calls, chunks, pipeline } = setup()
    pipeline.push('A.', 'neutral')
    calls[0]!.d.resolve(audio(1))
    await tick()
    expect(chunks.map((c) => [c.seq, c.last])).toEqual([[0, false]])
    await pipeline.finish()
    expect(chunks.map((c) => [c.seq, c.text, c.last])).toEqual([
      [0, 'A.', false],
      [1, '', true],
    ])
    expect(chunks[1]!.audio.byteLength).toBe(0)
  })

  it('skips text that is empty after cleaning and silently ignores "empty" rejections', async () => {
    const { calls, chunks, errors, pipeline, client } = setup()
    pipeline.push('[[happy]]', 'happy')
    pipeline.push('   ', 'happy')
    expect(client.synthesize).not.toHaveBeenCalled()
    pipeline.push('Hallo.', 'happy')
    const finished = pipeline.finish()
    calls[0]!.d.reject(new Error('empty'))
    await finished
    expect(errors).toHaveLength(0)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.last).toBe(true)
  })

  it('finish() is idempotent and push() after finish() is ignored', async () => {
    const { calls, chunks, pipeline, client } = setup()
    pipeline.push('A.', 'neutral')
    const p1 = pipeline.finish()
    const p2 = pipeline.finish()
    expect(p1).toBe(p2)
    pipeline.push('B.', 'neutral')
    expect(client.synthesize).toHaveBeenCalledTimes(1)
    calls[0]!.d.resolve(audio(1))
    await p1
    expect(chunks.map((c) => c.text)).toEqual(['A.'])
  })

  it('abort() cancels in-flight requests, resolves finish() immediately and emits nothing more', async () => {
    const { calls, chunks, errors, pipeline, client } = setup(2)
    pipeline.push('A.', 'neutral')
    pipeline.push('B.', 'neutral')
    pipeline.push('C.', 'neutral')
    const finished = pipeline.finish()
    pipeline.abort()
    expect(calls[0]!.options.signal?.aborted).toBe(true)
    expect(calls[1]!.options.signal?.aborted).toBe(true)
    await finished

    // late results / abort rejections are ignored
    calls[0]!.d.resolve(audio(1))
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    calls[1]!.d.reject(abortErr)
    await tick()
    expect(chunks).toHaveLength(0)
    expect(errors).toHaveLength(0)
    expect(client.synthesize).toHaveBeenCalledTimes(2) // C never started

    pipeline.push('D.', 'neutral')
    expect(client.synthesize).toHaveBeenCalledTimes(2)
    await pipeline.finish()
    expect(chunks).toHaveLength(0)
  })

  it('finish() after abort() resolves without a terminal chunk', async () => {
    const { chunks, pipeline } = setup()
    pipeline.push('A.', 'neutral')
    pipeline.abort()
    await pipeline.finish()
    expect(chunks).toHaveLength(0)
  })

  it('the external signal aborts the pipeline too', async () => {
    const { calls, chunks, controller, pipeline } = setup()
    pipeline.push('A.', 'neutral')
    const finished = pipeline.finish()
    controller.abort()
    expect(calls[0]!.options.signal?.aborted).toBe(true)
    await finished
    calls[0]!.d.resolve(audio(1))
    await tick()
    expect(chunks).toHaveLength(0)
  })

  it('a pre-aborted signal yields a dead pipeline', async () => {
    const { client } = fakeClient()
    const controller = new AbortController()
    controller.abort()
    const chunks: SpeechChunk[] = []
    const pipeline = createSpeechPipeline({ client, turnId: 't', onChunk: (c) => chunks.push(c), onError: () => undefined, signal: controller.signal })
    pipeline.push('A.', 'neutral')
    expect(client.synthesize).not.toHaveBeenCalled()
    await pipeline.finish()
    expect(chunks).toHaveLength(0)
  })

  it('survives a throwing onChunk / onError handler', async () => {
    const { client, calls } = fakeClient()
    const seen: number[] = []
    const pipeline = createSpeechPipeline({
      client,
      turnId: 't',
      onChunk: (c) => {
        seen.push(c.seq)
        throw new Error('renderer gone')
      },
      onError: () => {
        throw new Error('handler broken')
      },
      signal: new AbortController().signal,
    })
    pipeline.push('A.', 'neutral')
    pipeline.push('B.', 'neutral')
    const finished = pipeline.finish()
    calls[0]!.d.reject(new Error('x'))
    calls[1]!.d.resolve(audio(2))
    await finished
    expect(seen).toEqual([0])
  })

  it('uses concurrency 2 by default and respects a custom limit', async () => {
    const a = setup()
    for (let i = 0; i < 5; i++) a.pipeline.push(`S${i}.`, 'neutral')
    expect(a.client.synthesize).toHaveBeenCalledTimes(2)

    const b = setup(4)
    for (let i = 0; i < 5; i++) b.pipeline.push(`S${i}.`, 'neutral')
    expect(b.client.synthesize).toHaveBeenCalledTimes(4)
    b.calls[3]!.d.resolve(audio(4))
    await tick()
    expect(b.client.synthesize).toHaveBeenCalledTimes(5)
  })
})
