/**
 * First-run wizard: a stepper over the shared page modules (welcome → character → brain → voice →
 * ears → permissions → finish). The last step calls config:completeSetup and closes the window.
 *
 * OWNER: settings-ui agent.
 */
import type { FlowyConfig } from '@shared/config'
import { presetById } from '@shared/personality'
import { t } from './i18n'
import { nextStep, prevStep, routeHash, WIZARD_STEPS, type WizardStep, wizardIndex } from './nav'
import { pageById } from './pages'
import type { PageContext } from './pages/context'
import { button, el, note, section } from './ui'
import { collectWarnings } from './validation'

export const CLOSE_AFTER_FINISH_MS = 2000

export interface WizardHost {
  /** Build a page context for the given page id (the shell owns stores/listeners). */
  context(pageId: Exclude<WizardStep, 'welcome' | 'finish'>): PageContext
  config(): FlowyConfig
  flush(): Promise<void>
  go(step: WizardStep): void
  /** Called after setup was completed (the shell may switch to tabs mode as a fallback). */
  completed(): void
}

function stepper(current: WizardStep): HTMLElement {
  const items = WIZARD_STEPS.map((step, i) =>
    el(
      'li',
      { class: `stepper-item${step === current ? ' is-current' : i < wizardIndex(current) ? ' is-done' : ''}` },
      el('span', { class: 'stepper-dot' }, String(i + 1)),
      el('span', { class: 'stepper-label' }, t(`wizard.step.${step}`)),
    ),
  )
  return el('ol', { class: 'stepper' }, items)
}

function welcome(): HTMLElement {
  return el(
    'div',
    { class: 'page wizard-welcome' },
    el('div', { class: 'hero' }, el('div', { class: 'hero-art' }, '✨'), el('h1', null, t('wizard.welcome.title')), el('p', { class: 'lead' }, t('wizard.welcome.body'))),
    note('info', t('wizard.welcome.needs')),
  )
}

export function summaryRows(config: FlowyConfig, lang: 'de' | 'en'): Array<[string, string]> {
  const voice = config.tts.provider === 'none' ? '—' : config.tts.provider === 'fish-cloud' ? `Fish Audio Cloud · ${config.tts.fishCloud.model}` : `Fish Speech · ${config.tts.fishLocal.baseUrl}`
  const ears = config.stt.provider === 'none' ? '—' : config.stt.provider === 'fish-cloud' ? 'Fish Audio ASR' : `${config.stt.openaiCompatible.baseUrl} · ${config.stt.openaiCompatible.model}`
  return [
    [t('wizard.finish.summaryName'), config.character.name],
    [t('wizard.finish.summaryPreset'), presetById(config.character.preset).title[lang]],
    [t('wizard.finish.summaryModel'), config.llm.model],
    [t('wizard.finish.summaryVoice'), voice],
    [t('wizard.finish.summaryEars'), ears],
    [t('wizard.finish.summaryPermissions'), t(`level.${config.permissions.level}`)],
  ]
}

function finish(host: WizardHost, lang: 'de' | 'en'): HTMLElement {
  const config = host.config()
  const warnings = collectWarnings(config)
  const rows = summaryRows(config, lang).map(([label, value]) => el('div', { class: 'info-row' }, el('span', { class: 'info-label' }, label), el('span', { class: 'info-value' }, value)))
  const issues = warnings.length
    ? note('warn', el('strong', null, t('wizard.finish.openIssues')), el('ul', null, warnings.map((w) => el('li', null, t(w.key)))))
    : note('ok', t('wizard.finish.allGood'))
  return el('div', { class: 'page' }, section(t('wizard.finish.title'), t('wizard.finish.body'), el('div', { class: 'info-list' }, rows), issues))
}

export interface WizardView {
  element: HTMLElement
}

export function renderWizard(host: WizardHost, step: WizardStep, lang: 'de' | 'en'): WizardView {
  const body = el('div', { class: 'wizard-body' })
  if (step === 'welcome') body.appendChild(welcome())
  else if (step === 'finish') body.appendChild(finish(host, lang))
  else body.appendChild(pageById(step).render(host.context(step)))

  const prev = prevStep(step)
  const next = nextStep(step)
  const back = prev ? button(t('common.back'), () => host.go(prev), { variant: 'ghost' }) : null
  let forward: HTMLElement
  if (step === 'finish') {
    forward = button(t('wizard.finish.button'), () => void complete(), { variant: 'primary' })
  } else {
    forward = button(step === 'welcome' ? t('wizard.welcome.start') : t('common.next'), () => void goNext(), { variant: 'primary' })
  }

  async function goNext(): Promise<void> {
    await host.flush()
    if (next) host.go(next)
  }

  async function complete(): Promise<void> {
    ;(forward as HTMLButtonElement).disabled = true
    await host.flush()
    try {
      await window.flowy.invoke('config:completeSetup')
    } catch (err) {
      console.error('[settings] completeSetup failed', err)
      ;(forward as HTMLButtonElement).disabled = false
      return
    }
    body.replaceChildren(el('div', { class: 'page' }, note('ok', el('strong', null, t('wizard.finish.done')))))
    footer.hidden = true
    setTimeout(() => {
      window.close()
      // If the window did not close (e.g. blocked), fall back to the normal settings view.
      setTimeout(() => host.completed(), 300)
    }, CLOSE_AFTER_FINISH_MS)
  }

  const footer = el(
    'footer',
    { class: 'wizard-footer' },
    el('span', { class: 'muted' }, t('wizard.progress', { current: wizardIndex(step) + 1, total: WIZARD_STEPS.length })),
    el('div', { class: 'wizard-nav' }, back, forward),
  )

  const element = el('div', { class: 'wizard' }, el('header', { class: 'wizard-header' }, el('h1', { class: 'brand' }, 'Flowy'), stepper(step)), body, footer)
  return { element }
}

export { routeHash }
