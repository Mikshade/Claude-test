/**
 * What every settings page gets from the shell.
 *
 * OWNER: settings-ui agent.
 */
import type { FlowyConfig, Language } from '@shared/config'
import type { AppInfo } from '@shared/ipc'
import type { StringKey } from '../i18n'
import type { PageId } from '../nav'
import type { SettingsStore } from '../store'
import type { NoteKind } from '../ui'

export type Mode = 'tabs' | 'wizard'

export interface PageContext {
  /** Snapshot of the current config at render time (use `store.get()` for the latest). */
  readonly config: FlowyConfig
  readonly store: SettingsStore
  readonly info: AppInfo | null
  readonly lang: Language
  readonly mode: Mode
  /** Re-render this page (after structural changes such as a provider switch). */
  rerender(): void
  /** Run `listener` after every config change while this page is mounted. */
  onConfig(listener: (config: FlowyConfig) => void): void
  /** Register cleanup that runs when the page is unmounted (stop audio, timers …). */
  onUnmount(cleanup: () => void): void
  toast(message: string, kind?: NoteKind): void
  /** Jump to another page (tabs mode) – used by cross-references such as "set the key under Voice". */
  navigate(page: PageId): void
}

export interface Page {
  id: PageId
  titleKey: StringKey
  descriptionKey: StringKey
  render(ctx: PageContext): HTMLElement
}
