import { TOAST_COPIED_MANUAL, createTestClock } from '@cairn/protocol'
import { flushSync, mount, unmount, type ComponentProps } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ItemRow from './ItemRow.svelte'
import Palette from './Palette.svelte'
import {
  PaletteState,
  ROW_HEIGHT_PX,
  SHORTCUT_HINTS,
  TOAST_MS,
  VISIBLE_ROWS,
} from './palette-state.svelte'
import { createFakeApi, makeItem, testItemId, type FakeApi } from './testing'

let host: HTMLDivElement
let app: Record<string, unknown> | null = null

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) { this.open = true },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) { this.open = false },
  })
  hitTarget(null)
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (app !== null) void unmount(app)
  app = null
  host.remove()
})

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const input = host.querySelector<HTMLInputElement>('[data-testid="search"]')
  if (input === null) throw new Error('the search field is missing')
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  input.dispatchEvent(event)
  flushSync()
  return event
}

function pressFocused(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  document.activeElement!.dispatchEvent(event)
  flushSync()
  return event
}

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')]
}

async function render(fake: FakeApi, clock = createTestClock()): Promise<PaletteState> {
  const state = new PaletteState({ api: fake.api, clock })
  await state.start()
  app = mount(Palette, { target: host, props: { palette: state } }) as Record<string, unknown>
  flushSync()
  return state
}

function pointer(element: EventTarget, type: string, x: number, y: number, pointerId = 1, buttons = type === 'pointerup' ? 0 : 1): Event {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true })
  Object.defineProperties(event, { pointerId: { value: pointerId }, isPrimary: { value: true } })
  element.dispatchEvent(event)
  flushSync()
  return event
}

function hitTarget(element: Element | null): void {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => element })
}

describe('mouse gestures and tab deletion confirmation', () => {
  it('assigns a clip using mouse movement and release without a native drag payload', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)], tabs: ['work'] })
    const state = await render(fake)
    const source = rows()[1]!
    const target = host.querySelector('[aria-label="Delete tab work"]')!
    pointer(source, 'pointerdown', 30, 200)
    hitTarget(target.querySelector('path'))
    pointer(window, 'pointermove', 180, 140)
    expect(target.closest('.tab-entry')?.classList.contains('tab-drop-target')).toBe(true)
    pointer(window, 'pointerup', 180, 140)
    source.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await state.pending
    flushSync()
    expect(fake.items[1]?.tags).toEqual(['work'])
    expect(state.tabs).toEqual([{ tag: 'work', count: 1 }])
    expect(fake.copyCalls).toEqual([])
    expect(fake.removeTabCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    expect(state.activeTab).toEqual({ kind: 'all' })
    state.dispose()
  })

  it('asks before removing a tab and lets Cancel keep its clips assigned', async () => {
    const fake = createFakeApi({ items: [makeItem(0, { tags: ['work'] })] })
    const state = await render(fake)
    host.querySelector<HTMLButtonElement>('[aria-label="Delete tab work"]')!.click()
    flushSync()
    const dialog = host.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(fake.removeTabCalls).toEqual([])
    expect(dialog?.textContent).toContain('clips')
    const cancel = dialog!.querySelector<HTMLButtonElement>('[data-testid="cancel-tab-delete"]')!
    expect(document.activeElement).toBe(cancel)
    cancel.click()
    flushSync()
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(fake.items[0]?.tags).toEqual(['work'])
    expect(fake.removeTabCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it('cancels the confirmation on Escape or reopening without closing or deleting', async () => {
    const fake = createFakeApi({ items: [makeItem(0, { tags: ['work'] })] })
    const state = await render(fake)
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Delete tab work"]')!
    remove.click()
    flushSync()
    pressFocused('Escape')
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.search'))
    remove.click()
    flushSync()
    fake.emitPaletteShown({ shownAt: 12345 })
    await state.pending
    flushSync()
    expect(host.querySelector('[role="alertdialog"]')).toBeNull()
    expect(fake.removeTabCalls).toEqual([])
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it('keeps the tab and assignments if a confirmed deletion fails', async () => {
    const fake = createFakeApi({ items: [makeItem(0, { tags: ['work'] })] })
    fake.failTabManagement = true
    const state = await render(fake)
    host.querySelector<HTMLButtonElement>('[aria-label="Delete tab work"]')!.click()
    flushSync()
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-tab-delete"]')!.click()
    await state.pending
    flushSync()
    expect(host.querySelector('[aria-label="Delete tab work"]')).not.toBeNull()
    expect(fake.items[0]?.tags).toEqual(['work'])
    expect(state.toast?.text).toContain('Could not delete')
    expect(fake.removeCalls).toEqual([])
    state.dispose()
  })
})

describe('dragging clips into tabs', () => {
  it('tags the dragged clip without copying, closing, or changing the current tab', async () => {
    const first = makeItem(0, { tags: ['work'] })
    const second = makeItem(1, { title: 'Private login', preview: 'synthetic private content' })
    const fake = createFakeApi({ items: [first, second] })
    const state = await render(fake)
    const source = rows()[1]!
    const target = [...host.querySelectorAll('.tab')].find(tab => tab.textContent?.startsWith('work'))!
    pointer(source.querySelector('.drag-handle')!, 'pointerdown', 30, 220)
    hitTarget(target)
    pointer(window, 'pointermove', 160, 140)
    expect(target.closest('.tab-entry')?.classList.contains('tab-drop-target')).toBe(true)
    expect(host.querySelector('.drag-status')?.textContent).toContain('Release to add to work')
    expect(host.querySelector('.drag-status')?.textContent).not.toContain('synthetic private content')
    pointer(window, 'pointerup', 160, 140)
    await state.pending
    flushSync()
    expect(fake.tagCalls).toEqual([{ id: second.id, tag: 'work', tagged: true }])
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    expect(state.activeTab).toEqual({ kind: 'all' })
    expect(host.querySelector('.tab-drop-target')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.search'))
  })

  it('pins an unselected dragged clip and never toggles an already pinned clip off', async () => {
    const item = makeItem(1, { pinned: true })
    const fake = createFakeApi({ items: [makeItem(0), item] })
    const state = await render(fake)
    const target = [...host.querySelectorAll('.tab')].find(tab => tab.textContent?.startsWith('Pinned'))!
    pointer(rows()[1]!, 'pointerdown', 30, 220)
    hitTarget(target)
    pointer(window, 'pointermove', 110, 140)
    pointer(window, 'pointerup', 110, 140)
    await state.pending
    expect(fake.pinCalls).toEqual([{ id: item.id, pinned: true }])
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
  })

  it('rejects secret pinning and ignores external or cancelled drags', async () => {
    const fake = createFakeApi({ items: [makeItem(0, { flags: ['secret'] })] })
    const state = await render(fake)
    const target = [...host.querySelectorAll('.tab')].find(tab => tab.textContent?.startsWith('Pinned'))!
    hitTarget(target)
    pointer(window, 'pointermove', 110, 140)
    pointer(window, 'pointerup', 110, 140)
    expect(fake.pinCalls).toEqual([])
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    pointer(window, 'pointermove', 110, 140)
    pointer(window, 'pointerup', 110, 140)
    await state.pending
    expect(fake.pinCalls).toEqual([])
    expect(state.toast?.text).toContain('Secret')
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    pointer(window, 'pointermove', 110, 140)
    pointer(window, 'pointercancel', 110, 140)
    pointer(window, 'pointerup', 110, 140)
    expect(host.querySelector('.tab-drop-target')).toBeNull()
    expect(fake.pinCalls).toEqual([])
  })

  it('does not treat All as a drop target', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    await render(fake)
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    const target = host.querySelector('.tab')!
    hitTarget(target)
    pointer(window, 'pointermove', 30, 140)
    expect(host.querySelector('.tab-drop-target')).toBeNull()
    pointer(window, 'pointerup', 30, 140)
    expect(fake.tagCalls).toEqual([])
    expect(fake.pinCalls).toEqual([])
    expect(fake.copyCalls).toEqual([])
  })

  it.each(['Escape', 'pointercancel', 'blur', 'lostpointercapture'])('cancels with %s without copying or tagging', async (reason) => {
    const fake = createFakeApi({ items: [makeItem(0)], tabs: ['work'] })
    const state = await render(fake)
    const source = rows()[0]!
    pointer(source, 'pointerdown', 30, 220)
    hitTarget(host.querySelector('[aria-label="Delete tab work"]'))
    pointer(window, 'pointermove', 160, 140)
    if (reason === 'Escape') press('Escape')
    else if (reason === 'blur') window.dispatchEvent(new Event('blur'))
    else pointer(reason === 'lostpointercapture' ? host.querySelector('.palette')! : window, reason, 160, 140)
    flushSync()
    pointer(window, 'pointerup', 160, 140)
    source.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
    await state.pending
    expect(fake.items[0]?.tags).toEqual([])
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    expect(host.querySelector('.tab-drop-target')).toBeNull()
    expect(host.querySelector('.drag-status')).toBeNull()
    state.dispose()
  })

  it('keeps normal row clicks working below the movement threshold', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    const state = await render(fake)
    const source = rows()[0]!
    pointer(source, 'pointerdown', 30, 220)
    pointer(window, 'pointermove', 33, 222)
    pointer(window, 'pointerup', 33, 222)
    source.click()
    await state.pending
    expect(fake.copyCalls).toEqual([testItemId(0)])
    expect(fake.tagCalls).toEqual([])
    state.dispose()
  })

  it('cancels a stale drag when the mouse is no longer held', async () => {
    const fake = createFakeApi({ items: [makeItem(0)], tabs: ['work'] })
    const state = await render(fake)
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    hitTarget(host.querySelector('[aria-label="Delete tab work"]'))
    pointer(window, 'pointermove', 160, 140)
    pointer(window, 'pointermove', 160, 140, 1, 0)
    expect(host.querySelector('.drag-status')).toBeNull()
    pointer(window, 'pointerup', 160, 140)
    expect(fake.tagCalls).toEqual([])
    state.dispose()
  })

  it('clears an unfinished gesture when a new press starts elsewhere', async () => {
    const fake = createFakeApi({ items: [makeItem(0)], tabs: ['work'] })
    const state = await render(fake)
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    pointer(host.querySelector('.search')!, 'pointerdown', 30, 80)
    hitTarget(host.querySelector('[aria-label="Delete tab work"]'))
    pointer(window, 'pointermove', 160, 140)
    pointer(window, 'pointerup', 160, 140)
    expect(fake.tagCalls).toEqual([])
    state.dispose()
  })

  it('does not swallow a keyboard button activation after cancelling a drag', async () => {
    const fake = createFakeApi({ items: [makeItem(0)], tabs: ['work'] })
    const state = await render(fake)
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Delete tab work"]')!
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    hitTarget(remove)
    pointer(window, 'pointermove', 160, 140)
    press('Escape')
    remove.focus()
    remove.click()
    flushSync()
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(fake.tagCalls).toEqual([])
    expect(fake.removeTabCalls).toEqual([])
    state.dispose()
  })

  it('drops into the tab under the release point and cancels releases outside tabs', async () => {
    const fake = createFakeApi({ items: [makeItem(0)], tabs: ['work', 'home'] })
    const state = await render(fake)
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    hitTarget(host.querySelector('[aria-label="Delete tab work"]'))
    pointer(window, 'pointermove', 160, 140)
    hitTarget(host.querySelector('[aria-label="Delete tab home"]'))
    pointer(window, 'pointerup', 240, 140)
    await state.pending
    expect(fake.items[0]?.tags).toEqual(['home'])
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    hitTarget(host.querySelector('[aria-label="Delete tab work"]'))
    pointer(window, 'pointermove', 160, 140)
    hitTarget(null)
    pointer(window, 'pointerup', -10, -10)
    expect(fake.tagCalls).toEqual([{ id: testItemId(0), tag: 'home', tagged: true }])
    state.dispose()
  })

  it('does not start dragging from row action buttons', async () => {
    const fake = createFakeApi({ items: [makeItem(0)], tabs: ['work'] })
    const state = await render(fake)
    pointer(rows()[0]!.querySelector('.row-view')!, 'pointerdown', 30, 220)
    hitTarget(host.querySelector('[aria-label="Delete tab work"]'))
    pointer(window, 'pointermove', 160, 140)
    pointer(window, 'pointerup', 160, 140)
    expect(fake.tagCalls).toEqual([])
    expect(host.querySelector('.drag-status')).toBeNull()
    state.dispose()
  })

  it('keeps the dragged clip identity when a scrolled list changes during the gesture', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 120 }, (_, i) => makeItem(i)), tabs: ['work'] })
    const state = await render(fake)
    state.setScrollTop(60 * ROW_HEIGHT_PX)
    await state.pending
    flushSync()
    const source = rows()[2]!
    const id = source.id.replace('cairn-row-', '')
    pointer(source, 'pointerdown', 30, 220)
    hitTarget(host.querySelector('[aria-label="Delete tab work"]'))
    pointer(window, 'pointermove', 160, 140)
    state.setScrollTop(70 * ROW_HEIGHT_PX)
    await state.pending
    flushSync()
    pointer(window, 'pointerup', 160, 140)
    await state.pending
    expect(fake.tagCalls).toEqual([{ id, tag: 'work', tagged: true }])
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })
})

describe('the palette shell', () => {
  it('focuses the search field on mount and again on every palette.shown', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = await render(fake)
    const input = host.querySelector<HTMLInputElement>('[data-testid="search"]')!

    expect(document.activeElement).toBe(input)

    state.query = 'stale query'
    flushSync()
    input.blur()
    expect(document.activeElement).not.toBe(input)

    fake.emitPaletteShown({ shownAt: 1_767_225_600_123 })
    flushSync()

    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')
    expect(state.shownAt).toBe(1_767_225_600_123)
  })

  it('closes on Escape without sending a second close for a native blur', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    await render(fake)

    press('Escape')
    expect(fake.closeCalls).toBe(1)

    window.dispatchEvent(new Event('blur'))
    flushSync()
    expect(fake.closeCalls).toBe(1)
  })

  it('shows the persistent hotkey row only when registration failed', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    await render(fake)

    expect(host.querySelector('[data-testid="hotkey-status"]')).toBe(null)

    fake.emitHotkeyStatus({ status: 'failed', accelerator: 'Cmd+Shift+V' })
    flushSync()

    const row = host.querySelector('[data-testid="hotkey-status"]')
    expect(row?.textContent?.trim()).toBe(
      'Cmd+Shift+V is not registered — another app already owns it. Try Cmd+Shift+C instead; rebinding lives in Settings, which this build does not have yet.',
    )
    expect(row?.getAttribute('role')).toBe('status')
  })

  it('says nothing is copied yet, and says no matches for a query that misses', async () => {
    const fake = createFakeApi({ items: [] })
    const state = await render(fake)

    expect(host.querySelector('[data-testid="empty"]')?.textContent?.trim()).toBe('Nothing copied yet')

    await state.setQuery('zzz')
    flushSync()

    expect(host.querySelector('[data-testid="empty"]')?.textContent?.trim()).toBe('No matches')
  })
})

describe('content type filters', () => {
  async function chooseType(value: string, state: PaletteState): Promise<void> {
    const picker = host.querySelector<HTMLSelectElement>('[aria-label="Filter by type"]')
    expect(picker).not.toBeNull()
    picker!.focus()
    picker!.value = value
    picker!.dispatchEvent(new Event('change', { bubbles: true }))
    await state.pending
    flushSync()
  }

  it('filters the whole history by type and restores all types without copying', async () => {
    const fake = createFakeApi({ items: [
      ...Array.from({ length: 60 }, (_, i) => makeItem(i)),
      makeItem(60, { kind: 'image', title: 'Holiday photo' }),
      makeItem(61, { kind: 'richtext' }),
      makeItem(62, { kind: 'files' }),
    ] })
    const state = await render(fake)
    await chooseType('image', state)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.textContent).toContain('Holiday photo')
    expect(state.total).toBe(1)
    expect(fake.listCalls.at(-1)).toEqual({ limit: 32, offset: 0, pinnedOnly: false, kind: 'image' })
    expect(host.querySelector('[data-testid="hidden-content"]')).not.toBeNull()
    await chooseType('richtext', state)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.querySelector('.chip')?.textContent).toBe('Rich text')
    await chooseType('files', state)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.querySelector('.chip')?.textContent).toBe('Files')
    await chooseType('all', state)
    expect(state.total).toBe(63)
    expect(fake.listCalls.at(-1)?.kind).toBeUndefined()
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it.each(['bottom', 'right'])('hands focus back after filtering so arrows preview images in the %s layout', async (layout) => {
    const images = [1, 2, 3].map(n => makeItem(n, { kind: 'image', preview: '' }))
    const sources = ['iVBORw0KGgoAAQ==', 'iVBORw0KGgoAAg==', 'iVBORw0KGgoAAw=='].map(s => `data:image/png;base64,${s}`)
    const fake = createFakeApi({
      items: [makeItem(0), ...images],
      previews: new Map(images.map((item, i) => [item.id, { text: '', imageDataUrl: sources[i]!, isHtmlSource: false, truncated: false }])),
    })
    const state = await render(fake)
    if (layout === 'right') host.querySelector<HTMLButtonElement>('[aria-label="Preview on right"]')!.click()
    await chooseType('image', state)
    expect(document.activeElement).toBe(host.querySelector('[data-testid="search"]'))
    for (const [key, index] of [['ArrowDown', 1], ['ArrowDown', 2], ['ArrowUp', 1], ['Home', 0], ['End', 2]] as const) {
      pressFocused(key)
      await state.pending
      flushSync()
      expect(state.activeKind).toBe('image')
      expect(state.selectedItem?.id).toBe(images[index]!.id)
      expect(host.querySelector('.preview-image')?.getAttribute('src')).toBe(sources[index])
    }
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    pressFocused('Enter')
    await state.pending
    expect(fake.copyCalls).toEqual([images[2]!.id])
    state.dispose()
  })

  it('returns focus immediately and does not steal it back when filtering finishes later', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1, { kind: 'image' })] })
    const state = await render(fake)
    const picker = host.querySelector<HTMLSelectElement>('[aria-label="Filter by type"]')!
    fake.deferred = true
    picker.focus()
    picker.value = 'image'
    picker.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.activeElement).toBe(host.querySelector('[data-testid="search"]'))
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Preview on right"]')!
    button.focus()
    fake.deferred = false
    fake.pending[0]!()
    await state.pending
    flushSync()
    expect(document.activeElement).toBe(button)
    state.dispose()
  })

  it('combines type with tabs and search, then resets it when reopened', async () => {
    const items = [
      makeItem(0, { kind: 'image', title: 'Invoice scan', pinned: true, tags: ['work'] }),
      makeItem(1, { kind: 'text', preview: 'Invoice notes', pinned: true, tags: ['work'] }),
      makeItem(2, { kind: 'image', title: 'Invoice personal' }),
    ]
    const fake = createFakeApi({ items, searchHitsFor: () => items.map(item => ({ item, score: 1, ranges: [] })) })
    const state = await render(fake)
    await state.selectTab({ kind: 'tag', tag: 'work' })
    await state.setQuery('Invoice')
    await chooseType('image', state)
    expect(state.query).toBe('Invoice')
    expect(rows()).toHaveLength(1)
    expect(fake.searchCalls.at(-1)).toEqual({ q: 'Invoice', limit: 50, pinnedOnly: false, tag: 'work', kind: 'image' })
    await state.selectTab({ kind: 'pinned' })
    flushSync()
    expect(fake.searchCalls.at(-1)).toEqual({ q: 'Invoice', limit: 50, pinnedOnly: true, kind: 'image' })
    expect(rows()).toHaveLength(1)
    fake.emitPaletteShown({ shownAt: 5678 })
    await state.pending
    flushSync()
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Filter by type"]')?.value).toBe('all')
    expect(state.total).toBe(3)
    state.dispose()
  })

  it('explains an empty type filter and lets the picker own its keyboard events', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)
    const picker = host.querySelector<HTMLSelectElement>('[aria-label="Filter by type"]')
    expect(picker).not.toBeNull()
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']) {
      picker!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    expect(state.selectedIndex).toBe(0)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    await chooseType('image', state)
    expect(host.querySelector('[data-testid="empty"]')?.textContent).toBe('No images here — try All types or another tab.')
    picker!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await state.pending
    expect(fake.closeCalls).toBe(1)
    state.dispose()
  })
})

describe('the virtualised result list', () => {
  it('returns keyboard navigation from a row action to the list before Enter copies', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)
    host.querySelector<HTMLButtonElement>('.row-view')!.focus()
    pressFocused('ArrowDown')
    await state.pending
    expect(document.activeElement).toBe(host.querySelector('[data-testid="search"]'))
    pressFocused('Enter')
    await state.pending
    expect(fake.copyCalls).toEqual([testItemId(1)])
    state.dispose()
  })

  it('renders a bounded window of rows for 500 items, not 500 rows', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 500 }, (_, i) => makeItem(i)) })
    const state = await render(fake)

    expect(state.total).toBe(500)
    expect(rows().length).toBe(VISIBLE_ROWS + 2)
    expect(host.querySelector<HTMLElement>('[data-testid="spacer"]')?.style.height).toBe('22000px')
    expect(rows()[0]?.style.top).toBe('0px')
    expect(rows()[1]?.style.top).toBe(`${ROW_HEIGHT_PX}px`)

    press('End')
    await state.pending
    flushSync()

    expect(state.selectedIndex).toBe(499)
    expect(rows().length).toBeLessThanOrEqual(VISIBLE_ROWS + 4)
    expect(rows().at(-1)?.getAttribute('aria-selected')).toBe('true')
  })

  it('follows a mouse scroll by re-windowing, not by rendering more rows', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 500 }, (_, i) => makeItem(i)) })
    const state = await render(fake)
    const list = host.querySelector<HTMLDivElement>('#cairn-results')!

    list.scrollTop = 100 * ROW_HEIGHT_PX
    list.dispatchEvent(new Event('scroll'))
    await state.pending
    flushSync()

    expect(state.windowStart).toBe(100)
    expect(rows().length).toBeLessThanOrEqual(VISIBLE_ROWS + 4)
    expect(rows()[0]?.style.top).toBe(`${98 * ROW_HEIGHT_PX}px`)
    expect(fake.listCalls.length).toBe(2)
    expect(fake.listCalls[1]).toEqual({ limit: 32, offset: 98, pinnedOnly: false })
  })

  it('moves the selection with the arrow keys and reports it as aria-activedescendant', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1), makeItem(2)] })
    await render(fake)
    const input = host.querySelector<HTMLInputElement>('[data-testid="search"]')!

    expect(input.getAttribute('aria-activedescendant')).toBe(`cairn-row-${testItemId(0)}`)
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')

    press('ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(`cairn-row-${testItemId(1)}`)
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('false')

    press('ArrowUp')
    press('ArrowUp')
    expect(input.getAttribute('aria-activedescendant')).toBe(`cairn-row-${testItemId(2)}`)
  })

  it('draws a kind chip, a masked secret badge, a thumbnail and match highlights', async () => {
    const thumb = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    const fake = createFakeApi({
      items: [
        makeItem(0, { kind: 'image', preview: 'Screenshot', thumbnailDataUrl: thumb }),
        makeItem(1, {
          kind: 'text',
          preview: 'AKIA••••A7QD',
          flags: ['secret'],
          expiresAt: 1_767_225_600_000 + 300_000,
        }),
        makeItem(2, { kind: 'files', preview: 'file:///Users/me/a.txt' }),
      ],
      searchHitsFor: () => [
        { item: makeItem(0, { preview: 'Screenshot' }), score: 1, ranges: [0, 6] },
      ],
    })
    const state = await render(fake)

    expect([...host.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual([
      'Image',
      'Text',
      'Files',
    ])
    expect(host.querySelector<HTMLImageElement>('.thumb')?.getAttribute('src')).toBe(thumb)
    expect(host.querySelector('.badge-secret')?.textContent?.trim()).toBe('Secret · expires in 5m')
    expect(rows()[1]?.textContent).toContain('AKIA••••A7QD')

    await state.setQuery('Screen')
    flushSync()

    expect(host.querySelector('mark')?.textContent).toBe('Screen')
  })

  it('refuses a thumbnail that is not a JPEG data URL', async () => {
    const fake = createFakeApi({
      items: [makeItem(0, { thumbnailDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })],
    })
    await render(fake)

    expect(host.querySelector('.thumb')).toBe(null)
  })
})

describe('recall', () => {
  it('puts the item on the clipboard and clears its toast without closing again', async () => {
    const clock = createTestClock()
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    await render(fake, clock)

    press('ArrowDown')
    press('Enter')
    await Promise.resolve()
    await Promise.resolve()
    flushSync()

    expect(fake.copyCalls).toEqual([testItemId(1)])
    expect(host.querySelector('[data-testid="toast"]')?.textContent).toBe(TOAST_COPIED_MANUAL)
    expect(host.querySelector('[data-testid="toast"]')?.getAttribute('role')).toBe('status')
    expect(fake.closeCalls).toBe(0)

    clock.advance(TOAST_MS)
    flushSync()

    expect(fake.closeCalls).toBe(0)
    expect(host.querySelector('[data-testid="toast"]')).toBe(null)
  })

  it('keeps the search usable when a row is copied and the palette is immediately reopened', async () => {
    const clock = createTestClock()
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake, clock)
    rows()[1]!.click()
    await state.pending
    expect(fake.copyCalls).toEqual([testItemId(1)])

    fake.emitPaletteShown({ shownAt: clock.now() })
    await state.pending
    flushSync()
    clock.advance(TOAST_MS + 100)
    flushSync()

    expect(fake.closeCalls).toBe(0)
    expect(document.activeElement).toBe(host.querySelector('[data-testid="search"]'))
    expect(rows()).toHaveLength(2)
    state.dispose()
  })
})

describe('pin and delete', () => {
  it('pins with Cmd+P, removes with Cmd+Backspace, and leaves Cmd+A to the text field', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)

    press('p', { metaKey: true })
    await state.pending
    expect(fake.pinCalls).toEqual([{ id: testItemId(0), pinned: true }])

    press('Backspace', { metaKey: true })
    await state.pending
    expect(fake.removeCalls).toEqual([testItemId(0)])

    // Cmd+A / Cmd+C / Cmd+V belong to the search field and the app's Edit menu, not to us.
    expect(press('a', { metaKey: true }).defaultPrevented).toBe(false)
    expect(press('c', { metaKey: true }).defaultPrevented).toBe(false)
    expect(press('v', { metaKey: true }).defaultPrevented).toBe(false)
    expect(fake.pinCalls.length).toBe(1)
  })
})

describe('the preview pane', () => {
  it('switches between bottom and right previews without copying, and keeps the layout on reopening', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)
    const right = host.querySelector<HTMLButtonElement>('[aria-label="Preview on right"]')
    expect(right).not.toBeNull()
    right!.click()
    flushSync()
    const divider = host.querySelector<HTMLElement>('[role="separator"]')!
    expect(host.querySelector('.content-panes.side-by-side')).not.toBeNull()
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(right!.getAttribute('aria-pressed')).toBe('true')
    const initial = Number(divider.getAttribute('aria-valuenow'))
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    flushSync()
    const changed = Number(divider.getAttribute('aria-valuenow'))
    expect(changed).toBeLessThan(initial)
    expect(state.selectedIndex).toBe(0)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    fake.emitPaletteShown({ shownAt: 9876 })
    await state.pending
    flushSync()
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(changed)
    host.querySelector<HTMLButtonElement>('[aria-label="Preview below list"]')!.click()
    flushSync()
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal')
    expect(host.querySelector('.content-panes.side-by-side')).toBeNull()
    right!.click()
    flushSync()
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(changed)
    state.dispose()
  })

  it('resizes a right-side preview horizontally and resets its divider on double-click', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    const state = await render(fake)
    host.querySelector<HTMLButtonElement>('[aria-label="Preview on right"]')!.click()
    flushSync()
    const container = host.querySelector<HTMLElement>('.content-panes')!
    const divider = host.querySelector<HTMLElement>('[role="separator"]')!
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 100, 720, 400))
    vi.spyOn(divider, 'getBoundingClientRect').mockReturnValue(new DOMRect(435, 100, 12, 400))
    divider.setPointerCapture = vi.fn()
    divider.hasPointerCapture = () => true
    divider.releasePointerCapture = vi.fn()
    const pointer = (type: string, x: number, y = 200) => {
      const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      divider.dispatchEvent(event)
      flushSync()
    }
    pointer('pointerdown', 441)
    pointer('pointermove', 541)
    expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThan(60)
    const moved = divider.getAttribute('aria-valuenow')
    pointer('pointermove', 541, 300)
    expect(divider.getAttribute('aria-valuenow')).toBe(moved)
    pointer('pointerup', 541)
    pointer('pointermove', 441)
    expect(divider.getAttribute('aria-valuenow')).toBe(moved)
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    flushSync()
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(60)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it('reveals an image without copying and removes it from the DOM on reopening', async () => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO8sAAAAASUVORK5CYII='
    const item = makeItem(0, { kind: 'image', title: 'Private screenshot', preview: '' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: '', isHtmlSource: false, truncated: false, imageDataUrl }]]),
    })
    const state = await render(fake)
    expect(host.querySelector('.preview-image')).toBeNull()
    host.querySelector<HTMLButtonElement>('.row-view')!.click()
    await state.pending
    flushSync()
    expect(host.querySelector('.preview-image')?.getAttribute('src')).toBe(imageDataUrl)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    fake.emitPaletteShown({ shownAt: 1234 })
    await state.pending
    flushSync()
    expect(host.querySelector('.preview-image')).toBeNull()
    expect(host.innerHTML).not.toContain(imageDataUrl)
    state.dispose()
  })

  it.each(['https://example.com/tracker.png', 'data:image/svg+xml;base64,PHN2Zy8+'])(
    'never loads an unsafe image preview: %s', async (imageDataUrl) => {
      const item = makeItem(0, { kind: 'image', preview: '' })
      const fake = createFakeApi({
        items: [item],
        previews: new Map([[item.id, { text: '', isHtmlSource: false, truncated: false, imageDataUrl }]]),
      })
      const state = await render(fake)
      expect(host.querySelector('.preview-image')).toBeNull()
      expect(host.textContent).toContain('Image preview unavailable.')
      state.dispose()
    },
  )

  it('views a scrolled clip without copying, closing, or moving the list', async () => {
    const item = makeItem(105)
    const fake = createFakeApi({
      items: Array.from({ length: 500 }, (_, i) => makeItem(i)),
      previews: new Map([[item.id, { text: 'Complete content\nSecond line', isHtmlSource: false, truncated: false }]]),
    })
    const state = await render(fake)
    state.setScrollTop(100 * ROW_HEIGHT_PX)
    await state.pending
    flushSync()
    const view = host.querySelector<HTMLButtonElement>(`#cairn-row-${item.id} .row-view`)
    expect(view).not.toBeNull()
    view!.click()
    await state.pending
    flushSync()

    expect(state.selectedItem?.id).toBe(item.id)
    expect(state.windowStart).toBe(100)
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe('Complete content\nSecond line')
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it('reveals a titled clip only on an explicit view click and hides it on reopening', async () => {
    const item = makeItem(0, { title: 'Work login', preview: '' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([[item.id, { text: 'private-test-value', isHtmlSource: false, truncated: false }]]),
    })
    const state = await render(fake)
    expect(host.textContent).not.toContain('private-test-value')
    const view = host.querySelector<HTMLButtonElement>('.row-view')
    expect(view).not.toBeNull()
    view!.click()
    await state.pending
    flushSync()
    expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe('private-test-value')
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)

    fake.emitPaletteShown({ shownAt: 1234 })
    await state.pending
    flushSync()
    expect(host.textContent).not.toContain('private-test-value')
    expect(host.querySelector('[data-testid="hidden-content"]')).not.toBeNull()
    state.dispose()
  })

  it('resizes the preview using a keyboard divider without moving or copying the selected clip', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)
    const divider = host.querySelector<HTMLElement>('[role="separator"]')
    expect(divider).not.toBeNull()
    const start = Number(divider!.getAttribute('aria-valuenow'))
    const key = (value: string) => {
      divider!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
      flushSync()
    }
    key('ArrowUp')
    expect(Number(divider!.getAttribute('aria-valuenow'))).toBeLessThan(start)
    key('Home')
    expect(divider!.getAttribute('aria-valuenow')).toBe(divider!.getAttribute('aria-valuemin'))
    key('End')
    expect(divider!.getAttribute('aria-valuenow')).toBe(divider!.getAttribute('aria-valuemax'))
    key('Enter')
    expect(state.selectedIndex).toBe(0)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it('drags the divider within pane limits and stops resizing after releasing it', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    const state = await render(fake)
    const container = host.querySelector<HTMLElement>('.content-panes')!
    const divider = host.querySelector<HTMLElement>('[role="separator"]')!
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 400))
    vi.spyOn(divider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 380, 600, 12))
    divider.setPointerCapture = vi.fn()
    divider.hasPointerCapture = () => true
    divider.releasePointerCapture = vi.fn()
    const pointer = (type: string, y: number) => {
      const event = new MouseEvent(type, { clientY: y, button: 0, bubbles: true, cancelable: true })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      divider.dispatchEvent(event)
      flushSync()
    }
    pointer('pointerdown', 384)
    pointer('pointermove', 284)
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(46)
    pointer('pointermove', -100)
    expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemin'))
    pointer('pointermove', 1000)
    expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemax'))
    pointer('pointerup', 1000)
    pointer('pointermove', 284)
    expect(divider.getAttribute('aria-valuenow')).toBe(divider.getAttribute('aria-valuemax'))
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    state.dispose()
  })

  it('lists copied files one per line for a files item', async () => {
    const item = makeItem(0, { kind: 'files', preview: 'file:///Users/me/a%20b.txt' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([
        [
          item.id,
          {
            text: 'file:///Users/me/a%20b.txt\nfile:///Users/me/c.png',
            isHtmlSource: false,
            truncated: false,
          },
        ],
      ]),
    })
    await render(fake)

    const list = host.querySelector('[data-testid="file-list"]')
    expect([...(list?.querySelectorAll('li') ?? [])].map((li) => li.textContent)).toEqual([
      '/Users/me/a b.txt',
      '/Users/me/c.png',
    ])
  })
})

describe('the props shape', () => {
  it('gives ItemRow exactly the masked summary and nothing that could hold a raw body', () => {
    // A compile-time exhaustiveness check: add a prop to ItemRow and this literal stops compiling.
    const propKeys: Record<keyof ComponentProps<typeof ItemRow>, true> = {
      item: true,
      selected: true,
      ranges: true,
      top: true,
      nowMs: true,
      onpick: true,
      onview: true,
      onpin: true,
      ontag: true,
      ontitle: true,
      ondelete: true,
      onpointerdown: true,
    }
    expect(Object.keys(propKeys).sort()).toEqual([
      'item',
      'nowMs',
      'ondelete',
      'onpick',
      'onpin',
      'onpointerdown',
      'ontag',
      'ontitle',
      'onview',
      'ranges',
      'selected',
      'top',
    ])
  })
})

describe('the action bar', () => {
  // Pin (Cmd+P) and delete (Cmd+Backspace) have always worked and were never mentioned anywhere, so
  // in practice the pin feature did not exist for anyone who had not read the source.
  it('names pin and delete, which are reachable no other way', async () => {
    await render(createFakeApi({ items: [makeItem(1)] }))
    const hints = host.querySelector('[data-testid="hints"]')
    expect(hints).not.toBeNull()
    const text = hints?.textContent ?? ''
    expect(text).toContain('pin')
    expect(text).toContain('⌘P')
    expect(text).toContain('delete')
    expect(text).toContain('⌘⌫')
  })

  it('names every shortcut the palette actually handles', () => {
    // Guards the drift that makes hints worse than none: a key handled but not listed, or listed but
    // no longer handled.
    const handled = ['↑↓', '⏎', '⌘E', '⌘P', '⌘T', '⌘⌫', 'esc']
    expect(SHORTCUT_HINTS.map((h) => h.keys)).toEqual(handled)
  })

  it('is buttons, not a legend — clicking pin pins the selected row', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    const state = await render(fake)
    const pin = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="hints"] button')].find(
      (b) => b.textContent?.includes('pin'),
    )
    expect(pin).toBeDefined()

    pin?.click()
    await state.pending
    flushSync()

    expect(fake.pinCalls).toEqual([{ id: testItemId(0), pinned: true }])
  })

  it('offers a button per row action so nothing is keyboard-only', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)
    const buttons = [...rows()[1]!.querySelectorAll<HTMLButtonElement>('.row-btn')]
    expect(buttons.length).toBe(5)

    buttons.find((button) => button.title === 'Delete')?.click()
    await state.pending
    flushSync()

    // The click also moved the selection onto the row it acted on, so the two can never disagree.
    expect(fake.removeCalls).toEqual([testItemId(1)])
  })
})

describe('title editing', () => {
  it('opens with Cmd+E and saves with Enter without copying the item', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    const state = await render(fake)
    press('e', { metaKey: true })
    const field = host.querySelector<HTMLInputElement>('[data-testid="title-input"]')
    expect(field).not.toBeNull()
    expect(document.activeElement).toBe(field)

    field!.value = 'Work login'
    field!.dispatchEvent(new Event('input', { bubbles: true }))
    field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await state.pending
    flushSync()

    expect(fake.titleCalls).toEqual([{ id: testItemId(0), title: 'Work login' }])
    expect(fake.copyCalls).toEqual([])
    expect(host.querySelector('[data-testid="title-input"]')).toBe(null)
    expect(rows()[0]?.textContent).toContain('Work login')
    expect(host.querySelector('[data-testid="hidden-content"]')).not.toBe(null)
    state.dispose()
  })

  it('cancels a title edit with Escape while keeping the palette open', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    const state = await render(fake)
    press('e', { metaKey: true })
    const field = host.querySelector<HTMLInputElement>('[data-testid="title-input"]')!
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    flushSync()

    expect(state.titleEditing).toBe(false)
    expect(fake.titleCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
    expect(document.activeElement).toBe(host.querySelector('[data-testid="search"]'))
    state.dispose()
  })
})

describe('tabs', () => {
  it('creates an empty tab without assigning or requiring a selected clip', async () => {
    const fake = createFakeApi()
    const state = await render(fake)
    const create = host.querySelector<HTMLButtonElement>('[data-testid="new-tab"]')!
    expect(create.disabled).toBe(false)
    create.click()
    flushSync()
    const input = host.querySelector<HTMLInputElement>('[data-testid="new-tab-input"]')!
    expect(input).not.toBeNull()
    input.value = ' Work '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await state.pending
    flushSync()
    expect(fake.createTabCalls).toEqual([{ tag: 'Work' }])
    expect(state.tabs).toEqual([{ tag: 'work', count: 0 }])
    expect(fake.tagCalls).toEqual([])
    expect(fake.copyCalls).toEqual([])
    expect(state.activeTab).toEqual({ kind: 'all' })
    expect(document.activeElement).toBe(host.querySelector('.search'))
  })

  it('deletes only the tab and returns to All without deleting or copying clips', async () => {
    const fake = createFakeApi({ items: [makeItem(0, { tags: ['work', 'home'] }), makeItem(1, { tags: ['work'], pinned: true })] })
    const state = await render(fake)
    await state.selectTab({ kind: 'tag', tag: 'work' })
    flushSync()
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Delete tab work"]')!
    expect(remove).not.toBeNull()
    remove.focus()
    remove.click()
    flushSync()
    expect(fake.removeTabCalls).toEqual([])
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-tab-delete"]')!.click()
    await state.pending
    flushSync()
    expect(fake.removeTabCalls).toEqual([{ tag: 'work' }])
    expect(state.activeTab).toEqual({ kind: 'all' })
    expect(state.total).toBe(2)
    expect(fake.items.map(item => item.tags)).toEqual([['home'], []])
    expect(fake.items[1]?.pinned).toBe(true)
    expect(fake.removeCalls).toEqual([])
    expect(fake.copyCalls).toEqual([])
    expect(host.querySelector('[aria-label="Delete tab work"]')).toBeNull()
    expect(host.querySelector('[aria-label="Delete tab All"]')).toBeNull()
    expect(host.querySelector('[aria-label="Delete tab Pinned"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.search'))
  })

  it('keeps existing-tab assignment separate from creating a new tab', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1, { tags: ['work'] })] })
    const state = await render(fake)
    press('t', { metaKey: true })
    expect(host.querySelector('[aria-label="Add to work"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="new-tab-input"]')).toBeNull()
    expect(host.querySelector('[data-testid="tag-input"]')).toBeNull()
    state.dispose()
  })

  it('keeps tab edits recoverable when saving fails and cancels without closing the app', async () => {
    const fake = createFakeApi({ items: [makeItem(0, { tags: ['work'] })] })
    fake.failTabManagement = true
    const state = await render(fake)
    state.openTabCreation()
    state.newTabDraft = 'Personal'
    await state.createTab()
    flushSync()
    expect(state.tabCreating).toBe(true)
    expect(state.newTabDraft).toBe('Personal')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not create')
    pressFocused('Escape')
    expect(state.tabCreating).toBe(false)
    expect(fake.closeCalls).toBe(0)
    await state.selectTab({ kind: 'tag', tag: 'work' })
    await state.removeTab('work')
    expect(state.activeTab).toEqual({ kind: 'tag', tag: 'work' })
    expect(state.total).toBe(1)
    expect(fake.items[0]?.tags).toEqual(['work'])
    expect(fake.removeCalls).toEqual([])
    state.dispose()
  })

  it('offers existing tabs as clickable choices and shows current membership', async () => {
    const fake = createFakeApi({ items: [
      makeItem(0, { tags: ['home'] }), makeItem(1, { tags: ['work'] }),
    ] })
    const state = await render(fake)
    press('t', { metaKey: true })
    expect(host.querySelector('[aria-label="Remove from home"]')?.getAttribute('aria-pressed')).toBe('true')
    const work = host.querySelector<HTMLButtonElement>('[aria-label="Add to work"]')!
    expect(work).not.toBeNull()
    work.click()
    await state.pending
    flushSync()
    expect(fake.tagCalls).toEqual([{ id: testItemId(0), tag: 'work', tagged: true }])
    expect(host.querySelector('[aria-label="Remove from work"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(state.tagging).toBe(true)
    host.querySelector<HTMLButtonElement>('[aria-label="Done tagging"]')!.click()
    flushSync()
    expect(state.tagging).toBe(false)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
  })

  it('keeps tab choices attached to the original clip when selection changes', async () => {
    const fake = createFakeApi({ items: [
      makeItem(0, { tags: ['home'] }), makeItem(1, { tags: ['work'] }),
    ] })
    const state = await render(fake)
    press('t', { metaKey: true })
    state.selectedIndex = 1
    flushSync()
    host.querySelector<HTMLButtonElement>('[aria-label="Remove from home"]')!.click()
    await state.pending
    flushSync()
    expect(fake.tagCalls).toEqual([{ id: testItemId(0), tag: 'home', tagged: false }])
    expect(pressFocused('ArrowDown').defaultPrevented).toBe(true)
    expect(state.selectedIndex).toBe(1)
    expect(document.activeElement?.closest('.tag-options')).not.toBeNull()
  })

  it('keeps keyboard focus while assigning and after a legacy tab disappears', async () => {
    const fake = createFakeApi({ items: [
      makeItem(0, { tags: ['home'] }), makeItem(1, { tags: ['work'] }),
    ] })
    fake.tabNames.delete('home')
    const state = await render(fake)
    press('t', { metaKey: true })
    const focused = document.activeElement as HTMLButtonElement
    expect(focused.getAttribute('aria-label')).toBe('Remove from home')
    fake.deferred = true
    focused.click()
    flushSync()
    expect(focused.disabled).toBe(false)
    expect(focused.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(focused)
    fake.deferred = false
    fake.pending.shift()!()
    await state.pending
    flushSync()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Add to work')
    pressFocused('Escape')
    expect(state.tagging).toBe(false)
    expect(fake.closeCalls).toBe(0)
    expect(document.activeElement).toBe(host.querySelector('.search'))
  })

  it('keeps navigation keys in tab creation and never assigns the selected clip', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)
    host.querySelector<HTMLButtonElement>('[data-testid="new-tab"]')!.click()
    flushSync()
    const field = host.querySelector<HTMLInputElement>('[data-testid="new-tab-input"]')!
    field.value = 'work'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(pressFocused(key).defaultPrevented).toBe(false)
      expect(state.selectedIndex).toBe(0)
      expect(document.activeElement).toBe(field)
    }
    pressFocused('Enter')
    await state.pending
    expect(fake.createTabCalls).toEqual([{ tag: 'work' }])
    expect(fake.tagCalls).toEqual([])
    expect(fake.copyCalls).toEqual([])
    state.dispose()
  })

  it('always offers All and Pinned, and one tab per tag in use', async () => {
    const fake = createFakeApi({
      items: [makeItem(0, { tags: ['work'] }), makeItem(1, { pinned: true }), makeItem(2)],
    })
    await render(fake)

    const labels = [...host.querySelectorAll('[data-testid="tabs"] .tab')].map((b) =>
      (b.textContent ?? '').trim(),
    )
    expect(labels).toEqual(['All', 'Pinned1', 'work1'])
  })

  it('shows only that tab’s items when a tab is clicked, and says so when it is empty', async () => {
    const fake = createFakeApi({
      items: [makeItem(0, { tags: ['work'] }), makeItem(1), makeItem(2)],
    })
    const state = await render(fake)
    expect(state.total).toBe(3)

    await state.selectTab({ kind: 'tag', tag: 'work' })
    flushSync()

    expect(state.total).toBe(1)
    expect(fake.listCalls.at(-1)).toEqual({ limit: 32, offset: 0, pinnedOnly: false, tag: 'work' })

    await state.selectTab({ kind: 'pinned' })
    flushSync()

    expect(state.total).toBe(0)
    expect(host.querySelector('[data-testid="empty"]')?.textContent?.trim()).toBe(
      'Nothing pinned yet — pinned copies are never evicted',
    )
  })

  it('adds a clip by dragging it onto a newly created empty tab', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)

    host.querySelector<HTMLButtonElement>('[data-testid="new-tab"]')!.click()
    flushSync()
    const field = host.querySelector<HTMLInputElement>('[data-testid="new-tab-input"]')
    expect(field).not.toBeNull()

    state.newTabDraft = ' Work  Notes '
    await state.createTab()
    flushSync()

    expect(fake.tagCalls).toEqual([])
    expect(state.tabs).toEqual([{ tag: 'work notes', count: 0 }])
    const target = [...host.querySelectorAll('.tab')].find(tab => tab.textContent?.startsWith('work notes'))!
    pointer(rows()[0]!, 'pointerdown', 30, 220)
    hitTarget(target)
    pointer(window, 'pointermove', 160, 140)
    pointer(window, 'pointerup', 160, 140)
    await state.pending
    flushSync()
    expect(fake.tagCalls).toEqual([{ id: testItemId(0), tag: 'work notes', tagged: true }])
    expect(state.tabs).toEqual([{ tag: 'work notes', count: 1 }])
    expect(host.querySelector('[data-testid="new-tab-input"]')).toBe(null)
    expect(fake.copyCalls).toEqual([])
    expect(fake.closeCalls).toBe(0)
  })

  it('says why when an item is already in as many tabs as it can be', async () => {
    const fake = createFakeApi({ items: [makeItem(0)] })
    fake.failTagWith = 'E_TAG_LIMIT'
    const state = await render(fake)

    state.openTagging()
    await state.toggleTag('ninth')
    flushSync()

    expect(host.querySelector('[data-testid="toast"]')?.textContent).toBe(
      'An item can be in at most 8 tabs',
    )
  })
})
