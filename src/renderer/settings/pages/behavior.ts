/**
 * Behavior page: greeting, proactive comments (interval, quiet hours), screen awareness with a
 * cost/privacy explanation, autostart and display selection.
 *
 * OWNER: settings-ui agent.
 */
import type { FlowyConfig, ScreenAwarenessMode } from '@shared/config'
import type { DisplayInfo } from '@shared/ipc'
import { hourLabel } from '../catalog'
import { t } from '../i18n'
import { el, field, note, replaceChildren, section, select, type SelectOption } from '../ui'
import { boundSelect, boundSlider, boundToggle } from './bind'
import type { Page, PageContext } from './context'

function hourSelect(ctx: PageContext, path: 'behavior.proactive.quietHoursStart' | 'behavior.proactive.quietHoursEnd'): HTMLSelectElement {
  const options = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))
  return boundSelect<string>(ctx, path, options, { map: (v) => Number(v) })
}

/** Options for the display dropdown: 'primary', every connected display, plus the stored id if it is not connected. */
export function displayOptions(displays: DisplayInfo[], current: FlowyConfig['display']): Array<SelectOption<string>> {
  const options: Array<SelectOption<string>> = [{ value: 'primary', label: t('behavior.displayPrimary') }]
  for (const d of displays) options.push({ value: String(d.id), label: d.primary ? `${d.label} ★` : d.label })
  if (current !== 'primary' && !displays.some((d) => d.id === current)) {
    options.push({ value: String(current), label: t('behavior.displayUnknown', { id: current }) })
  }
  return options
}

/** Display selector fed by `app:getDisplays` ('primary' or a numeric Electron display id). */
function displayPicker(ctx: PageContext): HTMLElement {
  const holder = el('div', null)
  const render = (displays: DisplayInfo[]): void => {
    const current = ctx.store.get().display
    replaceChildren(
      holder,
      select<string>({
        value: String(current),
        options: displayOptions(displays, current),
        path: 'display',
        onChange: (v) => ctx.store.set('display', v === 'primary' ? 'primary' : Number.parseInt(v, 10), { immediate: true }),
      }),
    )
  }
  render([])
  void window.flowy
    .invoke('app:getDisplays')
    .then(render)
    .catch((err: unknown) => console.warn('[settings] app:getDisplays failed', err))
  return holder
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
      field(t('behavior.display'), displayPicker(ctx), { hint: t('behavior.displayHint') }),
    )

    return el('div', { class: 'page' }, general, proactive, screen, system)
  },
}
