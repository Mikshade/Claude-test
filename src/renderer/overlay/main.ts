/**
 * Overlay renderer entry: character (Live2D or fallback), movement/avoidance, bubble UI, audio.
 *
 * OWNER: renderer-core agent (character + movement), renderer-ui agent (bubble/chat/confirm),
 * audio agent (recorder/player). This file wires them together – keep it thin. Pure decisions live
 * in ./wiring.ts (tested).
 *
 * Push listeners are registered synchronously at module evaluation; events that arrive while the
 * character is still loading are queued and replayed once the runtime exists (cursor positions are
 * dropped instead).
 */
import type { FlowyConfig } from '@shared/config'
import type { AppInfo, Push, PushChannel } from '@shared/ipc'
import type { CompanionState, Emotion, Point, Rect, SpeechChunk } from '@shared/state'
import { stripMarkers } from '@shared/text'
import { createPlayer } from './audio/player'
import { createRecorder } from './audio/recorder'
import type { Player, Recorder } from './audio/types'
import { createBubble, type BubbleController } from './bubble'
import { createCharacter, type Character } from './character'
import { anchorPosition, createMovementController, pickFleeTarget, type MovementController } from './movement'
import {
  computeBlocked,
  computeInteractive,
  createMarkerStripper,
  diffConfig,
  type MarkerStripper,
  modelUrlCandidates,
  modifierHeld,
  noopBubble,
  noopPlayer,
  noopRecorder,
  opacityForState,
  selectModelPath,
  t,
} from './wiring'

/** Delay before her face returns to neutral after the last spoken chunk. */
const NEUTRAL_AFTER_SPEECH_MS = 1200

interface Runtime {
  config: FlowyConfig
  info: AppInfo
  stage: HTMLElement
  bubbleRoot: HTMLElement
  character: Character
  mover: MovementController
  bubble: BubbleController
  player: Player
  recorder: Recorder
  stripper: MarkerStripper
  workArea: Rect
  cursor: Point
  holdKey: boolean
  hovering: boolean
  interactive: boolean
  state: CompanionState
  wasMoving: boolean
  assistantTurn: string | null
  emotionTimer: number
  rebuild: Promise<void>
}

const api = window.flowy
let rt: Runtime | null = null
const pending: Array<() => void> = []

function on<C extends PushChannel>(channel: C, handler: (rt: Runtime, payload: Push[C]) => void, dropWhileBooting = false): void {
  api.on(channel, (payload) => {
    if (rt) handler(rt, payload)
    else if (!dropWhileBooting) pending.push(() => handler(rt as Runtime, payload))
  })
}

// ---- push events -----------------------------------------------------------------------------

on('cursor:position', onCursor, true)
on('state:changed', onState)
on('config:changed', applyConfig)
on('turn:started', (r) => {
  r.stripper.reset()
  r.assistantTurn = null
})
on('turn:userText', (r, { text }) => r.bubble.showUserText(stripMarkers(text)))
on('turn:assistantDelta', (r, { turnId, delta }) => {
  if (r.assistantTurn !== turnId) {
    r.assistantTurn = turnId
    r.stripper.reset()
    r.bubble.startAssistant(turnId)
  }
  const text = r.stripper.push(delta)
  if (text) r.bubble.appendAssistant(turnId, text)
})
on('turn:assistantDone', (r, { turnId, text }) => {
  r.stripper.reset()
  r.assistantTurn = null
  r.bubble.finishAssistant(turnId, stripMarkers(text))
})
on('turn:toolCall', (r, { summary }) => r.bubble.showToolProgress(summary))
on('turn:error', (r, error) => r.bubble.showError(error.message))
on('speech:chunk', (r, chunk) => r.player.enqueue(chunk))
on('speech:stop', (r) => r.player.stop())
on('ptt:start', (r, { turnId }) => onPttStart(r, turnId))
on('ptt:stop', (r) => void onPttStop(r))
on('emotion:set', (r, { emotion, holdMs }) => setEmotion(r, emotion, holdMs))
on('avatar:fly', flyAway)
on('avatar:setVisible', setVisible)
on('confirm:request', (r, request) => {
  void r.bubble.confirm(request).then((approved) => api.invoke('confirm:answer', request.id, approved))
})
on('confirm:resolved', (r, { id }) => r.bubble.resolveConfirm(id))

// ---- boot ------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const [config, info] = await Promise.all([api.invoke('config:get'), api.invoke('app:getInfo')])
  console.info('[overlay] boot', { version: info.version, model: config.avatar.modelPath || info.defaultModelPath })
  document.body.dataset['state'] = 'booting'

  const stage = document.getElementById('stage') ?? document.body
  const workArea = currentWorkArea()
  const character = await buildCharacter(config, info, stage)
  const runtime: Runtime = {
    config,
    info,
    stage,
    bubbleRoot: document.getElementById('bubble') ?? document.body,
    character,
    mover: createMovementController({
      workArea,
      size: character.size,
      fleeRadius: config.avatar.avoidance.radius,
      fleeDurationMs: config.avatar.avoidance.durationMs,
      initial: anchorPosition(config.avatar.anchor, workArea, character.size),
    }),
    bubble: noopBubble(),
    player: noopPlayer(),
    recorder: noopRecorder(),
    stripper: createMarkerStripper(),
    workArea,
    cursor: { x: -1, y: -1 },
    holdKey: false,
    hovering: false,
    interactive: false,
    state: 'booting',
    wasMoving: false,
    assistantTurn: null,
    emotionTimer: 0,
    rebuild: Promise.resolve(),
  }
  runtime.bubble = createBubbleSafe(runtime)
  runtime.player = createPlayerSafe(runtime)
  runtime.recorder = createRecorderSafe(runtime)
  document.body.dataset['character'] = character.kind

  wireWindow(runtime)
  startFrameLoop(runtime)
  rt = runtime
  for (const replay of pending.splice(0)) replay()
  onLanded(runtime)
}

function currentWorkArea(): Rect {
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
}

/** Probe the `flowy-model://` candidates for the configured (or bundled) model; null = no model. */
async function resolveModelUrl(config: FlowyConfig, info: AppInfo): Promise<string | null> {
  const modelPath = selectModelPath(config.avatar.modelPath, info.defaultModelPath)
  const candidates = modelUrlCandidates(modelPath)
  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (res.ok) return url
    } catch {
      /* not served – try the next candidate */
    }
  }
  if (candidates.length > 0) console.warn('[overlay] no Live2D model found for', modelPath, 'tried', candidates)
  return null
}

async function buildCharacter(config: FlowyConfig, info: AppInfo, stage: HTMLElement): Promise<Character> {
  const modelUrl = await resolveModelUrl(config, info)
  return createCharacter({
    modelUrl,
    coreAvailable: info.live2dCoreAvailable,
    height: config.avatar.height,
    mirror: config.avatar.mirror,
    stage,
  })
}

/** Swap the character (model path / height changed) while keeping her position. */
function queueRebuild(r: Runtime): void {
  r.rebuild = r.rebuild
    .then(async () => {
      const position = r.mover.position()
      r.character.dispose()
      r.character = await buildCharacter(r.config, r.info, r.stage)
      r.character.setState(r.state)
      r.character.setOpacity(opacityForState(r.state, r.config.appearance.idleOpacity))
      if (!r.config.avatar.lookAtCursor) r.character.lookAhead()
      r.mover.setSize(r.character.size)
      r.mover.setPosition(position)
      document.body.dataset['character'] = r.character.kind
      onLanded(r)
    })
    .catch((err: unknown) => console.error('[overlay] character rebuild failed', err))
}

// ---- subsystems ------------------------------------------------------------------------------

function createBubbleSafe(r: Runtime): BubbleController {
  try {
    return createBubble({
      root: r.bubbleRoot,
      language: r.config.character.language,
      fontSize: r.config.appearance.bubbleFontSize,
      onSubmitText: (text) => void api.invoke('turn:submitText', text).catch(warn('submitText')),
      onInterrupt: () => void api.invoke('turn:interrupt').catch(warn('interrupt')),
      onInteractiveChange: () => updateInteractive(r),
      onInputFocusChange: (focused) => void api.invoke('overlay:setFocus', focused).catch(warn('setFocus')),
    })
  } catch (err) {
    console.error('[overlay]', t(r.config.character.language, 'bubbleError'), err)
    return noopBubble()
  }
}

function createPlayerSafe(r: Runtime): Player {
  try {
    return createPlayer({
      volume: r.config.tts.volume / 100,
      outputDeviceId: r.config.tts.outputDeviceId,
      onMouth: (value) => r.character.setMouthOpen(value),
      onChunkStart: (chunk: SpeechChunk) => {
        r.bubble.showSpokenSentence(chunk.turnId, chunk.text)
        setEmotion(r, chunk.emotion)
      },
      onTurnFinished: (turnId) => {
        r.character.setMouthOpen(0)
        setEmotion(r, 'neutral', NEUTRAL_AFTER_SPEECH_MS, true)
        void api.invoke('turn:playbackFinished', turnId).catch(warn('playbackFinished'))
      },
      onError: (error, chunk) => {
        console.warn('[overlay] playback error', chunk.turnId, chunk.seq, error)
        r.bubble.showError(t(r.config.character.language, 'audioError'))
      },
    })
  } catch (err) {
    console.error('[overlay] audio player unavailable', err)
    return noopPlayer()
  }
}

function createRecorderSafe(r: Runtime): Recorder {
  try {
    return createRecorder({
      deviceId: r.config.stt.inputDeviceId,
      silenceTimeoutMs: r.config.stt.silenceTimeoutMs,
      maxRecordingMs: r.config.stt.maxRecordingMs,
      onLevel: (level) => r.bubble.setInputLevel(level),
      onAutoStop: (audio) => void submitAudio(r, audio),
    })
  } catch (err) {
    console.error('[overlay] recorder unavailable', err)
    return noopRecorder()
  }
}

// ---- cursor, mouse, interactivity ------------------------------------------------------------

function onCursor(r: Runtime, p: Point): void {
  r.cursor = p
  if (r.config.avatar.lookAtCursor) r.character.lookAt(p.x, p.y)
  r.hovering = r.character.hitTest(p.x, p.y)
  updateInteractive(r)
  if (r.config.avatar.avoidance.enabled) r.mover.maybeFlee(p, performance.now(), blocked(r))
}

function blocked(r: Runtime): boolean {
  return computeBlocked({
    pinned: r.config.avatar.pinned,
    holdKey: r.holdKey,
    bubbleInteractive: r.bubble.isInteractive(),
    state: r.state,
  })
}

function updateInteractive(r: Runtime): void {
  const next = computeInteractive({ hovering: r.hovering, holdKey: r.holdKey, bubbleInteractive: r.bubble.isInteractive() })
  if (next === r.interactive) return
  r.interactive = next
  void api.invoke('overlay:setInteractive', next).catch(warn('setInteractive'))
}

function setHoldKey(r: Runtime, held: boolean): void {
  if (held === r.holdKey) return
  r.holdKey = held
  updateInteractive(r)
}

/** A click "on her": the event landed on the page background / stage (not on bubble or chat DOM) and hits the body. */
function isCharacterClick(r: Runtime, e: MouseEvent): boolean {
  const target = e.target as Node | null
  const onBackground = target === null || target === document.documentElement || target === document.body || r.stage.contains(target)
  return onBackground && r.character.hitTest(e.clientX, e.clientY)
}

function wireWindow(r: Runtime): void {
  const key = (): FlowyConfig['avatar']['avoidance']['holdKeyToInteract'] => r.config.avatar.avoidance.holdKeyToInteract
  // Modifier state is read from mouse moves (they still arrive in forward click-through mode even
  // though the window has no focus) and from key events while the chat input is focused.
  window.addEventListener('mousemove', (e) => setHoldKey(r, modifierHeld(e, key())))
  window.addEventListener('keydown', (e) => setHoldKey(r, modifierHeld(e, key())))
  window.addEventListener('keyup', (e) => setHoldKey(r, modifierHeld(e, key())))
  window.addEventListener('click', (e) => {
    if (isCharacterClick(r, e)) r.bubble.openChatInput()
  })
  window.addEventListener('contextmenu', (e) => {
    if (!isCharacterClick(r, e)) return
    e.preventDefault()
    void api.invoke('overlay:showContextMenu').catch(warn('showContextMenu'))
  })
  window.addEventListener('resize', () => {
    r.workArea = currentWorkArea()
    r.mover.setWorkArea(r.workArea)
    onLanded(r)
  })
  window.addEventListener('beforeunload', () => {
    r.recorder.dispose()
    r.player.dispose()
    r.bubble.dispose()
    r.character.dispose()
  })
}

// ---- frame loop ------------------------------------------------------------------------------

function startFrameLoop(r: Runtime): void {
  const frame = (now: number): void => {
    const f = r.mover.update(now)
    r.character.setPosition(f.position.x, f.position.y)
    r.character.setFlightLean(f.lean)
    if (r.wasMoving && !f.moving) onLanded(r)
    r.wasMoving = f.moving
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/** She came to rest: re-anchor the bubble and tell main where she is. */
function onLanded(r: Runtime): void {
  r.bubble.setAnchor(r.character.bounds(), r.workArea)
  void api.invoke('overlay:reportBounds', r.mover.bounds()).catch(warn('reportBounds'))
}

function flyAway(r: Runtime): void {
  const target = pickFleeTarget(r.mover.position(), r.cursor, {
    workArea: r.workArea,
    size: r.character.size,
    fleeRadius: r.config.avatar.avoidance.radius,
    fleeDurationMs: r.config.avatar.avoidance.durationMs,
  })
  r.mover.flyTo(target, performance.now())
}

// ---- state, emotions, visibility -------------------------------------------------------------

function onState(r: Runtime, state: CompanionState): void {
  r.state = state
  r.character.setState(state)
  r.bubble.setState(state)
  document.body.dataset['state'] = state
  r.character.setOpacity(opacityForState(state, r.config.appearance.idleOpacity))
}

/** Show an emotion; with `holdMs` she returns to neutral afterwards. `deferred` delays the change itself. */
function setEmotion(r: Runtime, emotion: Emotion, holdMs?: number, deferred = false): void {
  window.clearTimeout(r.emotionTimer)
  if (deferred) {
    r.emotionTimer = window.setTimeout(() => r.character.setEmotion(emotion), holdMs ?? 0)
    return
  }
  r.character.setEmotion(emotion)
  if (holdMs && holdMs > 0 && emotion !== 'neutral') {
    r.emotionTimer = window.setTimeout(() => r.character.setEmotion('neutral'), holdMs)
  }
}

function setVisible(r: Runtime, visible: boolean): void {
  document.body.dataset['visible'] = String(visible)
  r.character.element.style.visibility = visible ? '' : 'hidden'
  if (visible) r.character.resume()
  else {
    r.character.pause()
    r.bubble.hide(0)
  }
}

// ---- push-to-talk ----------------------------------------------------------------------------

function onPttStart(r: Runtime, turnId: string): void {
  // main currently reuses this channel with an empty turnId for the "open chat" hotkey.
  if (turnId === '') {
    r.bubble.openChatInput()
    return
  }
  r.player.stop()
  r.recorder
    .start()
    .then(() => r.bubble.showListening())
    .catch((err: unknown) => {
      console.warn('[overlay] recorder start failed', err)
      r.bubble.showError(t(r.config.character.language, 'micError'))
    })
}

async function onPttStop(r: Runtime): Promise<void> {
  const audio = await r.recorder.stop().catch((err: unknown) => {
    console.warn('[overlay] recorder stop failed', err)
    return null
  })
  await submitAudio(r, audio)
}

async function submitAudio(r: Runtime, audio: Awaited<ReturnType<Recorder['stop']>>): Promise<void> {
  if (!audio) {
    r.bubble.hide(0)
    return
  }
  try {
    await api.invoke('turn:submitAudio', audio)
  } catch (err) {
    console.warn('[overlay] submitAudio failed', err)
    r.bubble.showError(String(err instanceof Error ? err.message : err))
  }
}

// ---- config ----------------------------------------------------------------------------------

function applyConfig(r: Runtime, next: FlowyConfig): void {
  const prev = r.config
  r.config = next
  const d = diffConfig(prev, next)
  if (d.rebuildCharacter) queueRebuild(r)
  else if (d.mirror) r.character.setMirror(next.avatar.mirror)
  if (d.avoidance) {
    r.mover.configure({ fleeRadius: next.avatar.avoidance.radius, fleeDurationMs: next.avatar.avoidance.durationMs })
  }
  if (d.anchor) {
    r.mover.setPosition(anchorPosition(next.avatar.anchor, r.workArea, r.character.size))
    onLanded(r)
  }
  if (d.lookAtCursor && !next.avatar.lookAtCursor) r.character.lookAhead()
  if (d.volume) r.player.setVolume(next.tts.volume / 100)
  if (d.outputDevice) void r.player.setOutputDevice(next.tts.outputDeviceId).catch(warn('setOutputDevice'))
  if (d.recorder) {
    r.recorder.setOptions({
      deviceId: next.stt.inputDeviceId,
      silenceTimeoutMs: next.stt.silenceTimeoutMs,
      maxRecordingMs: next.stt.maxRecordingMs,
    })
  }
  if (d.fontSize) r.bubble.setFontSize(next.appearance.bubbleFontSize)
  if (d.language) r.bubble.setLanguage(next.character.language)
  if (d.idleOpacity) r.character.setOpacity(opacityForState(r.state, next.appearance.idleOpacity))
  if (d.pinned || d.avoidance) updateInteractive(r)
}

function warn(what: string): (err: unknown) => void {
  return (err) => console.warn(`[overlay] ${what} failed`, err)
}

main().catch((err) => {
  console.error('[overlay] boot failed', err)
  document.body.dataset['state'] = 'error'
})
