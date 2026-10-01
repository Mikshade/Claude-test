/**
 * Look page: Live2D model path, size, anchor, avoidance, cursor tracking, mirror, pinned, idle
 * opacity, subtitles, theme.
 *
 * OWNER: settings-ui agent.
 */
import type { AvatarConfig } from '@shared/config'
import { LINKS } from '../catalog'
import { t } from '../i18n'
import { asyncButton, button, el, field, link, note, section, textInput } from '../ui'
import { boundSelect, boundSlider, boundToggle } from './bind'
import type { Page, PageContext } from './context'

function modelPathField(ctx: PageContext): HTMLElement {
  const input = textInput({
    value: ctx.config.avatar.modelPath,
    placeholder: ctx.info?.defaultModelPath || 'C:\\…\\model.model3.json',
    path: 'avatar.modelPath',
    onInput: (v) => ctx.store.set('avatar.modelPath', v.trim()),
    onCommit: () => void ctx.store.flush(),
  })
  ctx.onConfig((c) => {
    if (document.activeElement !== input && input.value !== c.avatar.modelPath) input.value = c.avatar.modelPath
  })
  const browse = asyncButton(t('common.browse'), t('common.browse'), async () => {
    const picked = await window.flowy.invoke('config:pickModelFile')
    if (picked) ctx.store.set('avatar.modelPath', picked, { immediate: true })
  })
  const clear = button(t('common.clear'), () => ctx.store.set('avatar.modelPath', '', { immediate: true }), { variant: 'ghost' })
  return el('div', { class: 'input-group' }, input, browse, clear)
}

export const lookPage: Page = {
  id: 'look',
  titleKey: 'look.title',
  descriptionKey: 'look.desc',
  render(ctx) {
    const anchors: Array<{ value: AvatarConfig['anchor']; label: string }> = [
      { value: 'bottom-right', label: t('anchor.bottom-right') },
      { value: 'bottom-left', label: t('anchor.bottom-left') },
      { value: 'top-right', label: t('anchor.top-right') },
      { value: 'top-left', label: t('anchor.top-left') },
    ]
    const holdKeys: Array<{ value: AvatarConfig['avoidance']['holdKeyToInteract']; label: string }> = [
      { value: 'Control', label: 'Strg / Ctrl' },
      { value: 'Alt', label: 'Alt' },
      { value: 'Shift', label: 'Shift' },
    ]
    const px = (v: number): string => t('common.px', { n: v })

    const model = section(
      t('look.model'),
      null,
      field(t('look.modelPath'), modelPathField(ctx), { hint: t('look.modelHint') }),
      ctx.info ? note(ctx.info.live2dCoreAvailable ? 'ok' : 'warn', ctx.info.live2dCoreAvailable ? t('look.coreAvailable') : t('look.coreMissing')) : null,
      note('info', `${t('look.license')} `, link('live2d.com', LINKS.live2dLicense)),
    )

    const sizing = section(
      t('look.title'),
      t('look.desc'),
      el(
        'div',
        { class: 'grid-2' },
        field(t('look.height'), boundSlider(ctx, 'avatar.height', { min: 150, max: 1200, step: 10, format: px })),
        field(t('look.anchor'), boundSelect(ctx, 'avatar.anchor', anchors)),
      ),
      boundToggle(ctx, 'avatar.lookAtCursor', t('look.lookAtCursor'), t('look.lookAtCursorDesc')),
      boundToggle(ctx, 'avatar.mirror', t('look.mirror'), t('look.mirrorDesc')),
      boundToggle(ctx, 'avatar.pinned', t('look.pinned'), t('look.pinnedDesc')),
    )

    const avoidance = section(
      t('look.avoidance'),
      t('look.avoidanceDesc'),
      boundToggle(ctx, 'avatar.avoidance.enabled', t('look.avoidanceEnabled'), null),
      el(
        'div',
        { class: 'grid-2' },
        field(t('look.radius'), boundSlider(ctx, 'avatar.avoidance.radius', { min: 40, max: 600, step: 10, format: px })),
        field(t('look.duration'), boundSlider(ctx, 'avatar.avoidance.durationMs', { min: 150, max: 3000, step: 50, format: (v) => `${v} ms` })),
      ),
      field(t('look.holdKey'), boundSelect(ctx, 'avatar.avoidance.holdKeyToInteract', holdKeys), { hint: t('look.holdKeyDesc') }),
    )

    const appearance = section(
      t('look.appearance'),
      null,
      field(t('look.idleOpacity'), boundSlider(ctx, 'appearance.idleOpacity', { min: 0, max: 100, step: 5, format: (v) => t('common.percent', { n: v }) })),
      boundToggle(ctx, 'appearance.showSubtitles', t('look.subtitles'), t('look.subtitlesDesc')),
      el(
        'div',
        { class: 'grid-2' },
        field(t('look.fontSize'), boundSlider(ctx, 'appearance.bubbleFontSize', { min: 10, max: 32, step: 1, format: px })),
        field(
          t('look.theme'),
          boundSelect<'auto' | 'light' | 'dark'>(ctx, 'appearance.theme', [
            { value: 'auto', label: t('theme.auto') },
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]),
        ),
      ),
    )

    return el('div', { class: 'page' }, model, sizing, avoidance, appearance)
  },
}
