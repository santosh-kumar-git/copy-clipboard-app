import {
  RETENTION_MAX_BYTES,
  RETENTION_MAX_ITEMS,
  SECRET_TTL_MS,
  type DeleteReason,
  type Item,
  type ItemId,
} from '@cairn/protocol'

export interface RetentionLimits {
  readonly maxItems: number
  /** null = never expire by age. The count limit is the promise; age is opt-in. */
  readonly maxAgeMs: number | null
  readonly maxBytes: number
  readonly secretTtlMs: number
}

export const DEFAULT_RETENTION: RetentionLimits = {
  maxItems: RETENTION_MAX_ITEMS,
  maxAgeMs: null,
  maxBytes: RETENTION_MAX_BYTES,
  secretTtlMs: SECRET_TTL_MS,
}

export interface Eviction {
  readonly id: ItemId
  readonly reason: DeleteReason
}

/**
 * The ONLY delete reason that may ever be replicated. Local eviction is local (spec §4): a phone
 * with a 100-item cap must not be able to delete 400 items off your desktop. M1 has no sync, but
 * this is the enforcement point M5 reads.
 */
export const SYNCABLE_DELETE_REASONS = ['user'] as const

export function isSyncableDelete(reason: DeleteReason): boolean {
  return (SYNCABLE_DELETE_REASONS as readonly DeleteReason[]).includes(reason)
}

/**
 * Pure. Applies all four limits — whichever bites first — and returns each doomed id exactly once,
 * with the reason of the first limit that condemned it. Pinned items are exempt from every limit
 * and their bytes do not count towards the budget. Sorting happens inside, so the caller may pass
 * items in any order and get the same answer.
 */
export function planEviction(
  items: readonly Item[],
  nowMs: number,
  limits: RetentionLimits = DEFAULT_RETENTION,
): readonly Eviction[] {
  const evictions: Eviction[] = []
  const doomed = new Set<ItemId>()
  const condemn = (it: Item, reason: DeleteReason): void => {
    if (doomed.has(it.id)) return
    doomed.add(it.id)
    evictions.push({ id: it.id, reason })
  }

  // Newest first, with the id as an absolute tiebreak so the plan is byte-identical across runs.
  const newestFirst = [...items].sort(
    (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )

  // 1. Secret TTL. Deliberately first, and NOT exempted by `pinned`: a secret can never be pinned
  //    (`isPinnable` refuses it), so a pinned secret would mean a bug upstream, and expiring it is
  //    the safe reading. Note this reads `it.expiresAt` and NOT `limits.secretTtlMs`: the TTL is
  //    applied once, at ingest, by `@cairn/privacy`'s `secretExpiresAt`, and stamped into the item.
  //    `limits.secretTtlMs` records the value that stamp was made with — it is not re-applied here,
  //    because re-deriving an expiry from a mutable limit would let a config change resurrect an
  //    already-expired secret.
  for (const it of newestFirst) {
    if (it.expiresAt !== null && nowMs >= it.expiresAt) condemn(it, 'secret-ttl')
  }
  // 2. Age.
  for (const it of newestFirst) {
    if (it.pinned || doomed.has(it.id)) continue
    if (limits.maxAgeMs !== null && nowMs - it.createdAt >= limits.maxAgeMs) {
      condemn(it, 'retention-age')
    }
  }
  // 3. Count.
  let kept = 0
  for (const it of newestFirst) {
    if (it.pinned || doomed.has(it.id)) continue
    kept += 1
    if (kept > limits.maxItems) condemn(it, 'retention-count')
  }
  // 4. Bytes.
  let bytes = 0
  for (const it of newestFirst) {
    if (it.pinned || doomed.has(it.id)) continue
    bytes += it.byteLength
    if (bytes > limits.maxBytes) condemn(it, 'retention-bytes')
  }
  return evictions
}
