/**
 * Ears (STT) page: provider, OpenAI-compatible endpoint with presets, language hint, microphone,
 * silence timeout and a 3-second microphone test.
 *
 * OWNER: settings-ui agent.
 */
import type { SttProvider } from '@shared/config'
import type { RecordedAudio } from '@shared/ipc'
import { formatSeconds, LINKS, matchSttPreset, STT_PRESETS } from '../catalog'
import { t } from '../i18n'
import { captureMicrophone, describeMicError, listAudioDevices } from '../mic'
import { asyncButton, button, el, field, link, note, replaceChildren, section, select, statusLine } from '../ui'
import { boundSecret, boundSelect, boundSlider, boundText, liveField } from './bind'
import type { Page, PageContext } from './context'

export const MIC_TEST_MS = 3000

function presetButtons(ctx: PageContext): HTMLElement {
  const active = matchSttPreset(ctx.config.stt.openaiCompatible.baseUrl)
  return el(
    'div',
    { class: 'chip-row' },
    STT_PRESETS.map((preset) =>
      button(
        t(preset.labelKey),
        () => {
          ctx.store.patch({ stt: { openaiCompatible: { baseUrl: preset.baseUrl, model: preset.model } } }, { immediate: true })
          ctx.rerender()
        },
        { small: true, variant: active?.id === preset.id ? 'primary' : 'secondary' },
      ),
    ),
  )
}

function openaiSection(ctx: PageContext): HTMLElement {
  return section(
    t('ears.providerOpenai'),
    t('ears.openaiHint'),
    field(t('ears.presets'), presetButtons(ctx)),
    field(t('ears.baseUrl'), boundText(ctx, 'stt.openaiCompatible.baseUrl', { type: 'url', placeholder: 'https://api.openai.com/v1' })),
    liveField(ctx, t('ears.apiKey'), boundSecret(ctx, 'stt.openaiCompatible.apiKey'), {
      warn: (c) => (c.stt.openaiCompatible.apiKey.trim() ? null : t('warn.sttOpenaiKeyMissing')),
    }),
    el('p', { class: 'field-hint' }, link('platform.openai.com/api-keys', LINKS.openaiKeys), ' · ', link('console.groq.com/keys', LINKS.groqKeys)),
    field(t('ears.model'), boundText(ctx, 'stt.openaiCompatible.model', { placeholder: 'whisper-1' })),
  )
}

function micSelect(ctx: PageContext): HTMLElement {
  const holder = el('div', null)
  const render = (devices: Array<{ deviceId: string; label: string }>): void => {
    const options = [{ value: '', label: t('voice.deviceDefault') }, ...devices.map((d) => ({ value: d.deviceId, label: d.label }))]
    const currentId = ctx.store.get().stt.inputDeviceId
    if (currentId && !devices.some((d) => d.deviceId === currentId)) options.push({ value: currentId, label: `${currentId.slice(0, 12)}…` })
    replaceChildren(
      holder,
      select<string>({
        value: currentId,
        options,
        path: 'stt.inputDeviceId',
        onChange: (v) => ctx.store.set('stt.inputDeviceId', v, { immediate: true }),
      }),
    )
  }
  render([])
  void listAudioDevices('audioinput').then(render)
  return holder
}

function micTest(ctx: PageContext, refreshDevices: () => void): HTMLElement {
  const status = statusLine()
  const meter = el('div', { class: 'level-meter' }, el('div', { class: 'level-fill' }))
  meter.hidden = true
  const fill = meter.firstElementChild as HTMLElement
  const run = async (): Promise<void> => {
    await ctx.store.flush()
    if (ctx.store.get().stt.provider === 'none') return
    status.set('busy', t('ears.recording'))
    meter.hidden = false
    let audio: RecordedAudio
    try {
      audio = await captureMicrophone({
        deviceId: ctx.store.get().stt.inputDeviceId,
        durationMs: MIC_TEST_MS,
        onLevel: (level) => {
          fill.style.width = `${Math.round(level * 100)}%`
        },
      })
    } catch (err) {
      meter.hidden = true
      status.set('danger', t('ears.micError', { message: describeMicError(err) }))
      return
    }
    meter.hidden = true
    refreshDevices() // labels become available after the first grant
    status.set('busy', t('ears.transcribing'))
    try {
      const result = await window.flowy.invoke('config:testStt', audio)
      if (!result.ok) status.set('danger', result.message)
      else if (!result.message.trim()) status.set('warn', t('ears.nothing'))
      else status.set('ok', t('ears.transcript', { text: result.message.trim() }))
    } catch (err) {
      status.set('danger', t('common.failed', { message: err instanceof Error ? err.message : String(err) }))
    }
  }
  return el(
    'div',
    { class: 'test-row test-row-wrap' },
    asyncButton(t('ears.testButton'), t('ears.recording'), run, { variant: 'primary', disabled: ctx.config.stt.provider === 'none' }),
    meter,
    status.element,
  )
}

export const earsPage: Page = {
  id: 'ears',
  titleKey: 'ears.title',
  descriptionKey: 'ears.desc',
  render(ctx) {
    const providerOptions: Array<{ value: SttProvider; label: string }> = [
      { value: 'fish-cloud', label: t('ears.providerFish') },
      { value: 'openai-compatible', label: t('ears.providerOpenai') },
      { value: 'none', label: t('ears.providerNone') },
    ]
    const providerField = liveField(ctx, t('ears.provider'), boundSelect<SttProvider>(ctx, 'stt.provider', providerOptions, { rerender: true }), {
      warn: (c) => (c.stt.provider === 'fish-cloud' && !c.tts.fishCloud.apiKey.trim() ? t('warn.sttNeedsFishKey') : null),
    })
    const provider = section(t('ears.title'), t('ears.desc'), providerField, ctx.config.stt.provider === 'fish-cloud' ? note('info', t('ears.fishNote')) : null)

    const micHolder = el('div', null)
    const renderMic = (): void => replaceChildren(micHolder, micSelect(ctx))
    renderMic()

    const recording = section(
      t('ears.mic'),
      null,
      field(t('ears.mic'), micHolder, { hint: t('voice.deviceHint') }),
      field(t('ears.language'), boundText(ctx, 'stt.language', { placeholder: ctx.lang }), { hint: t('ears.languageHint') }),
      el(
        'div',
        { class: 'grid-2' },
        field(t('ears.silence'), boundSlider(ctx, 'stt.silenceTimeoutMs', { min: 0, max: 10000, step: 100, format: (v) => formatSeconds(v, ctx.lang) }), {
          hint: t('ears.silenceDesc'),
        }),
        field(t('ears.maxRecording'), boundSlider(ctx, 'stt.maxRecordingMs', { min: 1000, max: 120000, step: 1000, format: (v) => formatSeconds(v, ctx.lang) })),
      ),
      micTest(ctx, renderMic),
    )

    return el('div', { class: 'page' }, provider, ctx.config.stt.provider === 'openai-compatible' ? openaiSection(ctx) : null, ctx.config.stt.provider === 'none' ? null : recording)
  },
}
