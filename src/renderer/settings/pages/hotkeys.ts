/**
 * Hotkeys page: accelerator capture inputs (focus + press keys → Electron accelerator string).
 *
 * OWNER: settings-ui agent.
 */
import type { HotkeysConfig } from '@shared/config'
import { acceleratorFromKeyEvent, acceleratorWarning, prettyAccelerator } from '../accelerator'
import { t } from '../i18n'
import { button, el, field, note, section } from '../ui'
import type { Page, PageContext } from './context'

/** Order on the page; labels/descriptions are `hotkey.<id>` / `hotkey.<id>Desc` in the string tables. */
const HOTKEY_IDS: ReadonlyArray<keyof HotkeysConfig> = ['pushToTalk', 'toggleVisibility', 'openChat', 'interrupt']

function warningText(accelerator: string): string | null {
  switch (acceleratorWarning(accelerator)) {
    case 'noModifier':
      return t('hotkeys.warnNoModifier')
    case 'bareEscape':
      return t('hotkeys.warnBareEscape')
    default:
      return null
  }
}

function captureInput(ctx: PageContext, key: keyof HotkeysConfig): HTMLElement {
  const path = `hotkeys.${key}`
  const input = el('input', { class: 'input hotkey-input', type: 'text', readonly: true, dataset: { path }, spellcheck: 'false' })
  const show = (value: string): void => {
    input.value = value ? prettyAccelerator(value) : ''
    input.placeholder = document.activeElement === input ? t('hotkeys.press') : t('hotkeys.empty')
    f.setWarning(warningText(value))
  }
  const commit = (value: string): void => {
    ctx.store.set(path, value, { immediate: true })
    show(value)
  }
  input.addEventListener('focus', () => show(ctx.store.get().hotkeys[key]))
  input.addEventListener('blur', () => show(ctx.store.get().hotkeys[key]))
  input.addEventListener('keydown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Backspace' || e.key === 'Delete') {
      commit('')
      return
    }
    if (e.key === 'Tab') return
    const accelerator = acceleratorFromKeyEvent(e)
    if (accelerator) commit(accelerator)
  })
  const clear = button(t('common.clear'), () => commit(''), { variant: 'ghost', small: true })
  const f = field(t(`hotkey.${key}`), el('div', { class: 'input-group' }, input, clear), { hint: t(`hotkey.${key}Desc`) })
  show(ctx.config.hotkeys[key])
  ctx.onConfig((c) => {
    if (document.activeElement !== input) show(c.hotkeys[key])
  })
  return f
}

export const hotkeysPage: Page = {
  id: 'hotkeys',
  titleKey: 'hotkeys.title',
  descriptionKey: 'hotkeys.desc',
  render(ctx) {
    const list = section(
      t('hotkeys.title'),
      t('hotkeys.desc'),
      note('info', t('hotkeys.howto')),
      HOTKEY_IDS.map((id) => captureInput(ctx, id)),
      el('p', { class: 'muted' }, t('hotkeys.conflictNote')),
    )
    return el('div', { class: 'page' }, list)
  },
}
