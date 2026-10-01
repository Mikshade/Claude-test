/**
 * About page: version, paths, clear history, links, re-run the wizard.
 *
 * OWNER: settings-ui agent.
 */
import { LINKS } from '../catalog'
import { t } from '../i18n'
import { asyncButton, button, el, link, section, statusLine } from '../ui'
import type { Page } from './context'

function infoRow(label: string, value: string): HTMLElement {
  const copy = button(t('common.copy'), () => {
    void navigator.clipboard?.writeText(value).then(() => {
      copy.textContent = t('common.copied')
      setTimeout(() => {
        copy.textContent = t('common.copy')
      }, 1500)
    })
  }, { variant: 'ghost', small: true })
  return el('div', { class: 'info-row' }, el('span', { class: 'info-label' }, label), el('code', { class: 'info-value' }, value), value ? copy : null)
}

export const aboutPage: Page = {
  id: 'about',
  titleKey: 'about.title',
  descriptionKey: 'about.desc',
  render(ctx) {
    const info = ctx.info
    const facts = section(
      t('about.title'),
      t('about.desc'),
      el(
        'div',
        { class: 'info-list' },
        infoRow(t('about.version'), info?.version ?? '?'),
        infoRow(t('about.platform'), info?.platform ?? '?'),
        infoRow(t('about.userData'), info?.userDataPath ?? ''),
        infoRow(t('about.defaultModel'), info?.defaultModelPath || t('about.noModel')),
        infoRow(t('about.elevated'), info?.elevated ? t('common.yes') : t('common.no')),
      ),
    )

    const status = statusLine()
    const clearBtn = asyncButton(
      t('about.clearHistory'),
      t('about.clearHistory'),
      async () => {
        if (!window.confirm(t('about.clearConfirm'))) return
        try {
          await window.flowy.invoke('chat:clearHistory')
          status.set('ok', t('about.cleared'))
        } catch (err) {
          status.set('danger', t('common.failed', { message: err instanceof Error ? err.message : String(err) }))
        }
      },
      { variant: 'danger' },
    )
    const history = section(t('about.history'), t('about.historyDesc'), el('div', { class: 'test-row' }, clearBtn, status.element))

    const links = section(
      t('about.links'),
      null,
      el(
        'ul',
        { class: 'link-list' },
        el('li', null, link('Fish Audio', LINKS.fishVoices)),
        el('li', null, link('Anthropic Console', LINKS.anthropicConsole)),
        el('li', null, link('Live2D', LINKS.live2d)),
        el('li', null, link('Fish Speech (open source)', LINKS.fishSpeechRepo)),
      ),
      el('p', { class: 'muted' }, t('about.credits')),
      button(t('about.rerunWizard'), () => {
        location.hash = '#wizard'
      }),
    )

    return el('div', { class: 'page' }, facts, history, links)
  },
}
