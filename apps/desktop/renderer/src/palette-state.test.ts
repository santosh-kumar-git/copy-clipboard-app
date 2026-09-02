import { TOAST_COPIED_MANUAL, TOAST_COPIED_SECURE_INPUT, createTestClock } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  FETCH_SPAN,
  PaletteState,
  RECALL_TOAST_TEXT,
  SEARCH_LIMIT,
  SECRET_PIN_REFUSED_TEXT,
  TOAST_MS,
  VISIBLE_ROWS,
  filePathsFromPreview,
  highlightSegments,
  kindChipLabel,
  nextIndex,
  secretExpiryLabel,
  visibleRange,
  windowStartFor,
} from './palette-state.svelte'
import { createFakeApi, makeItem, testItemId } from './testing'

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

describe('PaletteState', () => {
  it('loads a bounded window and never holds more than FETCH_SPAN previews', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 500 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    expect(state.total).toBe(500)
    expect(state.loadedRowCount).toBe(FETCH_SPAN)
    expect(fake.listCalls).toEqual([{ limit: 32, offset: 0, pinnedOnly: false }])

    state.moveSelection('End')
    await state.pending

    expect(state.selectedIndex).toBe(499)
    expect(state.loadedRowCount).toBeLessThanOrEqual(FETCH_SPAN)
    expect(state.rowAt(499)?.preview).toBe('item 499')
    expect(state.rowAt(0)).toBe(null)
  })

  it('searches with the frozen limit and shows no results honestly', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    await state.setQuery('wrhs')
    expect(fake.searchCalls).toEqual([{ q: 'wrhs', limit: SEARCH_LIMIT }])
    expect(state.mode).toBe('search')
    expect(state.total).toBe(0)

    await state.setQuery('  ')
    expect(state.mode).toBe('recent')
    expect(state.total).toBe(1)
  })

  it('drops a stale search response instead of overwriting a newer one', async () => {
    const fake = createFakeApi({
      items: [makeItem(1)],
      searchHitsFor: (q) => [
        { item: makeItem(7, { preview: q === 'ab' ? 'NEW' : 'OLD' }), score: 1, ranges: [] },
      ],
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    fake.deferred = true
    const first = state.setQuery('a')
    const second = state.setQuery('ab')
    expect(fake.pending.length).toBe(2)

    // Land them out of order: the OLDER request resolves last and must be ignored.
    const [resolveOld, resolveNew] = fake.pending.splice(0, 2)
    resolveNew?.()
    resolveOld?.()
    fake.deferred = false
    await Promise.all([first, second])

    expect(state.query).toBe('ab')
    expect(state.total).toBe(1)
    expect(state.rowAt(0)?.preview).toBe('NEW')
  })

  it('copies the selected item, toasts the honest M1 sentence, and closes after two seconds', async () => {
    const clock = createTestClock()
    const fake = createFakeApi({ items: [makeItem(1), makeItem(2)] })
    const state = new PaletteState({ api: fake.api, clock })
    await state.start()
    state.moveSelection('ArrowDown')

    await state.recall()

    expect(fake.copyCalls).toEqual([testItemId(2)])
    expect(state.toast).toEqual({ text: TOAST_COPIED_MANUAL, tone: 'info' })
    expect(fake.closeCalls).toBe(0)

    clock.advance(TOAST_MS - 1)
    expect(fake.closeCalls).toBe(0)
    clock.advance(1)
    expect(fake.closeCalls).toBe(1)
    expect(state.toast).toBe(null)
  })

  it('warns instead of lying when the copy IPC is rejected', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    fake.failCopy = true
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    await state.recall()

    expect(state.toast?.tone).toBe('warn')
    expect(state.toast?.text).toBe('Cairn could not put that on the clipboard')
    expect(fake.closeCalls).toBe(0)
  })

  it('refuses to pin a secret without even calling the IPC', async () => {
    const secret = makeItem(1, { preview: 'AKIA••••A7QD', flags: ['secret'], expiresAt: 301_000 })
    const fake = createFakeApi({ items: [secret] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    await state.togglePin()

    expect(fake.pinCalls).toEqual([])
    expect(state.toast).toEqual({ text: SECRET_PIN_REFUSED_TEXT, tone: 'warn' })
  })

  it('ignores a malformed event payload instead of trusting it', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    fake.emitHotkeyStatus({ status: 'exploded', accelerator: 'Cmd+Shift+V' })
    fake.emitToast({ text: 'x'.repeat(201), tone: 'info' })
    fake.emitToast('not an object')
    fake.emitPaletteShown({ shownAt: 'yesterday' })

    expect(state.hotkeyStatus).toBe('active')
    expect(state.toast).toBe(null)
    expect(state.shownAt).toBe(0)

    fake.emitHotkeyStatus({ status: 'failed', accelerator: 'Cmd+Shift+V' })
    expect(state.hotkeyStatus).toBe('failed')
  })
})
