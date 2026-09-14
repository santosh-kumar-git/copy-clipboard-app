import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SECRET_TTL_MS,
  contentHash,
  createTestClock,
  err,
  type Candidate,
  type Item,
  type ItemKind,
  type ResolvedRep,
} from '@cairn/protocol'
import { DEFAULT_RULES, classify, mask } from '@cairn/privacy'
import { createSearchIndex } from '@cairn/search'
import { openStore, randomTestKey, silentLogger, tempStoreDir } from '@cairn/store'
import { createHistory, type History } from './history'
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
  const opened = openStore({ dir, key: randomTestKey(), clock, logger: silentLogger })
  if (!opened.ok) throw new Error(opened.message)
  const store = opened.value
  const makeHistory = () => {
    const index = createSearchIndex()
    const history = createHistory({
      store, clock, search: index, logger: silentLogger,
      privacy: { rules: DEFAULT_RULES, classify, mask },
      retention: { ...DEFAULT_RETENTION, maxItems },
    })
    return { history, index }
  }
  return { ...makeHistory(), makeHistory, store, clock }
}

function rep(mime: string, body: string | Uint8Array): ResolvedRep {
  const bytes = Buffer.from(body)
  return { mime, uti: null, bytes, byteLength: bytes.length, sha256: contentHash(bytes) }
}

function candidate(text: string): Candidate {
  const primary = rep('text/plain', text)
  return {
    reps: [primary], kind: 'text', contentHash: primary.sha256, primaryText: mask(text).preview,
    hints: [], sourceApp: null, thumbnailJpeg: null, changeToken: 'synthetic', capturedAt: 0,
  }
}

async function add(history: History, input: Candidate): Promise<Item> {
  const result = await history.ingest(input)
  if (!result.ok) throw new Error(result.message)
  if (result.value.outcome !== 'added') throw new Error(`expected added, got ${result.value.outcome}`)
  return result.value.item
}

describe('kind filters and result limits', () => {
  async function addTyped(history: History, kind: ItemKind, label: string): Promise<Item> {
    const mime = { text: 'text/plain', richtext: 'text/html', image: 'image/png', files: 'text/uri-list' }[kind]
    const primary = rep(mime, label)
    const item = await add(history, {
      ...candidate(label), kind, reps: [primary], contentHash: primary.sha256,
      primaryText: kind === 'image' ? null : label,
    })
    expect((await history.setTitle(item.id, 'warehouse report')).ok).toBe(true)
    return item
  }

  it.each(['text', 'richtext', 'image', 'files'] as const)(
    'finds %s matches beyond the first unfiltered page and preserves ranking',
    async (kind) => {
      const { history, clock, index } = harness()
      await addTyped(history, kind, 'oldest target')
      clock.advance(1)
      const middle = await addTyped(history, kind, 'middle target')
      clock.advance(1)
      const newest = await addTyped(history, kind, 'newest target')
      const otherKind = kind === 'text' ? 'richtext' : 'text'
      for (const label of ['other one', 'other two', 'other three']) {
        clock.advance(1)
        await addTyped(history, otherKind, label)
      }

      expect(index.query('warehouse', 2).map((hit) => hit.id)).not.toContain(newest.id)
      expect(history.search('warehouse', 2, { kind })).toMatchObject([
        { item: { id: newest.id, kind }, score: 1 / 4, ranges: [0, 9] },
        { item: { id: middle.id, kind }, score: 1 / 5, ranges: [0, 9] },
      ])
      expect(history.search('', 2, { kind }).map((hit) => hit.item.id)).toEqual([newest.id, middle.id])
      expect(history.search('nonexistent', 2, { kind })).toEqual([])
    },
  )

  it('intersects kind, normalized tab and pin filters before applying the limit', async () => {
    const { history, clock } = harness()
    const target = await addTyped(history, 'files', 'target')
    expect((await history.tag(target.id, 'work', true)).ok).toBe(true)
    expect((await history.pin(target.id, true)).ok).toBe(true)
    for (const [kind, tag, pinned] of [
      ['text', 'work', true], ['files', 'personal', true], ['files', 'work', false],
    ] as const) {
      clock.advance(1)
      const other = await addTyped(history, kind, `other ${kind} ${tag}`)
      expect((await history.tag(other.id, tag, true)).ok).toBe(true)
      expect((await history.pin(other.id, pinned)).ok).toBe(true)
    }

    expect(history.search('warehouse', 1, { kind: 'files', tag: '  WORK  ', pinnedOnly: true }))
      .toMatchObject([{ item: { id: target.id }, score: 1 / 4, ranges: [0, 9] }])
    expect(history.search('warehouse', 1, { kind: 'files', tag: 'missing', pinnedOnly: true })).toEqual([])
  })

  it.each([{ tag: 'work' }, { pinnedOnly: true }])('fills a limited search with a later match for %j', async (filter) => {
    const { history, clock } = harness()
    const target = await addTyped(history, 'text', 'target')
    expect((await history.tag(target.id, 'work', true)).ok).toBe(true)
    expect((await history.pin(target.id, true)).ok).toBe(true)
    clock.advance(1)
    await addTyped(history, 'text', 'newer unfiled and unpinned')
    expect(history.search('warehouse', 1, filter).map((hit) => hit.item.id)).toEqual([target.id])
  })

  it('skips expired and missing hits before applying the limit', async () => {
    const { history, clock, index } = harness()
    const target = await addTyped(history, 'text', 'live target')
    clock.advance(1)
    const expired = await addTyped(history, 'text', 'AKIA2E0PQIN4XA7QD')
    clock.advance(1)
    const missing = await addTyped(history, 'text', 'removed target')
    expect((await history.remove(missing.id)).ok).toBe(true)
    index.add({
      id: missing.id, preview: 'warehouse report', pinned: false, tagged: false,
      updatedAt: clock.now(), ord: 100,
    })
    clock.advance(SECRET_TTL_MS)

    expect(history.get(expired.id)?.expiresAt).toBeLessThanOrEqual(clock.now())
    expect(index.query('warehouse', 2).map((hit) => hit.id)).toEqual([missing.id, expired.id])
    expect(history.search('warehouse', 1).map((hit) => hit.item.id)).toEqual([target.id])
  })

  it.each([0, -1])('returns no matches for limit %s', async (limit) => {
    const { history } = harness()
    await addTyped(history, 'files', 'target')
    expect(history.search('warehouse', limit, { kind: 'files' })).toEqual([])
  })

  it('counts kind-filtered list totals before pagination while keeping global tab and pin counts', async () => {
    const { history, clock } = harness()
    const targets: Item[] = []
    for (const label of ['oldest', 'middle', 'newest']) {
      for (const kind of ['files', 'text'] as const) {
        clock.advance(1)
        const item = await addTyped(history, kind, `${label} ${kind}`)
        expect((await history.tag(item.id, 'work', true)).ok).toBe(true)
        expect((await history.pin(item.id, true)).ok).toBe(true)
        if (kind === 'files') targets.push(item)
      }
    }
    const filter = { kind: 'files', tag: 'work', pinnedOnly: true, limit: 1 } as const
    for (const [offset, target] of [...targets].reverse().entries()) {
      const page = history.list({ ...filter, offset })
      expect(page.items.map((item) => item.id)).toEqual([target.id])
      expect(page.total).toBe(3)
    }
    expect(history.list({ ...filter, offset: 3 })).toEqual({ items: [], total: 3 })
    expect(history.list({ kind: 'image', limit: 1 })).toEqual({ items: [], total: 0 })
    expect(history.tabs()).toEqual([{ tag: 'work', count: 6 }])
    expect(history.pinnedCount()).toBe(6)
  })

  it('searches the title only and keeps typed searches empty while previews are evicted', async () => {
    const { history } = harness()
    const target = await addTyped(history, 'files', 'confidential body')
    expect(history.search('confidential', 1, { kind: 'files' })).toEqual([])
    expect(history.search('warehouse', 1, { kind: 'files' }).map((hit) => hit.item.id)).toEqual([target.id])
    history.evictPreviewCache()
    expect(history.search('warehouse', 1, { kind: 'files' })).toEqual([])
  })
})

describe('classification of captured representations', () => {
  it.each(['text/plain', 'text/uri-list', 'text/html', 'text/rtf'])(
    'keeps a masked %s secret expiring and unpinnable across reloads',
    async (mime) => {
      const { history, makeHistory, store, clock, index } = harness()
      const secret = 'AKIA2E0PQIN4XA7QD'
      const original = rep(mime, secret)
      const item = await add(history, {
        ...candidate(secret), reps: [original], contentHash: original.sha256,
      })

      expect.soft(item.flags).toContain('secret')
      expect.soft(item.expiresAt).toBe(clock.now() + SECRET_TTL_MS)
      expect.soft(item.preview).toBe('AKIA••••A7QD')
      expect.soft(item.maskSpans).toMatchObject([{ start: 0, detector: 'aws-access-key' }])
      expect.soft(await history.pin(item.id, true)).toMatchObject({ ok: false, code: 'E_PIN_REFUSED_SECRET' })
      expect(JSON.stringify(index.debugHaystack())).not.toContain(secret)
      const resolved = await history.resolveReps(item.id)
      expect(resolved).toMatchObject({ ok: true, value: [original] })
      for await (const event of store.readAll()) {
        expect(event.ok).toBe(true)
        expect(JSON.stringify(event)).not.toContain(secret)
      }
      const layout = store.layout()
      for (const file of [layout.logPath, ...readdirSync(layout.blobDir).map((f) => join(layout.blobDir, f))]) {
        expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false)
      }

      const reloaded = makeHistory().history
      expect((await reloaded.load()).ok).toBe(true)
      expect.soft(reloaded.get(item.id)?.flags).toContain('secret')
      clock.advance(SECRET_TTL_MS)
      expect.soft(reloaded.list().total).toBe(0)
      expect.soft(await reloaded.resolveReps(item.id)).toMatchObject({ ok: false, code: 'E_ITEM_EXPIRED' })
    },
  )

  it('selects original plain text ahead of earlier HTML and ignores the supplied preview', async () => {
    const { history } = harness()
    const input = candidate('AKIA2E0PQIN4XA7QD')
    const item = await add(history, {
      ...input, primaryText: 'ordinary preview', reps: [rep('text/html', '<p>ordinary</p>'), ...input.reps],
    })
    expect(item.flags).toContain('secret')
    expect(item.preview).toBe('AKIA••••A7QD')
  })

  it('does not decode a binary primary or classify a secondary HTML representation as primary text', async () => {
    const { history } = harness()
    const image = rep('image/png', 'synthetic image bytes')
    const item = await add(history, {
      ...candidate('AKIA2E0PQIN4XA7QD'),
      kind: 'image', contentHash: image.sha256, primaryText: null,
      reps: [rep('text/html', 'AKIA2E0PQIN4XA7QD'), image],
    })
    expect(item.flags).toEqual([])
    expect(item.preview).toBe('')
    expect(item.expiresAt).toBeNull()
  })
})

const sharedBytes = Buffer.from('synthetic shared image')
type SharedUse = 'rep' | 'thumbnail' | 'both'
function sharedCandidate(text: string, use: SharedUse): Candidate {
  const input = candidate(text)
  return {
    ...input,
    reps: use === 'thumbnail' ? input.reps : [
      ...input.reps, rep('image/jpeg', sharedBytes),
      ...(use === 'both' ? [rep('application/octet-stream', sharedBytes)] : []),
    ],
    thumbnailJpeg: use === 'rep' ? null : sharedBytes,
  }
}

describe.each(['remove', 'evict'] as const)('shared blobs during %s', (action) => {
  it.each([
    ['rep', 'rep'], ['thumbnail', 'thumbnail'], ['rep', 'thumbnail'],
    ['thumbnail', 'rep'], ['both', 'both'],
  ] satisfies [SharedUse, SharedUse][])(
    'preserves a deleted %s still used as a %s after reload, then frees its last reference',
    async (removedUse, survivorUse) => {
      const { history, makeHistory, store, clock } = harness(1)
      const removed = await add(history, sharedCandidate('older copy', removedUse))
      clock.advance(1)
      const survivor = await add(history, sharedCandidate('newer copy', survivorUse))
      expect((await history.ingest(sharedCandidate('newer copy', survivorUse))).ok).toBe(true)
      const reloaded = makeHistory().history
      expect((await reloaded.load()).ok).toBe(true)

      const deletion = action === 'remove' ? await reloaded.remove(removed.id) : await reloaded.evictNow()
      expect(deletion.ok).toBe(true)
      expect(reloaded.list().items.map((item) => item.id)).toEqual([survivor.id])
      expect(store.getBlob(contentHash(sharedBytes))).toEqual({ ok: true, value: sharedBytes })
      expect((await reloaded.resolveReps(survivor.id)).ok).toBe(true)
      expect(store.getBlob(removed.repRefs[0]!.blobId)).toMatchObject({ ok: false, code: 'E_BLOB_MISSING' })

      if (action === 'remove') {
        reloaded.setMaxItems(0)
        expect(await reloaded.evictNow()).toEqual({ ok: true, value: { evicted: 1 } })
      } else {
        expect(await reloaded.remove(survivor.id)).toEqual({ ok: true, value: { removed: true } })
      }
      expect(store.stat()).toMatchObject({ ok: true, value: { blobCount: 0 } })
    },
  )
})

it('frees a shared blob after evicting multiple owners in one batch', async () => {
  const { history, store, clock } = harness(1)
  await add(history, sharedCandidate('first copy', 'both'))
  clock.advance(1)
  await add(history, sharedCandidate('second copy', 'both'))
  clock.advance(1)
  const survivor = await add(history, candidate('keeper'))

  expect(await history.evictNow()).toEqual({ ok: true, value: { evicted: 2 } })
  expect(store.getBlob(contentHash(sharedBytes))).toMatchObject({ ok: false, code: 'E_BLOB_MISSING' })
  expect((await history.resolveReps(survivor.id)).ok).toBe(true)
  expect(store.stat()).toMatchObject({ ok: true, value: { blobCount: 1 } })
})

it('preserves a shared blob when ingest overlaps removal of its previous owner', async () => {
  const { history } = harness()
  const previous = await add(history, sharedCandidate('previous copy', 'both'))
  const [ingested, removed] = await Promise.all([
    history.ingest(sharedCandidate('incoming copy', 'both')),
    history.remove(previous.id),
  ])
  expect(removed.ok).toBe(true)
  expect(ingested).toMatchObject({ ok: true, value: { outcome: 'added' } })
  if (!ingested.ok || ingested.value.outcome !== 'added') throw new Error('expected added')
  expect((await history.resolveReps(ingested.value.item.id)).ok).toBe(true)
})

it('deduplicates simultaneous ingests and replays the same single item', async () => {
  const { history, makeHistory } = harness()
  const results = await Promise.all([
    history.ingest(candidate('simultaneous copy')), history.ingest(candidate('simultaneous copy')),
  ])
  expect(results.map((result) => result.ok && result.value.outcome)).toEqual(['added', 'duplicate'])
  expect(history.list().total).toBe(1)
  const reloaded = makeHistory().history
  expect((await reloaded.load()).ok).toBe(true)
  expect(reloaded.list()).toEqual(history.list())
})

it('deduplicates a copy arriving while its existing item is being reloaded', async () => {
  const { history, makeHistory } = harness()
  const existing = await add(history, candidate('existing copy'))
  const [loaded, ingested] = await Promise.all([
    history.load(), history.ingest(candidate('existing copy')),
  ])
  expect(loaded.ok).toBe(true)
  expect(ingested).toMatchObject({ ok: true, value: { outcome: 'duplicate', item: { id: existing.id } } })
  expect(history.list().total).toBe(1)
  const reloaded = makeHistory().history
  expect((await reloaded.load()).ok).toBe(true)
  expect(reloaded.list()).toEqual(history.list())
})

it('does not resurrect an item when metadata updates overlap its deletion', async () => {
  const { history, makeHistory } = harness()
  const item = await add(history, candidate('deleted copy'))
  await Promise.all([
    history.pin(item.id, true), history.setTitle(item.id, 'Alias'), history.remove(item.id),
    history.tag(item.id, 'work', true),
  ])
  expect(history.get(item.id)).toBeUndefined()
  const reloaded = makeHistory().history
  expect((await reloaded.load()).ok).toBe(true)
  expect(reloaded.get(item.id)).toBeUndefined()
})

it('finishes a recall before an overlapping deletion can remove its remaining representations', async () => {
  const { history } = harness()
  const item = await add(history, sharedCandidate('recalled copy', 'both'))
  const [recalled, removed] = await Promise.all([history.resolveReps(item.id), history.remove(item.id)])
  expect(recalled).toMatchObject({ ok: true, value: [{}, {}, {}] })
  expect(removed).toEqual({ ok: true, value: { removed: true } })
})

it('preserves same-tick list and search ordering when compaction receives newest-first ids', async () => {
  const { history, store, makeHistory } = harness()
  const first = await add(history, candidate('warehouse first'))
  const second = await add(history, candidate('warehouse second'))
  const before = history.list()
  expect(before.items.map((item) => item.id)).toEqual([second.id, first.id])
  expect(store.compact(before.items.map((item) => item.id)).ok).toBe(true)
  const reloaded = makeHistory().history
  expect((await reloaded.load()).ok).toBe(true)
  expect(reloaded.list()).toEqual(before)
  expect(reloaded.search('warehouse', 10).map((hit) => hit.item.id)).toEqual([second.id, first.id])
})

describe.each(['remove', 'evict'] as const)('blob cleanup failures during %s', (action) => {
  it('hides a durably deleted item immediately and retries cleanup on the next sweep', async () => {
    const { history, store, makeHistory } = harness(0)
    const item = await add(history, sharedCandidate('deleted synthetic body', 'both'))
    const changes: string[] = []
    history.onChange((event) => changes.push(event.reason))
    vi.spyOn(store, 'deleteBlob').mockReturnValueOnce(err('E_STORE_IO', 'synthetic unlink failure'))

    const result = action === 'remove' ? await history.remove(item.id) : await history.evictNow()
    expect(result).toMatchObject({ ok: false, code: 'E_STORE_IO' })
    expect.soft(history.get(item.id)).toBeUndefined()
    expect.soft(history.list().total).toBe(0)
    expect.soft(history.search('deleted', 10)).toEqual([])
    expect.soft(await history.resolveReps(item.id)).toMatchObject({ ok: false, code: 'E_ITEM_NOT_FOUND' })
    expect.soft(changes).toEqual([action === 'remove' ? 'delete' : 'evict'])

    expect(await history.evictNow()).toEqual({ ok: true, value: { evicted: 0 } })
    expect(store.stat()).toMatchObject({ ok: true, value: { blobCount: 0 } })
    const reloaded = makeHistory().history
    expect((await reloaded.load()).ok).toBe(true)
    expect(reloaded.list()).toEqual(history.list())
  })

  it('recovers interrupted cleanup on reload without deleting a surviving shared blob', async () => {
    const { history, store, makeHistory, clock } = harness(1)
    const removed = await add(history, sharedCandidate('older synthetic body', 'both'))
    clock.advance(1)
    const survivor = await add(history, sharedCandidate('newer synthetic body', 'both'))
    vi.spyOn(store, 'deleteBlob').mockReturnValueOnce(err('E_STORE_IO', 'synthetic unlink failure'))
    const result = action === 'remove' ? await history.remove(removed.id) : await history.evictNow()
    expect(result).toMatchObject({ ok: false, code: 'E_STORE_IO' })

    const reloaded = makeHistory().history
    expect((await reloaded.load()).ok).toBe(true)
    expect(reloaded.list().items.map((item) => item.id)).toEqual([survivor.id])
    expect(store.getBlob(removed.repRefs[0]!.blobId)).toMatchObject({ ok: false, code: 'E_BLOB_MISSING' })
    expect(await reloaded.resolveReps(survivor.id)).toMatchObject({ ok: true, value: [{}, {}, {}] })
    expect(store.getBlob(contentHash(sharedBytes))).toEqual({ ok: true, value: sharedBytes })
  })
})

it('publishes completed evictions when a later delete record cannot be persisted', async () => {
  const { history, store, clock, makeHistory } = harness(0)
  const first = await add(history, candidate('first synthetic body'))
  clock.advance(1)
  const second = await add(history, candidate('second synthetic body'))
  const changes: { reason: string; total: number }[] = []
  history.onChange((event) => changes.push(event))
  const append = store.appendEvent.bind(store)
  vi.spyOn(store, 'appendEvent')
    .mockImplementationOnce(append)
    .mockReturnValueOnce(err('E_STORE_IO', 'synthetic append failure'))

  expect(await history.evictNow()).toMatchObject({ ok: false, code: 'E_STORE_IO' })
  expect(history.get(second.id)).toBeUndefined()
  expect(history.list().items.map((item) => item.id)).toEqual([first.id])
  expect(changes).toEqual([{ reason: 'evict', total: 1 }])
  const reloaded = makeHistory().history
  expect((await reloaded.load()).ok).toBe(true)
  expect(reloaded.list()).toEqual(history.list())
  expect((await reloaded.resolveReps(first.id)).ok).toBe(true)
})
