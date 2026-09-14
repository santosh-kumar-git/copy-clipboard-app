import type { ItemSummary } from '@cairn/protocol'
import type { CairnBridge, CopyResult, ListParams, PreviewResult, SearchParams } from './api'

/** A 26-char Crockford base32 id that `ItemIdSchema` in @cairn/protocol accepts (no I, L, O or U). */
export function testItemId(n: number): string {
  return 'CARN' + String(n).padStart(22, '0')
}

export function makeItem(n: number, over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: testItemId(n),
    kind: 'text',
    title: null,
    preview: `item ${n}`,
    previewTruncated: false,
    flags: [],
    maskedSpanCount: 0,
    sourceAppName: 'TextEdit',
    byteLength: 8,
    createdAt: 1_767_225_600_000 - n * 1_000,
    pinned: false,
    tags: [],
    expiresAt: null,
    thumbnailDataUrl: null,
    ...over,
  }
}

export interface SearchHit {
  item: ItemSummary
  score: number
  ranges: number[]
}

export interface FakeApi {
  readonly api: CairnBridge
  readonly listCalls: ListParams[]
  readonly searchCalls: SearchParams[]
  readonly previewCalls: string[]
  readonly copyCalls: string[]
  readonly pinCalls: { id: string; pinned: boolean }[]
  readonly tagCalls: { id: string; tag: string; tagged: boolean }[]
  readonly titleCalls: { id: string; title: string | null }[]
  readonly readyCalls: { shownAt: number }[]
  failTitle: boolean
  readonly removeCalls: string[]
  /** Rejects `tag` with this code, so a test can drive the E_TAG_LIMIT toast. */
  failTagWith: string | null
  closeCalls: number
  /** The whole synthetic history the fake pages out of. */
  items: ItemSummary[]
  /** Search results per query, so a test can prove a stale response is dropped. */
  searchHitsFor: (q: string) => SearchHit[]
  previews: Map<string, PreviewResult>
  copyResult: CopyResult
  failCopy: boolean
  failList: boolean
  /** Deferred mode: every call resolves only when you invoke its entry in `pending`. */
  deferred: boolean
  readonly pending: (() => void)[]
  emitHistoryChanged(payload: unknown): void
  emitHotkeyStatus(payload: unknown): void
  emitToast(payload: unknown): void
  emitPaletteShown(payload: unknown): void
}

export function createFakeApi(
  init: Partial<Pick<FakeApi, 'items' | 'searchHitsFor' | 'previews' | 'copyResult'>> = {},
): FakeApi {
  const listeners = {
    'history.changed': [] as ((p: unknown) => void)[],
    'hotkey.status': [] as ((p: unknown) => void)[],
    toast: [] as ((p: unknown) => void)[],
    'palette.shown': [] as ((p: unknown) => void)[],
  }
  // The bridge types each callback with its own payload type; the fake stores them as
  // `(p: unknown) => void` on purpose, so a test can push a malformed payload through.
  const sub = (bucket: ((p: unknown) => void)[], cb: unknown): (() => void) => {
    const fn = cb as (p: unknown) => void
    bucket.push(fn)
    return () => {
      const i = bucket.indexOf(fn)
      if (i >= 0) bucket.splice(i, 1)
    }
  }

  const fake: FakeApi = {
    api: undefined as unknown as CairnBridge,
    listCalls: [],
    searchCalls: [],
    previewCalls: [],
    copyCalls: [],
    pinCalls: [],
    tagCalls: [],
    titleCalls: [],
    readyCalls: [],
    failTitle: false,
    failTagWith: null,
    removeCalls: [],
    closeCalls: 0,
    items: init.items ?? [],
    searchHitsFor: init.searchHitsFor ?? (() => []),
    previews: init.previews ?? new Map(),
    copyResult: init.copyResult ?? { result: 'copied-manual', reason: 'user-preference' },
    failCopy: false,
    failList: false,
    deferred: false,
    pending: [],
    emitHistoryChanged: (p) => listeners['history.changed'].forEach((cb) => cb(p)),
    emitHotkeyStatus: (p) => listeners['hotkey.status'].forEach((cb) => cb(p)),
    emitToast: (p) => listeners.toast.forEach((cb) => cb(p)),
    emitPaletteShown: (p) => listeners['palette.shown'].forEach((cb) => cb(p)),
  }

  const settle = <T>(value: T): Promise<T> =>
    fake.deferred
      ? new Promise<T>((resolve) => fake.pending.push(() => resolve(value)))
      : Promise.resolve(value)

  /** The fake filters and counts the same way main does, so a tab test proves the wiring rather than
   *  the fake's opinion of it. */
  const matches = (it: ItemSummary, p: Pick<ListParams, 'pinnedOnly' | 'tag' | 'kind'>): boolean =>
    (p.pinnedOnly !== true || it.pinned) && (p.tag === undefined || it.tags.includes(p.tag)) &&
    (p.kind === undefined || it.kind === p.kind)
  const tabsOf = (): { tag: string; count: number }[] => {
    const counts = new Map<string, number>()
    for (const it of fake.items) for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => (a.tag < b.tag ? -1 : 1))
  }
  const pinnedCount = (): number => fake.items.filter((it) => it.pinned).length

  const api: CairnBridge = {
    list: (params) => {
      fake.listCalls.push(params)
      if (fake.failList) return Promise.reject(new Error('E_IPC_REJECTED'))
      const live = fake.items.filter((item) => matches(item, params))
      return settle({
        items: live.slice(params.offset, params.offset + params.limit),
        total: live.length,
        tabs: tabsOf(),
        pinnedCount: pinnedCount(),
      })
    },
    search: (params) => {
      fake.searchCalls.push(params)
      return settle({
        results: fake.searchHitsFor(params.q).filter((hit) => matches(hit.item, params)).slice(0, params.limit),
        tabs: tabsOf(),
        pinnedCount: pinnedCount(),
      })
    },
    preview: (params) => {
      fake.previewCalls.push(params.id)
      return settle(
        fake.previews.get(params.id) ?? { text: '', isHtmlSource: false, truncated: false },
      )
    },
    pin: (params) => {
      fake.pinCalls.push(params)
      fake.items = fake.items.map((it) =>
        it.id === params.id ? { ...it, pinned: params.pinned } : it,
      )
      return settle({ pinned: params.pinned })
    },
    tag: (params) => {
      fake.tagCalls.push(params)
      if (fake.failTagWith !== null) return Promise.reject(new Error(fake.failTagWith))
      const tag = params.tag.replace(/\s+/g, ' ').trim().toLowerCase()
      let tags: string[] = []
      fake.items = fake.items.map((it) => {
        if (it.id !== params.id) return it
        tags = params.tagged
          ? [...new Set([...it.tags, tag])].sort()
          : it.tags.filter((t) => t !== tag)
        return { ...it, tags }
      })
      return settle({ tags })
    },
    setTitle: (params) => {
      fake.titleCalls.push(params)
      if (fake.failTitle) return Promise.reject(new Error('E_STORE_IO'))
      const title = params.title?.replace(/\s+/g, ' ').trim() || null
      fake.items = fake.items.map((it) => it.id === params.id ? { ...it, title } : it)
      return settle({ title })
    },
    remove: (params) => {
      fake.removeCalls.push(params.id)
      return settle({ removed: true })
    },
    copy: (params) => {
      fake.copyCalls.push(params.id)
      if (fake.failCopy) return Promise.reject(new Error('E_IPC_REJECTED'))
      return settle(fake.copyResult)
    },
    close: () => {
      fake.closeCalls += 1
      return settle({ closed: true as const })
    },
    paletteReady: (params) => {
      fake.readyCalls.push(params)
      return settle({ ready: true })
    },
    securityStatus: () =>
      settle({
        keyringMode: 'os-keyring' as const,
        encryptedAtRest: true,
        dataDirMode: '700',
        notes: [],
      }),
    onHistoryChanged: (cb) => sub(listeners['history.changed'], cb),
    onHotkeyStatus: (cb) => sub(listeners['hotkey.status'], cb),
    onToast: (cb) => sub(listeners.toast, cb),
    onPaletteShown: (cb) => sub(listeners['palette.shown'], cb),
  }
  ;(fake as { api: CairnBridge }).api = api
  return fake
}
