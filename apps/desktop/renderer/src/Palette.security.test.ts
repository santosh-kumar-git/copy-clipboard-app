import { createTestClock } from '@cairn/protocol'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it } from 'vitest'
import Palette from './Palette.svelte'
import { PaletteState } from './palette-state.svelte'
import { createFakeApi, makeItem } from './testing'

// The same control as Preview.security.test.ts, but end to end: a hostile payload copied from a web
// page travels main -> IPC -> list row -> preview pane, through the match-highlighting path too,
// and must arrive as text in every one of them.
const PAYLOAD = '<img src=x onerror="window.cairn.list({limit:1,offset:0,pinnedOnly:false})">'

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
  delete (globalThis as Record<string, unknown>).__pwned
})

it('renders a hostile HTML clipboard item as text in the row and in the preview', async () => {
  const item = makeItem(0, { kind: 'richtext', preview: PAYLOAD })
  const fake = createFakeApi({
    items: [item],
    previews: new Map([[item.id, { text: PAYLOAD, isHtmlSource: true, truncated: false }]]),
    searchHitsFor: () => [{ item, score: 1, ranges: [0, 4] }],
  })
  const state = new PaletteState({ api: fake.api, clock: createTestClock() })
  await state.start()
  app = mount(Palette, { target: host, props: { palette: state } }) as Record<string, unknown>
  flushSync()

  expect(host.querySelectorAll('img').length).toBe(0)
  expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe(PAYLOAD)
  expect(host.querySelector('[role="option"]')?.textContent).toContain(PAYLOAD)
  expect(host.querySelector('[data-testid="preview-badge"]')?.textContent?.trim()).toBe('HTML source')

  // The highlight path builds DOM from ufuzzy offsets, so it is a second possible sink.
  await state.setQuery('img')
  flushSync()

  expect(host.querySelector('mark')?.textContent).toBe('<img')
  expect(host.querySelectorAll('img').length).toBe(0)
  expect((globalThis as Record<string, unknown>).__pwned).toBe(undefined)
  // Only the initial list call: nothing in the payload reached the bridge.
  expect(fake.listCalls.length).toBe(1)
  expect(fake.copyCalls).toEqual([])
})

it('keeps titled clipboard content out of text, attributes and thumbnails until explicitly revealed', async () => {
  const hidden = 'synthetic-private-value'
  const item = makeItem(1, {
    title: 'Work login',
    preview: hidden,
    thumbnailDataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
  })
  const fake = createFakeApi({
    items: [item],
    previews: new Map([[item.id, { text: hidden, isHtmlSource: false, truncated: false }]]),
  })
  const state = new PaletteState({ api: fake.api, clock: createTestClock() })
  await state.start()
  app = mount(Palette, { target: host, props: { palette: state } }) as Record<string, unknown>
  flushSync()

  expect(host.textContent).toContain('Work login')
  expect(host.innerHTML).not.toContain(hidden)
  expect(host.querySelector('img')).toBe(null)
  expect(fake.previewCalls).toEqual([])

  host.querySelector<HTMLButtonElement>('[data-testid="reveal-content"]')!.click()
  await state.pending
  flushSync()
  expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe(hidden)

  fake.emitPaletteShown({ shownAt: 123 })
  await state.pending
  flushSync()
  expect(host.innerHTML).not.toContain(hidden)
  state.dispose()
})
