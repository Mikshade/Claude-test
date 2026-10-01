/**
 * Client-side config store for the settings page.
 *
 * - Holds the current (optimistically merged) config.
 * - `set(path, value)` / `patch(patch)` queue a deep-partial patch; text/slider edits are debounced
 *   (300 ms), selects/toggles are flushed immediately. Pending patches are merged so one IPC round
 *   trip carries everything typed in the meantime.
 * - The flushed patch goes through `invoke` ('config:patch'); its result becomes the new base and any
 *   patch queued meanwhile is re-applied on top.
 * - `applyRemote(config)` handles 'config:changed' pushes: our own echo (equal to local state) is
 *   ignored, foreign changes (tray toggles …) are merged under the pending patch and reported as
 *   'remote' so the page can re-render.
 *
 * OWNER: settings-ui agent. Pure – unit-tested with an injected `invoke` in store.test.ts.
 */
import { type DeepPartial, type FlowyConfig, mergeConfig } from '@shared/config'

export const PATCH_DEBOUNCE_MS = 300

export type ChangeSource = 'local' | 'ack' | 'remote'
export type StoreListener = (config: FlowyConfig, source: ChangeSource) => void

export interface PatchOptions {
  /** Flush right away (selects, toggles, buttons). Default: debounced. */
  immediate?: boolean
}

export interface SettingsStore {
  get(): FlowyConfig
  patch(patch: DeepPartial<FlowyConfig>, options?: PatchOptions): void
  /** Convenience: patch a single dot-path such as 'tts.fishCloud.apiKey'. */
  set(path: string, value: unknown, options?: PatchOptions): void
  /** Send whatever is pending now. Resolves when the round trip is done (never rejects). */
  flush(): Promise<void>
  /** Apply a config pushed by main. Returns true when it changed the local state. */
  applyRemote(config: FlowyConfig): boolean
  /** Replace the local state unconditionally (e.g. after an invalid patch was rejected). */
  reset(config: FlowyConfig): void
  subscribe(listener: StoreListener): () => void
  hasPending(): boolean
}

export interface StoreDeps {
  invoke: (patch: DeepPartial<FlowyConfig>) => Promise<FlowyConfig>
  onError?: (error: unknown, patch: DeepPartial<FlowyConfig>) => void
  debounceMs?: number
}

/** Build a deep-partial patch from a dot-path: patchFromPath('a.b', 1) → { a: { b: 1 } }. */
export function patchFromPath(path: string, value: unknown): DeepPartial<FlowyConfig> {
  const keys = path.split('.').filter((k) => k.length > 0)
  if (keys.length === 0) throw new Error('empty config path')
  let out: unknown = value
  for (let i = keys.length - 1; i >= 0; i--) out = { [keys[i]!]: out }
  return out as DeepPartial<FlowyConfig>
}

/** Read a dot-path from an object (undefined when missing). */
export function getPath(obj: unknown, path: string): unknown {
  let cursor: unknown = obj
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

function mergePatch(base: DeepPartial<FlowyConfig> | null, patch: DeepPartial<FlowyConfig>): DeepPartial<FlowyConfig> {
  if (!base) return structuredClone(patch)
  return mergeConfig(base as object, patch as DeepPartial<object>) as DeepPartial<FlowyConfig>
}

export function createSettingsStore(initial: FlowyConfig, deps: StoreDeps): SettingsStore {
  const debounceMs = deps.debounceMs ?? PATCH_DEBOUNCE_MS
  let local: FlowyConfig = structuredClone(initial)
  let pending: DeepPartial<FlowyConfig> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null
  const listeners = new Set<StoreListener>()

  function notify(source: ChangeSource): void {
    const snapshot = structuredClone(local)
    for (const l of listeners) {
      try {
        l(snapshot, source)
      } catch (err) {
        console.error('[settings-store] listener failed', err)
      }
    }
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  async function send(): Promise<void> {
    clearTimer()
    if (!pending) return
    if (inflight) {
      // Serialise: wait for the current round trip, then send what accumulated meanwhile.
      await inflight
      return send()
    }
    const patch = pending
    pending = null
    inflight = (async () => {
      try {
        const next = await deps.invoke(patch)
        local = pending ? mergeConfig(next, pending) : next
        notify('ack')
      } catch (err) {
        console.error('[settings-store] patch rejected', err)
        deps.onError?.(err, patch)
      } finally {
        inflight = null
      }
    })()
    await inflight
  }

  function schedule(): void {
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void send()
    }, debounceMs)
  }

  function patch(p: DeepPartial<FlowyConfig>, options: PatchOptions = {}): void {
    local = mergeConfig(local, p)
    pending = mergePatch(pending, p)
    notify('local')
    if (options.immediate) void send()
    else schedule()
  }

  function applyRemote(config: FlowyConfig): boolean {
    const merged = pending ? mergeConfig(config, pending) : config
    if (JSON.stringify(merged) === JSON.stringify(local)) return false
    local = structuredClone(merged)
    notify('remote')
    return true
  }

  return {
    get: () => structuredClone(local),
    patch,
    set: (path, value, options) => patch(patchFromPath(path, value), options),
    flush: () => send(),
    applyRemote,
    reset(config) {
      clearTimer()
      pending = null
      local = structuredClone(config)
      notify('remote')
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hasPending: () => pending !== null || inflight !== null,
  }
}
