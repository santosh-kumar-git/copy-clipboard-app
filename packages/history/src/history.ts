import { randomBytes } from 'node:crypto'
import {
  PREVIEW_MAX_CHARS,
  TABS_MAX,
  TAGS_MAX_PER_ITEM,
  TITLE_MAX_CHARS,
  contentHash,
  err,
  newItemId,
  normalizeTag,
  normalizeTitle,
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
  type Tab,
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
  /** Restrict to one tab. Normalised here, so a caller may pass what the user typed. */
  readonly tag?: string
}
export interface ListResult {
  readonly items: readonly Item[]
  readonly total: number
}
/** What `search` may be narrowed by, so a query typed inside a tab searches that tab. */
export interface SearchFilter {
  readonly kind?: ItemKind
  readonly pinnedOnly?: boolean
  readonly tag?: string
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
  search(q: string, limit: number, filter?: SearchFilter): readonly ScoredItem[]
  resolveReps(id: ItemId): Promise<Result<readonly ResolvedRep[]>>
  pin(id: ItemId, pinned: boolean): Promise<Result<{ pinned: boolean }>>
  /**
   * Adds or removes one tab name on one item. Creating a tab and filling it are the same act: there
   * is no registry to add to, so `tabs()` grows the moment the first item carries the name and
   * shrinks again when the last one stops.
   */
  tag(id: ItemId, tag: string, tagged: boolean): Promise<Result<{ tags: readonly string[] }>>
  setTitle(id: ItemId, title: string | null): Promise<Result<{ title: string | null }>>
  /** Every tab that currently has at least one live item, alphabetical, capped at TABS_MAX. */
  tabs(): readonly Tab[]
  /** How many live items are pinned — the Pinned tab's count. */
  pinnedCount(): number
  remove(id: ItemId): Promise<Result<{ removed: boolean }>>
  evictNow(): Promise<Result<{ evicted: number }>>
  evictPreviewCache(): void
  /**
   * Changes the item-count limit at runtime. Limits used to be frozen at construction, so a limit
   * changed in Settings could not take effect until the next launch, and nothing failed to say so.
   *
   * Deliberately narrower than a whole-`RetentionLimits` setter: `secretTtlMs` is a security
   * parameter the composition root owns, and a caller passing `config.retention` — which has no
   * `secretTtlMs` — would silently reset it.
   */
  setMaxItems(maxItems: number): void
  /**
   * True after `evictPreviewCache()` until the next `load()`. Callers need this because eviction is
   * NOT self-healing: previews are blanked and `search()` answers nothing until the encrypted store
   * is re-read, and `list()` is synchronous so it cannot re-read on its own.
   */
  previewsEvicted(): boolean
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

/** `''` — what a whitespace-only tab name normalises to — means "no filter", not "no matches". */
export function filterByTag(items: readonly Item[], tag: string | undefined): Item[] {
  const wanted = tag === undefined ? '' : normalizeTag(tag)
  if (wanted === '') return [...items]
  return items.filter((it) => it.tags.includes(wanted))
}

/**
 * Adds or removes one tab name. Pure, so the cap and the dedupe are testable without a store.
 * Three distinct answers, because the caller has to tell them apart:
 *  - `'invalid'`  the name normalises to nothing;
 *  - `'at-limit'` the item already carries TAGS_MAX_PER_ITEM tags. Refused loudly rather than
 *                 silently dropping the oldest: a tab the user asked for that quietly did not
 *                 happen is worse than being told no.
 *  - `'unchanged'` already in the requested state, so `tag()` writes no store record.
 */
export type ApplyTagOutcome =
  | { readonly kind: 'changed'; readonly tags: readonly string[] }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'at-limit' }

export function applyTag(
  current: readonly string[],
  rawTag: string,
  tagged: boolean,
): ApplyTagOutcome {
  const tag = normalizeTag(rawTag)
  if (tag === '') return { kind: 'invalid' }
  const has = current.includes(tag)
  if (tagged === has) return { kind: 'unchanged' }
  if (!tagged) return { kind: 'changed', tags: current.filter((t) => t !== tag) }
  if (current.length >= TAGS_MAX_PER_ITEM) return { kind: 'at-limit' }
  return { kind: 'changed', tags: [...current, tag].sort() }
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
  let limits = deps.retention ?? DEFAULT_RETENTION
  const items = new Map<ItemId, Item>()
  /** itemId -> the store `seq` of its ITEM_ADDED record. Restart-identical, unlike a random id. */
  const ord = new Map<ItemId, number>()
  const byHash = new Map<ContentHash, ItemId>()
  const pendingBlobDeletes = new Set<BlobId>()
  const listeners = new Set<(e: { reason: ChangeReason; total: number }) => void>()
  /** False after evictPreviewCache() until the next load(). Guards `search()` (spec §11 control 6). */
  let previewsLoaded = true
  let evictionEpoch = 0
  let loading: Promise<Result<{ items: number }>> | null = null
  const scrubPreview = (it: Item): Item => ({ ...it, title: null, preview: '', maskSpans: [] })
  const remember = (it: Item): void => {
    items.set(it.id, previewsLoaded ? it : scrubPreview(it))
  }

  const emit = (reason: ChangeReason): void => {
    for (const cb of listeners) cb({ reason, total: items.size })
  }
  const recency = (a: Item, b: Item): number =>
    b.updatedAt - a.updatedAt || (ord.get(b.id) ?? 0) - (ord.get(a.id) ?? 0)
  const reindex = (it: Item): void => {
    if (!previewsLoaded) return
    search.add({
      id: it.id,
      preview: it.title ?? it.preview,
      pinned: it.pinned,
      tagged: (it.tags?.length ?? 0) > 0,
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
  // Old records predate tags and titles.
  const withDefaults = (it: Item): Item => ({
    ...it, tags: Array.isArray(it.tags) ? it.tags : [], title: it.title ?? null,
  })
  const blobIds = (it: Item): Set<BlobId> => new Set([
    ...it.repRefs.map((ref) => ref.blobId),
    ...(it.thumbnailBlobId === null ? [] : [it.thumbnailBlobId]),
  ])
  const deleteUnreferencedBlobs = (): Result<void> => {
    for (const it of items.values()) {
      for (const id of blobIds(it)) pendingBlobDeletes.delete(id)
    }
    let result: Result<void> = ok(undefined)
    for (const id of pendingBlobDeletes) {
      const deleted = store.deleteBlob(id)
      if (!deleted.ok) {
        if (result.ok) result = deleted
      } else {
        pendingBlobDeletes.delete(id)
      }
    }
    return result
  }

  const replay = async (): Promise<Result<{ items: number }>> => {
    const startedAtEpoch = evictionEpoch
    const restored = new Map<ItemId, Item>()
    const restoredOrd = new Map<ItemId, number>()
    const restoredDeletes = new Set<BlobId>()
    for await (const rec of store.readAll()) {
      if (!rec.ok) return rec
      const ev = rec.value
      if (ev.kind === 'ITEM_ADDED') {
        restored.set(ev.item.id, withDefaults(ev.item))
        restoredOrd.set(ev.item.id, ev.seq)
      } else if (ev.kind === 'ITEM_UPDATED') {
        const cur = restored.get(ev.id)
        if (cur !== undefined) restored.set(ev.id, withDefaults({ ...cur, ...ev.patch }))
      } else if (ev.kind === 'ITEM_DELETED') {
        const removed = restored.get(ev.id)
        if (removed !== undefined) for (const id of blobIds(removed)) restoredDeletes.add(id)
        restored.delete(ev.id)
        restoredOrd.delete(ev.id)
      }
    }
    // Publish one complete snapshot; an eviction during replay must remain effective.
    previewsLoaded = evictionEpoch === startedAtEpoch
    items.clear()
    ord.clear()
    byHash.clear()
    search.clear()
    for (const it of restored.values()) remember(it)
    for (const [id, seq] of restoredOrd) ord.set(id, seq)
    for (const [hash, id] of indexByContentHash(items.values())) byHash.set(hash, id)
    for (const it of items.values()) reindex(it)
    for (const id of restoredDeletes) pendingBlobDeletes.add(id)
    const deleted = deleteUnreferencedBlobs()
    if (!deleted.ok) return deleted
    return ok({ items: items.size })
  }

  return {
    load() {
      if (loading === null) loading = replay().finally(() => { loading = null })
      return loading
    },

    async ingest(candidate) {
      while (loading !== null) {
        const loaded = await loading
        if (!loaded.ok) return loaded
      }
      const totalBytes = candidate.reps.reduce((n, r) => n + r.byteLength, 0)
      const primary = primaryRep(candidate.reps)
      // Capture's preview is already masked; only the original primary bytes retain detector input.
      const rawText = primary?.mime.startsWith('text/') ? Buffer.from(primary.bytes).toString('utf8') : null
      const snapshot: Snapshot = {
        reps: candidate.reps,
        primaryText: rawText,
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
        const appended = store.appendEvent({
          kind: 'ITEM_UPDATED',
          id: existingId,
          patch: bumped.patch,
        })
        if (!appended.ok) return appended
        remember(bumped.item)
        reindex(bumped.item)
        logger.info('history.duplicate', { itemId: existingId, kind: existing.kind })
        emit('update')
        return ok({ outcome: 'duplicate', item: bumped.item })
      }
      const masked = privacy.mask(rawText ?? '')
      const { preview, previewTruncated } = truncatePreview(masked.preview)
      const repRefs: RepRef[] = []
      for (const rep of candidate.reps) {
        const put = store.putBlob(rep.bytes)
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
        const put = store.putBlob(candidate.thumbnailJpeg)
        if (!put.ok) return put
        thumbnailBlobId = put.value
      }
      const item: Item = {
        id: newItemId(now, randomBytes(10)),
        kind: candidate.kind,
        title: null,
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
        tags: [],
        // `now + SECRET_TTL_MS` inlined here would be a second copy of the 5-minute rule. Task 7's
        // predicate returns null for every non-secret flag set, which is the whole contract.
        expiresAt: secretExpiresAt(now, verdict.flags),
      }
      // No `at:` — the store stamps it from its own clock, and passing it is a TS2353 error.
      const appended = store.appendEvent({ kind: 'ITEM_ADDED', item })
      if (!appended.ok) return appended
      remember(item)
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
      live = filterByTag(live, q.tag)
      // Pure recency — pinned items are NOT floated to the top. They were, and it made the one list
      // people actually read lie about when things were copied: a pin from last week sat above the
      // thing you copied ten seconds ago. Pinned items now have their own tab, which is the honest
      // place for "show me only these", so this list can stay a timeline.
      live.sort(recency)
      const offset = q.offset ?? 0
      const limit = q.limit ?? live.length
      return { items: live.slice(offset, offset + limit), total: live.length }
    },

    search(q, limit, filter = {}) {
      if (!previewsLoaded || limit < 1) return []
      const now = clock.now()
      const tag = filter.tag === undefined ? '' : normalizeTag(filter.tag)
      const out: ScoredItem[] = []
      for (const hit of search.query(q, search.size)) {
        const it = items.get(hit.id)
        if (it === undefined || !isLive(it, now)) continue
        if (filter.kind !== undefined && it.kind !== filter.kind) continue
        if (filter.pinnedOnly === true && !it.pinned) continue
        if (tag !== '' && !it.tags.includes(tag)) continue
        out.push({ item: it, score: hit.score, ranges: hit.ranges })
        if (out.length >= limit) break
      }
      return out
    },

    async resolveReps(id) {
      while (loading !== null) {
        const loaded = await loading
        if (!loaded.ok) return loaded
      }
      const it = items.get(id)
      if (it === undefined) return err('E_ITEM_NOT_FOUND', `no item ${id}`)
      if (!isLive(it, clock.now())) return err('E_ITEM_EXPIRED', `item ${id} has expired`)
      const reps: ResolvedRep[] = []
      for (const ref of it.repRefs) {
        const got = store.getBlob(ref.blobId)
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
      while (loading !== null) {
        const loaded = await loading
        if (!loaded.ok) return loaded
      }
      const it = items.get(id)
      if (it === undefined) return err('E_ITEM_NOT_FOUND', `no item ${id}`)
      // Refuse loudly. A silently ignored pin is how a user believes a secret is being kept.
      // `isPinnable` is Task 7's predicate, not a local `flags.includes('secret')`: one rule, one
      // implementation, so an M2 flag that must also block pinning cannot be missed here.
      if (pinned && !isPinnable(it.flags)) {
        return err('E_PIN_REFUSED_SECRET', `item ${id} is secret-flagged and cannot be pinned`)
      }
      // `updatedAt` is left alone. Bumping it made pinning move the item to the top of the timeline,
      // which is the same lie as sorting pinned rows first — a copy from last week would appear to
      // have just happened. Pinning changes how long an item lives, not when it was copied.
      const patch = { updatedAt: it.updatedAt, pinned }
      const appended = store.appendEvent({ kind: 'ITEM_UPDATED', id, patch })
      if (!appended.ok) return appended
      const next = { ...it, ...patch }
      remember(next)
      reindex(next)
      logger.info('history.pinned', { itemId: id, ok: pinned })
      emit('update')
      return ok({ pinned })
    },

    async tag(id, rawTag, tagged) {
      while (loading !== null) {
        const loaded = await loading
        if (!loaded.ok) return loaded
      }
      const it = items.get(id)
      if (it === undefined) return err('E_ITEM_NOT_FOUND', `no item ${id}`)
      const applied = applyTag(it.tags, rawTag, tagged)
      if (applied.kind === 'invalid') return err('E_TAG_INVALID', 'a tab name cannot be empty')
      if (applied.kind === 'at-limit') {
        return err('E_TAG_LIMIT', `item ${id} already has ${String(TAGS_MAX_PER_ITEM)} tabs`)
      }
      if (applied.kind === 'unchanged') return ok({ tags: it.tags })
      // `updatedAt` is deliberately NOT bumped: filing something into a tab is not re-copying it,
      // and moving it to the top of the timeline is exactly the confusion the un-floated pin fixed.
      const patch = { updatedAt: it.updatedAt, tags: applied.tags }
      const appended = store.appendEvent({ kind: 'ITEM_UPDATED', id, patch })
      if (!appended.ok) return appended
      const next = { ...it, ...patch }
      remember(next)
      reindex(next)
      // The COUNT only. A tab name is user-authored text typed into a field one keystroke away from a
      // clipboard search box, so it is never logged.
      logger.info('history.tagged', { itemId: id, count: applied.tags.length })
      emit('update')
      return ok({ tags: applied.tags })
    },

    async setTitle(id, rawTitle) {
      while (loading !== null) {
        const loaded = await loading
        if (!loaded.ok) return loaded
      }
      const it = items.get(id)
      if (it === undefined) return err('E_ITEM_NOT_FOUND', `no item ${id}`)
      if (rawTitle !== null && rawTitle.length > TITLE_MAX_CHARS) {
        return err('E_BAD_PARAMS', `a title cannot exceed ${TITLE_MAX_CHARS} characters`)
      }
      const title = normalizeTitle(rawTitle)
      if (previewsLoaded && title === (it.title ?? null)) return ok({ title })
      const patch = { updatedAt: it.updatedAt, title }
      const appended = store.appendEvent({ kind: 'ITEM_UPDATED', id, patch })
      if (!appended.ok) return appended
      const next = { ...it, ...patch }
      remember(next)
      reindex(next)
      emit('update')
      return ok({ title })
    },

    tabs() {
      const now = clock.now()
      const counts = new Map<string, number>()
      for (const it of items.values()) {
        if (!isLive(it, now)) continue
        for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
        .slice(0, TABS_MAX)
    },

    pinnedCount() {
      const now = clock.now()
      let n = 0
      for (const it of items.values()) if (it.pinned && isLive(it, now)) n += 1
      return n
    },

    async remove(id) {
      while (loading !== null) {
        const loaded = await loading
        if (!loaded.ok) return loaded
      }
      const it = items.get(id)
      if (it === undefined) {
        const deleted = deleteUnreferencedBlobs()
        return deleted.ok ? ok({ removed: false }) : deleted
      }
      const appended = store.appendEvent({ kind: 'ITEM_DELETED', id, reason: 'user' })
      if (!appended.ok) return appended
      for (const blobId of blobIds(it)) pendingBlobDeletes.add(blobId)
      forget(id)
      const deleted = deleteUnreferencedBlobs()
      logger.info('history.removed', { itemId: id })
      emit('delete')
      if (!deleted.ok) return deleted
      return ok({ removed: true })
    },

    async evictNow() {
      while (loading !== null) {
        const loaded = await loading
        if (!loaded.ok) return loaded
      }
      const plan: readonly Eviction[] = planEviction([...items.values()], clock.now(), limits)
      let evicted = 0
      let persisted: Result<void> = ok(undefined)
      for (const ev of plan) {
        const it = items.get(ev.id)
        if (it === undefined) continue
        // The local log always records the delete — the hash chain requires it — but the reason is
        // never 'user', so `isSyncableDelete` keeps it off any future wire (spec §4).
        const appended = store.appendEvent({
          kind: 'ITEM_DELETED',
          id: ev.id,
          reason: ev.reason,
        })
        if (!appended.ok) {
          persisted = appended
          break
        }
        for (const id of blobIds(it)) pendingBlobDeletes.add(id)
        forget(ev.id)
        evicted += 1
      }
      const deleted = deleteUnreferencedBlobs()
      if (evicted > 0) {
        logger.info('history.evicted', { count: evicted })
        emit('evict')
      }
      if (!persisted.ok) return persisted
      if (!deleted.ok) return deleted
      return ok({ evicted })
    },

    evictPreviewCache() {
      search.clear()
      previewsLoaded = false
      evictionEpoch += 1
      // JavaScript cannot zero a string, so the honest control is to drop every reference and stop
      // answering searches until load() re-reads the encrypted store.
      for (const it of items.values()) remember(it)
    },

    setMaxItems(maxItems) {
      limits = { ...limits, maxItems }
    },

    previewsEvicted() {
      return !previewsLoaded
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
