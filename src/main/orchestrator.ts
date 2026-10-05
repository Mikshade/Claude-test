/**
 * The conversation turn pipeline and state machine:
 *
 *   hotkey → 'ptt:start' → renderer records → 'turn:submitAudio' → STT → brain (streaming)
 *   → SentenceChunker → SpeechPipeline (TTS) → 'speech:chunk' → renderer plays → 'turn:playbackFinished'
 *
 * Also: text turns, interruption (abort LLM + TTS, 'speech:stop'), confirm prompts for destructive tools,
 * screen awareness context (screenshot + active window + memory digest), the start-up greeting and the
 * optional periodic proactive comment. Provider details stay in the modules; this file only sequences them.
 */
import type { FlowyConfig } from '@shared/config'
import type { RecordedAudio } from '@shared/ipc'
import { greetingInstruction } from '@shared/personality'
import type { CompanionState, ConfirmRequest, Emotion } from '@shared/state'
import { SentenceChunker, shortId, stripMarkers } from '@shared/text'
import type { Agent, AgentResult } from './brain/agent'
import type { ConfigStore } from './config/store'
import { createLogger } from './log'
import type { NotesStore } from './memory/notes'
import type { SttClient } from './stt/types'
import { createSpeechPipeline, type SpeechPipeline } from './tts/pipeline'
import type { TtsClient } from './tts/types'
import type { WindowsSystem } from './system/windows'
import type { OverlayWindow } from './windows/overlay'

const log = createLogger('orchestrator')

/** Minimum safety net for the renderer's 'turn:playbackFinished' after the last chunk was sent. */
export const PLAYBACK_TIMEOUT_MIN_MS = 60_000
/** Conservative speaking rate used to size the playback safety net (characters per second). */
export const PLAYBACK_CHARS_PER_SECOND = 8
/** Added to stt.maxRecordingMs before we give up waiting for 'turn:submitAudio'. */
export const LISTENING_GRACE_MS = 5_000
/** Confirm prompts resolve to "denied" after this. */
export const CONFIRM_TIMEOUT_MS = 60_000
/** A new turn waits at most this long for the interrupted turn to finish writing its history. */
export const RUN_SETTLE_TIMEOUT_MS = 5_000
/** The proactive comment instruction tells the model to answer with exactly this when it has nothing to say. */
export const SILENCE_MARKER = '[[silence]]'

export interface ProactiveOptions {
  /** Attach a screenshot even in 'on-demand' mode (the periodic glance is about the screen). */
  screen?: boolean
  /** Show no UI (no "thinking" state, no bubble) until she actually says something. */
  quiet?: boolean
}

export interface OrchestratorDeps {
  store: ConfigStore
  overlay: () => OverlayWindow | null
  agent: () => Agent
  tts: () => TtsClient | null
  stt: () => SttClient | null
  system: WindowsSystem
  notes: NotesStore
  captureScreen: typeof import('./system/screenshot').captureScreen
  /** Test seam. */
  now?: () => number
}

export interface Orchestrator {
  state(): CompanionState
  /** Hotkey pressed: start listening, or stop listening if already listening, or interrupt if speaking. */
  pushToTalk(): void
  /** Recording result from the renderer; `null` = nothing usable (too short / no speech / mic failed) → back to idle. */
  submitAudio(audio: RecordedAudio | null): Promise<string>
  submitText(text: string): Promise<string>
  interrupt(): void
  playbackFinished(turnId: string): void
  answerConfirm(id: string, approved: boolean): void
  /** Ask the user to approve something (used by tools). Resolves false on timeout/dismiss. */
  confirm(request: Omit<ConfirmRequest, 'id'>): Promise<boolean>
  /**
   * Greeting / reminder / proactive comment entry point ('greeting' or a free instruction). Resolves with
   * the turn id, or '' when skipped (busy, hidden, disposed).
   */
  proactive(instruction: string, options?: ProactiveOptions): Promise<string>
  setMuted(muted: boolean): void
  isMuted(): boolean
  onState(listener: (state: CompanionState) => void): () => void
  dispose(): void
}

interface ActiveTurn {
  id: string
  source: 'voice' | 'text' | 'proactive'
  controller: AbortController
  pipeline: SpeechPipeline | null
  chunker: SentenceChunker
  text: string
  /** Resolves when the renderer reports playback finished (or on interrupt/timeout). */
  playbackDone: Promise<void>
  resolvePlayback: () => void
  ttsErrorReported: boolean
  /** Quiet proactive glance: no UI until real text arrives. */
  quiet: boolean
  /** turn:started was sent (always true for non-quiet turns). */
  uiStarted: boolean
}

const SCREEN_QUESTION_RE =
  /bildschirm|screen|monitor|siehst du|was (ist|steht|läuft)|what('s| is| do you see)|fenster|window|hier|this|dies|das da|schau|look|guck/i

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? (() => Date.now())
  let state: CompanionState = 'idle'
  let muted = false
  let active: ActiveTurn | null = null
  let listeningTurnId: string | null = null
  let listeningTimer: ReturnType<typeof setTimeout> | null = null
  let discardNextAudio = false
  /** Aborts a running transcription on interrupt. */
  let sttController: AbortController | null = null
  let proactiveTimer: ReturnType<typeof setInterval> | null = null
  /**
   * The most recent agent run. An interrupted run still appends its partial text / 'interrupted' tool
   * results to the shared history a few ticks after the abort, so the next run waits for it – otherwise
   * the new user message could land between a tool_use and its tool_result (API 400 on every later turn).
   */
  let lastRun: Promise<unknown> = Promise.resolve()
  let lastActivityAt = now()
  let disposed = false
  const listeners = new Set<(state: CompanionState) => void>()
  const pendingConfirms = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  const unsubscribeConfig = deps.store.onChange((next) => scheduleProactive(next))
  scheduleProactive(deps.store.get())

  function setState(next: CompanionState): void {
    if (state === next) return
    state = next
    log.debug(`state → ${next}`)
    for (const l of listeners) {
      try {
        l(next)
      } catch (err) {
        log.error('state listener failed', err)
      }
    }
  }

  function send<C extends Parameters<OverlayWindow['send']>[0]>(channel: C, payload: Parameters<OverlayWindow['send']>[1]): void {
    const overlay = deps.overlay()
    if (!overlay) return
    try {
      ;(overlay.send as (c: C, p: unknown) => void)(channel, payload)
    } catch (err) {
      log.error(`send ${channel} failed`, err)
    }
  }

  function sendError(turnId: string, stage: 'stt' | 'llm' | 'tts' | 'tool' | 'audio', message: string): void {
    send('turn:error', { turnId, stage, message })
  }

  // ---- listening ------------------------------------------------------------------------------
  function startListening(): void {
    // A quiet proactive glance may still be running while the state is 'idle'.
    if (active) interrupt()
    const turnId = shortId('t')
    listeningTurnId = turnId
    discardNextAudio = false
    lastActivityAt = now()
    setState('listening')
    send('ptt:start', { turnId })
    clearListeningTimer()
    // The renderer's own cap (stt.maxRecordingMs) auto-stops the recording; this only covers a renderer
    // that never answers.
    const timeoutMs = deps.store.get().stt.maxRecordingMs + LISTENING_GRACE_MS
    listeningTimer = setTimeout(() => {
      if (state === 'listening' && listeningTurnId === turnId) {
        log.warn('no audio arrived after listening – back to idle')
        listeningTurnId = null
        setState('idle')
      }
    }, timeoutMs)
  }

  function stopListening(): void {
    send('ptt:stop', {})
    // The renderer answers with submitAudio(audio | null); the timer only covers a renderer that never answers.
    clearListeningTimer()
    const turnId = listeningTurnId
    listeningTimer = setTimeout(() => {
      if (state === 'listening' && listeningTurnId === turnId) {
        listeningTurnId = null
        setState('idle')
      }
    }, 8_000)
  }

  function cancelListening(): void {
    clearListeningTimer()
    if (state === 'listening') {
      discardNextAudio = true
      send('ptt:stop', {})
      listeningTurnId = null
      setState('idle')
    }
  }

  function clearListeningTimer(): void {
    if (listeningTimer) clearTimeout(listeningTimer)
    listeningTimer = null
  }

  // ---- context ----------------------------------------------------------------------------------
  async function buildContext(
    config: FlowyConfig,
    text: string,
    source: ActiveTurn['source'],
    signal: AbortSignal,
    forceScreen: boolean,
  ): Promise<{ context: Record<string, string>; screenshot?: { mediaType: 'image/png' | 'image/jpeg'; base64: string } }> {
    const context: Record<string, string> = {}
    const date = new Date(now())
    context['time'] = date.toLocaleString(config.character.language === 'de' ? 'de-DE' : 'en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    if (source === 'voice') context['input'] = 'spoken (push-to-talk, transcribed)'
    try {
      const digest = deps.notes.digest()
      if (digest) context['memory'] = digest
    } catch (err) {
      log.warn('notes digest failed', err)
    }
    if (config.screenAwareness.includeActiveWindow) {
      try {
        const win = await deps.system.getActiveWindow()
        if (win && (win.title || win.processName)) context['active_window'] = `${win.title} (${win.processName})`.trim()
      } catch (err) {
        log.debug('active window unavailable', err)
      }
    }
    if (signal.aborted) return { context }
    if (!wantsScreenshot(config, text, source, forceScreen)) return { context }
    try {
      const shot = await deps.captureScreen({
        display: config.display,
        maxLongEdge: config.screenAwareness.maxLongEdge,
        format: 'jpeg',
        jpegQuality: config.screenAwareness.jpegQuality,
      })
      context['screenshot'] = `attached (${shot.width}×${shot.height})`
      return { context, screenshot: { mediaType: shot.mediaType, base64: shot.base64 } }
    } catch (err) {
      log.warn('screenshot failed', err)
      return { context }
    }
  }

  // ---- turns --------------------------------------------------------------------------------------
  async function runTurn(
    text: string,
    source: ActiveTurn['source'],
    presetTurnId?: string,
    options: ProactiveOptions = {},
  ): Promise<string> {
    if (disposed) return ''
    if (active) interrupt()
    const config = deps.store.get()
    const turnId = presetTurnId ?? shortId('t')
    const controller = new AbortController()
    const signal = controller.signal
    let resolvePlayback: () => void = () => undefined
    const playbackDone = new Promise<void>((resolve) => {
      resolvePlayback = resolve
    })
    const tts = muted ? null : deps.tts()
    const quiet = source === 'proactive' && options.quiet === true
    const turn: ActiveTurn = {
      id: turnId,
      source,
      controller,
      pipeline: null,
      chunker: new SentenceChunker(),
      text: '',
      playbackDone,
      resolvePlayback,
      ttsErrorReported: false,
      quiet,
      uiStarted: false,
    }
    active = turn
    lastActivityAt = now()

    const startUi = (): void => {
      if (turn.uiStarted) return
      turn.uiStarted = true
      setState('thinking')
      send('turn:started', { turnId, source })
      if (source !== 'proactive') send('turn:userText', { turnId, text })
    }
    if (!quiet) startUi()

    if (tts) {
      turn.pipeline = createSpeechPipeline({
        client: tts,
        turnId,
        signal,
        onChunk: (chunk) => {
          if (active?.id !== turnId || !turn.uiStarted) return
          // Her voice is audible from the first sentence on, even while the model is still writing.
          if (state === 'thinking') setState('speaking')
          send('speech:chunk', chunk)
        },
        onError: (err, sentence) => {
          log.warn(`tts failed for "${sentence.slice(0, 40)}…": ${err.message}`)
          if (!turn.ttsErrorReported) {
            turn.ttsErrorReported = true
            sendError(turnId, 'tts', err.message)
          }
        },
      })
    }

    const pushSentences = (sentences: Array<{ text: string; emotion: Emotion }>): void => {
      for (const s of sentences) {
        if (!s.text) continue
        turn.pipeline?.push(s.text, s.emotion)
      }
    }

    let result: AgentResult | null = null
    try {
      const { context, screenshot } = await buildContext(config, text, source, signal, options.screen === true)
      if (signal.aborted) return turnId
      // Let an interrupted run finish its history writes first (see `lastRun`).
      await settleWithin(lastRun, RUN_SETTLE_TIMEOUT_MS)
      if (signal.aborted || active?.id !== turnId) return turnId
      const run = deps.agent().run(
        { turnId, text, source, context, screenshot },
        {
          onText: (delta) => {
            if (active?.id !== turnId) return
            turn.text += delta
            if (!turn.uiStarted) {
              // Quiet glance: stay invisible until she really says something (not the silence marker).
              if (turn.text.includes(SILENCE_MARKER) || !visibleText(turn.text)) return
              startUi()
              send('turn:assistantDelta', { turnId, delta: turn.text })
              pushSentences(turn.chunker.push(turn.text))
              return
            }
            send('turn:assistantDelta', { turnId, delta })
            pushSentences(turn.chunker.push(delta))
          },
          onToolCall: (name, summary) => {
            if (active?.id !== turnId || !turn.uiStarted) return
            send('turn:toolCall', { turnId, name, summary })
          },
          onToolResult: () => undefined,
          onEmotion: (emotion) => {
            if (active?.id !== turnId || !turn.uiStarted) return
            send('emotion:set', { emotion })
          },
        },
        signal,
      )
      lastRun = run.catch(() => undefined)
      result = await run
    } catch (err) {
      if (active?.id === turnId && !signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('turn failed', message)
        sendError(turnId, 'llm', message)
        finishTurn(turn, 'error')
      }
      return turnId
    }

    if (active?.id !== turnId || signal.aborted) return turnId

    if (result.aborted) {
      finishTurn(turn, 'idle')
      return turnId
    }

    if (!turn.uiStarted) {
      // A quiet glance that decided to say nothing (or only refused): leave no trace in the UI.
      turn.pipeline?.abort()
      finishTurn(turn, 'idle')
      return turnId
    }

    pushSentences(turn.chunker.flush())
    const finalText = source === 'proactive' && isSilence(turn.text) ? '' : stripMarkers(turn.text).trim()
    if (result.stopReason === 'refusal') {
      const decline =
        config.character.language === 'de' ? 'Dabei kann ich leider nicht helfen.' : 'I’m afraid I can’t help with that.'
      turn.pipeline?.push(decline, 'shy')
      send('turn:assistantDone', { turnId, text: decline })
    } else {
      send('turn:assistantDone', { turnId, text: finalText })
    }

    if (!turn.pipeline || (!finalText && result.stopReason !== 'refusal')) {
      // Nothing to speak (TTS off/muted, or a silent proactive turn).
      turn.pipeline?.abort()
      finishTurn(turn, 'idle')
      return turnId
    }

    setState('speaking')
    try {
      await turn.pipeline.finish()
    } catch (err) {
      log.warn('pipeline finish failed', err)
    }
    if (active?.id !== turnId) return turnId
    // Wait for the renderer to finish playing (it reports via playbackFinished), with a safety net sized
    // to the amount of text so a long read-aloud is not cut off.
    const timeout = setTimeout(() => turn.resolvePlayback(), playbackTimeoutMs(turn.text.length))
    await turn.playbackDone
    clearTimeout(timeout)
    if (active?.id === turnId) finishTurn(turn, 'idle')
    return turnId
  }

  function finishTurn(turn: ActiveTurn, next: CompanionState): void {
    if (active?.id === turn.id) active = null
    turn.resolvePlayback()
    lastActivityAt = now()
    setState(next)
    if (next === 'error') {
      // Show the error briefly, then return to idle so the next hotkey press works normally.
      setTimeout(() => {
        if (state === 'error' && !active) setState('idle')
      }, 2_500)
    }
  }

  function isSilence(text: string): boolean {
    const cleaned = stripMarkers(text).trim()
    return cleaned === '' || text.includes(SILENCE_MARKER)
  }

  // ---- proactive -------------------------------------------------------------------------------------
  function scheduleProactive(config: FlowyConfig): void {
    if (proactiveTimer) clearInterval(proactiveTimer)
    proactiveTimer = null
    const p = config.behavior.proactive
    if (!p.enabled || !config.setupCompleted) return
    const intervalMs = Math.max(2, p.intervalMinutes) * 60_000
    proactiveTimer = setInterval(() => {
      const cfg = deps.store.get()
      if (!cfg.behavior.proactive.enabled || state !== 'idle' || muted) return
      // The periodic comment is about what is on screen – pointless (and misleading) without a screenshot.
      if (!canSeeScreen(cfg)) return
      if (inQuietHours(new Date(now()).getHours(), cfg.behavior.proactive.quietHoursStart, cfg.behavior.proactive.quietHoursEnd)) return
      if (now() - lastActivityAt < intervalMs * 0.8) return
      void proactive(proactiveInstruction(cfg), { screen: true, quiet: true }).catch((err) =>
        log.warn('proactive comment failed', err),
      )
    }, intervalMs)
  }

  async function proactive(instruction: string, options: ProactiveOptions = {}): Promise<string> {
    if (disposed || state !== 'idle' || active) return ''
    // Hidden from the tray: no surprise voice and no screenshots (reminders then fall back to a toast).
    const overlay = deps.overlay()
    if (!overlay || !overlay.isVisible()) return ''
    const config = deps.store.get()
    const text = instruction === 'greeting' ? greetingInstruction(config.character) : instruction
    return runTurn(text, 'proactive', undefined, options)
  }

  // ---- confirms --------------------------------------------------------------------------------------
  function confirm(request: Omit<ConfirmRequest, 'id'>): Promise<boolean> {
    const id = shortId('c')
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirms.delete(id)
        send('confirm:resolved', { id })
        resolve(false)
      }, CONFIRM_TIMEOUT_MS)
      pendingConfirms.set(id, { resolve, timer })
      send('confirm:request', { ...request, id })
    })
  }

  function answerConfirm(id: string, approved: boolean): void {
    const pending = pendingConfirms.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingConfirms.delete(id)
    send('confirm:resolved', { id })
    pending.resolve(approved)
  }

  /** Deny every open confirm prompt (interrupt/dispose) and close the panels in the renderer. */
  function denyPendingConfirms(): void {
    for (const [id, pending] of pendingConfirms) {
      clearTimeout(pending.timer)
      pendingConfirms.delete(id)
      send('confirm:resolved', { id })
      pending.resolve(false)
    }
  }

  // ---- public API ------------------------------------------------------------------------------------
  function interrupt(): void {
    clearListeningTimer()
    // A late "Ja" must never run a destructive tool of a turn the user already cancelled.
    denyPendingConfirms()
    if (state === 'listening') {
      cancelListening()
      return
    }
    if (state === 'transcribing' && !active) {
      sttController?.abort()
      sttController = null
      setState('idle')
      return
    }
    const turn = active
    if (!turn) return
    active = null
    turn.controller.abort()
    turn.pipeline?.abort()
    send('speech:stop', { turnId: turn.id })
    turn.resolvePlayback()
    lastActivityAt = now()
    setState('idle')
  }

  return {
    state: () => state,

    pushToTalk() {
      if (disposed) return
      switch (state) {
        case 'listening':
          stopListening()
          return
        case 'thinking':
        case 'speaking':
          interrupt()
          startListening()
          return
        case 'transcribing':
          // The recording already auto-stopped (silence); this press was meant as "stop" – keep the utterance.
          return
        case 'booting':
          return
        default:
          startListening()
      }
    },

    async submitAudio(audio) {
      if (disposed) return ''
      clearListeningTimer()
      if (discardNextAudio) {
        discardNextAudio = false
        return ''
      }
      if (!audio) {
        // Too short / no speech / mic failed: the renderer already hid the bubble, we just stop waiting.
        listeningTurnId = null
        if (state === 'listening') setState('idle')
        return ''
      }
      const turnId = listeningTurnId ?? shortId('t')
      listeningTurnId = null
      const stt = deps.stt()
      if (!stt) {
        sendError(turnId, 'stt', 'Spracherkennung ist nicht konfiguriert.')
        setState('idle')
        return turnId
      }
      if (active) interrupt()
      setState('transcribing')
      const config = deps.store.get()
      const controller = new AbortController()
      sttController = controller
      let text = ''
      try {
        text = await stt.transcribe(audio, config.stt.language || config.character.language, controller.signal)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!(err instanceof Error && err.name === 'AbortError') && !controller.signal.aborted) {
          log.error('stt failed', message)
          sendError(turnId, 'stt', message)
        }
        if (sttController === controller) sttController = null
        if (state === 'transcribing') setState('idle')
        return turnId
      }
      if (sttController === controller) sttController = null
      if (state !== 'transcribing' || controller.signal.aborted) return turnId // interrupted meanwhile
      text = text.trim()
      if (!text) {
        sendError(turnId, 'stt', config.character.language === 'de' ? 'Ich habe nichts verstanden.' : 'I did not catch that.')
        setState('idle')
        return turnId
      }
      return runTurn(text, 'voice', turnId)
    },

    async submitText(text) {
      const trimmed = text.trim()
      if (!trimmed || disposed) return ''
      if (state === 'listening') cancelListening()
      return runTurn(trimmed, 'text')
    },

    interrupt,

    playbackFinished(turnId) {
      if (active?.id === turnId) active.resolvePlayback()
    },

    answerConfirm,
    confirm,
    proactive,

    setMuted(value) {
      muted = value
      const turn = active
      if (!muted || !turn?.pipeline) return
      // Silence her immediately; the text answer (and any running tools) continue.
      turn.pipeline.abort()
      turn.pipeline = null
      send('speech:stop', { turnId: turn.id })
      turn.resolvePlayback()
    },
    isMuted: () => muted,

    onState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispose() {
      disposed = true
      interrupt()
      sttController?.abort()
      sttController = null
      unsubscribeConfig()
      if (proactiveTimer) clearInterval(proactiveTimer)
      clearListeningTimer()
      denyPendingConfirms()
    },
  }
}

/** Streamed text as the user would see it: markers removed, a still-open `[[mark…` at the end ignored. */
export function visibleText(streamed: string): string {
  return stripMarkers(streamed)
    .replace(/\[\[[^\]]*$/, '')
    .trim()
}

/** Resolve when `promise` settles or after `ms`, whichever comes first (never rejects). */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    promise.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

/** Safety net for 'turn:playbackFinished': generous for the amount of text that is being spoken. */
export function playbackTimeoutMs(textLength: number): number {
  return Math.max(PLAYBACK_TIMEOUT_MIN_MS, 30_000 + Math.ceil((textLength / PLAYBACK_CHARS_PER_SECOND) * 1000))
}

/** Screenshots are possible at all: the permission flag is on and screen awareness is not 'off'. */
export function canSeeScreen(config: FlowyConfig): boolean {
  return config.permissions.allowScreenshots && config.screenAwareness.mode !== 'off'
}

/**
 * Attach a screenshot to this turn? 'always' → every turn; 'on-demand' → screen-like questions, and
 * proactive turns only when they ask for it (`forceScreen`: the periodic glance – never the greeting or a
 * reminder); 'off' / no permission → never.
 */
export function wantsScreenshot(
  config: FlowyConfig,
  text: string,
  source: 'voice' | 'text' | 'proactive',
  forceScreen = false,
): boolean {
  if (!canSeeScreen(config)) return false
  if (config.screenAwareness.mode === 'always' || forceScreen) return true
  return source !== 'proactive' && SCREEN_QUESTION_RE.test(text)
}

/** Quiet hours may wrap around midnight (e.g. 23 → 8). */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

export function proactiveInstruction(config: FlowyConfig): string {
  const de = config.character.language === 'de'
  return de
    ? `Du schaust dem Nutzer gerade unaufgefordert über die Schulter (Screenshot anbei). Wenn dir etwas wirklich Nützliches, Aufmunterndes oder Charmantes auffällt, sag es in EINEM kurzen Satz. Wenn nicht, antworte mit genau ${SILENCE_MARKER} und sonst nichts.`
    : `You are glancing at the user's screen uninvited (screenshot attached). If you notice something genuinely useful, encouraging or charming, say it in ONE short sentence. Otherwise reply with exactly ${SILENCE_MARKER} and nothing else.`
}
