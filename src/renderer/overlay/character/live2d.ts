/**
 * Live2D character on a PixiJS 7 canvas via pixi-live2d-display-lipsyncpatch (Cubism 3/4/5 models).
 *
 * - The Pixi app is only as large as the character; main.ts moves the wrapper with translate3d().
 * - The plugin module is imported lazily inside load(): it throws at evaluation time when
 *   `window.Live2DCubismCore` is missing, so it must only be evaluated once the core is present.
 * - Lip sync is manual: the analyser value from audio/player.ts is written into the model's
 *   LipSync parameter ids in the internal model's 'beforeModelUpdate' hook (after motions,
 *   physics and pose, right before coreModel.update()).
 * - Look-at drives the FocusController directly with a normalised vector so partial glances work
 *   (model.focus() always snaps to a unit vector).
 */
import * as PIXI from 'pixi.js'
import type { Cubism4InternalModel, Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4'
import type { CompanionState, Emotion, Point, Rect } from '@shared/state'
import { LIVELY_EMOTIONS, matchAttentiveExpression, matchExpression, matchMotionGroup } from './emotions'
import type { Character } from './index'
import { clamp, composeTransform, fitToHeight, hitBoundingBox, normalizedFocus } from '../hitTest'

export interface Live2DOptions {
  /** URL of a `*.model3.json` (served by the flowy-model:// protocol). */
  modelUrl: string
  height: number
  mirror: boolean
  stage: HTMLElement
}

type Cubism4Module = typeof import('pixi-live2d-display-lipsyncpatch/cubism4')
type Model = Live2DModel<Cubism4InternalModel>

/**
 * Untyped-library boundary: the plugin's published d.ts declares `InternalModel extends
 * utils.EventEmitter` with `utils` unresolved, so the (eventemitter3) on/off methods are invisible
 * to TypeScript although they exist at runtime. This is the only place that relies on them.
 */
interface InternalModelEmitter {
  on(event: 'beforeModelUpdate', listener: () => void): unknown
  off(event: 'beforeModelUpdate', listener: () => void): unknown
}

function asEmitter(internal: Cubism4InternalModel): InternalModelEmitter {
  return internal as unknown as InternalModelEmitter
}

/** Used when the model declares no LipSync group (e.g. the Rice / Mark samples). */
export const DEFAULT_LIP_SYNC_IDS: readonly string[] = ['ParamMouthOpenY']
/** Exponential smoothing per frame applied on top of the player's own smoothing. */
export const MOUTH_SMOOTHING = 0.5

/** Mouth value for the next frame: smoothed toward the target, snapped to 0 when nearly closed. */
export function nextMouthValue(current: number, target: number, smoothing = MOUTH_SMOOTHING): number {
  const next = current + (clamp(target, 0, 1) - current) * clamp(smoothing, 0, 1)
  return next < 0.002 ? 0 : clamp(next, 0, 1)
}

export function createLive2DCharacter(options: Live2DOptions): Character {
  const height = Math.max(1, Math.round(options.height))
  const size = { width: Math.max(1, Math.round(height * 0.6)), height }

  const element = document.createElement('div')
  element.className = 'character character-live2d'
  Object.assign(element.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${size.width}px`,
    height: `${size.height}px`,
    transformOrigin: '50% 100%',
    willChange: 'transform, opacity',
    pointerEvents: 'none',
  })

  let lib: Cubism4Module | null = null
  let app: PIXI.Application<HTMLCanvasElement> | null = null
  let model: Model | null = null
  let lipSyncIds: readonly string[] = DEFAULT_LIP_SYNC_IDS
  let expressionNames: string[] = []
  let motionGroups: string[] = []
  let attentiveName: string | null = null
  let hasHitAreas = false

  const pos: Point = { x: 0, y: 0 }
  let lean = 0
  let mirror = options.mirror
  let modelScale = 1
  let state: CompanionState = 'booting'
  let emotion: Emotion = 'neutral'
  let attentiveShown = false
  let lastLook: Point | null = null
  let mouthTarget = 0
  let mouth = 0

  function onBeforeModelUpdate(): void {
    if (!model) return
    mouth = nextMouthValue(mouth, mouthTarget)
    // While she is not speaking and the mouth is closed, leave the parameter to motions/expressions.
    if (mouth === 0 && state !== 'speaking') return
    const core = model.internalModel.coreModel
    for (const id of lipSyncIds) core.setParameterValueById(id, mouth, 1)
  }

  function applyTransform(): void {
    element.style.transform = composeTransform(pos.x, pos.y, lean)
  }

  function applyMirror(): void {
    if (!model) return
    model.scale.set(mirror ? -modelScale : modelScale, modelScale)
  }

  function applyFocus(): void {
    if (!model) return
    const f = lastLook
      ? normalizedFocus(lastLook.x - pos.x, lastLook.y - pos.y, size, { mirror, state })
      : { x: 0, y: state === 'thinking' ? 0.55 : 0 }
    model.internalModel.focusController.focus(f.x, f.y)
  }

  function playExpression(name: string | null): void {
    if (!model) return
    const manager = model.internalModel.motionManager.expressionManager
    if (!manager) return
    if (name === null) manager.resetExpression()
    else void model.expression(name).catch(() => false)
  }

  function playMotion(group: string): void {
    if (!model || !lib) return
    void model.motion(group, undefined, lib.MotionPriority.NORMAL).catch(() => false)
  }

  /** Apply the current emotion/state to expressions and motions (tolerates models without either). */
  function applyEmotion(playMotions: boolean): void {
    if (!model) return
    if (emotion === 'neutral') {
      playExpression(state === 'listening' ? attentiveName : null)
      attentiveShown = state === 'listening' && attentiveName !== null
      return
    }
    attentiveShown = false
    const name = matchExpression(emotion, expressionNames)
    playExpression(name)
    if (!playMotions) return
    const group = matchMotionGroup(emotion, motionGroups)
    if (group && (name === null || LIVELY_EMOTIONS.has(emotion))) playMotion(group)
  }

  async function load(): Promise<void> {
    lib = await import('pixi-live2d-display-lipsyncpatch/cubism4')
    lib.config.logLevel = lib.config.LOG_LEVEL_WARNING
    lib.config.sound = false
    app = new PIXI.Application<HTMLCanvasElement>({
      width: size.width,
      height,
      backgroundAlpha: 0,
      antialias: false,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: 'high-performance',
      hello: false,
    })
    app.ticker.maxFPS = 60
    Object.assign(app.view.style, { position: 'absolute', left: '0', top: '0' })
    element.appendChild(app.view)

    const loaded = await lib.Live2DModel.from(options.modelUrl, {
      ticker: app.ticker,
      autoUpdate: true,
      autoHitTest: false,
      autoFocus: false,
      motionPreload: lib.MotionPreloadStrategy.IDLE,
    })
    model = loaded as Model
    const internal = model.internalModel

    const fit = fitToHeight(internal.width, internal.height, height)
    modelScale = fit.scale
    size.width = fit.size.width
    model.anchor.set(0.5, 0)
    model.position.set(size.width / 2, 0)
    applyMirror()
    app.renderer.resize(size.width, height)
    element.style.width = `${size.width}px`
    app.stage.addChild(model)

    // Manual lip sync (see header).
    internal.lipSync = false
    const ids = internal.motionManager.lipSyncIds
    lipSyncIds = ids.length > 0 ? [...ids] : DEFAULT_LIP_SYNC_IDS
    asEmitter(internal).on('beforeModelUpdate', onBeforeModelUpdate)

    expressionNames = internal.motionManager.expressionManager?.definitions.map((d) => d.Name) ?? []
    motionGroups = Object.keys(internal.motionManager.definitions)
    attentiveName = matchAttentiveExpression(expressionNames)
    hasHitAreas = Object.keys(internal.hitAreas).length > 0
    console.info('[live2d] model capabilities', {
      lipSyncIds,
      expressions: expressionNames,
      motionGroups,
      hitAreas: Object.keys(internal.hitAreas),
    })

    options.stage.appendChild(element)
    applyTransform()
    applyFocus()
    applyEmotion(false)
  }

  function destroyPixi(): void {
    try {
      if (model) {
        asEmitter(model.internalModel).off('beforeModelUpdate', onBeforeModelUpdate)
        model.stopMotions()
        model.destroy({ children: true, texture: true, baseTexture: true })
      }
    } catch (err) {
      console.warn('[live2d] model destroy failed', err)
    }
    try {
      app?.destroy(true, { children: true, texture: true, baseTexture: true })
    } catch (err) {
      console.warn('[live2d] app destroy failed', err)
    }
    model = null
    app = null
  }

  const character: Character = {
    kind: 'live2d',
    element,
    size,
    async load() {
      try {
        await load()
      } catch (err) {
        destroyPixi()
        element.remove()
        throw err
      }
    },
    setEmotion(next) {
      if (next === emotion) return
      emotion = next
      applyEmotion(true)
    },
    setState(next) {
      const prev = state
      state = next
      if (next === 'listening' || (prev === 'listening' && attentiveShown)) applyEmotion(false)
      applyFocus()
    },
    setMouthOpen(value) {
      mouthTarget = clamp(Number.isFinite(value) ? value : 0, 0, 1)
    },
    lookAt(x, y) {
      lastLook = { x, y }
      applyFocus()
    },
    lookAhead() {
      lastLook = null
      applyFocus()
    },
    hitTest(x, y) {
      if (!model) return false
      if (hasHitAreas) return model.hitTest(x - pos.x, y - pos.y).length > 0
      return hitBoundingBox(x, y, character.bounds())
    },
    bounds(): Rect {
      return { x: pos.x, y: pos.y, width: size.width, height: size.height }
    },
    position() {
      return { ...pos }
    },
    setPosition(x, y) {
      pos.x = x
      pos.y = y
      applyTransform()
    },
    setFlightLean(next) {
      lean = clamp(Number.isFinite(next) ? next : 0, -1, 1)
      applyTransform()
    },
    setMirror(next) {
      mirror = next
      applyMirror()
      applyFocus()
    },
    setOpacity(alpha) {
      element.style.opacity = String(clamp(alpha, 0, 1))
    },
    pause() {
      app?.ticker.stop()
    },
    resume() {
      if (!app) return
      if (model) model.deltaTime = 0 // no physics jump after a long pause
      app.ticker.start()
    },
    dispose() {
      destroyPixi()
      element.remove()
    },
  }
  return character
}
