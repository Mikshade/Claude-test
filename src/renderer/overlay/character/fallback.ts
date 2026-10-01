/**
 * Procedural fallback character: a small chibi anime girl drawn with 2D canvas paths so Flowy works
 * without any Live2D model or the proprietary Cubism Core. Blinks, breathes, sways her hair, follows
 * the cursor with her eyes, moves her mouth with the TTS analyser and changes her face per emotion.
 *
 * Drawing happens in a 100 × 160 design space scaled to the configured height (DPR aware).
 */
import type { CompanionState, Emotion, Point, Rect } from '@shared/state'
import { FACE_PRESETS, type FacePreset } from './emotions'
import type { Character } from './index'
import { clamp, composeTransform, hitBoundingBox, normalizedFocus } from '../hitTest'

export interface FallbackOptions {
  height: number
  mirror: boolean
  stage: HTMLElement
}

type Ctx = CanvasRenderingContext2D

const W = 100
const H = 160
const C = {
  hair: '#7b6cf6',
  hairDark: '#5a4bd1',
  hairLight: '#a79cff',
  skin: '#ffe6d5',
  skinShade: '#f3c9b4',
  blush: '#ff8fa8',
  iris: '#3fb8c8',
  irisDark: '#1e5f73',
  line: '#3a2e5a',
  dress: '#f7f2ff',
  dressAccent: '#8f7cff',
  ribbon: '#ff7aa2',
  shoe: '#4a4a6a',
  mouth: '#c9405f',
  mouthOpen: '#7a1f33',
}

/** Exponential smoothing factor for a frame of `dt` ms with time constant `tau` ms. */
function smooth(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau)
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k
}

export function createFallbackCharacter(options: FallbackOptions): Character {
  const height = Math.max(1, Math.round(options.height))
  const size = { width: Math.round((height * W) / H), height }
  const scale = height / H

  const element = document.createElement('div')
  element.className = 'character character-fallback'
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
  const canvas = document.createElement('canvas')
  canvas.style.width = `${size.width}px`
  canvas.style.height = `${size.height}px`
  element.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  let dpr = 1
  function fitCanvas(): void {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
  }
  fitCanvas()

  // ---- animation state ------------------------------------------------------------------------
  const pos: Point = { x: 0, y: 0 }
  let lean = 0
  let mirror = options.mirror
  let state: CompanionState = 'booting'
  let emotion: Emotion = 'neutral'
  let mouthTarget = 0
  let mouth = 0
  const lookTarget = { x: 0, y: 0 }
  const look = { x: 0, y: 0 }
  const face: FacePreset = { ...FACE_PRESETS.neutral }
  let blinkAt = 0
  let blinkStart = -1
  let raf = 0
  let last = 0
  let running = false
  let time = 0

  function scheduleBlink(now: number): void {
    blinkAt = now + 2000 + Math.random() * 4000
  }

  function targetFace(): FacePreset {
    const base = FACE_PRESETS[emotion]
    if (state === 'sleeping') return { ...base, eyeOpen: 0.05, mouthCurve: 0.2, blush: 0.1 }
    if (state === 'listening' && emotion === 'neutral') return { ...base, eyeOpen: 1, browRaise: 0.4, mouthCurve: 0.5 }
    if (state === 'thinking' && emotion === 'neutral') return FACE_PRESETS.thinking
    return base
  }

  function step(now: number): void {
    const dt = last ? clamp(now - last, 0, 100) : 16
    last = now
    time += dt
    const k = smooth(dt, 90)
    const target = targetFace()
    face.eyeOpen = lerp(face.eyeOpen, target.eyeOpen, k)
    face.browAngle = lerp(face.browAngle, target.browAngle, k)
    face.browRaise = lerp(face.browRaise, target.browRaise, k)
    face.mouthCurve = lerp(face.mouthCurve, target.mouthCurve, k)
    face.mouthWidth = lerp(face.mouthWidth, target.mouthWidth, k)
    face.blush = lerp(face.blush, target.blush, k)
    face.headTilt = lerp(face.headTilt, target.headTilt, k)
    face.sparkle = target.sparkle
    face.sweat = target.sweat
    look.x = lerp(look.x, lookTarget.x, smooth(dt, 120))
    look.y = lerp(look.y, lookTarget.y, smooth(dt, 120))
    mouth = lerp(mouth, mouthTarget, smooth(dt, 40))
    if (blinkStart < 0 && now >= blinkAt) blinkStart = now
    let blink = 1
    if (blinkStart >= 0) {
      const phase = (now - blinkStart) / 170
      if (phase >= 1) {
        blinkStart = -1
        scheduleBlink(now)
      } else blink = 1 - Math.sin(phase * Math.PI)
    }
    draw(blink)
  }

  function loop(now: number): void {
    if (!running) return
    step(now)
    raf = requestAnimationFrame(loop)
  }

  // ---- drawing ---------------------------------------------------------------------------------
  function draw(blink: number): void {
    if (!ctx) return
    const g = ctx
    g.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
    g.clearRect(0, 0, W, H)
    if (mirror) {
      g.translate(W, 0)
      g.scale(-1, 1)
    }
    const breath = 1 + 0.012 * Math.sin((time / 1900) * Math.PI * 2)
    const sway = Math.sin((time / 1500) * Math.PI * 2) * 1.6 + (mirror ? -lean : lean) * 7
    const lx = (mirror ? -look.x : look.x) * (state === 'listening' ? 1.2 : 1)
    const ly = look.y

    g.lineJoin = 'round'
    g.lineCap = 'round'
    drawBackHair(g, sway)
    g.save()
    g.translate(50, 128)
    g.scale(1, breath)
    g.translate(-50, -128)
    drawBody(g)
    g.restore()
    g.save()
    g.translate(50, 78)
    g.rotate(face.headTilt + lx * 0.06 - sway * 0.01)
    g.translate(-50, -78 + (breath - 1) * -30)
    drawHead(g)
    drawFace(g, lx, ly, blink)
    drawFrontHair(g, sway)
    g.restore()
    if (face.sparkle) drawSparkles(g)
  }

  function drawBackHair(g: Ctx, sway: number): void {
    g.fillStyle = C.hairDark
    g.beginPath()
    g.moveTo(18, 52)
    g.bezierCurveTo(14, 20, 86, 20, 82, 52)
    g.bezierCurveTo(88, 80, 90 + sway, 100, 84 + sway * 1.6, 118)
    g.bezierCurveTo(74 + sway, 110, 70 + sway, 120, 66 + sway * 1.3, 112)
    g.lineTo(60, 92)
    g.lineTo(40, 92)
    g.lineTo(34 + sway * 1.3, 112)
    g.bezierCurveTo(30 + sway, 120, 26 + sway, 110, 16 + sway * 1.6, 118)
    g.bezierCurveTo(10 + sway, 100, 12, 80, 18, 52)
    g.closePath()
    g.fill()
  }

  function drawBody(g: Ctx): void {
    // neck
    g.fillStyle = C.skinShade
    g.fillRect(45, 74, 10, 10)
    // dress
    g.fillStyle = C.dress
    g.beginPath()
    g.moveTo(37, 82)
    g.quadraticCurveTo(50, 88, 63, 82)
    g.lineTo(70, 100)
    g.quadraticCurveTo(76, 126, 74, 130)
    g.quadraticCurveTo(50, 138, 26, 130)
    g.quadraticCurveTo(24, 126, 30, 100)
    g.closePath()
    g.fill()
    g.strokeStyle = C.dressAccent
    g.lineWidth = 1.2
    g.stroke()
    // waist band + collar ribbon
    g.fillStyle = C.dressAccent
    g.beginPath()
    g.moveTo(31, 100)
    g.quadraticCurveTo(50, 106, 69, 100)
    g.lineTo(69, 104)
    g.quadraticCurveTo(50, 110, 31, 104)
    g.closePath()
    g.fill()
    g.fillStyle = C.ribbon
    g.beginPath()
    g.moveTo(50, 88)
    g.lineTo(44, 84)
    g.lineTo(44, 92)
    g.closePath()
    g.moveTo(50, 88)
    g.lineTo(56, 84)
    g.lineTo(56, 92)
    g.closePath()
    g.fill()
    // arms
    g.strokeStyle = C.skin
    g.lineWidth = 6
    g.beginPath()
    g.moveTo(33, 92)
    g.quadraticCurveTo(26, 104, 30, 116)
    g.moveTo(67, 92)
    g.quadraticCurveTo(74, 104, 70, 116)
    g.stroke()
    // legs + shoes
    g.lineWidth = 7
    g.beginPath()
    g.moveTo(42, 130)
    g.lineTo(42, 148)
    g.moveTo(58, 130)
    g.lineTo(58, 148)
    g.stroke()
    g.fillStyle = C.shoe
    g.beginPath()
    g.ellipse(41, 151, 6.5, 3.5, 0, 0, Math.PI * 2)
    g.ellipse(59, 151, 6.5, 3.5, 0, 0, Math.PI * 2)
    g.fill()
  }

  function drawHead(g: Ctx): void {
    g.fillStyle = C.skin
    g.beginPath()
    g.moveTo(21, 50)
    g.bezierCurveTo(21, 20, 79, 20, 79, 50)
    g.bezierCurveTo(79, 66, 66, 80, 50, 82)
    g.bezierCurveTo(34, 80, 21, 66, 21, 50)
    g.closePath()
    g.fill()
    // ears
    g.beginPath()
    g.ellipse(21, 56, 3.5, 5, 0, 0, Math.PI * 2)
    g.ellipse(79, 56, 3.5, 5, 0, 0, Math.PI * 2)
    g.fill()
  }

  function drawEye(g: Ctx, cx: number, cy: number, lx: number, ly: number, open: number): void {
    const w = 6.5
    const h = 8
    g.save()
    g.beginPath()
    g.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2)
    g.clip()
    g.fillStyle = '#ffffff'
    g.fillRect(cx - w, cy - h, 2 * w, 2 * h)
    const ix = cx + lx * 2.8
    const iy = cy + 1 - ly * 2.2
    const grad = g.createRadialGradient(ix, iy - 2, 1, ix, iy, 6)
    grad.addColorStop(0, C.iris)
    grad.addColorStop(1, C.irisDark)
    g.fillStyle = grad
    g.beginPath()
    g.ellipse(ix, iy, 4.3, 5.6, 0, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = C.line
    g.beginPath()
    g.ellipse(ix, iy + 0.5, 1.9, 2.8, 0, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = 'rgba(255,255,255,0.95)'
    g.beginPath()
    g.ellipse(ix - 1.6, iy - 2.6, 1.6, 1.9, 0, 0, Math.PI * 2)
    g.fill()
    g.beginPath()
    g.ellipse(ix + 1.6, iy + 2.2, 0.8, 0.9, 0, 0, Math.PI * 2)
    g.fill()
    // eyelid (skin) slides down as the eye closes
    const lid = (1 - open) * 2 * h
    g.fillStyle = C.skin
    g.fillRect(cx - w - 1, cy - h - 1, 2 * w + 2, lid + 1)
    g.restore()
    // upper lash line
    g.strokeStyle = C.line
    g.lineWidth = 1.6
    g.beginPath()
    g.moveTo(cx - w, cy - h + lid * 0.95 + 0.5)
    g.quadraticCurveTo(cx, cy - h - 1.5 + lid, cx + w, cy - h + lid * 0.95 + 0.5)
    g.stroke()
  }

  function drawFace(g: Ctx, lx: number, ly: number, blink: number): void {
    const open = clamp(face.eyeOpen * blink, 0, 1)
    drawEye(g, 38, 57, lx, ly, open)
    drawEye(g, 62, 57, lx, ly, open)
    // eyebrows
    g.strokeStyle = C.hairDark
    g.lineWidth = 1.4
    const raise = -face.browRaise * 2.5
    for (const side of [-1, 1]) {
      const cx = 50 + side * 12
      const y = 45 + raise
      g.beginPath()
      g.moveTo(cx - side * 6, y + face.browAngle * 3) // inner end
      g.quadraticCurveTo(cx, y - 2, cx + side * 6, y - face.browAngle * 3) // outer end
      g.stroke()
    }
    // blush
    if (face.blush > 0.02) {
      g.fillStyle = `rgba(255,143,168,${(0.6 * face.blush).toFixed(3)})`
      g.beginPath()
      g.ellipse(31, 66, 5.5, 2.6, 0, 0, Math.PI * 2)
      g.ellipse(69, 66, 5.5, 2.6, 0, 0, Math.PI * 2)
      g.fill()
    }
    // mouth
    const mw = 4.5 * face.mouthWidth
    const my = 72
    const openness = clamp(mouth, 0, 1)
    if (openness > 0.06) {
      g.fillStyle = C.mouthOpen
      g.beginPath()
      g.ellipse(50, my + openness * 1.5, mw * (0.8 + openness * 0.3), 1 + openness * 5, 0, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = C.mouth
      g.beginPath()
      g.ellipse(50, my + 1.5 + openness * 4, mw * 0.6, openness * 2, 0, 0, Math.PI)
      g.fill()
    } else {
      g.strokeStyle = C.mouth
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(50 - mw, my)
      g.quadraticCurveTo(50, my + face.mouthCurve * 3.2, 50 + mw, my)
      g.stroke()
    }
  }

  function drawFrontHair(g: Ctx, sway: number): void {
    g.fillStyle = C.hair
    g.beginPath()
    g.moveTo(20, 50)
    g.bezierCurveTo(18, 16, 82, 16, 80, 50)
    g.quadraticCurveTo(78, 42, 74, 36)
    g.quadraticCurveTo(70, 50, 64, 40)
    g.quadraticCurveTo(58, 52, 54, 36)
    g.quadraticCurveTo(50, 50, 46, 38)
    g.quadraticCurveTo(40, 52, 34, 36)
    g.quadraticCurveTo(28, 48, 24, 40)
    g.quadraticCurveTo(22, 46, 20, 50)
    g.closePath()
    g.fill()
    // side locks
    g.beginPath()
    g.moveTo(20, 48)
    g.quadraticCurveTo(14 + sway * 0.5, 70, 18 + sway, 92)
    g.quadraticCurveTo(24, 80, 25, 56)
    g.closePath()
    g.moveTo(80, 48)
    g.quadraticCurveTo(86 + sway * 0.5, 70, 82 + sway, 92)
    g.quadraticCurveTo(76, 80, 75, 56)
    g.closePath()
    g.fill()
    // highlight + ahoge
    g.strokeStyle = C.hairLight
    g.lineWidth = 1.6
    g.beginPath()
    g.moveTo(32, 30)
    g.quadraticCurveTo(44, 24, 58, 27)
    g.stroke()
    g.strokeStyle = C.hair
    g.lineWidth = 2.2
    g.beginPath()
    g.moveTo(52, 22)
    g.quadraticCurveTo(54 + sway, 10, 64 + sway * 1.5, 14)
    g.stroke()
    // ribbon
    g.fillStyle = C.ribbon
    g.beginPath()
    g.moveTo(76, 34)
    g.lineTo(84, 28)
    g.lineTo(84, 40)
    g.closePath()
    g.moveTo(76, 34)
    g.lineTo(70, 27)
    g.lineTo(69, 38)
    g.closePath()
    g.fill()
  }

  function drawSparkles(g: Ctx): void {
    g.fillStyle = '#ffd86b'
    for (const [x, y, phase] of [
      [14, 40, 0],
      [88, 48, 1.3],
      [82, 20, 2.4],
      [12, 70, 3.1],
    ] as const) {
      const r = 2.5 + 1.5 * Math.sin(time / 240 + phase)
      g.beginPath()
      g.moveTo(x, y - r)
      g.quadraticCurveTo(x, y, x + r, y)
      g.quadraticCurveTo(x, y, x, y + r)
      g.quadraticCurveTo(x, y, x - r, y)
      g.quadraticCurveTo(x, y, x, y - r)
      g.fill()
    }
  }

  function applyTransform(): void {
    element.style.transform = composeTransform(pos.x, pos.y, lean)
  }

  const character: Character = {
    kind: 'fallback',
    element,
    size,
    async load() {
      options.stage.appendChild(element)
      applyTransform()
      scheduleBlink(performance.now())
      character.resume()
    },
    setEmotion(next) {
      emotion = next
    },
    setState(next) {
      state = next
    },
    setMouthOpen(value) {
      mouthTarget = clamp(Number.isFinite(value) ? value : 0, 0, 1)
    },
    lookAt(x, y) {
      const f = normalizedFocus(x - pos.x, y - pos.y, size, { state })
      lookTarget.x = f.x
      lookTarget.y = f.y
    },
    lookAhead() {
      lookTarget.x = 0
      lookTarget.y = state === 'thinking' ? 0.5 : 0
    },
    hitTest(x, y) {
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
    },
    setOpacity(alpha) {
      element.style.opacity = String(clamp(alpha, 0, 1))
    },
    pause() {
      running = false
      cancelAnimationFrame(raf)
    },
    resume() {
      if (running) return
      running = true
      last = 0
      fitCanvas()
      raf = requestAnimationFrame(loop)
    },
    dispose() {
      character.pause()
      element.remove()
    },
  }
  return character
}
