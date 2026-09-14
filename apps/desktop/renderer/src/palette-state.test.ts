import {
  TAGS_MAX_PER_ITEM,
  TOAST_COPIED_MANUAL,
  TOAST_COPIED_SECURE_INPUT,
  createTestClock,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  FETCH_SPAN,
  MAX_TABS_PER_ITEM,
  PaletteState,
  RECALL_TOAST_TEXT,
  ROW_HEIGHT_PX,
  SEARCH_LIMIT,
  SECRET_PIN_REFUSED_TEXT,
  TOAST_MS,
  VISIBLE_ROWS,
  filePathsFromPreview,
  highlightSegments,
  kindChipLabel,
  sameTab,
  tabFilter,
  formatBytes,
  rowFallbackLabel,
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

  it('mirrors the per-item tab cap the main process enforces', () => {
    expect(MAX_TABS_PER_ITEM).toBe(TAGS_MAX_PER_ITEM)
  })

  it('narrows list and search by the active tab, and by nothing at all on All', () => {
    expect(tabFilter({ kind: 'all' })).toEqual({ pinnedOnly: false })
    expect(tabFilter({ kind: 'pinned' })).toEqual({ pinnedOnly: true })
    expect(tabFilter({ kind: 'tag', tag: 'work' })).toEqual({ pinnedOnly: false, tag: 'work' })
    expect(sameTab({ kind: 'tag', tag: 'work' }, { kind: 'tag', tag: 'home' })).toBe(false)
    expect(sameTab({ kind: 'tag', tag: 'work' }, { kind: 'tag', tag: 'work' })).toBe(true)
    expect(sameTab({ kind: 'all' }, { kind: 'pinned' })).toBe(false)
  })
})

describe('PaletteState', () => {
  it('does not repopulate a preview from a list reply that arrives after close', async () => {
    const item = makeItem(0)
    const fake = createFakeApi({ items: [item], previews: new Map([
      [item.id, { text: 'synthetic private body', isHtmlSource: false, truncated: false }],
    ]) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    fake.deferred = true
    const reloading = state.reload()
    fake.deferred = false
    await state.close()
    fake.pending.shift()!()
    await reloading
    expect(state.previewText).toBe('')
    expect(state.rows).toEqual([])
    expect(fake.previewCalls).toEqual([item.id])
    state.dispose()
  })

  it('scrubs hidden content and ignores history events until reopening', async () => {
    const item = makeItem(0, { title: 'Private login' })
    const fake = createFakeApi({ items: [item], previews: new Map([
      [item.id, { text: 'synthetic private body', isHtmlSource: false, truncated: false }],
    ]) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    await state.revealPreview()
    expect(state.previewText).toBe('synthetic private body')
    fake.emitPaletteHidden()
    expect(state.previewText).toBe('')
    expect(state.rows).toEqual([])
    const requests = fake.listCalls.length
    fake.emitHistoryChanged({ reason: 'update', total: 1 })
    await state.pending
    expect(fake.listCalls).toHaveLength(requests)
    fake.emitPaletteShown({ shownAt: 123 })
    await state.pending
    expect(state.selectedItem?.id).toBe(item.id)
    expect(state.contentHidden).toBe(true)
    expect(state.previewText).toBe('')
    state.dispose()
  })

  it('ignores an offscreen reply after returning to cached rows', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 120 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    fake.deferred = true
    state.setScrollTop(100 * ROW_HEIGHT_PX)
    const away = state.pending
    state.setScrollTop(0)
    await state.pending
    fake.deferred = false
    fake.pending.shift()!()
    await away
    expect(state.windowStart).toBe(0)
    expect(state.rowsOffset).toBe(0)
    expect(state.visibleRows.every(row => row.item !== null)).toBe(true)
    state.dispose()
  })

  it('preserves the selected clip across overlapping history refreshes', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1), makeItem(2)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.moveSelection('ArrowDown')
    await state.pending
    fake.deferred = true
    fake.items.unshift(makeItem(100))
    fake.emitHistoryChanged({ reason: 'ingest', total: 4 })
    const older = state.pending
    fake.items.unshift(makeItem(101))
    fake.emitHistoryChanged({ reason: 'ingest', total: 5 })
    const newer = state.pending
    const [resolveOlder, resolveNewer] = fake.pending.splice(0, 2)
    fake.deferred = false
    resolveNewer!()
    await newer
    resolveOlder!()
    await older
    await state.recall()
    expect(fake.copyCalls).toEqual([testItemId(1)])
    expect(state.selectedItem?.id).toBe(testItemId(1))
    state.dispose()
  })

  it('honors navigation while a history refresh is pending', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1), makeItem(2)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.moveSelection('ArrowDown')
    await state.pending
    fake.deferred = true
    fake.items.unshift(makeItem(100))
    fake.emitHistoryChanged({ reason: 'ingest', total: 4 })
    const refresh = state.pending
    state.moveSelection('Home')
    const navigation = state.pending
    fake.deferred = false
    for (const resolve of fake.pending.splice(0)) resolve()
    await Promise.all([refresh, navigation])
    expect(state.selectedItem?.id).toBe(testItemId(100))
    state.dispose()
  })

  it('keeps the selected clip when a new capture shifts the visible page', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 120 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.moveSelection('End')
    await state.pending
    fake.items.unshift(makeItem(999))
    fake.emitHistoryChanged({ reason: 'ingest', total: 121 })
    await state.pending
    expect(state.selectedItem?.id).toBe(testItemId(119))
    state.dispose()
  })

  it('applies an open tab editor to its original clip if the selection changes', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.openTagging()
    state.tagDraft = 'work'
    state.selectedIndex = 1
    await state.commitTag()
    expect(fake.tagCalls).toEqual([{ id: testItemId(0), tag: 'work', tagged: true }])
    state.dispose()
  })

  it('reloads the visible page after history changes instead of leaving scrolled rows blank', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 120 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.moveSelection('End')
    await state.pending
    fake.emitHistoryChanged({ reason: 'update', total: 120 })
    await state.pending
    expect(state.selectedItem?.id).toBe(testItemId(119))
    expect(state.visibleRows.every(row => row.item !== null)).toBe(true)
    expect(fake.listCalls.at(-1)?.offset).toBeGreaterThan(0)
    state.dispose()
  })

  it('clamps the scroll position and reloads surviving rows after the last page disappears', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 120 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.moveSelection('End')
    await state.pending
    fake.items = fake.items.slice(0, 10)
    fake.emitHistoryChanged({ reason: 'delete', total: 10 })
    await state.pending
    expect(state.windowStart).toBe(2)
    expect(state.selectedItem?.id).toBe(testItemId(9))
    expect(state.visibleRows.every(row => row.item !== null)).toBe(true)
    state.dispose()
  })

  it('refreshes active search results when an item is deleted without clearing the query', async () => {
    const item = makeItem(0, { preview: 'needle' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: 'needle body', isHtmlSource: false, truncated: false }]]),
    })
    fake.searchHitsFor = () => fake.items.map(item => ({ item, score: 1, ranges: [] }))
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    await state.setQuery('needle')
    fake.items = []
    fake.emitHistoryChanged({ reason: 'delete', total: 0 })
    await state.pending
    expect(state.query).toBe('needle')
    expect(state.total).toBe(0)
    expect(state.selectedItem).toBeNull()
    expect(state.previewText).toBe('')
    state.dispose()
  })

  it('clears old preview content as soon as a history refresh starts', async () => {
    const item = makeItem(0)
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: 'old preview content', isHtmlSource: false, truncated: false }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    fake.deferred = true
    fake.emitHistoryChanged({ reason: 'update', total: 1 })
    expect(state.previewText).toBe('')
    fake.deferred = false
    fake.pending[0]!()
    await state.pending
    state.dispose()
  })

  it('discards a slow type-filter reply after the user chooses another type', async () => {
    const fake = createFakeApi({ items: [
      makeItem(0, { kind: 'image' }), makeItem(1, { kind: 'files' }), makeItem(2),
    ] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    fake.deferred = true
    const images = state.selectKind('image')
    const files = state.selectKind('files')
    expect(state.selectedItem).toBeNull()
    expect(state.previewText).toBe('')
    fake.deferred = false
    fake.pending[1]!()
    await files
    expect(state.selectedItem?.kind).toBe('files')
    fake.pending[0]!()
    await images
    expect(state.activeKind).toBe('files')
    expect(state.selectedItem?.kind).toBe('files')
    state.dispose()
  })

  it('keeps the selected type while paging and clears a revealed preview when changing type', async () => {
    const image = makeItem(0, { kind: 'image', title: 'Private screenshot' })
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const fake = createFakeApi({
      items: [image, ...Array.from({ length: 100 }, (_, i) => makeItem(i + 1))],
      previews: new Map([[image.id, { text: '', isHtmlSource: false, truncated: false, imageDataUrl }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    await state.revealPreview()
    expect(state.previewImageUrl).toBe(imageDataUrl)
    await state.selectKind('text')
    expect(state.previewImageUrl).toBeNull()
    state.setScrollTop(60 * ROW_HEIGHT_PX)
    await state.pending
    expect(fake.listCalls.at(-1)).toMatchObject({ kind: 'text', offset: 58 })
    expect(state.visibleRows.every(row => row.item?.kind === 'text')).toBe(true)
    await state.selectKind('image')
    expect(state.contentHidden).toBe(true)
    expect(state.previewImageUrl).toBeNull()
    state.dispose()
  })

  it('loads the preview after keyboard navigation reaches an uncached page', async () => {
    const last = makeItem(499)
    const fake = createFakeApi({
      items: Array.from({ length: 500 }, (_, i) => makeItem(i)),
      previews: new Map([[last.id, { text: 'Last clip content', isHtmlSource: false, truncated: false }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.moveSelection('End')
    await state.pending
    expect(state.previewText).toBe('Last clip content')
    state.dispose()
  })

  it('loads the preview when a keyboard jump also emits a scroll event', async () => {
    const first = makeItem(0)
    const fake = createFakeApi({
      items: Array.from({ length: 120 }, (_, i) => makeItem(i)),
      previews: new Map([[first.id, { text: 'First clip content', isHtmlSource: false, truncated: false }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.moveSelection('End')
    await state.pending
    fake.deferred = true
    state.moveSelection('Home')
    const navigation = state.pending
    state.setScrollTop(0)
    const scrolling = state.pending
    fake.deferred = false
    fake.pending[0]!()
    await navigation
    fake.pending[1]?.()
    await scrolling
    expect(state.selectedItem?.id).toBe(first.id)
    expect(state.previewText).toBe('First clip content')
    state.dispose()
  })

  it('keeps the scrolled page when resizing with the selection off screen', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 500 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.setScrollTop(100 * ROW_HEIGHT_PX)
    await state.pending
    state.setViewportHeight(200)
    await state.pending
    expect(state.windowStart).toBe(100)
    state.setViewportHeight(2000)
    await state.pending
    expect(state.windowStart).toBe(100)
    expect(state.visibleRows.every((row) => row.item !== null)).toBe(true)
    state.dispose()
  })

  it('keeps the selected row fully visible when an editor reduces the list height', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 20 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.setViewportHeight(200)
    state.moveSelection('End')
    await state.pending

    expect(state.windowStart).toBe(16)
    expect(state.selectedIndex).toBe(19)
    state.setViewportHeight(352)
    expect(state.windowStart).toBe(12)
    state.dispose()
  })

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
    // `pinnedOnly: false` and no `tag`: the All tab narrows by nothing, and a search typed inside a
    // tab is narrowed to it.
    expect(fake.searchCalls).toEqual([{ q: 'wrhs', limit: SEARCH_LIMIT, pinnedOnly: false }])
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

  it('copies the selected item and expires the toast without sending a second close', async () => {
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
    expect(fake.closeCalls).toBe(0)
    expect(state.toast).toBe(null)
  })

  it('keeps a reopened palette open after the previous copy toast expires', async () => {
    const clock = createTestClock()
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = new PaletteState({ api: fake.api, clock })
    await state.start()
    await state.recall()
    clock.advance(100)

    fake.emitPaletteShown({ shownAt: clock.now() })
    await state.pending
    await state.setQuery('new search')
    clock.advance(TOAST_MS)

    expect(fake.closeCalls).toBe(0)
    expect(state.query).toBe('new search')
    expect(state.toast).toBe(null)
    state.dispose()
  })

  it('does not let an old copy timer clear a new warning after reopening', async () => {
    const clock = createTestClock()
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = new PaletteState({ api: fake.api, clock })
    await state.start()
    await state.recall()

    fake.emitPaletteShown({ shownAt: clock.now() })
    await state.pending
    fake.emitToast({ text: 'History is locked', tone: 'warn' })
    clock.advance(TOAST_MS)

    expect(state.toast).toEqual({ text: 'History is locked', tone: 'warn' })
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it('discards an old preview when a newer search has no selection', async () => {
    const item = makeItem(1)
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: 'old preview', isHtmlSource: false, truncated: false }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    fake.deferred = true
    const oldPreview = state.loadPreview()
    const resolveOld = fake.pending.shift()!
    fake.deferred = false
    await state.setQuery('no matches')
    expect(state.previewText).toBe('')

    resolveOld()
    await oldPreview

    expect(state.selectedItem).toBe(null)
    expect(state.previewText).toBe('')
    state.dispose()
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

describe('rows with no text preview', () => {
  // An image has no text preview, and thumbnails are captured but not yet served to the renderer, so
  // these rows rendered completely blank — visually identical to the evicted preview-cache bug.
  it('describes the item instead of rendering nothing', () => {
    expect(rowFallbackLabel({ kind: 'image', byteLength: 240_154 })).toBe('Image · 235 KB')
    expect(rowFallbackLabel({ kind: 'files', byteLength: 512 })).toBe('Files · 512 B')
  })

  it('formats bytes without pretending to more precision than is useful', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    // Over ten units the decimal is noise, so it goes.
    expect(formatBytes(20 * 1024)).toBe('20 KB')
    expect(formatBytes(240_154)).toBe('235 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })

  it('never returns an empty string, whatever the size', () => {
    for (const n of [0, 1, 1023, 1024, 1e6, 1e9, 1e12]) {
      expect(formatBytes(n).length).toBeGreaterThan(1)
    }
  })
})

describe('private titles', () => {
  it('acknowledges reopening only after the hidden preview has been rendered', async () => {
    let finishFrame!: () => void
    const frame = new Promise<void>((resolve) => { finishFrame = resolve })
    const item = makeItem(1, { title: 'Work login' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: 'synthetic-private-text', isHtmlSource: false, truncated: false }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock(), afterRender: () => frame })
    await state.start()
    await state.revealPreview()
    fake.emitPaletteShown({ shownAt: 123 })

    expect(state.previewText).toBe('')
    expect(state.revealedItemId).toBe(null)
    expect(fake.readyCalls).toEqual([])
    finishFrame()
    await state.pending
    expect(state.contentHidden).toBe(true)
    expect(fake.readyCalls).toEqual([{ shownAt: 123 }])
    state.dispose()
  })

  it('does not dismiss a newer title edit when an older save completes', async () => {
    const fake = createFakeApi({ items: [makeItem(1), makeItem(2)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.openTitleEditing()
    state.titleDraft = 'First title'
    fake.deferred = true
    const saving = state.commitTitle()
    const finish = fake.pending.shift()!
    state.selectedIndex = 1
    state.openTitleEditing()
    state.titleDraft = 'Second draft'
    fake.deferred = false
    finish()
    await saving

    expect(state.titleEditing).toBe(true)
    expect(state.titleDraft).toBe('Second draft')
    state.dispose()
  })

  it('does not fetch titled content until revealed and hides it again when reopened', async () => {
    const item = makeItem(1, { title: 'Work login', preview: 'synthetic-private-text' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: 'synthetic-private-text', isHtmlSource: false, truncated: false }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    expect(state.contentHidden).toBe(true)
    expect(fake.previewCalls).toEqual([])
    expect(state.previewText).toBe('')
    await state.revealPreview()
    expect(state.previewText).toBe('synthetic-private-text')
    await state.recall()
    expect(fake.copyCalls).toEqual([item.id])

    fake.emitPaletteShown({ shownAt: 123 })
    await state.pending
    expect(state.contentHidden).toBe(true)
    expect(state.previewText).toBe('')
    expect(fake.previewCalls).toEqual([item.id])
    state.dispose()
  })

  it('saves a title for the item being edited even if the selection changes', async () => {
    const fake = createFakeApi({ items: [makeItem(1), makeItem(2)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.openTitleEditing()
    state.titleDraft = 'Work login'
    state.selectedIndex = 1
    await state.commitTitle()

    expect(fake.titleCalls).toEqual([{ id: testItemId(1), title: 'Work login' }])
    expect(fake.items[0]?.title).toBe('Work login')
    expect(state.titleEditing).toBe(false)
    state.dispose()
  })

  it('allows clearing a title and keeps the editor open when saving fails', async () => {
    const fake = createFakeApi({ items: [makeItem(1, { title: 'Work login' })] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    state.openTitleEditing()
    expect(state.titleDraft).toBe('Work login')
    state.titleDraft = ''
    fake.failTitle = true
    await state.commitTitle()
    expect(state.titleEditing).toBe(true)
    expect(state.toast?.tone).toBe('warn')

    fake.failTitle = false
    await state.commitTitle()
    expect(fake.items[0]?.title).toBe(null)
    expect(state.titleEditing).toBe(false)
    state.dispose()
  })

  it('discards a pending reveal when the user hides content', async () => {
    const item = makeItem(1, { title: 'Work login' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: 'synthetic-private-text', isHtmlSource: false, truncated: false }]]),
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()
    fake.deferred = true
    const revealing = state.revealPreview()
    const resolve = fake.pending.shift()!
    state.hidePreview()
    resolve()
    await revealing
    expect(state.contentHidden).toBe(true)
    expect(state.previewText).toBe('')
    state.dispose()
  })
})
