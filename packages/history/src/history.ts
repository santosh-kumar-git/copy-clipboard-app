import { randomBytes } from 'node:crypto'
import {
  PREVIEW_MAX_CHARS,
  contentHash,
  err,
  newItemId,
  ok,
  type BlobId,
  type Candidate,
  type Classification,
  type Clock,
  type ContentHash,
  type Item,
  type ItemId,
  type ItemKind,
  type Logger,
  type MaskSpan,
  type PrivacyRules,
  type RepRef,
  type ResolvedRep,
  type Result,
  type ScoredItem,
  type Snapshot,
  type Unsub,
} from '@cairn/protocol'
// The 5-minute TTL rule lives in ONE place, and it is not this file. `isPinnable` joins it in Step 36.
import { isPinnable, secretExpiresAt } from '@cairn/privacy'
import { bumpUpdatedAt, indexByContentHash } from './dedupe'
import { DEFAULT_RETENTION, planEviction, type Eviction, type RetentionLimits } from './retention'
import type { SearchIndex } from '@cairn/search'
import type { Store } from '@cairn/store'

/** Injected rather than imported, so every history test can run without a real detector table. */
export interface PrivacyPort {
  readonly rules: PrivacyRules
  classify(snapshot: Snapshot, rules: PrivacyRules): Classification
  mask(text: string): { readonly preview: string; readonly spans: readonly MaskSpan[] }
}

export interface HistoryDeps {
  readonly store: Store
  readonly privacy: PrivacyPort
  readonly search: SearchIndex
  readonly clock: Clock
  readonly logger: Logger
  readonly retention?: RetentionLimits
}

export interface ListQuery {
  readonly limit?: number
  readonly offset?: number
  readonly kind?: ItemKind
  readonly pinnedOnly?: boolean
}
export interface ListResult {
  readonly items: readonly Item[]
  readonly total: number
}
export type ChangeReason = 'ingest' | 'update' | 'delete' | 'evict'
export type IngestOutcome =
  | { readonly outcome: 'added'; readonly item: Item }
  | { readonly outcome: 'duplicate'; readonly item: Item }
  | { readonly outcome: 'skipped'; readonly reason: string }

export interface History {
  load(): Promise<Result<{ items: number }>>
  ingest(candidate: Candidate): Promise<Result<IngestOutcome>>
  list(q?: ListQuery): ListResult
  search(q: string, limit: number): readonly ScoredItem[]
  resolveReps(id: ItemId): Promise<Result<readonly ResolvedRep[]>>
  pin(id: ItemId, pinned: boolean): Promise<Result<{ pinned: boolean }>>
  remove(id: ItemId): Promise<Result<{ removed: boolean }>>
  evictNow(): Promise<Result<{ evicted: number }>>
  evictPreviewCache(): void
  get(id: ItemId): Item | undefined
  onChange(cb: (e: { reason: ChangeReason; total: number }) => void): Unsub
}

/** Frozen by the contract §5.5, so two machines hash and label the same copy identically. */
const PRIMARY_ORDER = ['text/plain', 'text/uri-list', 'image/png', 'text/html', 'text/rtf'] as const

export function primaryRep(reps: readonly ResolvedRep[]): ResolvedRep | undefined {
  for (const mime of PRIMARY_ORDER) {
    const hit = reps.find((r) => r.mime === mime)
    if (hit !== undefined) return hit
  }
  return reps[0]
}

/** One palette row is one line, so runs of whitespace collapse before the 512-char cut. */
export function truncatePreview(text: string): { preview: string; previewTruncated: boolean } {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= PREVIEW_MAX_CHARS
    ? { preview: oneLine, previewTruncated: false }
    : { preview: oneLine.slice(0, PREVIEW_MAX_CHARS), previewTruncated: true }
}

export function createHistory(deps: HistoryDeps): History {
  const { store, privacy, search, clock, logger } = deps
  const limits = deps.retention ?? DEFAULT_RETENTION
  const items = new Map<ItemId, Item>()
  /** itemId -> the store `seq` of its ITEM_ADDED record. Restart-identical, unlike a random id. */
  const ord = new Map<ItemId, number>()
  const byHash = new Map<ContentHash, ItemId>()
  const listeners = new Set<(e: { reason: ChangeReason; total: number }) => void>()
  /** False after evictPreviewCache() until the next load(). Guards `search()` (spec §11 control 6). */
  let previewsLoaded = true

  const emit = (reason: ChangeReason): void => {
    for (const cb of listeners) cb({ reason, total: items.size })
  }
  const recency = (a: Item, b: Item): number =>
    b.updatedAt - a.updatedAt || (ord.get(b.id) ?? 0) - (ord.get(a.id) ?? 0)
  const reindex = (it: Item): void => {
    search.add({
      id: it.id,
      preview: it.preview,
      pinned: it.pinned,
      updatedAt: it.updatedAt,
      ord: ord.get(it.id) ?? 0,
    })
  }
  const forget = (id: ItemId): void => {
    const it = items.get(id)
    items.delete(id)
    ord.delete(id)
    search.remove(id)
    if (it !== undefined && byHash.get(it.contentHash) === id) byHash.delete(it.contentHash)
  }
  const isLive = (it: Item, nowMs: number): boolean => it.expiresAt === null || nowMs < it.expiresAt

  return {
    async load() {
      items.clear()
      ord.clear()
      byHash.clear()
      search.clear()
      for await (const rec of store.readAll()) {
        if (!rec.ok) return rec
        const ev = rec.value
        if (ev.kind === 'ITEM_ADDED') {
          items.set(ev.item.id, ev.item)
          ord.set(ev.item.id, ev.seq)
        } else if (ev.kind === 'ITEM_UPDATED') {
          const cur = items.get(ev.id)
          if (cur !== undefined) items.set(ev.id, { ...cur, ...ev.patch })
        } else if (ev.kind === 'ITEM_DELETED') {
          items.delete(ev.id)
          ord.delete(ev.id)
        }
        // CHECKPOINT carries no item state in M1; the store owns maxSeq and the watermark vector.
      }
      for (const [hash, id] of indexByContentHash(items.values())) byHash.set(hash, id)
      previewsLoaded = true
      for (const it of items.values()) reindex(it)
      return ok({ items: items.size })
    },

    async ingest(candidate) {
      const totalBytes = candidate.reps.reduce((n, r) => n + r.byteLength, 0)
      const snapshot: Snapshot = {
        reps: candidate.reps,
        primaryText: candidate.primaryText,
        kind: candidate.kind,
        hints: candidate.hints,
        sourceApp: candidate.sourceApp,
        totalBytes,
      }
      // Classified here as well as in `capture`: two independent refusals are cheaper than one
      // missed concealed hint, and this is the only layer that can refuse to WRITE.
      const verdict = privacy.classify(snapshot, privacy.rules)
      if (verdict.action === 'skip') {
        logger.info('privacy.skipped', { kind: candidate.kind, flags: verdict.flags })
        return ok({ outcome: 'skipped', reason: verdict.reason })
      }
      const now = clock.now()
      const existingId = byHash.get(candidate.contentHash)
      const existing = existingId === undefined ? undefined : items.get(existingId)
      if (existingId !== undefined && existing !== undefined) {
        const bumped = bumpUpdatedAt(existing, now)
        const appended = await store.appendEvent({
          kind: 'ITEM_UPDATED',
          id: existingId,
          patch: bumped.patch,
        })
        if (!appended.ok) return appended
        items.set(existingId, bumped.item)
        reindex(bumped.item)
        logger.info('history.duplicate', { itemId: existingId, kind: existing.kind })
        emit('update')
        return ok({ outcome: 'duplicate', item: bumped.item })
      }
      const masked = privacy.mask(candidate.primaryText ?? '')
      const { preview, previewTruncated } = truncatePreview(masked.preview)
      const repRefs: RepRef[] = []
      for (const rep of candidate.reps) {
        const put = await store.putBlob(rep.bytes)
        if (!put.ok) return put
        repRefs.push({
          mime: rep.mime,
          uti: rep.uti,
          byteLength: rep.byteLength,
          sha256: rep.sha256,
          blobId: put.value,
        })
      }
      let thumbnailBlobId: BlobId | null = null
      if (candidate.thumbnailJpeg !== null) {
        const put = await store.putBlob(candidate.thumbnailJpeg)
        if (!put.ok) return put
        thumbnailBlobId = put.value
      }
      const item: Item = {
        id: newItemId(now, randomBytes(10)),
        kind: candidate.kind,
        contentHash: candidate.contentHash,
        preview,
        previewTruncated,
        maskSpans: masked.spans,
        flags: verdict.flags,
        repRefs,
        thumbnailBlobId,
        sourceApp: candidate.sourceApp,
        byteLength: repRefs.reduce((n, r) => n + r.byteLength, 0),
        createdAt: now,
        updatedAt: now,
        pinned: false,
        // `now + SECRET_TTL_MS` inlined here would be a second copy of the 5-minute rule. Task 7's
        // predicate returns null for every non-secret flag set, which is the whole contract.
        expiresAt: secretExpiresAt(now, verdict.flags),
      }
      // No `at:` — the store stamps it from its own clock, and passing it is a TS2353 error.
      const appended = await store.appendEvent({ kind: 'ITEM_ADDED', item })
      if (!appended.ok) return appended
      items.set(item.id, item)
      ord.set(item.id, appended.value.seq)
      byHash.set(item.contentHash, item.id)
      reindex(item)
      logger.info('history.ingested', {
        itemId: item.id,
        kind: item.kind,
        byteLength: item.byteLength,
        flags: item.flags,
      })
      emit('ingest')
      return ok({ outcome: 'added', item })
    },

    list(q = {}) {
      const now = clock.now()
      let live = [...items.values()].filter((it) => isLive(it, now))
      if (q.pinnedOnly === true) live = live.filter((it) => it.pinned)
      if (q.kind !== undefined) live = live.filter((it) => it.kind === q.kind)
      live.sort((a, b) => Number(b.pinned) - Number(a.pinned) || recency(a, b))
      const offset = q.offset ?? 0
      const limit = q.limit ?? live.length
      return { items: live.slice(offset, offset + limit), total: live.length }
    },

    search(q, limit) {
      if (!previewsLoaded) return []
      const now = clock.now()
      const out: ScoredItem[] = []
      for (const hit of search.query(q, limit)) {
        const it = items.get(hit.id)
        if (it === undefined || !isLive(it, now)) continue
        out.push({ item: it, score: hit.score, ranges: hit.ranges })
      }
      return out
    },

    async resolveReps(id) {
      const it = items.get(id)
      if (it === undefined) return err('E_ITEM_NOT_FOUND', `no item ${id}`)
      if (!isLive(it, clock.now())) return err('E_ITEM_EXPIRED', `item ${id} has expired`)
      const reps: ResolvedRep[] = []
      for (const ref of it.repRefs) {
        const got = await store.getBlob(ref.blobId)
        if (!got.ok) return got
        // Verify before handing bytes to anyone: cheap, and it turns a silent corruption into a code.
        if (contentHash(got.value) !== ref.sha256) {
          return err('E_STORE_CORRUPT', `blob ${ref.blobId} does not match its declared hash`)
        }
        reps.push({
          mime: ref.mime,
          uti: ref.uti,
          bytes: got.value,
          byteLength: got.value.length,
          sha256: ref.sha256,
        })
      }
      return ok(reps)
    },

    async pin(id, pinned) {
      const it = items.get(id)
      if (it === undefined) return err('E_ITEM_NOT_FOUND', `no item ${id}`)
      // Refuse loudly. A silently ignored pin is how a user believes a secret is being kept.
      // `isPinnable` is Task 7's predicate, not a local `flags.includes('secret')`: one rule, one
      // implementation, so an M2 flag that must also block pinning cannot be missed here.
      if (pinned && !isPinnable(it.flags)) {
        return err('E_PIN_REFUSED_SECRET', `item ${id} is secret-flagged and cannot be pinned`)
      }
      const now = clock.now()
      const patch = { updatedAt: now, pinned }
      const appended = await store.appendEvent({ kind: 'ITEM_UPDATED', id, patch })
      if (!appended.ok) return appended
      const next = { ...it, ...patch }
      items.set(id, next)
      reindex(next)
      logger.info('history.pinned', { itemId: id, ok: pinned })
      emit('update')
      return ok({ pinned })
    },

    async remove(id) {
      const it = items.get(id)
      if (it === undefined) return ok({ removed: false })
      const appended = await store.appendEvent({ kind: 'ITEM_DELETED', id, reason: 'user' })
      if (!appended.ok) return appended
      for (const ref of it.repRefs) {
        const del = await store.deleteBlob(ref.blobId)
        if (!del.ok) return del
      }
      if (it.thumbnailBlobId !== null) {
        const del = await store.deleteBlob(it.thumbnailBlobId)
        if (!del.ok) return del
      }
      forget(id)
      logger.info('history.removed', { itemId: id })
      emit('delete')
      return ok({ removed: true })
    },

    async evictNow() {
      const plan: readonly Eviction[] = planEviction([...items.values()], clock.now(), limits)
      for (const ev of plan) {
        const it = items.get(ev.id)
        if (it === undefined) continue
        // The local log always records the delete — the hash chain requires it — but the reason is
        // never 'user', so `isSyncableDelete` keeps it off any future wire (spec §4).
        const appended = await store.appendEvent({
          kind: 'ITEM_DELETED',
          id: ev.id,
          reason: ev.reason,
        })
        if (!appended.ok) return appended
        for (const ref of it.repRefs) {
          const del = await store.deleteBlob(ref.blobId)
          if (!del.ok) return del
        }
        if (it.thumbnailBlobId !== null) {
          const del = await store.deleteBlob(it.thumbnailBlobId)
          if (!del.ok) return del
        }
        forget(ev.id)
      }
      if (plan.length > 0) {
        logger.info('history.evicted', { count: plan.length })
        emit('evict')
      }
      return ok({ evicted: plan.length })
    },

    evictPreviewCache() {
      search.clear()
      previewsLoaded = false
      // JavaScript cannot zero a string, so the honest control is to drop every reference and stop
      // answering searches until load() re-reads the encrypted store.
      for (const [id, it] of items) items.set(id, { ...it, preview: '', maskSpans: [] })
    },

    get(id) {
      return items.get(id)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}
