/**
 * Voice (TTS) page: provider, Fish cloud (key, model, voice search, format/latency, clone sample),
 * Fish local, playback (cues, speed, volume, output device) and the "test voice" button.
 *
 * OWNER: settings-ui agent.
 */
import type { FishCloudModel, FlowyConfig, TtsProvider } from '@shared/config'
import type { TestResult, VoiceInfo } from '@shared/ipc'
import { LINKS, parseFishReferenceId, TTS_CLOUD_MODELS } from '../catalog'
import { t } from '../i18n'
import { listAudioDevices } from '../mic'
import { asyncButton, button, el, field, link, note, replaceChildren, section, select, statusLine, textInput } from '../ui'
import { playableFromTestAudio } from '../wav'
import { boundSecret, boundSelect, boundSlider, boundText, boundTextarea, boundToggle, liveField } from './bind'
import type { Page, PageContext } from './context'

/** One shared <audio> element per page instance (voice samples + test playback). */
interface AudioPlayer {
  play(src: string): void
  stop(): void
  onEnded(fn: () => void): void
}

function createAudioPlayer(ctx: PageContext): AudioPlayer {
  const audio = new Audio()
  let objectUrl: string | null = null
  let endedListener: (() => void) | null = null
  const release = (): void => {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  audio.addEventListener('ended', () => endedListener?.())
  audio.addEventListener('error', () => endedListener?.())
  ctx.onUnmount(() => {
    audio.pause()
    release()
  })
  return {
    play(src) {
      audio.pause()
      release()
      if (src.startsWith('blob:')) objectUrl = src
      audio.src = src
      audio.volume = Math.max(0, Math.min(1, ctx.store.get().tts.volume / 100))
      void audio.play().catch((err: unknown) => {
        console.warn('[settings] playback failed', err)
        endedListener?.()
      })
    },
    stop() {
      audio.pause()
      endedListener?.()
    },
    onEnded(fn) {
      endedListener = fn
    },
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function voiceCard(ctx: PageContext, voice: VoiceInfo, player: AudioPlayer, current: () => string): HTMLElement {
  let playBtn: HTMLButtonElement | null = null
  const sampleUrl = voice.sampleUrl
  if (sampleUrl) {
    const btn = button(`▶ ${t('common.play')}`, () => {
      if (btn.dataset['playing'] === '1') {
        player.stop()
        return
      }
      player.onEnded(() => {
        btn.dataset['playing'] = '0'
        btn.textContent = `▶ ${t('common.play')}`
      })
      btn.dataset['playing'] = '1'
      btn.textContent = `■ ${t('common.stop')}`
      player.play(sampleUrl)
    }, { small: true })
    playBtn = btn
  }
  const selectBtn = button(t('common.select'), () => ctx.store.set('tts.fishCloud.referenceId', voice.id, { immediate: true }), { variant: 'primary', small: true })
  const card = el(
    'article',
    { class: 'voice-card', dataset: { voiceId: voice.id } },
    voice.coverImage ? el('img', { class: 'voice-cover', src: voice.coverImage, alt: '', loading: 'lazy' }) : el('div', { class: 'voice-cover voice-cover-empty' }, '♪'),
    el(
      'div',
      { class: 'voice-body' },
      el('h4', { class: 'voice-title' }, voice.title),
      el('p', { class: 'voice-meta' }, [voice.languages.join(', '), voice.author ? t('voice.by', { author: voice.author }) : ''].filter(Boolean).join(' · ')),
      voice.tags.length ? el('p', { class: 'voice-tags' }, voice.tags.slice(0, 6).map((tag) => el('span', { class: 'tag' }, tag))) : null,
      voice.description ? el('p', { class: 'voice-desc' }, voice.description.slice(0, 160)) : null,
    ),
    el('div', { class: 'voice-actions' }, playBtn, selectBtn),
  )
  const mark = (): void => {
    const active = current() === voice.id
    card.classList.toggle('is-active', active)
    selectBtn.textContent = active ? `✓ ${t('common.selected')}` : t('common.select')
  }
  mark()
  ctx.onConfig(mark)
  return card
}

function voiceSearch(ctx: PageContext, player: AudioPlayer): HTMLElement {
  const results = el('div', { class: 'voice-results' })
  const status = statusLine()
  const input = textInput({ value: '', placeholder: t('voice.searchPlaceholder') })
  const current = (): string => ctx.store.get().tts.fishCloud.referenceId

  async function search(): Promise<void> {
    if (!ctx.store.get().tts.fishCloud.apiKey.trim()) {
      status.set('warn', t('voice.needKey'))
      return
    }
    await ctx.store.flush()
    status.set('busy', t('common.searching'))
    replaceChildren(results)
    try {
      const voices = await window.flowy.invoke('config:searchVoices', input.value.trim())
      status.set(null)
      if (!voices.length) {
        status.set('info', t('voice.noResults'))
        return
      }
      replaceChildren(results, voices.map((v) => voiceCard(ctx, v, player, current)))
    } catch (err) {
      status.set('danger', t('voice.searchFailed', { message: describeError(err) }))
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void search()
    }
  })
  const searchBtn = asyncButton(t('common.search'), t('common.searching'), search, { variant: 'primary' })
  return el('div', { class: 'voice-search' }, el('div', { class: 'input-group' }, input, searchBtn), status.element, results)
}

function referenceIdField(ctx: PageContext): HTMLElement {
  const input = textInput({
    value: ctx.config.tts.fishCloud.referenceId,
    placeholder: 'z. B. 9a9cf47702da476aa4629e2506d4a857 / https://fish.audio/m/…',
    path: 'tts.fishCloud.referenceId',
    onInput: (v) => {
      const id = parseFishReferenceId(v)
      f.setWarning(id === null ? t('voice.referenceInvalid') : null)
      if (id !== null) ctx.store.set('tts.fishCloud.referenceId', id)
    },
    onCommit: (v) => {
      const id = parseFishReferenceId(v)
      if (id !== null) {
        input.value = id
        void ctx.store.flush()
      }
    },
  })
  const f = field(t('voice.referenceId'), input, { hint: t('voice.referenceIdHint') })
  ctx.onConfig((c) => {
    if (document.activeElement !== input && input.value !== c.tts.fishCloud.referenceId) input.value = c.tts.fishCloud.referenceId
  })
  return f
}

function testSection(ctx: PageContext, player: AudioPlayer): HTMLElement {
  const status = statusLine()
  const run = async (): Promise<void> => {
    await ctx.store.flush()
    status.set('busy', t('voice.testing'))
    let result: TestResult
    try {
      result = await window.flowy.invoke('config:testTts')
    } catch (err) {
      status.set('danger', t('common.failed', { message: describeError(err) }))
      return
    }
    status.set(result.ok ? 'ok' : 'danger', result.message)
    if (result.ok && result.audio) {
      const playable = playableFromTestAudio(result.audio)
      const blob = new Blob([playable.bytes as BlobPart], { type: playable.mime })
      player.play(URL.createObjectURL(blob))
    }
  }
  return el('div', { class: 'test-row' }, asyncButton(t('voice.testButton'), t('voice.testing'), run, { variant: 'primary' }), status.element)
}

function cloudSection(ctx: PageContext, player: AudioPlayer): HTMLElement[] {
  const modelOptions = TTS_CLOUD_MODELS.map((m) => ({ value: m.id, label: m.label }))
  const modelDesc = el('p', { class: 'field-hint' })
  const describeModel = (config: FlowyConfig): void => {
    const m = TTS_CLOUD_MODELS.find((x) => x.id === config.tts.fishCloud.model)
    modelDesc.textContent = m ? t(m.descriptionKey) : ''
  }
  describeModel(ctx.config)
  ctx.onConfig(describeModel)

  const account = section(
    t('voice.providerCloud'),
    null,
    liveField(ctx, t('voice.apiKey'), boundSecret(ctx, 'tts.fishCloud.apiKey'), {
      warn: (c) => (c.tts.fishCloud.apiKey.trim() ? null : t('warn.ttsKeyMissing')),
    }),
    el('p', { class: 'field-hint' }, `${t('voice.apiKeyHint')} `, link('fish.audio/app/api-keys', LINKS.fishApiKeys)),
    field(t('voice.model'), el('div', null, boundSelect<FishCloudModel>(ctx, 'tts.fishCloud.model', modelOptions), modelDesc)),
    note('info', `${t('voice.pricingNote')} `, link('fish.audio/app/developers/billing', LINKS.fishBilling)),
    testSection(ctx, player),
  )

  const voice = section(t('voice.voice'), t('voice.voiceDesc'), voiceSearch(ctx, player), referenceIdField(ctx))

  const formatOptions: Array<{ value: 'mp3' | 'wav' | 'pcm'; label: string }> = [
    { value: 'mp3', label: 'mp3' },
    { value: 'wav', label: 'wav' },
    { value: 'pcm', label: 'pcm' },
  ]
  const latencyOptions: Array<{ value: 'normal' | 'balanced' | 'low'; label: string }> = [
    { value: 'normal', label: t('latency.normal') },
    { value: 'balanced', label: t('latency.balanced') },
    { value: 'low', label: t('latency.low') },
  ]
  const transport = section(
    t('voice.format'),
    null,
    el(
      'div',
      { class: 'grid-2' },
      field(t('voice.format'), boundSelect(ctx, 'tts.fishCloud.format', formatOptions), { hint: t('voice.formatHint') }),
      field(t('voice.latency'), boundSelect(ctx, 'tts.fishCloud.latency', latencyOptions)),
    ),
  )

  const clone = section(
    t('voice.clone'),
    t('voice.cloneDesc'),
    field(t('voice.cloneAudio'), boundText(ctx, 'tts.fishCloud.cloneSample.audioPath', { placeholder: 'C:\\Users\\…\\sample.wav' })),
    field(t('voice.cloneTranscript'), boundTextarea(ctx, 'tts.fishCloud.cloneSample.transcript', { rows: 3 })),
  )
  return [account, voice, transport, clone]
}

function localSection(ctx: PageContext, player: AudioPlayer): HTMLElement[] {
  const formatOptions: Array<{ value: 'wav' | 'mp3'; label: string }> = [
    { value: 'wav', label: 'wav' },
    { value: 'mp3', label: 'mp3' },
  ]
  const server = section(
    t('voice.providerLocal'),
    t('voice.localHint'),
    field(t('voice.localBaseUrl'), boundText(ctx, 'tts.fishLocal.baseUrl', { type: 'url', placeholder: 'http://127.0.0.1:8080' })),
    field(t('voice.localApiKey'), boundSecret(ctx, 'tts.fishLocal.apiKey')),
    field(t('voice.localReferenceId'), boundText(ctx, 'tts.fishLocal.referenceId')),
    field(t('voice.format'), boundSelect(ctx, 'tts.fishLocal.format', formatOptions)),
    el('p', { class: 'field-hint' }, link('github.com/fishaudio/fish-speech', LINKS.fishSpeechRepo)),
    testSection(ctx, player),
  )
  const clone = section(
    t('voice.clone'),
    t('voice.cloneDesc'),
    field(t('voice.cloneAudio'), boundText(ctx, 'tts.fishLocal.cloneSample.audioPath', { placeholder: 'C:\\Users\\…\\sample.wav' })),
    field(t('voice.cloneTranscript'), boundTextarea(ctx, 'tts.fishLocal.cloneSample.transcript', { rows: 3 })),
  )
  return [server, clone]
}

function outputDeviceSelect(ctx: PageContext): HTMLElement {
  const holder = el('div', null)
  const render = (devices: Array<{ deviceId: string; label: string }>): void => {
    const options = [{ value: '', label: t('voice.deviceDefault') }, ...devices.map((d) => ({ value: d.deviceId, label: d.label }))]
    const currentId = ctx.store.get().tts.outputDeviceId
    if (currentId && !devices.some((d) => d.deviceId === currentId)) options.push({ value: currentId, label: `${currentId.slice(0, 12)}…` })
    replaceChildren(
      holder,
      select<string>({
        value: currentId,
        options,
        path: 'tts.outputDeviceId',
        onChange: (v) => ctx.store.set('tts.outputDeviceId', v, { immediate: true }),
      }),
    )
  }
  render([])
  void listAudioDevices('audiooutput').then(render)
  return holder
}

function playbackSection(ctx: PageContext): HTMLElement {
  return section(
    t('voice.playback'),
    null,
    boundToggle(ctx, 'tts.emotionCues', t('voice.emotionCues'), t('voice.emotionCuesDesc')),
    el(
      'div',
      { class: 'grid-2' },
      field(t('voice.speed'), boundSlider(ctx, 'tts.speed', { min: 0.5, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)}×` })),
      field(t('voice.volume'), boundSlider(ctx, 'tts.volume', { min: 0, max: 100, step: 1, format: (v) => t('common.percent', { n: v }) })),
    ),
    field(t('voice.outputDevice'), outputDeviceSelect(ctx), { hint: t('voice.deviceHint') }),
  )
}

export const voicePage: Page = {
  id: 'voice',
  titleKey: 'voice.title',
  descriptionKey: 'voice.desc',
  render(ctx) {
    const player = createAudioPlayer(ctx)
    const providerOptions: Array<{ value: TtsProvider; label: string }> = [
      { value: 'fish-cloud', label: t('voice.providerCloud') },
      { value: 'fish-local', label: t('voice.providerLocal') },
      { value: 'none', label: t('voice.providerNone') },
    ]
    const provider = section(t('voice.title'), t('voice.desc'), field(t('voice.provider'), boundSelect<TtsProvider>(ctx, 'tts.provider', providerOptions, { rerender: true })))

    const body: HTMLElement[] = []
    switch (ctx.config.tts.provider) {
      case 'fish-cloud':
        body.push(...cloudSection(ctx, player))
        break
      case 'fish-local':
        body.push(...localSection(ctx, player))
        break
      case 'none':
        body.push(note('info', t('voice.noneNote')))
        break
    }
    return el('div', { class: 'page' }, provider, ...body, ctx.config.tts.provider === 'none' ? null : playbackSection(ctx))
  },
}
