/**
 * Chromium permission policy for our own windows.
 *
 * Electron auto-approves every permission request unless a handler is installed. Flowy only needs:
 *  - 'media' for the microphone (audio only – a video request is denied even from our own pages)
 *  - 'speaker-selection' so the player can pick the configured output device (setSinkId)
 *  - clipboard read / sanitized write for the chat input
 * Everything else (geolocation, notifications from the page, display-capture, usb, …) is denied and logged.
 * Requests are only honoured from our own origins: file://, http://localhost:* (dev server) and flowy-model://.
 *
 * OWNER: overlay agent.
 */
import type { Session } from 'electron'
import { createLogger } from '../log'

const log = createLogger('permissions')

/** Permissions we grant to our own pages. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'speaker-selection',
  'clipboard-read',
  'clipboard-sanitized-write',
])

/** Loose shape of the `details` argument of both handlers (request: mediaTypes[]; check: mediaType). */
export interface PermissionDetails {
  mediaTypes?: ReadonlyArray<'video' | 'audio'>
  mediaType?: 'video' | 'audio' | 'unknown'
  requestingUrl?: string
  securityOrigin?: string
}

/** True for URLs/origins of pages we ship: file://, http(s)://localhost|127.0.0.1[:port], flowy-model://. */
export function isOwnOrigin(urlOrOrigin: string | null | undefined): boolean {
  if (!urlOrOrigin) return false
  let url: URL
  try {
    url = new URL(urlOrOrigin)
  } catch {
    return false
  }
  switch (url.protocol) {
    case 'file:':
    case 'flowy-model:':
      return true
    case 'http:':
    case 'https:':
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    default:
      return false
  }
}

/**
 * Pure policy: should `permission` be granted to `origin`?
 * 'media' is audio-only: a request listing 'video' (or a check for mediaType 'video') is denied.
 */
export function decidePermission(permission: string, origin: string | null | undefined, details: PermissionDetails = {}): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false
  if (!isOwnOrigin(origin)) return false
  if (permission === 'media') {
    if (details.mediaTypes && details.mediaTypes.some((t) => t !== 'audio')) return false
    if (details.mediaType === 'video') return false
  }
  return true
}

const installed = new WeakSet<Session>()

/**
 * Install request + check handlers on `session`. Idempotent per session (the overlay and the settings
 * window share the default session, both may call this).
 */
export function installPermissionHandlers(session: Session): void {
  if (installed.has(session)) return
  installed.add(session)

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.requestingUrl || safeUrl(webContents)
    const d: PermissionDetails = 'mediaTypes' in details ? { mediaTypes: details.mediaTypes } : {}
    const granted = decidePermission(permission, origin, d)
    if (!granted) log.warn(`denied permission request '${permission}' from ${origin || '<unknown>'}`)
    else log.debug(`granted permission request '${permission}' from ${origin}`)
    callback(granted)
  })

  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = details.requestingUrl || requestingOrigin
    const granted = decidePermission(permission, origin, { mediaType: details.mediaType })
    if (!granted) log.debug(`denied permission check '${permission}' from ${origin || '<unknown>'}`)
    return granted
  })

  log.debug('permission handlers installed')
}

function safeUrl(webContents: { getURL(): string } | null): string {
  try {
    return webContents?.getURL() ?? ''
  } catch {
    return ''
  }
}
