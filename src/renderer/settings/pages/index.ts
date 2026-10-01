/**
 * Page registry (sidebar order).
 *
 * OWNER: settings-ui agent.
 */
import type { PageId } from '../nav'
import { aboutPage } from './about'
import { behaviorPage } from './behavior'
import { brainPage } from './brain'
import { characterPage } from './character'
import type { Page } from './context'
import { earsPage } from './ears'
import { hotkeysPage } from './hotkeys'
import { lookPage } from './look'
import { permissionsPage } from './permissions'
import { voicePage } from './voice'

export const PAGES: readonly Page[] = [characterPage, voicePage, brainPage, earsPage, lookPage, permissionsPage, hotkeysPage, behaviorPage, aboutPage]

export function pageById(id: PageId): Page {
  return PAGES.find((p) => p.id === id) ?? characterPage
}
