import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type FlowyConfig, mergeConfig } from '@shared/config'
import {
  basename,
  computeBlocked,
  computeInteractive,
  createMarkerStripper,
  diffConfig,
  MODEL_URL_PREFIX,
  modelUrlCandidates,
  modifierHeld,
  noopBubble,
  noopPlayer,
  noopRecorder,
  opacityForState,
  selectModelPath,
  t,
} from './wiring'

describe('basename / model URL', () => {
  it('handles Windows and POSIX paths', () => {
    expect(basename('C:\\Users\\me\\models\\Hiyori\\Hiyori.model3.json')).toBe('Hiyori.model3.json')
    expect(basename('/opt/flowy/models/default/Haru.model3.json')).toBe('Haru.model3.json')
    expect(basename('C:\\Users\\me\\models\\default\\')).toBe('default')
    expect(basename('plain.json')).toBe('plain.json')
    expect(basename('')).toBe('')
  })

  it('maps a model3.json path to a single encoded flowy-model URL', () => {
    expect(modelUrlCandidates('D:\\L2D\\Momose Hiyori\\Hiyori Momose.model3.json')).toEqual([
      `${MODEL_URL_PREFIX}Hiyori%20Momose.model3.json`,
    ])
    expect(modelUrlCandidates('/x/y/shizuku.model.json')).toEqual([`${MODEL_URL_PREFIX}shizuku.model.json`])
  })

  it('probes conventional file names for a directory (the bundled default model folder)', () => {
    expect(modelUrlCandidates('C:\\app\\resources\\models\\default')).toEqual([
      `${MODEL_URL_PREFIX}default.model3.json`,
      `${MODEL_URL_PREFIX}model.model3.json`,
      `${MODEL_URL_PREFIX}index.model3.json`,
    ])
    expect(modelUrlCandidates('/models/Hiyori/')[0]).toBe(`${MODEL_URL_PREFIX}Hiyori.model3.json`)
    expect(modelUrlCandidates('')).toEqual([])
    expect(modelUrlCandidates('   ')).toEqual([])
  })

  it('selects the configured model before the bundled default', () => {
    expect(selectModelPath('C:\\me\\a.model3.json', '/app/default')).toBe('C:\\me\\a.model3.json')
    expect(selectModelPath('', '/app/default')).toBe('/app/default')
    expect(selectModelPath(' ', '')).toBe('')
  })
})

describe('modifierHeld', () => {
  const ev = (ctrlKey = false, altKey = false, shiftKey = false): { ctrlKey: boolean; altKey: boolean; shiftKey: boolean } => ({
    ctrlKey,
    altKey,
    shiftKey,
  })

  it('maps the configured hold key to the event flag', () => {
    expect(modifierHeld(ev(true), 'Control')).toBe(true)
    expect(modifierHeld(ev(false, true), 'Control')).toBe(false)
    expect(modifierHeld(ev(false, true), 'Alt')).toBe(true)
    expect(modifierHeld(ev(false, false, true), 'Shift')).toBe(true)
    expect(modifierHeld(ev(true, true, true), 'Shift')).toBe(true)
    expect(modifierHeld(ev(), 'Shift')).toBe(false)
  })
})

describe('computeInteractive / computeBlocked', () => {
  it('is interactive only over her with the hold key, or when the bubble wants input', () => {
    expect(computeInteractive({ hovering: true, holdKey: true, bubbleInteractive: false })).toBe(true)
    expect(computeInteractive({ hovering: true, holdKey: false, bubbleInteractive: false })).toBe(false)
    expect(computeInteractive({ hovering: false, holdKey: true, bubbleInteractive: false })).toBe(false)
    expect(computeInteractive({ hovering: false, holdKey: false, bubbleInteractive: true })).toBe(true)
    expect(computeInteractive({ hovering: false, holdKey: false, bubbleInteractive: false })).toBe(false)
  })

  it('blocks flight while pinned, holding the key, bubble open or listening', () => {
    const base = { pinned: false, holdKey: false, bubbleInteractive: false, state: 'idle' as const }
    expect(computeBlocked(base)).toBe(false)
    expect(computeBlocked({ ...base, pinned: true })).toBe(true)
    expect(computeBlocked({ ...base, holdKey: true })).toBe(true)
    expect(computeBlocked({ ...base, bubbleInteractive: true })).toBe(true)
    expect(computeBlocked({ ...base, state: 'listening' })).toBe(true)
    expect(computeBlocked({ ...base, state: 'speaking' })).toBe(false)
  })
})

describe('opacityForState', () => {
  it('fades only while idle/sleeping and clamps the percentage', () => {
    expect(opacityForState('idle', 70)).toBeCloseTo(0.7)
    expect(opacityForState('sleeping', 70)).toBeCloseTo(0.7)
    expect(opacityForState('speaking', 70)).toBe(1)
    expect(opacityForState('idle', 250)).toBe(1)
    expect(opacityForState('idle', -5)).toBe(0)
  })
})

describe('createMarkerStripper', () => {
  it('strips complete markers inside one delta', () => {
    const s = createMarkerStripper()
    expect(s.push('Hallo [[happy]] du!')).toBe('Hallo  du!')
  })

  it('holds back a marker split across deltas', () => {
    const s = createMarkerStripper()
    expect(s.push('Na [[ha')).toBe('Na ')
    expect(s.push('ppy]] klar')).toBe(' klar')
    expect(s.push('[')).toBe('')
    expect(s.push('[sad]]!')).toBe('!')
    expect(s.flush()).toBe('')
  })

  it('releases a lone bracket that was not a marker', () => {
    const s = createMarkerStripper()
    expect(s.push('a [')).toBe('a ')
    expect(s.push('b]')).toBe('[b]')
    expect(s.push('x [')).toBe('x ')
    expect(s.flush()).toBe('[')
  })

  it('drops an unterminated marker on flush and reset clears state', () => {
    const s = createMarkerStripper()
    expect(s.push('text [[thin')).toBe('text ')
    expect(s.flush()).toBe('')
    s.push('[[')
    s.reset()
    expect(s.push('clean')).toBe('clean')
  })
})

describe('diffConfig', () => {
  const base: FlowyConfig = DEFAULT_CONFIG
  const patched = (patch: Parameters<typeof mergeConfig<FlowyConfig>>[1]): FlowyConfig => mergeConfig(base, patch)

  it('reports nothing for an identical config', () => {
    const d = diffConfig(base, structuredClone(base))
    expect(Object.values(d).every((v) => v === false)).toBe(true)
  })

  it('flags a character rebuild for model path / height and the individual sections otherwise', () => {
    expect(diffConfig(base, patched({ avatar: { modelPath: 'C:\\m.model3.json' } })).rebuildCharacter).toBe(true)
    expect(diffConfig(base, patched({ avatar: { height: 600 } })).rebuildCharacter).toBe(true)
    const d = diffConfig(
      base,
      patched({
        avatar: { mirror: true, avoidance: { radius: 200 }, anchor: 'top-left', lookAtCursor: false, pinned: true },
        tts: { volume: 20, outputDeviceId: 'dev' },
        stt: { inputDeviceId: 'mic' },
        appearance: { bubbleFontSize: 20, idleOpacity: 50, theme: 'dark' },
        character: { language: 'en' },
      }),
    )
    expect(d).toEqual({
      rebuildCharacter: false,
      mirror: true,
      avoidance: true,
      anchor: true,
      lookAtCursor: true,
      pinned: true,
      volume: true,
      outputDevice: true,
      recorder: true,
      fontSize: true,
      language: true,
      idleOpacity: true,
      theme: true,
    })
  })
})

describe('i18n', () => {
  it('has German and English strings', () => {
    expect(t('de', 'micError')).toMatch(/Mikrofon/)
    expect(t('en', 'micError')).toMatch(/microphone/)
    expect(t('en', 'modelError')).not.toBe(t('de', 'modelError'))
  })
})

describe('no-op stand-ins', () => {
  it('are inert and never throw', async () => {
    const bubble = noopBubble()
    bubble.setAnchor({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 10, height: 10 })
    expect(bubble.isInteractive()).toBe(false)
    expect(bubble.isChatInputOpen()).toBe(false)
    await expect(bubble.confirm({ id: '1', title: 't', detail: 'd', danger: false })).resolves.toBe(false)
    const player = noopPlayer()
    expect(player.isPlaying()).toBe(false)
    expect(player.currentTurn()).toBeNull()
    await expect(player.setOutputDevice('x')).resolves.toBeUndefined()
    const recorder = noopRecorder()
    expect(recorder.isRecording()).toBe(false)
    await expect(recorder.stop()).resolves.toBeNull()
    await expect(recorder.start()).rejects.toThrow()
  })
})
