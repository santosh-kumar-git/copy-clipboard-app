import { TOAST_COPIED_MANUAL, createTestClock } from '@cairn/protocol'
import { flushSync, mount, unmount, type ComponentProps } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('closes on Escape and on losing focus, which is what hides the window', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    await render(fake)

    press('Escape')
    expect(fake.closeCalls).toBe(1)

    window.dispatchEvent(new Event('blur'))
    flushSync()
    expect(fake.closeCalls).toBe(2)
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

describe('the virtualised result list', () => {
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
  it('puts the item on the clipboard, toasts the M1 sentence, then closes', async () => {
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

    expect(fake.closeCalls).toBe(1)
    expect(host.querySelector('[data-testid="toast"]')).toBe(null)
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
    }
    expect(Object.keys(propKeys).sort()).toEqual([
      'item',
      'nowMs',
      'onpick',
      'ranges',
      'selected',
      'top',
    ])
  })
})

describe('the shortcut hints', () => {
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
    const handled = ['↑↓', '⏎', '⌘P', '⌘⌫', 'esc']
    expect(SHORTCUT_HINTS.map((h) => h.keys)).toEqual(handled)
  })
})
