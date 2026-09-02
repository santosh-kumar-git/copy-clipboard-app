import { describe, expect, it } from 'vitest'
import {
  RETENTION_MAX_AGE_MS,
  RETENTION_MAX_BYTES,
  RETENTION_MAX_ITEMS,
  SECRET_TTL_MS,
  type ContentHash,
  type Item,
  type ItemId,
} from '@cairn/protocol'
import { isSyncableDelete, planEviction, SYNCABLE_DELETE_REASONS } from './retention'

const HASH = ('sha256-' + 'a'.repeat(43)) as ContentHash
/** 2026-01-01T00:00:00Z, the createTestClock default, so timestamps in failures are recognisable. */
const NOW = 1_767_225_600_000

interface ItemSpec {
  readonly id: string
  readonly createdAt: number
  readonly bytes?: number
  readonly pinned?: boolean
  readonly expiresAt?: number | null
}
const item = (o: ItemSpec): Item => ({
  id: o.id as ItemId,
  kind: 'text',
  contentHash: HASH,
  preview: o.id,
  previewTruncated: false,
  maskSpans: [],
  flags: o.expiresAt == null ? [] : ['secret'],
  repRefs: [],
  thumbnailBlobId: null,
  sourceApp: null,
  byteLength: o.bytes ?? 10,
  createdAt: o.createdAt,
  updatedAt: o.createdAt,
  pinned: o.pinned ?? false,
  expiresAt: o.expiresAt ?? null,
})

describe('planEviction — the 500-item limit', () => {
  it('keeps the newest 500 unpinned items and evicts the rest as retention-count', () => {
    const items = Array.from({ length: RETENTION_MAX_ITEMS + 3 }, (_, i) =>
      item({ id: `I${String(i).padStart(4, '0')}`, createdAt: NOW - i }),
    )
    const plan = planEviction(items, NOW)
    expect(plan).toHaveLength(3)
    expect(plan.every((ev) => ev.reason === 'retention-count')).toBe(true)
    expect(plan.map((ev) => String(ev.id)).sort()).toEqual(['I0500', 'I0501', 'I0502'])
  })

  it('pinned items are exempt from the count limit and do not consume a slot', () => {
    const items = [
      item({ id: 'PINNED-ANCIENT', createdAt: NOW - RETENTION_MAX_AGE_MS * 10, pinned: true }),
      ...Array.from({ length: RETENTION_MAX_ITEMS + 1 }, (_, i) =>
        item({ id: `I${String(i).padStart(4, '0')}`, createdAt: NOW - i }),
      ),
    ]
    expect(planEviction(items, NOW).map((ev) => String(ev.id))).toEqual(['I0500'])
  })
})

describe('planEviction — the 30-day limit', () => {
  it('evicts at exactly 30 days and keeps an item 1 ms younger', () => {
    const items = [
      item({ id: 'OLD', createdAt: NOW - RETENTION_MAX_AGE_MS }),
      item({ id: 'YOUNG', createdAt: NOW - RETENTION_MAX_AGE_MS + 1 }),
    ]
    expect(planEviction(items, NOW)).toEqual([{ id: 'OLD', reason: 'retention-age' }])
  })

  it('pinned items are exempt from the age limit forever', () => {
    const items = [item({ id: 'OLD-PINNED', createdAt: NOW - RETENTION_MAX_AGE_MS * 100, pinned: true })]
    expect(planEviction(items, NOW)).toEqual([])
  })
})

describe('planEviction — the 512 MiB limit', () => {
  it('evicts oldest-first once unpinned bytes exceed the budget', () => {
    const half = RETENTION_MAX_BYTES / 2
    const items = [
      item({ id: 'C-NEW', createdAt: NOW, bytes: half }),
      item({ id: 'B-MID', createdAt: NOW - 1, bytes: half }),
      item({ id: 'A-OLD', createdAt: NOW - 2, bytes: half }),
    ]
    expect(planEviction(items, NOW)).toEqual([{ id: 'A-OLD', reason: 'retention-bytes' }])
  })

  it('pinned bytes never count towards the budget and pinned items are never evicted', () => {
    const items = [
      item({ id: 'PIN-HUGE', createdAt: NOW - 5, bytes: RETENTION_MAX_BYTES * 2, pinned: true }),
      item({ id: 'SMALL', createdAt: NOW, bytes: 10 }),
    ]
    expect(planEviction(items, NOW)).toEqual([])
  })
})

describe('planEviction — the 5-minute secret TTL', () => {
  it('evicts a secret-flagged item at exactly its expiry, not 1 ms before', () => {
    const items = [item({ id: 'S', createdAt: NOW, expiresAt: NOW + SECRET_TTL_MS })]
    expect(planEviction(items, NOW + SECRET_TTL_MS - 1)).toEqual([])
    expect(planEviction(items, NOW + SECRET_TTL_MS)).toEqual([{ id: 'S', reason: 'secret-ttl' }])
  })

  it('reports each id at most once, with the most specific reason, when several limits bite', () => {
    const items = [
      item({
        id: 'DOOMED',
        createdAt: NOW - RETENTION_MAX_AGE_MS,
        bytes: RETENTION_MAX_BYTES * 2,
        expiresAt: NOW - 1,
      }),
    ]
    expect(planEviction(items, NOW)).toEqual([{ id: 'DOOMED', reason: 'secret-ttl' }])
  })
})

describe('local eviction emits no tombstone that could ever replicate', () => {
  it('every reason planEviction can produce is non-syncable; only a user delete is', () => {
    // Otherwise a phone with a smaller cap would delete items off the desktop (spec §4).
    const reasons = new Set([
      ...planEviction([item({ id: 'A', createdAt: NOW, expiresAt: NOW })], NOW).map((ev) => ev.reason),
      ...planEviction([item({ id: 'B', createdAt: NOW - RETENTION_MAX_AGE_MS })], NOW).map((ev) => ev.reason),
      ...planEviction(
        Array.from({ length: RETENTION_MAX_ITEMS + 1 }, (_, i) => item({ id: `C${i}`, createdAt: NOW - i })),
        NOW,
      ).map((ev) => ev.reason),
      ...planEviction(
        [
          item({ id: 'D', createdAt: NOW, bytes: RETENTION_MAX_BYTES }),
          item({ id: 'E', createdAt: NOW - 1, bytes: 1 }),
        ],
        NOW,
      ).map((ev) => ev.reason),
    ])
    expect([...reasons].sort()).toEqual([
      'retention-age',
      'retention-bytes',
      'retention-count',
      'secret-ttl',
    ])
    for (const r of reasons) expect(isSyncableDelete(r)).toBe(false)
    expect(isSyncableDelete('user')).toBe(true)
    expect(SYNCABLE_DELETE_REASONS).toEqual(['user'])
  })
})
