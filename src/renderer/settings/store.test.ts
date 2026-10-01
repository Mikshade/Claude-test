import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type DeepPartial, type FlowyConfig, mergeConfig } from '@shared/config'
import { createSettingsStore, getPath, PATCH_DEBOUNCE_MS, patchFromPath } from './store'

describe('patchFromPath / getPath', () => {
  it('builds nested patches from dot paths', () => {
    expect(patchFromPath('tts.fishCloud.apiKey', 'k')).toEqual({ tts: { fishCloud: { apiKey: 'k' } } })
    expect(patchFromPath('autostart', true)).toEqual({ autostart: true })
    expect(() => patchFromPath('', 1)).toThrow()
  })
  it('reads nested values', () => {
    expect(getPath(DEFAULT_CONFIG, 'character.traits.warmth')).toBe(70)
    expect(getPath(DEFAULT_CONFIG, 'nope.deeper')).toBeUndefined()
    expect(getPath(DEFAULT_CONFIG, 'character.name.length')).toBeUndefined()
  })
})

describe('createSettingsStore', () => {
  /** Fake main: applies patches to its own copy and answers after a tick. */
  function fakeMain(): { invoke: (p: DeepPartial<FlowyConfig>) => Promise<FlowyConfig>; calls: DeepPartial<FlowyConfig>[]; state: FlowyConfig; fail: boolean } {
    const main = {
      calls: [] as DeepPartial<FlowyConfig>[],
      state: structuredClone(DEFAULT_CONFIG),
      fail: false,
      invoke: async (p: DeepPartial<FlowyConfig>): Promise<FlowyConfig> => {
        main.calls.push(structuredClone(p))
        await Promise.resolve()
        if (main.fail) throw new Error('invalid')
        main.state = mergeConfig(main.state, p)
        return structuredClone(main.state)
      },
    }
    return main
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies text edits optimistically and sends one merged patch after the debounce', async () => {
    const main = fakeMain()
    const store = createSettingsStore(DEFAULT_CONFIG, { invoke: main.invoke })
    const events: string[] = []
    store.subscribe((_c, source) => events.push(source))

    store.set('character.name', 'Y')
    store.set('character.name', 'Yu')
    store.set('character.userName', 'Max')
    expect(store.get().character.name).toBe('Yu')
    expect(store.hasPending()).toBe(true)
    expect(main.calls).toEqual([])

    await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS - 1)
    expect(main.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(main.calls).toEqual([{ character: { name: 'Yu', userName: 'Max' } }])
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual(['local', 'local', 'local', 'ack'])
    expect(store.hasPending()).toBe(false)
    expect(store.get().character.userName).toBe('Max')
  })

  it('sends immediate patches right away (together with anything pending)', async () => {
    const main = fakeMain()
    const store = createSettingsStore(DEFAULT_CONFIG, { invoke: main.invoke })
    store.set('character.name', 'Rin')
    store.set('avatar.pinned', true, { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(main.calls).toEqual([{ character: { name: 'Rin' }, avatar: { pinned: true } }])
  })

  it('keeps edits typed during an in-flight patch and sends them afterwards', async () => {
    const main = fakeMain()
    let release: (() => void) | null = null
    const slowInvoke = (p: DeepPartial<FlowyConfig>): Promise<FlowyConfig> =>
      new Promise((resolve) => {
        release = () => resolve(main.invoke(p))
      })
    const store = createSettingsStore(DEFAULT_CONFIG, { invoke: slowInvoke })
    store.set('character.name', 'A', { immediate: true })
    store.set('character.name', 'AB') // typed while the first patch is in flight
    expect(store.get().character.name).toBe('AB')
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().character.name).toBe('AB') // the ack must not clobber the newer local value
    await vi.advanceTimersByTimeAsync(PATCH_DEBOUNCE_MS)
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(main.calls.map((c) => c.character?.name)).toEqual(['A', 'AB'])
  })

  it('ignores remote echoes and merges foreign remote changes under pending edits', async () => {
    const main = fakeMain()
    const store = createSettingsStore(DEFAULT_CONFIG, { invoke: main.invoke })
    const events: string[] = []
    store.subscribe((_c, source) => events.push(source))

    store.set('character.name', 'Mio')
    // main echoes exactly what we have → ignored
    const echo = mergeConfig(structuredClone(DEFAULT_CONFIG), { character: { name: 'Mio' } })
    expect(store.applyRemote(echo)).toBe(false)
    // the tray toggled pinned meanwhile (main does not know about the un-flushed name yet)
    const foreign = mergeConfig(structuredClone(DEFAULT_CONFIG), { avatar: { pinned: true } })
    expect(store.applyRemote(foreign)).toBe(true)
    expect(store.get().avatar.pinned).toBe(true)
    expect(store.get().character.name).toBe('Mio')
    expect(events).toEqual(['local', 'remote'])
  })

  it('reports rejected patches and reset() replaces the local state', async () => {
    const main = fakeMain()
    main.fail = true
    const errors: unknown[] = []
    const store = createSettingsStore(DEFAULT_CONFIG, { invoke: main.invoke, onError: (e) => errors.push(e) })
    store.set('character.name', '', { immediate: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveLength(1)
    store.reset(DEFAULT_CONFIG)
    expect(store.get().character.name).toBe(DEFAULT_CONFIG.character.name)
    expect(store.hasPending()).toBe(false)
  })

  it('flush() resolves after the round trip and is a no-op without pending patches', async () => {
    const main = fakeMain()
    const store = createSettingsStore(DEFAULT_CONFIG, { invoke: main.invoke })
    await store.flush()
    expect(main.calls).toEqual([])
    store.set('tts.volume', 50)
    const done = store.flush()
    await vi.advanceTimersByTimeAsync(0)
    await done
    expect(main.calls).toEqual([{ tts: { volume: 50 } }])
    expect(main.state.tts.volume).toBe(50)
  })
})
