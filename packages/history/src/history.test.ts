import { RETENTION_MAX_AGE_MS, SECRET_TTL_MS, contentHash as hashOf, createTestClock, type Candidate, type ItemId, type Logger, type ResolvedRep } from '@cairn/protocol'
import { DEFAULT_RULES, classify, mask } from '@cairn/privacy'
import { openStore, randomTestKey, tempStoreDir } from '@cairn/store'
import { createSearchIndex } from '@cairn/search'
import { afterEach, describe, expect, it } from 'vitest'
import { createHistory, type History, type PrivacyPort } from './history'
import { DEFAULT_RETENTION, type RetentionLimits } from './retention'
describe('quit and relaunch', () => {
  it('replays readAll() and rebuilds identical in-memory state', async () => {
    const { mk, clock } = harness()
    const first = mk()
    await first.ingest(textCandidate('warehouse inventory report', clock.now()))
    clock.advance(1_000)
    await first.ingest(textCandidate('second thing', clock.now()))
    clock.advance(1_000)
    const pinTarget = first.list().items[1]!.id // the older row
    expect((await first.pin(pinTarget, true)).ok).toBe(true)
    const before = first.list()

    const second = mk() // a brand-new History over the same directory
    const loaded = await second.load()
    expect(loaded.ok && loaded.value.items).toBe(2)
    expect(second.list()).toEqual(before)
    expect(second.list().items[0]!.pinned).toBe(true)
    expect(second.search('wrhs', 10).map((s) => s.item.id)).toEqual([pinTarget])
    expect(second.list().items.map((i) => i.id)).toEqual(before.items.map((i) => i.id))
  })

  it('a removed item does not come back after a restart', async () => {
    const { mk, clock } = harness()
    const first = mk()
    const r = await first.ingest(textCandidate('delete me', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    await first.remove(r.value.item.id)
    const second = mk()
    expect((await second.load()).ok).toBe(true)
    expect(second.list().total).toBe(0)
    expect(second.get(r.value.item.id)).toBeUndefined()
  })
})

describe('pinning', () => {
  it('pin survives a restart', async () => {
    const { mk, clock } = harness()
    const first = mk()
    const r = await first.ingest(textCandidate('pin me', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect((await first.pin(r.value.item.id, true)).ok).toBe(true)
    const second = mk()
    await second.load()
    expect(second.get(r.value.item.id)!.pinned).toBe(true)
    expect(second.list({ pinnedOnly: true }).total).toBe(1)
  })

  it('pinning a secret-flagged item is REFUSED, not silently ignored', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('AKIA2E0PQIN4XA7QD', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    const pinned = await hist.pin(r.value.item.id, true)
    expect(pinned.ok).toBe(false)
    if (!pinned.ok) expect(pinned.code).toBe('E_PIN_REFUSED_SECRET')
    expect(hist.get(r.value.item.id)!.pinned).toBe(false)
    // …and the refusal does not buy it any extra life.
    clock.advance(SECRET_TTL_MS)
    await hist.evictNow()
    expect(hist.get(r.value.item.id)).toBeUndefined()
  })

  it('pin() on an unknown id returns E_ITEM_NOT_FOUND', async () => {
    const { mk } = harness()
    const hist = mk()
    const r = await hist.pin('01ABCDEFGHJKMNPQRSTVWXYZ00' as ItemId, true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_ITEM_NOT_FOUND')
  })
})

const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} }
const privacyPort: PrivacyPort = { rules: DEFAULT_RULES, classify, mask }

function textCandidate(text: string, at: number): Candidate {
  const bytes = new TextEncoder().encode(text)
  const rep: ResolvedRep = {
    mime: 'text/plain',
    uti: 'public.utf8-plain-text',
    bytes,
    byteLength: bytes.length,
    sha256: hashOf(bytes),
  }
  return {
    reps: [rep],
    kind: 'text',
    contentHash: rep.sha256,
    primaryText: text,
    hints: [],
    sourceApp: null,
    thumbnailJpeg: null,
    changeToken: String(at),
    capturedAt: at,
  }
}

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})
function harness(retention?: RetentionLimits) {
  const { dir, cleanup } = tempStoreDir()
  cleanups.push(cleanup)
  const clock = createTestClock()
  const key = randomTestKey()
  const index = createSearchIndex()
  const mk = (): History => {
    const opened = openStore({ dir, key, clock, logger: silentLogger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    return createHistory({
      store: opened.value,
      privacy: privacyPort,
      search: index,
      clock,
      logger: silentLogger,
      ...(retention === undefined ? {} : { retention }),
    })
  }
  return { dir, clock, mk, index }
}

describe('retention through history, with the injected clock', () => {
  it('a secret-flagged item is listed at t+299_999 and gone at t+300_000', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('AKIA2E0PQIN4XA7QD', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    clock.advance(SECRET_TTL_MS - 1)
    expect(hist.list().total).toBe(1)
    expect(hist.search('akia', 10)).toHaveLength(1)
    clock.advance(1)
    expect(hist.list().total).toBe(0)
    expect(hist.search('akia', 10)).toEqual([])
    const evicted = await hist.evictNow()
    expect(evicted.ok && evicted.value.evicted).toBe(1)
    expect(hist.get(r.value.item.id)).toBeUndefined()
  })

  it('an expired secret cannot be recalled even before evictNow() runs', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('AKIA2E0PQIN4XA7QD', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    clock.advance(SECRET_TTL_MS)
    const reps = await hist.resolveReps(r.value.item.id)
    expect(reps.ok).toBe(false)
    if (!reps.ok) expect(reps.code).toBe('E_ITEM_EXPIRED')
  })

  it('unpinning re-exposes an item to retention', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const a = await hist.ingest(textCandidate('keeper', clock.now()))
    if (!a.ok || a.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect((await hist.pin(a.value.item.id, true)).ok).toBe(true)
    clock.advance(RETENTION_MAX_AGE_MS + 1)
    const nothing = await hist.evictNow()
    expect(nothing.ok && nothing.value.evicted).toBe(0)
    expect(hist.list().total).toBe(1)
    expect((await hist.pin(a.value.item.id, false)).ok).toBe(true)
    const evicted = await hist.evictNow()
    expect(evicted.ok && evicted.value.evicted).toBe(1)
    expect(hist.list().total).toBe(0)
  })

  it('evictNow deletes the blobs too and emits an "evict" change', async () => {
    const { mk, clock, dir } = harness({ ...DEFAULT_RETENTION, maxItems: 1 })
    const hist = mk()
    await hist.ingest(textCandidate('older', clock.now()))
    clock.advance(1_000)
    await hist.ingest(textCandidate('newer', clock.now()))
    const { readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(2)
    const seen: string[] = []
    hist.onChange((ev) => seen.push(ev.reason))
    const evicted = await hist.evictNow()
    expect(evicted.ok && evicted.value.evicted).toBe(1)
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(1)
    expect(hist.list().items.map((i) => i.preview)).toEqual(['newer'])
    expect(seen).toEqual(['evict'])
  })

  it('an eviction is not resurrected by a restart', async () => {
    const { mk, clock } = harness({ ...DEFAULT_RETENTION, maxItems: 1 })
    const first = mk()
    await first.ingest(textCandidate('older', clock.now()))
    clock.advance(1_000)
    await first.ingest(textCandidate('newer', clock.now()))
    await first.evictNow()
    const second = mk()
    expect((await second.load()).ok).toBe(true)
    expect(second.list().items.map((i) => i.preview)).toEqual(['newer'])
  })
})

describe('evictPreviewCache — the only thing that bounds the decrypted-preview window', () => {
  it('clears the index and blanks the cached previews; search returns nothing until reloaded', async () => {
    const { mk, clock, index } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('warehouse inventory report', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect(hist.search('wrhs', 10)).toHaveLength(1)
    expect(index.size).toBe(1)

    hist.evictPreviewCache()

    // Look INSIDE the index, not just at what search() returns — otherwise deleting
    // `search.clear()` from evictPreviewCache would leave this test green.
    expect(index.size).toBe(0)
    expect(index.debugHaystack()).toEqual([])
    expect(hist.search('wrhs', 10)).toEqual([])
    expect(hist.search('', 10)).toEqual([])
    expect(hist.list().items[0]!.preview).toBe('')
    expect(hist.list().items[0]!.maskSpans).toEqual([])
    expect(JSON.stringify(hist.list())).not.toContain('warehouse')

    const reloaded = await hist.load()
    expect(reloaded.ok).toBe(true)
    expect(hist.search('wrhs', 10)).toHaveLength(1)
    expect(hist.list().items[0]!.preview).toBe('warehouse inventory report')
  })

  it('does not lose the items themselves — only their previews', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('still here', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    hist.evictPreviewCache()
    expect(hist.list().total).toBe(1)
    // The bytes are in the encrypted store, so an explicit recall still works.
    const reps = await hist.resolveReps(r.value.item.id)
    expect(reps.ok).toBe(true)
    if (reps.ok) expect(new TextDecoder().decode(reps.value[0]!.bytes)).toBe('still here')
  })
})
