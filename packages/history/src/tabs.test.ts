import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TABS_MAX, TAG_MAX_CHARS, contentHash, createTestClock, err,
  type Candidate, type ItemId, type Logger,
} from '@cairn/protocol'
import { DEFAULT_RULES, classify, mask } from '@cairn/privacy'
import { createSearchIndex } from '@cairn/search'
import { itemFixture, openStore, randomTestKey, tempStoreDir, testItemId } from '@cairn/store'
import { createHistory } from './history'
import { DEFAULT_RETENTION } from './retention'

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function harness(maxItems = DEFAULT_RETENTION.maxItems) {
  const { dir, cleanup } = tempStoreDir()
  cleanups.push(cleanup)
  const key = randomTestKey()
  const clock = createTestClock()
  const logs: unknown[] = []
  const logger: Logger = {
    log(level, event, fields) { logs.push({ level, event, fields }) },
    debug(event, fields) { logger.log('debug', event, fields) },
    info(event, fields) { logger.log('info', event, fields) },
    warn(event, fields) { logger.log('warn', event, fields) },
    error(event, fields) { logger.log('error', event, fields) },
  }
  let failCompact = false
  const connect = () => {
    const opened = openStore({
      dir, key, clock, logger,
      unsafeTestHooks: { onBeforeRename() { if (failCompact) throw new Error('synthetic failure') } },
    })
    if (!opened.ok) throw new Error(opened.message)
    const store = opened.value
    const history = createHistory({
      store, clock, logger, search: createSearchIndex(),
      privacy: { rules: DEFAULT_RULES, classify, mask },
      retention: { ...DEFAULT_RETENTION, maxItems },
    })
    return { store, history }
  }
  return { ...connect(), connect, clock, logs, failCompaction: () => { failCompact = true } }
}

async function add(history: ReturnType<typeof createHistory>, text: string): Promise<ItemId> {
  const bytes = Buffer.from(text)
  const sha256 = contentHash(bytes)
  const candidate: Candidate = {
    reps: [{ mime: 'text/plain', uti: null, bytes, byteLength: bytes.length, sha256 }],
    kind: 'text', contentHash: sha256, primaryText: mask(text).preview, hints: [],
    sourceApp: null, thumbnailJpeg: null, capturedAt: 0, changeToken: 'synthetic',
  }
  const result = await history.ingest(candidate)
  if (!result.ok || result.value.outcome !== 'added') throw new Error('expected added')
  return result.value.item.id
}

describe('explicit tabs', () => {
  it('persists empty normalized tabs encrypted across restart and repeated empty compaction', async () => {
    const { history, store, connect, logs } = harness()
    expect(await history.createTab('  Private \n Project  ')).toEqual({
      ok: true, value: { tag: 'private project', created: true },
    })
    const afterCreate = store.stat()
    expect(await history.createTab('PRIVATE PROJECT')).toEqual({
      ok: true, value: { tag: 'private project', created: false },
    })
    expect(store.stat()).toEqual(afterCreate)
    expect(history.tabs()).toEqual([{ tag: 'private project', count: 0 }])
    expect(JSON.stringify(logs)).not.toContain('private project')
    expect(readFileSync(store.layout().logPath).includes(Buffer.from('private project'))).toBe(false)
    store.close()
    const restarted = connect()
    expect(await restarted.history.load()).toEqual({ ok: true, value: { items: 0 } })
    for (let i = 0; i < 2; i++) {
      expect(restarted.store.compact([])).toMatchObject({
        ok: true, value: { liveItemCount: 0, linesAfter: 2, blobsRemoved: 0 },
      })
      expect((await restarted.history.load()).ok).toBe(true)
      expect(restarted.history.tabs()).toEqual([{ tag: 'private project', count: 0 }])
    }
    expect(readFileSync(restarted.store.layout().logPath).includes(Buffer.from('private project'))).toBe(false)
    expect(await restarted.history.removeTab('private project')).toEqual({
      ok: true, value: { removed: true, untagged: 0 },
    })
    expect(restarted.store.compact([])).toMatchObject({ ok: true, value: { linesAfter: 1 } })
    const deleted = connect()
    expect((await deleted.history.load()).ok).toBe(true)
    expect(deleted.history.tabs()).toEqual([])
  })

  it('keeps an explicitly created legacy live tab when its last item is untagged', async () => {
    const { history, store, connect } = harness()
    const id = await add(history, 'filed body')
    expect((await history.tag(id, 'work', true)).ok).toBe(true)
    expect(await history.createTab('WORK')).toEqual({ ok: true, value: { tag: 'work', created: false } })
    expect((await history.tag(id, 'work', false)).ok).toBe(true)
    expect(history.tabs()).toEqual([{ tag: 'work', count: 0 }])
    expect(store.compact([id]).ok).toBe(true)
    const restarted = connect()
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.tabs()).toEqual([{ tag: 'work', count: 0 }])
  })

  it('deletes a tab with one event without changing clips, recency, pins, titles, other tags or blobs', async () => {
    const { history, store, connect, clock } = harness()
    const first = await add(history, 'first body')
    clock.advance(1)
    const second = await add(history, 'second body')
    await history.tag(first, 'work', true)
    await history.tag(first, 'other', true)
    await history.tag(second, 'work', true)
    await history.pin(first, true)
    await history.setTitle(second, 'Second alias')
    await history.createTab('work')
    const before = history.list().items
    const changes: string[] = []
    history.onChange((event) => changes.push(event.reason))
    const append = vi.spyOn(store, 'appendEvent')
    const deleteBlob = vi.spyOn(store, 'deleteBlob')
    const remove = vi.spyOn(history, 'remove')
    const evict = vi.spyOn(history, 'evictNow')
    clock.advance(100)
    expect(await history.removeTab(' WORK ')).toEqual({ ok: true, value: { removed: true, untagged: 2 } })
    expect(append.mock.calls).toEqual([[{ kind: 'TAB_DELETED', tag: 'work' }]])
    expect(deleteBlob).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(evict).not.toHaveBeenCalled()
    expect(changes).toEqual(['update'])
    const expected = before.map((item) => ({ ...item, tags: item.tags.filter((tag) => tag !== 'work') }))
    expect(history.list().items).toEqual(expected)
    expect(history.tabs()).toEqual([{ tag: 'other', count: 1 }])
    expect(history.list({ tag: 'work' }).total).toBe(0)
    expect(history.search('body', 10, { tag: 'work' })).toEqual([])
    expect(await history.resolveReps(first)).toMatchObject({ ok: true, value: [{ bytes: Buffer.from('first body') }] })
    for (const compact of [false, true]) {
      if (compact) expect(store.compact([second, first]).ok).toBe(true)
      const restarted = connect()
      expect((await restarted.history.load()).ok).toBe(true)
      expect(restarted.history.list().items).toEqual(expected)
      expect(restarted.history.tabs()).toEqual([{ tag: 'other', count: 1 }])
    }
    expect(await history.removeTab('work')).toEqual({ ok: true, value: { removed: false, untagged: 0 } })
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('infers only final live legacy tags and allows retagging after a tab deletion', async () => {
    const { history, store, connect, clock } = harness()
    const blob = store.putBlob(Buffer.from('legacy body'))
    if (!blob.ok) throw new Error(blob.message)
    const live = { ...itemFixture(testItemId(1), blob.value, 'legacy body'), tags: ['old'] }
    const deleted = { ...live, id: testItemId(2), tags: ['deleted'] }
    const expired = { ...live, id: testItemId(3), tags: ['expired'], expiresAt: clock.now() }
    for (const item of [live, deleted, expired]) expect(store.appendEvent({ kind: 'ITEM_ADDED', item }).ok).toBe(true)
    expect(store.appendEvent({ kind: 'ITEM_UPDATED', id: live.id, patch: { updatedAt: live.updatedAt, tags: ['live'] } }).ok).toBe(true)
    expect(store.appendEvent({ kind: 'ITEM_DELETED', id: deleted.id, reason: 'user' }).ok).toBe(true)
    expect((await history.load()).ok).toBe(true)
    expect(history.tabs()).toEqual([{ tag: 'live', count: 1 }])
    expect(await history.removeTab('expired')).toEqual({ ok: true, value: { removed: true, untagged: 1 } })
    expect(history.get(expired.id)).toMatchObject({ tags: [], expiresAt: expired.expiresAt })
    expect(await history.removeTab('live')).toEqual({ ok: true, value: { removed: true, untagged: 1 } })
    expect((await history.tag(live.id, 'live', true)).ok).toBe(true)
    expect(store.compact([live.id, expired.id]).ok).toBe(true)
    const restarted = connect()
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.tabs()).toEqual([{ tag: 'live', count: 1 }])
    expect((await restarted.history.tag(live.id, 'live', false)).ok).toBe(true)
    expect(restarted.history.tabs()).toEqual([])
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.tabs()).toEqual([])
  })

  it('normalizes names and counts both explicit and live implicit tabs toward the creation limit', async () => {
    const { history, store } = harness()
    const id = await add(history, 'body')
    await history.tag(id, 'implicit', true)
    expect(await history.createTab('  ')).toMatchObject({ ok: false, code: 'E_TAG_INVALID' })
    expect(await history.removeTab('\n')).toMatchObject({ ok: false, code: 'E_TAG_INVALID' })
    const longTag = 'a'.repeat(TAG_MAX_CHARS)
    expect(await history.createTab(` ${longTag}suffix `)).toEqual({
      ok: true, value: { tag: longTag, created: true },
    })
    for (let i = 2; i < TABS_MAX; i++) expect((await history.createTab(`empty ${i}`)).ok).toBe(true)
    const before = store.stat()
    expect(await history.createTab('overflow')).toMatchObject({ ok: false, code: 'E_TAG_LIMIT' })
    expect(store.stat()).toEqual(before)
    expect(await history.createTab('implicit')).toEqual({ ok: true, value: { tag: 'implicit', created: false } })
    expect(await history.removeTab(longTag)).toEqual({ ok: true, value: { removed: true, untagged: 0 } })
    expect((await history.createTab('replacement')).ok).toBe(true)
    expect(history.tabs()).toHaveLength(TABS_MAX)
  })

  it('leaves state and notifications unchanged when either atomic append fails', async () => {
    const { history, store, connect } = harness()
    const id = await add(history, 'body')
    await history.tag(id, 'work', true)
    await history.createTab('work')
    const before = history.list()
    const changes = vi.fn()
    history.onChange(changes)
    const append = vi.spyOn(store, 'appendEvent')
    append.mockReturnValueOnce(err('E_STORE_IO', 'synthetic failure'))
    expect(await history.createTab('empty')).toMatchObject({ ok: false, code: 'E_STORE_IO' })
    append.mockReturnValueOnce(err('E_STORE_IO', 'synthetic failure'))
    expect(await history.removeTab('work')).toMatchObject({ ok: false, code: 'E_STORE_IO' })
    expect(history.list()).toEqual(before)
    expect(history.tabs()).toEqual([{ tag: 'work', count: 1 }])
    expect(changes).not.toHaveBeenCalled()
    const restarted = connect()
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.list()).toEqual(before)
    expect(restarted.history.tabs()).toEqual(history.tabs())
  })

  it('retains empty tabs and committed untagging after a failed compaction', async () => {
    const { history, store, connect, failCompaction } = harness()
    const id = await add(history, 'body')
    await history.createTab('empty')
    await history.createTab('work')
    await history.tag(id, 'work', true)
    await history.removeTab('work')
    const before = readFileSync(store.layout().logPath)
    failCompaction()
    expect(store.compact([id])).toMatchObject({ ok: false, code: 'E_STORE_IO' })
    expect(readFileSync(store.layout().logPath)).toEqual(before)
    const restarted = connect()
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.tabs()).toEqual([{ tag: 'empty', count: 0 }])
    expect(restarted.history.get(id)?.tags).toEqual([])
  })

  it('does not persist scrubbed titles or previews when removing a tab after cache eviction', async () => {
    const { history, connect } = harness()
    const id = await add(history, 'private body')
    await history.setTitle(id, 'Private alias')
    await history.tag(id, 'work', true)
    const before = history.get(id)!
    history.evictPreviewCache()
    expect(await history.removeTab('work')).toEqual({ ok: true, value: { removed: true, untagged: 1 } })
    expect(history.get(id)).toMatchObject({ tags: [], title: null, preview: '' })
    expect(history.previewsEvicted()).toBe(true)
    const restarted = connect()
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.get(id)).toEqual({ ...before, tags: [] })
  })

  it('queues tab mutations behind replay and preserves the order of retagging and pinning', async () => {
    const { history, connect } = harness()
    const id = await add(history, 'body')
    await history.createTab('work')
    await history.tag(id, 'work', true)
    const results = await Promise.all([
      history.load(), history.createTab('empty'), history.removeTab('work'),
      history.tag(id, 'work', true), history.pin(id, true),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(history.tabs()).toEqual([{ tag: 'empty', count: 0 }, { tag: 'work', count: 1 }])
    expect(history.get(id)).toMatchObject({ pinned: true, tags: ['work'] })
    const restarted = connect()
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.list()).toEqual(history.list())
    expect(restarted.history.tabs()).toEqual(history.tabs())
    await restarted.history.tag(id, 'work', false)
    expect(restarted.history.tabs()).toEqual([{ tag: 'empty', count: 0 }])
  })

  it('does not publish partial tab replay or apply waiting mutations after replay failure', async () => {
    const { history, store } = harness()
    await history.createTab('existing')
    vi.spyOn(store, 'readAll').mockImplementationOnce(async function* () {
      yield { ok: true, value: { kind: 'TAB_CREATED', tag: 'partial', seq: 99, at: 0 } } as const
      yield err('E_STORE_CORRUPT', 'synthetic failure')
    })
    const results = await Promise.all([history.load(), history.createTab('new'), history.removeTab('existing')])
    expect(results).toMatchObject([
      { ok: false, code: 'E_STORE_CORRUPT' },
      { ok: false, code: 'E_STORE_CORRUPT' },
      { ok: false, code: 'E_STORE_CORRUPT' },
    ])
    expect(history.tabs()).toEqual([{ tag: 'existing', count: 0 }])
    expect((await history.load()).ok).toBe(true)
    expect(history.tabs()).toEqual([{ tag: 'existing', count: 0 }])
  })

  it('makes newly untagged clips eligible only at the next normal retention sweep', async () => {
    const { history, store, connect, clock } = harness(1)
    const old = await add(history, 'old body')
    await history.tag(old, 'work', true)
    clock.advance(1)
    const pinned = await add(history, 'pinned body')
    await history.tag(pinned, 'work', true)
    await history.pin(pinned, true)
    clock.advance(1)
    const filed = await add(history, 'filed body')
    await history.tag(filed, 'work', true)
    await history.tag(filed, 'other', true)
    clock.advance(1)
    const recent = await add(history, 'recent body')
    expect(await history.evictNow()).toEqual({ ok: true, value: { evicted: 0 } })
    const before = history.list().items
    const deleteBlob = vi.spyOn(store, 'deleteBlob')
    expect(await history.removeTab('work')).toEqual({ ok: true, value: { removed: true, untagged: 3 } })
    expect(deleteBlob).not.toHaveBeenCalled()
    expect(history.list().items).toEqual(before.map((item) => ({ ...item, tags: item.tags.filter((tag) => tag !== 'work') })))
    const restarted = connect()
    expect((await restarted.history.load()).ok).toBe(true)
    expect(restarted.history.list()).toEqual(history.list())
    expect(await restarted.history.evictNow()).toEqual({ ok: true, value: { evicted: 1 } })
    expect(restarted.history.get(old)).toBeUndefined()
    expect(restarted.history.list().items.map((item) => item.id)).toEqual([recent, filed, pinned])
  })
})
