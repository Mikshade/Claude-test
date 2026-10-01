/**
 * Character page: names, language, form of address, personality preset cards, trait sliders,
 * custom prompt and a live excerpt of the system prompt.
 *
 * OWNER: settings-ui agent.
 */
import type { CharacterConfig, FlowyConfig, Language, PersonalityPreset } from '@shared/config'
import { buildSystemPrompt, PRESETS } from '@shared/personality'
import { t } from '../i18n'
import { el, field, replaceChildren, section } from '../ui'
import { boundRadio, boundSelect, boundSlider, boundText, boundTextarea, liveField } from './bind'
import type { Page, PageContext } from './context'

const TRAITS: ReadonlyArray<{ key: keyof CharacterConfig['traits']; labelKey: 'trait.warmth' | 'trait.playfulness' | 'trait.sass' | 'trait.formality' | 'trait.verbosity' | 'trait.proactivity' }> = [
  { key: 'warmth', labelKey: 'trait.warmth' },
  { key: 'playfulness', labelKey: 'trait.playfulness' },
  { key: 'sass', labelKey: 'trait.sass' },
  { key: 'formality', labelKey: 'trait.formality' },
  { key: 'verbosity', labelKey: 'trait.verbosity' },
  { key: 'proactivity', labelKey: 'trait.proactivity' },
]

/** The character-related head of the system prompt (everything before the SPEECH OUTPUT rules). */
export function promptExcerpt(config: FlowyConfig): string {
  const full = buildSystemPrompt({ character: config.character, permissions: config.permissions, toolNames: [], platform: 'Windows' })
  const cut = full.indexOf('\nSPEECH OUTPUT:')
  return (cut > 0 ? full.slice(0, cut) : full).trim()
}

function presetCards(ctx: PageContext): HTMLElement {
  const grid = el('div', { class: 'preset-grid', role: 'radiogroup' })
  const buttons = new Map<PersonalityPreset, HTMLButtonElement>()
  for (const preset of PRESETS) {
    const btn = el(
      'button',
      { type: 'button', class: 'preset-card', role: 'radio', dataset: { preset: preset.id } },
      el('span', { class: 'preset-title' }, preset.title[ctx.lang]),
      el('span', { class: 'preset-tagline' }, preset.tagline[ctx.lang]),
    )
    btn.addEventListener('click', () => ctx.store.set('character.preset', preset.id, { immediate: true }))
    buttons.set(preset.id, btn)
    grid.appendChild(btn)
  }
  const mark = (config: FlowyConfig): void => {
    for (const [id, btn] of buttons) {
      const active = id === config.character.preset
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-checked', String(active))
    }
  }
  mark(ctx.config)
  ctx.onConfig(mark)
  return grid
}

export const characterPage: Page = {
  id: 'character',
  titleKey: 'character.title',
  descriptionKey: 'character.desc',
  render(ctx) {
    const languageOptions: Array<{ value: Language; label: string }> = [
      { value: 'de', label: t('common.german') },
      { value: 'en', label: t('common.english') },
    ]

    const identity = section(
      t('character.title'),
      t('character.desc'),
      liveField(ctx, t('character.name'), boundText(ctx, 'character.name', { placeholder: 'Yui' }), {
        warn: (c) => (c.character.name.trim() ? null : t('warn.nameEmpty')),
      }),
      field(t('character.userName'), boundText(ctx, 'character.userName'), { hint: t('character.userNameHint') }),
      field(t('common.language'), boundSelect<Language>(ctx, 'character.language', languageOptions), { hint: t('character.languageHint') }),
      ctx.config.character.language === 'de'
        ? field(
            t('character.formOfAddress'),
            boundRadio<'du' | 'Sie'>(ctx, 'character.formOfAddress', [
              { value: 'du', label: t('character.du') },
              { value: 'Sie', label: t('character.sie') },
            ]),
          )
        : null,
    )

    const personality = section(t('character.personality'), t('character.personalityDesc'), presetCards(ctx))

    const traits = section(
      t('character.traits'),
      t('character.traitsDesc'),
      el(
        'div',
        { class: 'trait-grid' },
        TRAITS.map((trait) => field(t(trait.labelKey), boundSlider(ctx, `character.traits.${trait.key}`, { min: 0, max: 100, step: 1 }))),
      ),
    )

    const custom = section(
      t('character.customPrompt'),
      t('character.customPromptDesc'),
      boundTextarea(ctx, 'character.customPrompt', { placeholder: t('character.customPromptPlaceholder'), rows: 5 }),
    )

    const pre = el('pre', { class: 'prompt-preview' }, promptExcerpt(ctx.config))
    ctx.onConfig((config) => replaceChildren(pre, promptExcerpt(config)))
    const preview = section(t('character.preview'), t('character.previewDesc'), pre)

    return el('div', { class: 'page' }, identity, personality, traits, custom, preview)
  },
}
