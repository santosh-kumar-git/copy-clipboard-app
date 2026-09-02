import { describe, expect, it } from 'vitest'
import type { ItemId } from '@cairn/protocol'
import { createSearchIndex, type SearchEntry } from './index'

interface EntrySpec {
  readonly id: string
  readonly preview: string
  readonly pinned?: boolean
  readonly updatedAt?: number
  readonly ord?: number
}
/** `as ItemId` is fine in a test: these ids are opaque keys, not parsed. */
const e = (o: EntrySpec): SearchEntry => ({
  id: o.id as ItemId,
  preview: o.preview,
  pinned: o.pinned ?? false,
  updatedAt: o.updatedAt ?? 1_000,
  ord: o.ord ?? 1,
})

describe('createSearchIndex — matching', () => {
  it('matches out-of-order letters inside a single word', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'warehouse inventory report', ord: 1, updatedAt: 1 }))
    ix.add(e({ id: 'B', preview: 'nothing relevant here', ord: 2, updatedAt: 2 }))
    const hits = ix.query('wrhs', 10)
    expect(hits.map((h) => String(h.id))).toEqual(['A'])
    // w@0, r@2, h@4, s@7 — a FLAT array of alternating [start, end) offsets, not pairs.
    expect(hits[0]!.ranges).toEqual([0, 1, 2, 3, 4, 5, 7, 8])
    expect(hits[0]!.score).toBe(1)
  })

  it('matches across a space, because a preview is one line of prose', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'hello world from a long preview' }))
    expect(ix.query('hlwrd', 10)[0]!.ranges).toEqual([0, 1, 2, 3, 6, 7, 8, 9, 10, 11])
  })

  it('does not match a needle that is not a subsequence', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'warehouse inventory report' }))
    expect(ix.query('zzzzq', 10)).toEqual([])
  })

  it('caps results at limit and scores 1, 1/2, 1/3', () => {
    const ix = createSearchIndex()
    for (let i = 0; i < 5; i++) ix.add(e({ id: `I${i}`, preview: `alpha ${i}`, updatedAt: i, ord: i }))
    const hits = ix.query('alpha', 3)
    expect(hits).toHaveLength(3)
    expect(hits.map((h) => h.score)).toEqual([1, 0.5, 1 / 3])
  })

  it('reports its size and every preview it holds', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'first', updatedAt: 1, ord: 1 }))
    ix.add(e({ id: 'B', preview: 'second', updatedAt: 2, ord: 2 }))
    expect(ix.size).toBe(2)
    expect([...ix.debugHaystack()].sort()).toEqual(['first', 'second'])
  })
})

describe('createSearchIndex — ordering and lifecycle', () => {
  it('an empty query is pinned first, then recency', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'OLD', preview: 'old', updatedAt: 100, ord: 1 }))
    ix.add(e({ id: 'NEW', preview: 'new', updatedAt: 300, ord: 3 }))
    ix.add(e({ id: 'PIN', preview: 'pinned', updatedAt: 200, ord: 2, pinned: true }))
    expect(ix.query('', 10).map((h) => String(h.id))).toEqual(['PIN', 'NEW', 'OLD'])
    expect(ix.query('   ', 10).map((h) => String(h.id))).toEqual(['PIN', 'NEW', 'OLD'])
    expect(ix.query('', 10).map((h) => h.ranges)).toEqual([[], [], []])
  })

  it('a punctuation-only query has no searchable term and falls back to the empty-query order', () => {
    // ufuzzy returns [null, null, null] for '(' — that is "nothing to match on", not an error.
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'alpha', updatedAt: 1, ord: 1 }))
    ix.add(e({ id: 'B', preview: 'beta', updatedAt: 2, ord: 2 }))
    expect(ix.query('(', 10).map((h) => String(h.id))).toEqual(['B', 'A'])
  })

  it('breaks relevance ties by recency, identically on every repeat', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'OLDER', preview: 'ab1', updatedAt: 100, ord: 1 }))
    ix.add(e({ id: 'NEWER', preview: 'ab2', updatedAt: 200, ord: 2 }))
    for (let n = 0; n < 5; n++) {
      expect(ix.query('ab', 10).map((h) => String(h.id))).toEqual(['NEWER', 'OLDER'])
    }
  })

  it('breaks a same-millisecond tie by ord, so two copies in one tick never flap', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'FIRST', preview: 'ab1', updatedAt: 500, ord: 7 }))
    ix.add(e({ id: 'SECOND', preview: 'ab2', updatedAt: 500, ord: 8 }))
    expect(ix.query('ab', 10).map((h) => String(h.id))).toEqual(['SECOND', 'FIRST'])
  })

  it('add() upserts by id rather than duplicating a row', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'before', updatedAt: 1, ord: 1 }))
    ix.add(e({ id: 'A', preview: 'after', updatedAt: 2, ord: 1 }))
    expect(ix.size).toBe(1)
    expect(ix.debugHaystack()).toEqual(['after'])
  })

  it('remove() reports whether the id was present', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'x' }))
    expect(ix.remove('A' as ItemId)).toBe(true)
    expect(ix.remove('A' as ItemId)).toBe(false)
    expect(ix.size).toBe(0)
  })

  it('clear() empties the index, so nothing is searchable until it is refilled', () => {
    const ix = createSearchIndex()
    ix.add(e({ id: 'A', preview: 'warehouse' }))
    ix.clear()
    expect(ix.size).toBe(0)
    expect(ix.debugHaystack()).toEqual([])
    expect(ix.query('wrhs', 10)).toEqual([])
    expect(ix.query('', 10)).toEqual([])
  })

  it('over capacity, evicts the oldest UNPINNED entry and never a pinned one', () => {
    const ix = createSearchIndex({ limit: 2 })
    ix.add(e({ id: 'P', preview: 'pinned old', updatedAt: 1, ord: 1, pinned: true }))
    ix.add(e({ id: 'A', preview: 'aaa', updatedAt: 2, ord: 2 }))
    ix.add(e({ id: 'B', preview: 'bbb', updatedAt: 3, ord: 3 }))
    expect(ix.size).toBe(2)
    expect(ix.query('', 10).map((h) => String(h.id))).toEqual(['P', 'B'])
  })

  it('clamps a silly limit to the hard cap and rejects a zero limit', () => {
    expect(() => createSearchIndex({ limit: 0 })).toThrow('limit must be >= 1')
    const ix = createSearchIndex({ limit: 1_000_000 })
    for (let i = 0; i < 10; i++) ix.add(e({ id: `I${i}`, preview: `p${i}`, updatedAt: i, ord: i }))
    expect(ix.size).toBe(10)
  })
})
