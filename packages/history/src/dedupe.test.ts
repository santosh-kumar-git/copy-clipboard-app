import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  contentHash,
  createTestClock,
  type Candidate,
  type Logger,
  type ResolvedRep,
} from '@cairn/protocol'
import { DEFAULT_RULES, classify, mask } from '@cairn/privacy'
import { openStore, randomTestKey, tempStoreDir } from '@cairn/store'
import { createSearchIndex } from '@cairn/search'
import { bumpUpdatedAt, indexByContentHash } from './dedupe'
import { createHistory, type History, type PrivacyPort } from './history'

const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} }
const privacy: PrivacyPort = { rules: DEFAULT_RULES, classify, mask }

function textCandidate(text: string, at: number): Candidate {
  const bytes = new TextEncoder().encode(text)
  const rep: ResolvedRep = {
    mime: 'text/plain',
    uti: 'public.utf8-plain-text',
    bytes,
    byteLength: bytes.length,
    sha256: contentHash(bytes),
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
function harness() {
  const { dir, cleanup } = tempStoreDir()
  cleanups.push(cleanup)
  const clock = createTestClock()
  const key = randomTestKey()
  const mk = (): History => {
    const opened = openStore({ dir, key, clock, logger: silentLogger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    return createHistory({
      store: opened.value,
      privacy,
      search: createSearchIndex(),
      clock,
      logger: silentLogger,
    })
  }
  return { dir, clock, mk }
}

describe('dedupe', () => {
  it('copying the same thing twice yields ONE item, one blob and a bumped updatedAt', async () => {
    const { mk, clock, dir } = harness()
    const hist = mk()
    const first = await hist.ingest(textCandidate('same bytes', clock.now()))
    if (!first.ok || first.value.outcome !== 'added') throw new Error('expected outcome "added"')
    clock.advance(5_000)
    const second = await hist.ingest(textCandidate('same bytes', clock.now()))
    expect(second.ok && second.value.outcome).toBe('duplicate')
    if (!second.ok || second.value.outcome !== 'duplicate') return
    expect(second.value.item.id).toBe(first.value.item.id)
    expect(second.value.item.createdAt).toBe(first.value.item.createdAt)
    expect(second.value.item.updatedAt).toBe(first.value.item.createdAt + 5_000)
    expect(hist.list().total).toBe(1)
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(1)
  })

  it('a re-copied item rises to the top of the list and of an empty search', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    await hist.ingest(textCandidate('alpha', clock.now()))
    clock.advance(1_000)
    await hist.ingest(textCandidate('beta', clock.now()))
    expect(hist.list().items.map((i) => i.preview)).toEqual(['beta', 'alpha'])
    clock.advance(1_000)
    await hist.ingest(textCandidate('alpha', clock.now()))
    expect(hist.list().items.map((i) => i.preview)).toEqual(['alpha', 'beta'])
    expect(hist.search('', 10).map((s) => s.item.preview)).toEqual(['alpha', 'beta'])
  })

  it('emits an "update" change rather than an "ingest" for a duplicate', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    await hist.ingest(textCandidate('same bytes', clock.now()))
    const seen: string[] = []
    hist.onChange((ev) => seen.push(ev.reason))
    clock.advance(1)
    await hist.ingest(textCandidate('same bytes', clock.now()))
    expect(seen).toEqual(['update'])
  })

  it('indexByContentHash maps every hash to its item id', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('one', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    const map = indexByContentHash(hist.list().items)
    expect(map.size).toBe(1)
    expect(map.get(r.value.item.contentHash)).toBe(r.value.item.id)
  })

  it('bumpUpdatedAt is pure: it changes updatedAt and nothing else', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('one', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    const bumped = bumpUpdatedAt(r.value.item, r.value.item.createdAt + 42)
    expect(bumped.patch).toEqual({ updatedAt: r.value.item.createdAt + 42 })
    expect(bumped.item).toEqual({ ...r.value.item, updatedAt: r.value.item.createdAt + 42 })
    expect(r.value.item.updatedAt).toBe(r.value.item.createdAt)
  })
})
