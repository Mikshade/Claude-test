import { describe, expect, it } from 'vitest'
import { EMOTIONS } from '@shared/state'
import { applyCue, cueFor, cueStyleForCloudModel } from './cues'

describe('cueFor', () => {
  it('maps every emotion to the S2 bracket cue', () => {
    expect(cueFor('happy', 'S2')).toBe('[happy] ')
    expect(cueFor('excited', 'S2')).toBe('[excited] ')
    expect(cueFor('sad', 'S2')).toBe('[sad] ')
    expect(cueFor('surprised', 'S2')).toBe('[surprised] ')
    expect(cueFor('angry', 'S2')).toBe('[angry] ')
    expect(cueFor('shy', 'S2')).toBe('[soft tone] ')
    expect(cueFor('smug', 'S2')).toBe('[playful] ')
    expect(cueFor('sleepy', 'S2')).toBe('[sleepy] ')
    expect(cueFor('thinking', 'S2')).toBe('[calm] ')
    expect(cueFor('neutral', 'S2')).toBe('')
  })

  it('uses parentheses for S1', () => {
    expect(cueFor('happy', 'S1')).toBe('(happy) ')
    expect(cueFor('shy', 'S1')).toBe('(soft tone) ')
    expect(cueFor('neutral', 'S1')).toBe('')
  })

  it('covers every emotion of the shared contract (only neutral is silent)', () => {
    for (const emotion of EMOTIONS) {
      const cue = cueFor(emotion, 'S2')
      if (emotion === 'neutral') expect(cue).toBe('')
      else expect(cue).toMatch(/^\[[a-z ]+\] $/)
    }
  })
})

describe('cueStyleForCloudModel', () => {
  it('s1 → S1, S2 family → S2', () => {
    expect(cueStyleForCloudModel('s1')).toBe('S1')
    expect(cueStyleForCloudModel('S1-mini')).toBe('S1')
    expect(cueStyleForCloudModel('s2-pro')).toBe('S2')
    expect(cueStyleForCloudModel('s2.1-pro')).toBe('S2')
    expect(cueStyleForCloudModel('s2.1-pro-free')).toBe('S2')
  })
})

describe('applyCue', () => {
  it('prefixes once, and only when enabled', () => {
    expect(applyCue('Hallo.', 'happy', 'S2', true)).toBe('[happy] Hallo.')
    expect(applyCue('Hallo.', 'happy', 'S1', true)).toBe('(happy) Hallo.')
    expect(applyCue('Hallo.', 'happy', 'S2', false)).toBe('Hallo.')
    expect(applyCue('Hallo.', undefined, 'S2', true)).toBe('Hallo.')
    expect(applyCue('Hallo.', 'neutral', 'S2', true)).toBe('Hallo.')
  })
})
