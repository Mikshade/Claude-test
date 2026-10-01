/**
 * Behavior page: greeting, proactive comments (interval, quiet hours), screen awareness with a
 * cost/privacy explanation, autostart and display selection.
 *
 * OWNER: settings-ui agent.
 */
import type { FlowyConfig, ScreenAwarenessMode } from '@shared/config'
import { hourLabel } from '../catalog'
import { t } from '../i18n'
import { el, field, note, section, select, textInput } from '../ui'
import { boundSelect, boundSlider, boundToggle } from './bind'
import type { Page, PageContext } from './context'

function hourSelect(ctx: PageContext, path: 'behavior.proactive.quietHoursStart' | 'behavior.proactive.quietHoursEnd'): HTMLSelectElement {
  const options = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))
  return boundSelect<string>(ctx, path, options, { map: (v) => Number(v) })
}

/** Display selector: 'primary' or a numeric Electron display id (typed in). */
function displayPicker(ctx: PageContext): HTMLElement {
  const current = ctx.config.display
  const custom = current !== 'primary'
  const idInput = textInput({
    value: custom ? String(current) : '',
    type: 'number',
    placeholder: '2528732444',
    path: 'display',
    onCommit: (v) => {
      const id = Number.parseInt(v, 10)
      if (Number.isInteger(id)) ctx.store.set('display', id, { immediate: true })
    },
  })
  const idField = field(t('behavior.displayId'), idInput, { hint: t('behavior.displayHint') })
  idField.hidden = !custom
  const sel = select<'primary' | 'custom'>({
    value: custom ? 'custom' : 'primary',
    options: [
      { value: 'primary', label: t('behavior.displayPrimary') },
      { value: 'custom', label: t('behavior.displayCustom') },
    ],
    onChange: (v) => {
      if (v === 'primary') {
        idField.hidden = true
        ctx.store.set('display', 'primary', { immediate: true })
      } else {
        idField.hidden = false
        idInput.focus()
      }
    },
  })
  return el('div', null, sel, idField)
}

export const behaviorPage: Page = {
  id: 'behavior',
  titleKey: 'behavior.title',
  descriptionKey: 'behavior.desc',
  render(ctx) {
    const modes: Array<{ value: ScreenAwarenessMode; label: string }> = [
      { value: 'always', label: t('screen.always') },
      { value: 'on-demand', label: t('screen.on-demand') },
      { value: 'off', label: t('screen.off') },
    ]
    const minutes = (v: number): string => t('common.minutes', { n: v })

    const general = section(t('behavior.title'), t('behavior.desc'), boundToggle(ctx, 'behavior.greetOnStart', t('behavior.greet'), t('behavior.greetDesc')))

    const proactiveBody = el(
      'div',
      { class: 'subsection' },
      field(t('behavior.interval'), boundSlider(ctx, 'behavior.proactive.intervalMinutes', { min: 2, max: 240, step: 1, format: minutes })),
      field(
        t('behavior.quietHours'),
        el(
          'div',
          { class: 'inline-controls' },
          el('span', { class: 'muted' }, t('behavior.quietFrom')),
          hourSelect(ctx, 'behavior.proactive.quietHoursStart'),
          el('span', { class: 'muted' }, t('behavior.quietTo')),
          hourSelect(ctx, 'behavior.proactive.quietHoursEnd'),
        ),
        { hint: t('behavior.quietHint') },
      ),
    )
    const syncProactive = (c: FlowyConfig): void => {
      proactiveBody.classList.toggle('is-disabled', !c.behavior.proactive.enabled)
    }
    syncProactive(ctx.config)
    ctx.onConfig(syncProactive)
    const proactive = section(
      t('behavior.proactive'),
      t('behavior.proactiveDesc'),
      boundToggle(ctx, 'behavior.proactive.enabled', t('behavior.proactiveEnabled'), null),
      proactiveBody,
    )

    const screen = section(
      t('behavior.screen'),
      null,
      field(t('behavior.screen'), boundSelect<ScreenAwarenessMode>(ctx, 'screenAwareness.mode', modes)),
      note('info', t('behavior.screenCost')),
      boundToggle(ctx, 'screenAwareness.includeActiveWindow', t('behavior.includeWindow'), t('behavior.includeWindowDesc')),
      el(
        'div',
        { class: 'grid-2' },
        field(t('behavior.maxLongEdge'), boundSlider(ctx, 'screenAwareness.maxLongEdge', { min: 640, max: 2048, step: 64, format: (v) => t('common.px', { n: v }) })),
        field(t('behavior.jpegQuality'), boundSlider(ctx, 'screenAwareness.jpegQuality', { min: 30, max: 95, step: 5, format: (v) => t('common.percent', { n: v }) })),
      ),
    )

    const system = section(
      t('behavior.system'),
      null,
      boundToggle(ctx, 'autostart', t('behavior.autostart'), t('behavior.autostartDesc')),
      field(t('behavior.display'), displayPicker(ctx)),
    )

    return el('div', { class: 'page' }, general, proactive, screen, system)
  },
}
