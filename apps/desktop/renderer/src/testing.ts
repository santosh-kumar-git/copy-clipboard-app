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
    preview: `item ${n}`,
    previewTruncated: false,
    flags: [],
    maskedSpanCount: 0,
    sourceAppName: 'TextEdit',
    byteLength: 8,
    createdAt: 1_767_225_600_000 - n * 1_000,
    pinned: false,
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
  readonly removeCalls: string[]
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

  const api: CairnBridge = {
    list: (params) => {
      fake.listCalls.push(params)
      if (fake.failList) return Promise.reject(new Error('E_IPC_REJECTED'))
      return settle({
        items: fake.items.slice(params.offset, params.offset + params.limit),
        total: fake.items.length,
      })
    },
    search: (params) => {
      fake.searchCalls.push(params)
      return settle({ results: fake.searchHitsFor(params.q).slice(0, params.limit) })
    },
    preview: (params) => {
      fake.previewCalls.push(params.id)
      return settle(
        fake.previews.get(params.id) ?? { text: '', isHtmlSource: false, truncated: false },
      )
    },
    pin: (params) => {
      fake.pinCalls.push(params)
      return settle({ pinned: params.pinned })
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
