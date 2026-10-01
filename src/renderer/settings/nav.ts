/**
 * Routing for the settings page: '#<page>' selects a tab, '#wizard' / '#wizard/<step>' the first-run
 * stepper. Pure – unit-tested in nav.test.ts.
 *
 * OWNER: settings-ui agent.
 */

export const PAGE_IDS = ['character', 'voice', 'brain', 'ears', 'look', 'permissions', 'hotkeys', 'behavior', 'about'] as const
export type PageId = (typeof PAGE_IDS)[number]

export const WIZARD_STEPS = ['welcome', 'character', 'brain', 'voice', 'ears', 'permissions', 'finish'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export const DEFAULT_PAGE: PageId = 'character'

export type Route = { mode: 'tabs'; page: PageId } | { mode: 'wizard'; step: WizardStep }

export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as readonly string[]).includes(value)
}

export function isWizardStep(value: string): value is WizardStep {
  return (WIZARD_STEPS as readonly string[]).includes(value)
}

/**
 * Parse `location.hash`. An empty hash opens the wizard until setup is completed, afterwards the
 * default tab. Unknown ids fall back to the default tab (or the first wizard step).
 */
export function parseHash(hash: string, setupCompleted: boolean): Route {
  const raw = decodeURIComponent(hash.replace(/^#/, '')).trim()
  if (!raw) return setupCompleted ? { mode: 'tabs', page: DEFAULT_PAGE } : { mode: 'wizard', step: 'welcome' }
  const [head = '', tail = ''] = raw.split('/', 2)
  if (head === 'wizard') return { mode: 'wizard', step: isWizardStep(tail) ? tail : 'welcome' }
  if (isPageId(head)) return { mode: 'tabs', page: head }
  return { mode: 'tabs', page: DEFAULT_PAGE }
}

export function routeHash(route: Route): string {
  return route.mode === 'wizard' ? (route.step === 'welcome' ? '#wizard' : `#wizard/${route.step}`) : `#${route.page}`
}

export function wizardIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step)
}

export function nextStep(step: WizardStep): WizardStep | null {
  return WIZARD_STEPS[wizardIndex(step) + 1] ?? null
}

export function prevStep(step: WizardStep): WizardStep | null {
  const i = wizardIndex(step)
  return i > 0 ? (WIZARD_STEPS[i - 1] ?? null) : null
}
