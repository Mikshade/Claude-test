/**
 * Tiny leveled logger. Writes to stdout and to <userData>/logs/flowy.log once `initFileLog` is called.
 */
import fs from 'node:fs'
import path from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let minLevel: Level = process.env['FLOWY_DEBUG'] ? 'debug' : 'info'
let stream: fs.WriteStream | null = null

export function initFileLog(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'flowy.log')
    // Rotate when the log gets large.
    try {
      const stat = fs.statSync(file)
      if (stat.size > 5 * 1024 * 1024) fs.renameSync(file, path.join(dir, 'flowy.old.log'))
    } catch {
      /* no file yet */
    }
    stream = fs.createWriteStream(file, { flags: 'a' })
  } catch (err) {
    console.error('[log] cannot open log file', err)
  }
}

export function setLogLevel(level: Level): void {
  minLevel = level
}

function write(level: Level, scope: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[minLevel]) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${args
    .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(line)
  stream?.write(line + '\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
  }
}
