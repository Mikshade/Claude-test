/**
 * Brain (LLM) page: Anthropic key, model, effort, refusal fallback, history size, connection test,
 * plus the web-search tool settings.
 *
 * OWNER: settings-ui agent.
 */
import type { FlowyConfig, LlmEffort } from '@shared/config'
import { isKnownLlmModel, LINKS, LLM_CUSTOM, LLM_EFFORT_KEYS, LLM_MODELS } from '../catalog'
import { t } from '../i18n'
import { asyncButton, el, field, link, section, select, statusLine, textInput } from '../ui'
import { boundSecret, boundSelect, boundSlider, boundToggle, liveField } from './bind'
import type { Page, PageContext } from './context'

function modelPicker(ctx: PageContext): HTMLElement {
  const current = ctx.config.llm.model
  const custom = !isKnownLlmModel(current)
  const options = [...LLM_MODELS.map((m) => ({ value: m.id, label: m.label })), { value: LLM_CUSTOM, label: t('llm.custom') }]
  const desc = el('p', { class: 'field-hint' })
  const customInput = textInput({
    value: custom ? current : '',
    placeholder: 'claude-opus-5-5',
    path: 'llm.model',
    onInput: (v) => {
      if (v.trim()) ctx.store.set('llm.model', v.trim())
    },
    onCommit: () => void ctx.store.flush(),
  })
  const customField = field(t('brain.customModel'), customInput)
  customField.hidden = !custom
  const sel = select<string>({
    value: custom ? LLM_CUSTOM : current,
    options,
    onChange: (v) => {
      if (v === LLM_CUSTOM) {
        customField.hidden = false
        customInput.focus()
      } else {
        customField.hidden = true
        ctx.store.set('llm.model', v, { immediate: true })
      }
      describe(ctx.store.get())
    },
  })
  const describe = (config: FlowyConfig): void => {
    const m = LLM_MODELS.find((x) => x.id === config.llm.model)
    desc.textContent = m ? t(m.descriptionKey) : ''
  }
  describe(ctx.config)
  return el('div', null, sel, desc, customField)
}

function testSection(ctx: PageContext): HTMLElement {
  const status = statusLine()
  const run = async (): Promise<void> => {
    await ctx.store.flush()
    status.set('busy', t('brain.testing'))
    try {
      const result = await window.flowy.invoke('config:testLlm')
      status.set(result.ok ? 'ok' : 'danger', result.message)
    } catch (err) {
      status.set('danger', t('common.failed', { message: err instanceof Error ? err.message : String(err) }))
    }
  }
  return el('div', { class: 'test-row' }, asyncButton(t('brain.testButton'), t('brain.testing'), run, { variant: 'primary' }), status.element)
}

export const brainPage: Page = {
  id: 'brain',
  titleKey: 'brain.title',
  descriptionKey: 'brain.desc',
  render(ctx) {
    const effortOptions = (['low', 'medium', 'high'] as const).map((e) => ({ value: e, label: t(LLM_EFFORT_KEYS[e]) }))
    const account = section(
      t('brain.title'),
      t('brain.desc'),
      liveField(ctx, t('brain.apiKey'), boundSecret(ctx, 'llm.apiKey', 'sk-ant-…'), {
        warn: (c) => (c.llm.apiKey.trim() ? null : t('warn.llmKeyMissing')),
      }),
      el('p', { class: 'field-hint' }, `${t('brain.apiKeyHint')} `, link('console.anthropic.com', LINKS.anthropicKeys)),
      field(t('brain.model'), modelPicker(ctx)),
      field(t('brain.effort'), boundSelect<LlmEffort>(ctx, 'llm.effort', effortOptions)),
      boundToggle(ctx, 'llm.refusalFallback', t('brain.refusalFallback'), t('brain.refusalFallbackDesc')),
      el(
        'div',
        { class: 'grid-2' },
        field(t('brain.maxHistory'), boundSlider(ctx, 'llm.maxHistoryTurns', { min: 4, max: 400, step: 2, format: (v) => t('common.turns', { n: v }) }), {
          hint: t('brain.maxHistoryDesc'),
        }),
        field(t('brain.maxToolIterations'), boundSlider(ctx, 'llm.maxToolIterations', { min: 1, max: 100, step: 1 })),
      ),
      testSection(ctx),
    )

    const web = section(
      t('brain.web'),
      t('brain.webDesc'),
      field(
        t('web.provider'),
        boundSelect<'duckduckgo' | 'brave'>(
          ctx,
          'web.searchProvider',
          [
            { value: 'duckduckgo', label: t('web.duckduckgo') },
            { value: 'brave', label: t('web.brave') },
          ],
          { rerender: true },
        ),
      ),
      ctx.config.web.searchProvider === 'brave'
        ? el('div', null, field(t('web.braveKey'), boundSecret(ctx, 'web.braveApiKey')), el('p', { class: 'field-hint' }, link('brave.com/search/api', LINKS.braveSearch)))
        : null,
      field(t('web.maxPageChars'), boundSlider(ctx, 'web.maxPageChars', { min: 2000, max: 200000, step: 1000, format: (v) => v.toLocaleString(ctx.lang) })),
    )

    return el('div', { class: 'page' }, account, web)
  },
}
