import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SECRET_TTL_MS,
  contentHash,
  createTestClock,
  type Candidate,
  type Item,
  type ResolvedRep,
} from '@cairn/protocol'
import { DEFAULT_RULES, classify, mask } from '@cairn/privacy'
import { createSearchIndex } from '@cairn/search'
import { openStore, randomTestKey, silentLogger, tempStoreDir } from '@cairn/store'
import { createHistory, type History } from './history'
import { DEFAULT_RETENTION } from './retention'

const cleanups: (() => void)[] = []
afterEach(() => {
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
