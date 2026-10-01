/**
 * Tests for the DOM-free parts of bubble.ts (the controller itself needs a browser).
 * Importing the module must not touch `document` at evaluation time – this file runs in node.
 */
import { describe, expect, it } from 'vitest'
import type { CompanionState } from '@shared/state'
import {
  canAutoHide,
  canInterrupt,
  chipKindForState,
  chipLabelKey,
  clampFontSize,
  findSpokenRange,
  inputHeightFor,
  isBusyState,
  MAX_INPUT_LINES,
  smoothLevel,
} from './bubble'

const ALL_STATES: CompanionState[] = ['booting', 'idle', 'listening', 'transcribing', 'thinking', 'speaking', 'error', 'sleeping']

describe('state → chip', () => {
  it('maps the three visible activities and hides the chip otherwise', () => {
    expect(chipKindForState('listening')).toBe('listening')
    expect(chipKindForState('transcribing')).toBe('thinking')
    expect(chipKindForState('thinking')).toBe('thinking')
    expect(chipKindForState('speaking')).toBe('speaking')
    for (const s of ['booting', 'idle', 'error', 'sleeping'] as const) expect(chipKindForState(s)).toBeNull()
  })

  it('label keys exist exactly for the chip states', () => {
    for (const s of ALL_STATES) {
      const kind = chipKindForState(s)
      const key = chipLabelKey(s)
      expect(kind === null).toBe(key === null)
      if (key) expect(key).toBe(s)
    }
  })

  it('busy states keep the bubble, interruptible states show the stop button', () => {
    expect(ALL_STATES.filter(isBusyState)).toEqual(['listening', 'transcribing', 'thinking', 'speaking'])
    expect(ALL_STATES.filter(canInterrupt)).toEqual(['thinking', 'speaking'])
  })
})

describe('canAutoHide', () => {
  it('hides only when idle with nothing open', () => {
    expect(canAutoHide({ state: 'idle', confirmPending: false, chatOpen: false })).toBe(true)
    expect(canAutoHide({ state: 'error', confirmPending: false, chatOpen: false })).toBe(true)
    expect(canAutoHide({ state: 'idle', confirmPending: true, chatOpen: false })).toBe(false)
    expect(canAutoHide({ state: 'idle', confirmPending: false, chatOpen: true })).toBe(false)
    for (const state of ['listening', 'transcribing', 'thinking', 'speaking'] as const) {
      expect(canAutoHide({ state, confirmPending: false, chatOpen: false })).toBe(false)
    }
  })
})

describe('findSpokenRange', () => {
  const text = 'Hallo! Ich bin Yui.\nWie kann ich helfen? Ich bin Yui. Wirklich.'

  it('finds an exact sentence', () => {
    expect(findSpokenRange(text, 'Hallo!')).toEqual({ start: 0, end: 6 })
  })

  it('tolerates whitespace differences (newlines, double spaces)', () => {
    const r = findSpokenRange('Ein  Satz\nmit   Umbrüchen.', 'Ein Satz mit Umbrüchen.')
    expect(r).toEqual({ start: 0, end: 'Ein  Satz\nmit   Umbrüchen.'.length })
    expect(findSpokenRange(text, 'Ich bin Yui. Wie kann ich helfen?')).toEqual({ start: 7, end: 40 })
  })

  it('continues after the previous sentence so a repeated sentence highlights the next occurrence', () => {
    const first = findSpokenRange(text, 'Ich bin Yui.')
    expect(first).toEqual({ start: 7, end: 19 })
    const second = findSpokenRange(text, 'Ich bin Yui.', first!.end)
    expect(second).toEqual({ start: 41, end: 53 })
  })

  it('falls back to searching from the start when nothing follows the cursor', () => {
    expect(findSpokenRange(text, 'Hallo!', 30)).toEqual({ start: 0, end: 6 })
  })

  it('returns null when the sentence is not in the text or inputs are empty', () => {
    expect(findSpokenRange(text, 'Tschüss.')).toBeNull()
    expect(findSpokenRange(text, '   ')).toBeNull()
    expect(findSpokenRange('', 'Hallo!')).toBeNull()
  })

  it('treats regex metacharacters literally', () => {
    const code = 'Nutze `ls *.txt` (im Ordner) oder [a-z]+?'
    expect(findSpokenRange(code, '(im Ordner) oder [a-z]+?')).toEqual({ start: 17, end: code.length })
    expect(findSpokenRange(code, 'ls *.txt')).toEqual({ start: 7, end: 15 })
  })

  it('handles a partially streamed text (sentence not complete yet)', () => {
    expect(findSpokenRange('Hallo! Ich bin', 'Ich bin Yui.')).toBeNull()
    expect(findSpokenRange('Hallo! Ich bin Yui.', 'Ich bin Yui.')).toEqual({ start: 7, end: 19 })
  })

  it('ignores out-of-range or odd cursors', () => {
    expect(findSpokenRange(text, 'Hallo!', -5)).toEqual({ start: 0, end: 6 })
    expect(findSpokenRange(text, 'Hallo!', 10_000)).toEqual({ start: 0, end: 6 })
    expect(findSpokenRange(text, 'Wirklich.', 3.7)).toEqual({ start: text.length - 9, end: text.length })
  })
})

describe('inputHeightFor', () => {
  const line = 21
  const chrome = 18 // 8 px padding top/bottom + 1 px borders

  it('is one line high for an empty / single-line input', () => {
    expect(inputHeightFor(0, line, chrome)).toBe(line + chrome)
    expect(inputHeightFor(line, line, chrome)).toBe(line + chrome)
  })

  it('grows with the content up to four lines', () => {
    expect(inputHeightFor(2 * line, line, chrome)).toBe(2 * line + chrome)
    expect(inputHeightFor(4 * line, line, chrome)).toBe(4 * line + chrome)
    expect(inputHeightFor(9 * line, line, chrome)).toBe(MAX_INPUT_LINES * line + chrome)
  })

  it('accepts a custom line cap and rounds to whole pixels', () => {
    expect(inputHeightFor(9 * line, line, chrome, 2)).toBe(2 * line + chrome)
    expect(inputHeightFor(30.4, 20.5, 10.2)).toBe(41)
    expect(inputHeightFor(100, 20, 10, 0)).toBe(30)
  })
})

describe('smoothLevel / clampFontSize', () => {
  it('boosts quiet levels, clamps to 0..1 and smooths', () => {
    expect(smoothLevel(0, 0.25, 1)).toBe(0.5)
    expect(smoothLevel(0, 1, 1)).toBe(1)
    expect(smoothLevel(0, 7, 1)).toBe(1)
    expect(smoothLevel(0, -3, 1)).toBe(0)
    expect(smoothLevel(0, Number.NaN, 1)).toBe(0)
    expect(smoothLevel(0, 1, 0.5)).toBe(0.5)
    expect(smoothLevel(1, 0, 0.5)).toBe(0.5)
  })

  it('clamps the font size to the config range', () => {
    expect(clampFontSize(15)).toBe(15)
    expect(clampFontSize(2)).toBe(10)
    expect(clampFontSize(99)).toBe(32)
    expect(clampFontSize(14.6)).toBe(15)
    expect(clampFontSize(Number.NaN)).toBe(15)
  })
})
