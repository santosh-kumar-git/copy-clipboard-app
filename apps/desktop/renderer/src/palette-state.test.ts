import { TOAST_COPIED_MANUAL, TOAST_COPIED_SECURE_INPUT } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  RECALL_TOAST_TEXT,
  VISIBLE_ROWS,
  filePathsFromPreview,
  highlightSegments,
  kindChipLabel,
  nextIndex,
  secretExpiryLabel,
  visibleRange,
  windowStartFor,
} from './palette-state.svelte'

describe('keyboard navigation arithmetic', () => {
  it('wraps Down past the last row to the first, and Up past the first to the last', () => {
    expect(nextIndex(0, 'ArrowDown', 3)).toBe(1)
    expect(nextIndex(2, 'ArrowDown', 3)).toBe(0)
    expect(nextIndex(0, 'ArrowUp', 3)).toBe(2)
    expect(nextIndex(1, 'ArrowUp', 3)).toBe(0)
    expect(nextIndex(1, 'Home', 3)).toBe(0)
    expect(nextIndex(1, 'End', 3)).toBe(2)
  })

  it('stays at 0 when there is nothing to select', () => {
    expect(nextIndex(0, 'ArrowDown', 0)).toBe(0)
    expect(nextIndex(0, 'End', 0)).toBe(0)
  })
})

describe('virtualisation arithmetic', () => {
  it('renders a bounded window over 500 items', () => {
    expect(visibleRange(0, 500)).toEqual({ start: 0, end: 10 })
    expect(visibleRange(100, 500)).toEqual({ start: 98, end: 110 })
    expect(visibleRange(492, 500)).toEqual({ start: 490, end: 500 })
    expect(visibleRange(0, 3)).toEqual({ start: 0, end: 3 })
  })

  it('scrolls by the minimum needed to keep the selection visible', () => {
    expect(windowStartFor(0, 0, 500)).toBe(0)
    expect(windowStartFor(VISIBLE_ROWS - 1, 0, 500)).toBe(0)
    expect(windowStartFor(VISIBLE_ROWS, 0, 500)).toBe(1)
    expect(windowStartFor(499, 0, 500)).toBe(492)
    expect(windowStartFor(0, 492, 500)).toBe(0)
    expect(windowStartFor(3, 0, 5)).toBe(0)
  })
})

describe('highlightSegments', () => {
  it('splits a preview into hit and miss segments from ufuzzy flat ranges', () => {
    expect(highlightSegments('hello world', [0, 1, 2, 3])).toEqual([
      { text: 'h', hit: true },
      { text: 'e', hit: false },
      { text: 'l', hit: true },
      { text: 'lo world', hit: false },
    ])
  })

  it('returns one miss segment when there are no ranges', () => {
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', hit: false }])
  })

  it('ignores malformed ranges rather than throwing, because they crossed a process boundary', () => {
    expect(highlightSegments('abc', [2, 1])).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('abc', [0, 99])).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('abc', [0, 1, 5])).toEqual([
      { text: 'a', hit: true },
      { text: 'bc', hit: false },
    ])
  })
})

describe('file paths', () => {
  it('decodes a file:// uri-list into displayable paths', () => {
    expect(filePathsFromPreview('file:///Users/me/a%20b.txt\nfile:///Users/me/c.png\n')).toEqual([
      '/Users/me/a b.txt',
      '/Users/me/c.png',
    ])
  })

  it('leaves a malformed percent escape alone instead of throwing', () => {
    expect(filePathsFromPreview('file:///tmp/100%')).toEqual(['/tmp/100%'])
  })
})

describe('labels', () => {
  it('names every kind in the union', () => {
    expect(kindChipLabel('text')).toBe('Text')
    expect(kindChipLabel('richtext')).toBe('Rich text')
    expect(kindChipLabel('image')).toBe('Image')
    expect(kindChipLabel('files')).toBe('Files')
  })

  it('counts a secret down from five minutes', () => {
    expect(secretExpiryLabel(null, 1_000)).toBe(null)
    expect(secretExpiryLabel(301_000, 1_000)).toBe('expires in 5m')
    expect(secretExpiryLabel(43_000, 1_000)).toBe('expires in 42s')
    expect(secretExpiryLabel(1_000, 1_000)).toBe('expired')
  })

  it('uses the same toast strings the main process holds as constants', () => {
    expect(RECALL_TOAST_TEXT['user-preference']).toBe(TOAST_COPIED_MANUAL)
    expect(RECALL_TOAST_TEXT['no-permission']).toBe(TOAST_COPIED_MANUAL)
    expect(RECALL_TOAST_TEXT['elevated-target']).toBe(TOAST_COPIED_MANUAL)
    expect(RECALL_TOAST_TEXT['secure-input']).toBe(TOAST_COPIED_SECURE_INPUT)
  })
})
