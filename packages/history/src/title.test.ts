import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SECRET_TTL_MS, contentHash, createTestClock, err,
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
  const clock = createTestClock()
  const logs: unknown[] = []
  const logger: Logger = {
    log(level, event, fields) { logs.push({ level, event, fields }) },
    debug(event, fields) { logger.log('debug', event, fields) },
    info(event, fields) { logger.log('info', event, fields) },
    warn(event, fields) { logger.log('warn', event, fields) },
    error(event, fields) { logger.log('error', event, fields) },
  }
  const opened = openStore({ dir, key: randomTestKey(), clock, logger })
  if (!opened.ok) throw new Error(opened.message)
  const store = opened.value
  const makeHistory = () => {
    const index = createSearchIndex()
    const history = createHistory({
      store, clock, logger, search: index,
      privacy: { rules: DEFAULT_RULES, classify, mask },
      retention: { ...DEFAULT_RETENTION, maxItems },
    })
    return { history, index }
  }
  return { ...makeHistory(), makeHistory, store, clock, logs }
}

function candidate(text: string): Candidate {
  const bytes = Buffer.from(text)
  const sha256 = contentHash(bytes)
  return {
    reps: [{ mime: 'text/plain', uti: null, bytes, byteLength: bytes.length, sha256 }],
    kind: 'text', contentHash: sha256, primaryText: mask(text).preview, hints: [],
    sourceApp: null, thumbnailJpeg: null, capturedAt: 0, changeToken: 'synthetic',
  }
}

async function add(history: ReturnType<typeof createHistory>, text: string): Promise<ItemId> {
  const result = await history.ingest(candidate(text))
  if (!result.ok || result.value.outcome !== 'added') throw new Error('expected added')
  return result.value.item.id
}

describe('item titles', () => {
  it('normalizes and persists a title encrypted through replay and compaction without logging it', async () => {
    const { history, makeHistory, store, clock, logs } = harness()
    const id = await add(history, 'clipboard body')
    const original = history.get(id)!
    const changes: string[] = []
    history.onChange((event) => changes.push(event.reason))
    clock.advance(100)
    expect(await history.setTitle(id, '  Private \n Project\tAlias  ')).toEqual({
      ok: true, value: { title: 'Private Project Alias' },
    })
    expect(history.get(id)).toEqual({ ...original, title: 'Private Project Alias' })
    expect(changes).toEqual(['update'])
    expect(JSON.stringify(logs)).not.toContain('Private')
    const checkDisk = () => {
      const layout = store.layout()
      for (const file of [layout.logPath, ...readdirSync(layout.blobDir).map((name) => join(layout.blobDir, name))]) {
        expect(readFileSync(file).includes(Buffer.from('Private Project Alias'))).toBe(false)
        expect(readFileSync(file).includes(Buffer.from('clipboard body'))).toBe(false)
      }
    }
    checkDisk()
    const reloaded = makeHistory().history
    expect((await reloaded.load()).ok).toBe(true)
    expect(reloaded.get(id)?.title).toBe('Private Project Alias')
    expect(store.compact([id]).ok).toBe(true)
    checkDisk()
    const compacted = makeHistory().history
    expect((await compacted.load()).ok).toBe(true)
    expect(compacted.get(id)?.title).toBe('Private Project Alias')
    expect((await compacted.resolveReps(id))).toMatchObject({
      ok: true, value: [{ bytes: Buffer.from('clipboard body') }],
    })
  })

  it('loads a legacy item without a title and can set and clear one', async () => {
    const { history, store, makeHistory } = harness()
    const blob = store.putBlob(Buffer.from('legacy body'))
    if (!blob.ok) throw new Error(blob.message)
    const legacy = itemFixture(testItemId(1), blob.value, 'legacy body')
    expect(legacy).not.toHaveProperty('title')
    expect(store.appendEvent({ kind: 'ITEM_ADDED', item: legacy }).ok).toBe(true)
    expect((await history.load()).ok).toBe(true)
    expect(history.get(legacy.id)?.title).toBeNull()
    expect((await history.setTitle(legacy.id, 'Legacy Alias')).ok).toBe(true)
    expect((await history.setTitle(legacy.id, null))).toEqual({ ok: true, value: { title: null } })
    const reloaded = makeHistory().history
    expect((await reloaded.load()).ok).toBe(true)
    expect(reloaded.get(legacy.id)?.title).toBeNull()
    expect(reloaded.search('legacy', 10).map((hit) => hit.item.id)).toEqual([legacy.id])
  })

  it('searches only the displayed title with matching ranges and restores body search after clearing', async () => {
    const { history, index, makeHistory } = harness()
    const id = await add(history, 'underlying confidential clipboard')
    expect((await history.setTitle(id, 'Workspace Alias')).ok).toBe(true)
    expect(index.debugHaystack()).toEqual(['Workspace Alias'])
    expect(history.search('confidential', 10)).toEqual([])
    expect(history.search('Workspace', 10)).toMatchObject([{ item: { id, title: 'Workspace Alias' }, ranges: [0, 9] }])
    const reloaded = makeHistory().history
    expect((await reloaded.load()).ok).toBe(true)
    expect(reloaded.search('confidential', 10)).toEqual([])
    expect(reloaded.search('Workspace', 10)).toMatchObject([{ item: { id }, ranges: [0, 9] }])
    expect((await reloaded.setTitle(id, '  \n\t '))).toEqual({ ok: true, value: { title: null } })
    expect(reloaded.search('Workspace', 10)).toEqual([])
    expect(reloaded.search('confidential', 10).map((hit) => hit.item.id)).toEqual([id])
  })

  it('enforces the 120-character limit and unknown ids without changing stored state', async () => {
    const { history, store } = harness()
    const id = await add(history, 'plain body')
    expect((await history.setTitle(id, 'A'.repeat(120)))).toEqual({ ok: true, value: { title: 'A'.repeat(120) } })
    const before = store.stat()
    expect(await history.setTitle(id, 'B'.repeat(121))).toMatchObject({ ok: false, code: 'E_BAD_PARAMS' })
    expect(await history.setTitle(testItemId(99), 'Alias')).toMatchObject({ ok: false, code: 'E_ITEM_NOT_FOUND' })
    expect(store.stat()).toEqual(before)
    expect(history.get(id)?.title).toBe('A'.repeat(120))
    expect(await history.setTitle(id, '')).toEqual({ ok: true, value: { title: null } })
  })

  it('preserves secret TTL, pin refusal, tags and recall bytes when titling or recopying', async () => {
    const { history, clock } = harness()
    const text = 'AKIA2E0PQIN4XA7QD'
    const id = await add(history, text)
    expect((await history.tag(id, 'work', true)).ok).toBe(true)
    const before = history.get(id)!
    expect((await history.setTitle(id, 'Credential')).ok).toBe(true)
    expect(history.get(id)).toEqual({ ...before, title: 'Credential' })
    expect(await history.pin(id, true)).toMatchObject({ ok: false, code: 'E_PIN_REFUSED_SECRET' })
    clock.advance(1)
    expect((await history.ingest(candidate(text))).ok).toBe(true)
    expect(history.get(id)).toMatchObject({ title: 'Credential', flags: ['secret'], tags: ['work'], expiresAt: before.expiresAt })
    expect(await history.resolveReps(id)).toMatchObject({ ok: true, value: [{ bytes: Buffer.from(text) }] })
    clock.advance(SECRET_TTL_MS - 1)
    expect(await history.resolveReps(id)).toMatchObject({ ok: false, code: 'E_ITEM_EXPIRED' })
    expect(await history.evictNow()).toEqual({ ok: true, value: { evicted: 1 } })
  })

  it('does not exempt a titled item from count retention', async () => {
    const { history, clock } = harness(1)
    const older = await add(history, 'old body')
    expect((await history.setTitle(older, 'Important Alias')).ok).toBe(true)
    clock.advance(1)
    const newer = await add(history, 'new body')
    expect(await history.evictNow()).toEqual({ ok: true, value: { evicted: 1 } })
    expect(history.list().items.map((item) => item.id)).toEqual([newer])
  })

  it('preserves title, pin and tags when their requests overlap', async () => {
    const { history } = harness()
    const id = await add(history, 'plain body')
    const results = await Promise.all([
      history.pin(id, true), history.setTitle(id, 'Alias'), history.tag(id, 'work', true),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(history.get(id)).toMatchObject({ title: 'Alias', pinned: true, tags: ['work'] })
    expect(history.search('Alias', 10)).toMatchObject([{ item: { id } }])
  })

  it('does not update the visible title or search index when persisting its patch fails', async () => {
    const { history, store, index } = harness()
    const id = await add(history, 'plain body')
    vi.spyOn(store, 'appendEvent').mockReturnValueOnce(err('E_STORE_IO', 'synthetic failure'))
    expect(await history.setTitle(id, 'Lost Alias')).toMatchObject({ ok: false, code: 'E_STORE_IO' })
    expect(history.get(id)?.title ?? null).toBeNull()
    expect(index.debugHaystack()).toEqual(['plain body'])
  })

  it('scrubs titles and previews from the decrypted cache until an explicit reload', async () => {
    const { history, index } = harness()
    const id = await add(history, 'private clipboard body')
    await history.setTitle(id, 'Private Alias')
    history.evictPreviewCache()
    expect(history.get(id)).toMatchObject({ title: null, preview: '', maskSpans: [] })
    expect(index.debugHaystack()).toEqual([])
    expect(history.search('Private', 10)).toEqual([])
    expect(history.previewsEvicted()).toBe(true)
    expect((await history.load()).ok).toBe(true)
    expect(history.get(id)).toMatchObject({ title: 'Private Alias', preview: 'private clipboard body' })
    expect(index.debugHaystack()).toEqual(['Private Alias'])
  })

  it('persists title edits and clearing while evicted without repopulating the cache', async () => {
    const { history, index, store } = harness()
    const id = await add(history, 'private clipboard body')
    await history.setTitle(id, 'Original Alias')
    history.evictPreviewCache()
    expect((await history.setTitle(id, 'Updated Alias')).ok).toBe(true)
    expect.soft(history.get(id)).toMatchObject({ title: null, preview: '' })
    expect.soft(index.debugHaystack()).toEqual([])
    expect((await history.setTitle(id, null)).ok).toBe(true)
    expect((await history.load()).ok).toBe(true)
    expect(history.get(id)?.title).toBeNull()
    const titles: (string | null | undefined)[] = []
    for await (const result of store.readAll()) {
      if (result.ok && result.value.kind === 'ITEM_UPDATED') titles.push(result.value.patch.title)
    }
    expect(titles).toEqual(['Original Alias', 'Updated Alias', null])
  })

  it('can clear an evicted title even though its cached value is already null', async () => {
    const { history } = harness()
    const id = await add(history, 'private clipboard body')
    await history.setTitle(id, 'Original Alias')
    history.evictPreviewCache()
    expect((await history.setTitle(id, null)).ok).toBe(true)
    expect((await history.load()).ok).toBe(true)
    expect(history.get(id)?.title).toBeNull()
  })

  it('keeps background ingestion and metadata updates out of an evicted cache', async () => {
    const { history, index } = harness()
    const id = await add(history, 'first private body')
    await history.setTitle(id, 'Private Alias')
    history.evictPreviewCache()
    const incoming = await add(history, 'second private body')
    await history.pin(id, true)
    await history.tag(id, 'work', true)
    await history.ingest(candidate('first private body'))
    expect(history.list().items.every((item) => item.preview === '' && item.title === null)).toBe(true)
    expect(index.debugHaystack()).toEqual([])
    expect((await history.load()).ok).toBe(true)
    expect(history.get(id)).toMatchObject({ title: 'Private Alias', pinned: true, tags: ['work'] })
    expect(history.get(incoming)?.preview).toBe('second private body')
  })

  it('keeps a cache eviction effective when a reload is already in flight', async () => {
    const { history, index } = harness()
    const id = await add(history, 'private clipboard body')
    await history.setTitle(id, 'Private Alias')
    const loading = history.load()
    history.evictPreviewCache()
    expect((await loading).ok).toBe(true)
    expect(history.previewsEvicted()).toBe(true)
    expect(history.get(id)).toMatchObject({ title: null, preview: '' })
    expect(index.debugHaystack()).toEqual([])
    expect((await history.load()).ok).toBe(true)
    expect(history.get(id)?.title).toBe('Private Alias')
  })

  it('applies overlapping title, pin and tag changes after a reload finishes', async () => {
    const { history } = harness()
    const id = await add(history, 'plain body')
    const outcomes = await Promise.all([
      history.load(), history.pin(id, true), history.setTitle(id, 'New Alias'),
      history.tag(id, 'work', true),
    ])
    expect(outcomes.every((result) => result.ok)).toBe(true)
    expect(history.get(id)).toMatchObject({ title: 'New Alias', pinned: true, tags: ['work'] })
    const before = history.list()
    expect((await history.load()).ok).toBe(true)
    expect(history.list()).toEqual(before)
  })

  it('refuses mutations after a failed reload and permits a later successful reload', async () => {
    const { history, store } = harness()
    const id = await add(history, 'plain body')
    vi.spyOn(store, 'readAll').mockImplementationOnce(async function* () {
      yield err('E_STORE_CORRUPT', 'synthetic corrupt record')
    })
    const results = await Promise.all([history.load(), history.setTitle(id, 'Alias')])
    expect(results).toMatchObject([
      { ok: false, code: 'E_STORE_CORRUPT' }, { ok: false, code: 'E_STORE_CORRUPT' },
    ])
    expect((await history.load()).ok).toBe(true)
    expect(history.get(id)?.title).toBeNull()
    expect((await history.setTitle(id, 'Alias')).ok).toBe(true)
  })
})
