/**
 * Persistent configuration store.
 *
 * - JSON file at <userData>/config.json, validated with the shared zod schema.
 * - Secrets are encrypted at rest with the injected `cipher` (Electron safeStorage in production,
 *   identity in tests). Encrypted values are stored as "enc:<base64>".
 * - Emits change events so windows/modules can react (hotkeys re-register, overlay re-themes, ...).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_CONFIG,
  type DeepPartial,
  type FlowyConfig,
  FlowyConfigSchema,
  mergeConfig,
  parseConfig,
  SECRET_PATHS,
} from '@shared/config'
import { createLogger } from '../log'

const log = createLogger('config')

export interface SecretCipher {
  encrypt(plain: string): string
  decrypt(stored: string): string
}

export const identityCipher: SecretCipher = {
  encrypt: (s) => s,
  decrypt: (s) => s,
}

const ENC_PREFIX = 'enc:'

export type ConfigListener = (config: FlowyConfig, previous: FlowyConfig) => void

export class ConfigStore {
  private config: FlowyConfig
  private readonly listeners = new Set<ConfigListener>()

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher = identityCipher,
  ) {
    this.config = this.load()
  }

  get(): FlowyConfig {
    return structuredClone(this.config)
  }

  /** Apply a deep partial patch, validate, persist, notify. Returns the new config. */
  patch(patch: DeepPartial<FlowyConfig>): FlowyConfig {
    const previous = this.config
    const merged = mergeConfig(previous, patch)
    const next = FlowyConfigSchema.parse(merged)
    this.config = next
    this.save()
    for (const l of this.listeners) {
      try {
        l(structuredClone(next), structuredClone(previous))
      } catch (err) {
        log.error('listener failed', err)
      }
    }
    return structuredClone(next)
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private load(): FlowyConfig {
    try {
      if (!fs.existsSync(this.filePath)) {
        log.info('no config yet, using defaults')
        return structuredClone(DEFAULT_CONFIG)
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown
      const decrypted = this.transformSecrets(raw, (v) =>
        v.startsWith(ENC_PREFIX) ? safeDecrypt(this.cipher, v.slice(ENC_PREFIX.length)) : v,
      )
      return parseConfig(decrypted)
    } catch (err) {
      log.error('config unreadable, falling back to defaults', err)
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.broken')
      } catch {
        /* ignore */
      }
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const encrypted = this.transformSecrets(structuredClone(this.config), (v) =>
        v ? ENC_PREFIX + this.cipher.encrypt(v) : '',
      )
      const tmp = this.filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(encrypted, null, 2), 'utf8')
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      log.error('cannot save config', err)
    }
  }

  private transformSecrets(obj: unknown, fn: (value: string) => string): unknown {
    if (!obj || typeof obj !== 'object') return obj
    for (const dotPath of SECRET_PATHS) {
      const keys = dotPath.split('.')
      let cursor: Record<string, unknown> | undefined = obj as Record<string, unknown>
      for (let i = 0; i < keys.length - 1; i++) {
        const next: unknown = cursor?.[keys[i]!]
        cursor = next && typeof next === 'object' ? (next as Record<string, unknown>) : undefined
        if (!cursor) break
      }
      const last = keys[keys.length - 1]!
      if (cursor && typeof cursor[last] === 'string') cursor[last] = fn(cursor[last] as string)
    }
    return obj
  }
}

function safeDecrypt(cipher: SecretCipher, value: string): string {
  try {
    return cipher.decrypt(value)
  } catch (err) {
    log.warn('cannot decrypt secret (different user/machine?) – clearing it', err)
    return ''
  }
}
