import { describe, expect, it } from 'vitest'
import { EMOTIONS } from '@shared/state'
import {
  EXPRESSION_PATTERNS,
  FACE_PRESETS,
  hasAllPresets,
  LIVELY_EMOTIONS,
  matchAttentiveExpression,
  matchExpression,
  matchMotionGroup,
  MOTION_GROUP_PATTERNS,
} from './emotions'

/** Expression lists of the official Live2D sample models (see research notes). */
const NATORI = ['Angry', 'Blushing', 'Normal', 'Sad', 'Smile', 'Surprised', 'exp_01', 'exp_02', 'exp_03', 'exp_04', 'exp_05']
const HARU = ['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08']
const MAO = ['exp_01', 'exp_02', 'exp_03', 'exp_04', 'exp_05', 'exp_06', 'exp_07', 'exp_08']

describe('matchExpression', () => {
  it('prefers descriptive names over index names', () => {
    expect(matchExpression('happy', NATORI)).toBe('Smile')
    expect(matchExpression('angry', NATORI)).toBe('Angry')
    expect(matchExpression('sad', NATORI)).toBe('Sad')
    expect(matchExpression('surprised', NATORI)).toBe('Surprised')
    expect(matchExpression('shy', NATORI)).toBe('Blushing')
    expect(matchExpression('excited', NATORI)).toBe('Smile')
  })

  it('falls back to index-style names', () => {
    expect(matchExpression('happy', HARU)).toBe('F01')
    expect(matchExpression('shy', HARU)).toBe('F02')
    expect(matchExpression('sad', MAO)).toBe('exp_04')
    expect(matchExpression('smug', MAO)).toBe('exp_08')
  })

  it('matches case-insensitively and returns null when nothing fits', () => {
    expect(matchExpression('happy', ['HAPPY_FACE'])).toBe('HAPPY_FACE')
    expect(matchExpression('sleepy', NATORI)).toBeNull()
    expect(matchExpression('happy', [])).toBeNull()
  })

  it('never returns an expression for neutral (the caller resets instead)', () => {
    expect(matchExpression('neutral', ['Normal', 'neutral'])).toBeNull()
  })

  it('has patterns for every emotion', () => {
    for (const e of EMOTIONS) expect(Array.isArray(EXPRESSION_PATTERNS[e])).toBe(true)
  })
})

describe('matchMotionGroup', () => {
  it('uses emotion-named groups first, then tap/flick groups', () => {
    expect(matchMotionGroup('happy', ['Idle', 'TapBody'])).toBe('TapBody')
    expect(matchMotionGroup('happy', ['Idle', 'Happy', 'TapBody'])).toBe('Happy')
    expect(matchMotionGroup('surprised', ['Idle', 'FlickUp', 'Tap'])).toBe('FlickUp')
    expect(matchMotionGroup('sad', ['Idle', 'FlickDown'])).toBe('FlickDown')
  })

  it('returns null for neutral and for models with only Idle', () => {
    expect(matchMotionGroup('neutral', ['Idle', 'TapBody'])).toBeNull()
    expect(matchMotionGroup('happy', ['Idle'])).toBeNull()
    expect(matchMotionGroup('sleepy', ['Idle', 'TapBody'])).toBeNull()
  })

  it('keeps the original casing of the group name', () => {
    expect(matchMotionGroup('excited', ['tapbody'])).toBe('tapbody')
    for (const e of EMOTIONS) expect(Array.isArray(MOTION_GROUP_PATTERNS[e])).toBe(true)
  })
})

describe('matchAttentiveExpression', () => {
  it('picks a listening/smile expression when present', () => {
    expect(matchAttentiveExpression(NATORI)).toBe('Smile')
    expect(matchAttentiveExpression(['Idle', 'Listening'])).toBe('Listening')
    expect(matchAttentiveExpression(HARU)).toBeNull()
  })
})

describe('FACE_PRESETS', () => {
  it('defines a preset for every emotion with sane ranges', () => {
    expect(hasAllPresets()).toBe(true)
    for (const e of EMOTIONS) {
      const p = FACE_PRESETS[e]
      expect(p.eyeOpen).toBeGreaterThanOrEqual(0)
      expect(p.eyeOpen).toBeLessThanOrEqual(1)
      expect(p.blush).toBeGreaterThanOrEqual(0)
      expect(p.blush).toBeLessThanOrEqual(1)
      expect(p.mouthCurve).toBeGreaterThanOrEqual(-1)
      expect(p.mouthCurve).toBeLessThanOrEqual(1)
      expect(Math.abs(p.headTilt)).toBeLessThan(0.5)
      expect(p.mouthWidth).toBeGreaterThan(0)
    }
    expect(FACE_PRESETS.happy.mouthCurve).toBeGreaterThan(FACE_PRESETS.sad.mouthCurve)
    expect(FACE_PRESETS.shy.blush).toBeGreaterThan(FACE_PRESETS.neutral.blush)
    expect(FACE_PRESETS.sleepy.eyeOpen).toBeLessThan(FACE_PRESETS.surprised.eyeOpen)
  })

  it('marks the lively emotions', () => {
    expect(LIVELY_EMOTIONS.has('excited')).toBe(true)
    expect(LIVELY_EMOTIONS.has('sleepy')).toBe(false)
  })
})
