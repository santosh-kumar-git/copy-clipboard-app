### Task 8: @cairn/history + @cairn/search — the domain service and palette ranking

These two packages are the **domain layer**: everything the palette needs, with no OS access and no
crypto. `@cairn/history` owns "what is in my clipboard history and what may stay there";
`@cairn/search` owns "given what the user typed, which rows and in what order". Both are pure
TypeScript over injected ports (`Store`, `Clock`, `Logger`, a privacy port and the search index), so
every test in this task runs on any machine with no compiler, no keychain, no clipboard and no OS
permission.

Two security controls live here and nowhere else, so they are tests, not comments:

- **The in-memory index holds masked previews only** (spec §11 control 5). Raw secret bytes exist only
  inside the encrypted store. The index is the one long-lived plaintext structure in the product, so
  it must never contain a raw token.
- **`evictPreviewCache()` really empties it** (spec §11 control 6, §10 "encrypted store is an at-rest
  claim only"). This is the control that bounds the window in which a long-lived process holds
  decrypted previews in RAM.

And one sync-safety control that looks like a detail and is not: **local eviction emits no tombstone
that could ever replicate** (spec §4). If a retention delete were syncable, a phone with a 100-item
cap would silently delete 400 items off your desktop. M1 has no sync, but the enforcement point is
here, in M1, because M5 reads it.

Two neighbouring controls deliberately do **not** live here, and the discipline is to import them
rather than re-derive them:

- **The 5-minute secret TTL** is `@cairn/privacy`'s `secretExpiresAt(createdAt, flags)`. `ingest`
  stamps its result into `Item.expiresAt` and `planEviction` honours that stamp; neither writes
  `now + SECRET_TTL_MS`.
- **"A secret is never pinnable"** is `@cairn/privacy`'s `isPinnable(flags)`. `pin()` calls it. A local
  `flags.includes('secret')` would compile, pass every test in this file, and silently miss the next
  flag M2 adds to the non-pinnable set.

---

**Files:**

Create:
- `packages/search/src/index.ts`
- `packages/history/src/index.ts`
- `packages/history/src/dedupe.ts`
- `packages/history/src/retention.ts`
- `packages/history/src/history.ts`

Test:
- `packages/search/src/index.test.ts`
- `packages/search/src/index.security.test.ts`
- `packages/history/src/dedupe.test.ts`
- `packages/history/src/retention.test.ts`
- `packages/history/src/history.test.ts`

Verify (do NOT create — they already exist):
- `packages/search/package.json`
- `packages/history/package.json`

Both manifests are written by **Task 1**, in its step that writes the ten workspace manifests, because
the root `package.json`'s `workspaces` array has to be complete before Task 1's own `npm install` can
link anything. Writing them again here would fork two files that are already on `main` — with a
different `description` in each copy, which is exactly the drift this task must not add. Step 2 asserts
their contents instead.

Modify: nothing. This task creates only files inside its own two packages' `src/` directories.

---

**Interfaces:**

`Consumes:` — exact signatures this task relies on. Do not redeclare any of these; import them.

From `@cairn/protocol` (Task 2):

```ts
export type ContentHash = string & { readonly [contentHashBrand]: 'sha256-b64url' }
export type BlobId = ContentHash
export type ItemId = string & { readonly [itemIdBrand]: 'cairn-id' }
export function contentHash(bytes: Uint8Array): ContentHash
export function newItemId(nowMs: number, rnd: Uint8Array): ItemId

export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly detail?: LogFields }
export type Result<T> = Ok<T> | Err
export const ok: <T>(value: T) => Ok<T>
export const err: (code: ErrorCode, message: string, detail?: LogFields) => Err

export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Cancel }
export interface TestClock extends Clock { advance(ms: number): void; readonly pending: number }
export function createTestClock(startMs?: number): TestClock
export type Unsub = () => void

export interface Logger {
  debug<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  info<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  warn<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  log<T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>): void
}

export type ItemKind = 'text' | 'richtext' | 'image' | 'files'
export type Flag = 'secret' | 'concealed' | 'transient' | 'auto-generated' | 'excluded' | 'no-sync' | 'cut'
export type DeleteReason = 'user' | 'retention-count' | 'retention-age' | 'retention-bytes' | 'secret-ttl' | 'rekey'
export interface ResolvedRep { readonly mime: string; readonly uti: string | null; readonly bytes: Uint8Array; readonly byteLength: number; readonly sha256: ContentHash }
export interface Snapshot { readonly reps: readonly ResolvedRep[]; readonly primaryText: string | null; readonly kind: ItemKind; readonly hints: readonly PasteboardHint[]; readonly sourceApp: SourceApp | null; readonly totalBytes: number }
export interface Candidate { readonly reps: readonly ResolvedRep[]; readonly kind: ItemKind; readonly contentHash: ContentHash; readonly primaryText: string | null; readonly hints: readonly PasteboardHint[]; readonly sourceApp: SourceApp | null; readonly thumbnailJpeg: Uint8Array | null; readonly changeToken: string; readonly capturedAt: number }
export interface RepRef { readonly mime: string; readonly uti: string | null; readonly byteLength: number; readonly sha256: ContentHash; readonly blobId: BlobId }
export interface MaskSpan { readonly start: number; readonly end: number; readonly detector: DetectorName }
export interface Item { /* §5.6 of the contract, verbatim */ }
export interface ItemPatch { readonly updatedAt: number; readonly pinned?: boolean; readonly expiresAt?: number | null }
export type StoreEvent = /* the 4-member union in §5.6 */
export interface ScoredItem { readonly item: Item; readonly score: number; readonly ranges: readonly number[] }
export interface Classification { readonly action: 'record' | 'skip'; readonly flags: readonly Flag[]; readonly reason: string }
export interface PrivacyRules { readonly detectors: readonly DetectorName[]; readonly honourHints: boolean; readonly excludedBundleIds: readonly string[] }

export const SECRET_TTL_MS: 300_000
export const RETENTION_MAX_ITEMS: 500
export const RETENTION_MAX_AGE_MS: number      // 30 days in ms
export const RETENTION_MAX_BYTES: number       // 512 MiB
export const SEARCH_INDEX_DEFAULT: 500
export const SEARCH_INDEX_HARD_CAP: 2_000
export const PREVIEW_MAX_CHARS: 512
```

From `@cairn/store` (Task 6):

```ts
export interface OpenStoreOptions {
  readonly dir: string
  readonly key: Buffer                        // EXACTLY 32 bytes; a wrong length THROWS
  readonly clock: Clock
  readonly logger: Logger
  readonly unsafeTestHooks?: UnsafeTestHooks  // tests only; Task 8 never passes it
}
/** Returns Err (never throws) for a corrupt or wrong-keyed store; throws only for a bad key length. */
export function openStore(opts: OpenStoreOptions): Result<Store>

/** EVERY method except `readAll` is SYNCHRONOUS. Task 6 froze that: the log has one writer and the
 *  fsync-before-append ordering must never interleave. `await` on a sync `Result` is harmless, which
 *  is why the `await store.…` calls below read the way they do. */
export interface Store {
  appendEvent(input: StoreEventInput): Result<StoreEvent>
  readAll(): AsyncIterable<Result<StoreEvent>>   // stops at the first Err it yields
  checkpoint(liveItemCount: number): Result<StoreEvent>
  compact(liveIds: readonly ItemId[]): Result<CompactSummary>
  putBlob(bytes: Uint8Array): Result<BlobId>
  getBlob(id: BlobId): Result<Buffer>
  deleteBlob(id: BlobId): Result<boolean>
  stat(): Result<StoreStats>
  readMeta(): Result<StoreMeta>
  writeMeta(meta: StoreMeta): Result<void>
  layout(): DataDirLayout
  close(): void
}

/** `seq` and `at` are the STORE's to assign, so neither appears here. Passing `at:` to
 *  `appendEvent` is a TS2353 excess-property error — the store stamps it from its own clock. */
export type StoreEventInput =
  | { readonly kind: 'ITEM_ADDED'; readonly item: Item }
  | { readonly kind: 'ITEM_UPDATED'; readonly id: ItemId; readonly patch: ItemPatch }
  | { readonly kind: 'ITEM_DELETED'; readonly id: ItemId; readonly reason: DeleteReason }

export interface StoreStats {
  readonly lineCount: number
  readonly anchorSeq: number
  readonly maxSeq: number
  readonly logBytes: number
  readonly blobCount: number
  readonly blobBytes: number
  readonly tornLineRepairedOnOpen: boolean
}
export interface CompactSummary {
  readonly liveItemCount: number
  readonly linesBefore: number
  readonly linesAfter: number
  readonly blobsRemoved: number
  readonly maxSeq: number
}
export interface StoreMeta {
  readonly schemaVersion: 1
  readonly keyMode: 'os-keyring' | 'passphrase' | 'unknown'
  readonly scryptSaltB64: string | null
}
export interface DataDirLayout {
  readonly dir: string; readonly logPath: string; readonly tmpLogPath: string
  readonly metaPath: string; readonly keyPath: string; readonly blobDir: string
}
export interface UnsafeTestHooks { readonly onBeforeRename?: () => void; readonly onAfterRename?: () => void }

export function tempStoreDir(): { dir: string; cleanup: () => void }   // test helper, re-exported from the barrel
export function randomTestKey(): Buffer                                // test helper, re-exported from the barrel
```

Three consequences Task 8's code honours everywhere, because getting any of them wrong is a compile
error, not a test failure:

1. `openStore` yields **`Result<Store>`**, never a bare `Store`. Every harness unwraps it with an
   `if (!opened.ok) throw …` before handing `opened.value` to `createHistory`.
2. `appendEvent` takes the three-member `StoreEventInput` above and returns `Result<StoreEvent>`.
   `StoreEvent` carries `seq`, so `appended.value.seq` is the recency key `ord` stores — and no call
   site passes `at`.
3. `deleteBlob` returns `Result<boolean>` (**not** `Result<{deleted: boolean}>`) and `stat()` returns
   `Result<StoreStats>` with exactly the seven fields above — there is no `liveItemCount` and no
   `bytesOnDisk` on it. Task 8 reads neither: `remove` and `evictNow` only check `del.ok`, and
   nothing in Task 8 calls `stat()` at all.

`StoreStats` and `CompactSummary` are shown here for reference only — **import** them from
`@cairn/store` if you ever need them; Task 8 must not redeclare them.

From `@cairn/privacy` (Task 7):

```ts
export function classify(snapshot: Snapshot, rules: PrivacyRules): Classification
export function mask(text: string): { readonly preview: string; readonly spans: readonly MaskSpan[] }
export const DEFAULT_RULES: PrivacyRules
/** `createdAt + 300_000` when `flags` contains 'secret', else null. */
export function secretExpiresAt(createdAt: number, flags: readonly Flag[]): number | null
/** False for 'secret'; true for 'transient' | 'auto-generated' | 'cut' | 'no-sync' and for []. */
export function isPinnable(flags: readonly Flag[]): boolean
```

**`secretExpiresAt` and `isPinnable` are imported, never reimplemented.** Task 8 could trivially write
`now + SECRET_TTL_MS` and `flags.includes('secret')` itself, and that is precisely the mistake: "5-minute
TTL, never pinnable" is one security rule and it must have one implementation. If M2 adds a second
non-pinnable flag, Task 7's predicate learns it and this task inherits the fix. `SECRET_TTL_MS` is still
imported here — but only by `retention.ts`, to fill `DEFAULT_RETENTION.secretTtlMs`, and by the tests, to
assert the boundary.

From `@leeoniya/ufuzzy@1.0.19` — **verified on this machine, and the two surprises matter:**

```ts
import uFuzzy from '@leeoniya/ufuzzy'                 // CJS/ESM dual, DEFAULT export, no named export
new uFuzzy(opts?: uFuzzy.Options)
uf.search(haystack: string[], needle: string, outOfOrder?: number, infoThresh?: number, preFiltered?: number[] | null)
  : [number[], uFuzzy.Info, number[]] | [number[], null, null] | [null, null, null]
// info.ranges[n] is a FLAT number[] of alternating [start, end) offsets, matching ScoredItem.ranges.
```

What was measured (`npm install @leeoniya/ufuzzy@1.0.19` in a scratch dir, then a script):

1. **The default options do NOT do out-of-order-letter matching.** `intraIns` defaults to `0`, which
   means "no extra characters inside a term", so with defaults `search([...], 'wrhs')` returns `[]`
   for the haystack entry `warehouse inventory report`. The M1 demo requires that match, so
   `intraIns: Infinity` is mandatory. With it, the result is `idxs = [0]` and
   `info.ranges[0] = [0,1,2,3,4,5,7,8]` (w@0, r@2, h@4, s@7).
2. **`intraChars` defaults to `'[a-z\\d]'`, so a term cannot span a space.** `hlwrd` does not match
   `hello world from a long preview` with defaults. With `intraChars: '[\\s\\S]'` it matches and
   returns `[0,1,2,3,6,7,8,9,10,11]` — the exact array the frozen contract §5.6 quotes. `[\s\S]`
   rather than `.` because a preview can contain a newline and `.` does not match one.
3. **The default final tiebreak is alphabetical.** `uFuzzy`'s built-in sort falls through to
   `compare(haystack[a], haystack[b])`, which defaults to an `Intl.Collator`. In a clipboard palette
   that is wrong and looks broken: two equally-relevant rows would order by text, not by recency.
   Passing `compare: () => 0` neutralises it, and because `Array.prototype.sort` is stable, ties then
   fall back to haystack order — which we control and keep as newest-first. Measured: with the
   collator, haystack `['ab3','ab2','ab1']` and needle `ab` returns `ab1, ab2, ab3`; with
   `compare: () => 0` it returns `ab3, ab2, ab1`, i.e. haystack order preserved.
4. **A query with no searchable term returns `[null, null, null]`.** `''`, `'   '`, `'('`, `'*'` and
   `'\\'` all do. So `idxs === null` is not an error — it means "nothing to match on", and we treat it
   exactly like an empty query instead of crashing or returning nothing.
5. `uf.search` never throws on regex-special input: `'a(b'` matched `function a(b,c){return b+c}`.

`Produces:` — the exported names later tasks (9 hotkey, 10 wiring/IPC, 11 renderer) rely on.

```ts
// @cairn/search — packages/search/src/index.ts
export interface SearchEntry {
  readonly id: ItemId
  /** ALREADY MASKED by the time it gets here. The index never sees a raw secret. */
  readonly preview: string
  readonly pinned: boolean
  readonly updatedAt: number
  /** The store `seq` of this item's ITEM_ADDED record. A stable, restart-identical recency key. */
  readonly ord: number
}
export interface SearchHit {
  readonly id: ItemId
  /** 1 for the best hit, then 1/2, 1/3 … Monotonic and deterministic; display ordering only. */
  readonly score: number
  /** Flat alternating [start, end) UTF-16 offsets into `preview`, straight from ufuzzy. */
  readonly ranges: readonly number[]
}
export interface SearchIndex {
  add(entry: SearchEntry): void          // upsert by id
  remove(id: ItemId): boolean
  query(q: string, limit: number): readonly SearchHit[]
  clear(): void
  readonly size: number
  /** Every preview currently held, in query order. Exists so the security test can read the whole
   *  plaintext surface of the index. */
  debugHaystack(): readonly string[]
}
export const UFUZZY_OPTIONS: {
  readonly intraIns: number; readonly interIns: number
  readonly intraChars: string; readonly interChars: string
  readonly compare: () => number
}
export function createSearchIndex(opts?: { limit?: number }): SearchIndex

// @cairn/history — packages/history/src/retention.ts
export interface RetentionLimits {
  readonly maxItems: number; readonly maxAgeMs: number; readonly maxBytes: number; readonly secretTtlMs: number
}
export const DEFAULT_RETENTION: RetentionLimits
export interface Eviction { readonly id: ItemId; readonly reason: DeleteReason }
export const SYNCABLE_DELETE_REASONS: readonly ['user']
export function isSyncableDelete(reason: DeleteReason): boolean
export function planEviction(items: readonly Item[], nowMs: number, limits?: RetentionLimits): readonly Eviction[]

// @cairn/history — packages/history/src/dedupe.ts
export function indexByContentHash(items: Iterable<Item>): Map<ContentHash, ItemId>
export function bumpUpdatedAt(item: Item, nowMs: number): { readonly item: Item; readonly patch: ItemPatch }

// @cairn/history — packages/history/src/history.ts
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
  readonly retention?: RetentionLimits     // omit for DEFAULT_RETENTION
}
export interface ListQuery {
  readonly limit?: number; readonly offset?: number; readonly kind?: ItemKind; readonly pinnedOnly?: boolean
}
export interface ListResult { readonly items: readonly Item[]; readonly total: number }
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
export function createHistory(deps: HistoryDeps): History
export function truncatePreview(text: string): { preview: string; previewTruncated: boolean }
export function primaryRep(reps: readonly ResolvedRep[]): ResolvedRep | undefined
```

`packages/search/src/index.ts` and `packages/history/src/index.ts` are the packages' only declared
`exports`. `packages/history/src/index.ts` is a barrel re-exporting `./dedupe`, `./retention` and
`./history`.

**Branch:** `m1/08-history-search`

---

- [ ] **Step 1: Create the branch.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git fetch origin && git checkout -b m1/08-history-search origin/main
```

Expected: `Switched to a new branch 'm1/08-history-search'`.

- [ ] **Step 2: Verify — do not rewrite — the two package manifests Task 1 already wrote.** Task 1's
      step that writes the ten workspace manifests created both of these, because the root
      `workspaces` array has to be complete before its `npm install` can link anything. Assert only
      what this task actually depends on: `name`, `type: "module"`, `private`, an `exports["."]` of
      `./src/index.ts`, `test` and `test:security` scripts naming the right vitest project, and a
      `dependencies` set exactly equal to contract §2's table — **two** entries for `@cairn/search`
      (`@cairn/protocol`, `@leeoniya/ufuzzy`) and **four** for `@cairn/history` (`@cairn/privacy`,
      `@cairn/protocol`, `@cairn/search`, `@cairn/store`). The `description` is deliberately **not**
      asserted: it is prose, and two tasks disagreeing about it is not a defect worth a red gate.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
node --input-type=module -e '
import { readFileSync } from "node:fs"
const want = {
  "@cairn/search": ["@cairn/protocol", "@leeoniya/ufuzzy"],
  "@cairn/history": ["@cairn/privacy", "@cairn/protocol", "@cairn/search", "@cairn/store"],
}
for (const dir of ["search", "history"]) {
  const m = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"))
  const deps = Object.keys(m.dependencies ?? {}).sort()
  const checks = [
    [m.name === `@cairn/${dir}`, `name is ${m.name}`],
    [m.type === "module", `type is ${m.type}`],
    [m.private === true, "private is not true"],
    [m.exports?.["."] === "./src/index.ts", `exports["."] is ${m.exports?.["."]}`],
    [m.scripts?.test === `vitest run --root ../.. --project unit packages/${dir}`, `test script is ${m.scripts?.test}`],
    [m.scripts?.["test:security"] === `vitest run --root ../.. --project security packages/${dir}`, `test:security script is ${m.scripts?.["test:security"]}`],
    [JSON.stringify(deps) === JSON.stringify(want[`@cairn/${dir}`]), `dependencies are ${JSON.stringify(deps)}`],
  ]
  for (const [ok, why] of checks) if (!ok) throw new Error(`packages/${dir}/package.json: ${why}`)
  console.log(`packages/${dir}/package.json OK (${deps.length} dependencies)`)
}
'
```

Expected, exactly:

```
packages/search/package.json OK (2 dependencies)
packages/history/package.json OK (4 dependencies)
```

If either throws, Task 1's manifest drifted from contract §2 — fix the manifest in place on this
branch and commit it with the first real commit below. Do **not** add a version range: every pin in
this repo is exact.

- [ ] **Step 3: Verify both workspaces are linked and `@leeoniya/ufuzzy` resolves.** Task 1's install
      already linked them; this only proves it, so a failure here is diagnosed before any test exists
      to blame.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
ls -ld node_modules/@cairn/search node_modules/@cairn/history
node -e "console.log(require('@leeoniya/ufuzzy/package.json').version)"
```

Expected: both `ls` lines begin with `l` (symlinks into `packages/`), and the `node` line prints
`1.0.19`. If `@leeoniya/ufuzzy` is missing, the root `devDependencies` pin from contract §2 is absent
— fix that, then `npm install`. If a `@cairn/*` symlink is missing, run `npm install` once; it is a
link, not a build, so there is nothing to compile.

- [ ] **Step 4: Establish the green baseline before writing a line of code.** Every "watch it fail"
      step below is only meaningful if the suite was green first — otherwise you cannot tell your new
      failure from an inherited one.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx tsc -p tsconfig.json
npm test
```

Expected: `tsc` exits 0 with no output, and `npm test` runs all **three** of `vitest.config.ts`'s
projects — `unit`, `security` and `renderer` — with `0 failed`. Use the bare `npm test` rather than
`npm run test:unit && npm run test:security`, because the `renderer` project is the one it is easy to
skip by accident, and a baseline that skipped a project is not a baseline. Nothing is committed in
this step — there is nothing new on disk yet.

- [ ] **Step 5: Write the first failing search test — out-of-order letters, ranges, limit and
      score.** This is the M1 demo's "type a few out-of-order letters" claim, expressed as
      assertions with the exact arrays measured from ufuzzy.

Create `packages/search/src/index.test.ts`:

```ts
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
```

- [ ] **Step 6: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run packages/search/src/index.test.ts
```

Expected: **FAIL** with
`Error: Cannot find module './index' imported from .../packages/search/src/index.test.ts`
and `search/src/index.test.ts (0 test)`. If you instead see 5 passing tests, you wrote the
implementation first.

- [ ] **Step 7: Write the minimal implementation.** Only matching, `add`, `size` and
      `debugHaystack` — `query('')`, `remove`, `clear` and the capacity cap come in the next cycle.

Create `packages/search/src/index.ts`:

```ts
import uFuzzy from '@leeoniya/ufuzzy'
import { SEARCH_INDEX_DEFAULT, SEARCH_INDEX_HARD_CAP, type ItemId } from '@cairn/protocol'

export interface SearchEntry {
  readonly id: ItemId
  /** ALREADY MASKED. `@cairn/history` masks at ingest, so a raw secret can never reach here. */
  readonly preview: string
  readonly pinned: boolean
  readonly updatedAt: number
  /** The store `seq` of the item's ITEM_ADDED record: a restart-identical recency tiebreak. */
  readonly ord: number
}

export interface SearchHit {
  readonly id: ItemId
  /** 1 for the best hit, then 1/2, 1/3 … Display ordering only; never a relevance percentage. */
  readonly score: number
  /** Flat alternating [start, end) UTF-16 offsets into `preview`, exactly as ufuzzy emits them. */
  readonly ranges: readonly number[]
}

export interface SearchIndex {
  add(entry: SearchEntry): void
  remove(id: ItemId): boolean
  query(q: string, limit: number): readonly SearchHit[]
  clear(): void
  readonly size: number
  debugHaystack(): readonly string[]
}

/**
 * Every one of these four overrides was measured, and ufuzzy's defaults get each one wrong for a
 * clipboard palette:
 *  - intraIns: 0 by default, which means `wrhs` does NOT match `warehouse`.
 *  - intraChars: '[a-z\d]' by default, so a term cannot span a space; `hlwrd` misses `hello world`.
 *  - compare: an Intl.Collator by default, so equally-relevant rows sort ALPHABETICALLY. Returning
 *    0 makes ufuzzy's stable sort fall back to haystack order, which we keep as newest-first.
 */
export const UFUZZY_OPTIONS = {
  intraIns: Infinity,
  interIns: Infinity,
  intraChars: '[\\s\\S]',
  interChars: '[\\s\\S]',
  compare: () => 0,
} as const

export function createSearchIndex(opts: { limit?: number } = {}): SearchIndex {
  const capacity = Math.min(opts.limit ?? SEARCH_INDEX_DEFAULT, SEARCH_INDEX_HARD_CAP)
  if (capacity < 1) throw new Error(`createSearchIndex: limit must be >= 1, got ${String(opts.limit)}`)
  const uf = new uFuzzy(UFUZZY_OPTIONS)
  const entries = new Map<ItemId, SearchEntry>()
  let ordered: SearchEntry[] = []
  let dirty = true

  const byRecency = (a: SearchEntry, b: SearchEntry): number => b.updatedAt - a.updatedAt || b.ord - a.ord
  const byPinnedThenRecency = (a: SearchEntry, b: SearchEntry): number =>
    Number(b.pinned) - Number(a.pinned) || byRecency(a, b)

  function rebuild(): void {
    if (!dirty) return
    ordered = [...entries.values()].sort(byPinnedThenRecency)
    dirty = false
  }

  return {
    add(entry) {
      entries.set(entry.id, entry)
      dirty = true
    },
    remove() {
      throw new Error('not implemented')
    },
    clear() {
      throw new Error('not implemented')
    },
    get size() {
      return entries.size
    },
    debugHaystack() {
      rebuild()
      return ordered.map((en) => en.preview)
    },
    query(q, limit) {
      if (limit < 1) return []
      rebuild()
      if (ordered.length === 0) return []
      const needle = q.trim()
      if (needle === '') return []
      const haystack = ordered.map((en) => en.preview)
      const [idxs, info, order] = uf.search(haystack, needle)
      if (idxs === null) return []
      const rank = (list: readonly { id: ItemId; ranges: readonly number[] }[]): SearchHit[] =>
        list.slice(0, limit).map((h, i) => ({ id: h.id, score: 1 / (1 + i), ranges: h.ranges }))
      if (info === null || order === null) {
        return rank(idxs.map((hi) => ({ id: ordered[hi]!.id, ranges: [] })))
      }
      return rank(order.map((oi) => ({ id: ordered[info.idx[oi]!]!.id, ranges: info.ranges[oi] ?? [] })))
    },
  }
}
```

- [ ] **Step 8: Run it and watch it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test -w @cairn/search
```

Expected: `Test Files 1 passed (1)`, `Tests 5 passed (5)`.

- [ ] **Step 9: Commit.**

```sh
git add packages/search/src/index.ts packages/search/src/index.test.ts
git commit -m "feat(search): ufuzzy matching over in-memory previews with flat highlight ranges"
```

- [ ] **Step 10: Write the second failing search test — empty query, termless query, tie
      determinism, capacity and removal.** A flapping order in a palette feels broken, so the tie
      rule is asserted five times in a row.

Append to `packages/search/src/index.test.ts`:

```ts
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
```

- [ ] **Step 11: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test -w @cairn/search
```

Expected: **FAIL**, 5 passed / 9 failed, with `Error: not implemented` from `remove()` and
`clear()`, and `AssertionError: expected [] to deeply equal [ 'PIN', 'NEW', 'OLD' ]` from the
empty-query test.

- [ ] **Step 12: Implement the ordering and lifecycle.** Replace the `add`, `remove` and `clear`
      members and the empty/termless branch of `query` in `packages/search/src/index.ts`.

Add this function just above the `return {` block:

```ts
  function evictOverflow(): void {
    if (entries.size <= capacity) return
    // Oldest first: negate the newest-first comparator. Pinned rows are exempt (spec §4).
    const unpinnedOldestFirst = [...entries.values()]
      .filter((en) => !en.pinned)
      .sort((a, b) => -byRecency(a, b))
    let over = entries.size - capacity
    for (const en of unpinnedOldestFirst) {
      if (over <= 0) break
      entries.delete(en.id)
      over -= 1
    }
    dirty = true
  }
```

Replace the three stub members with:

```ts
    add(entry) {
      entries.set(entry.id, entry)
      dirty = true
      evictOverflow()
    },
    remove(id) {
      const had = entries.delete(id)
      if (had) dirty = true
      return had
    },
    clear() {
      entries.clear()
      ordered = []
      dirty = false
    },
```

And inside `query`, replace the two early returns so a termless needle falls back to the
pinned-then-recency order. Move the `rank` helper above them:

```ts
      const rank = (list: readonly { id: ItemId; ranges: readonly number[] }[]): SearchHit[] =>
        list.slice(0, limit).map((h, i) => ({ id: h.id, score: 1 / (1 + i), ranges: h.ranges }))
      const needle = q.trim()
      if (needle === '') return rank(ordered.map((en) => ({ id: en.id, ranges: [] })))
      const haystack = ordered.map((en) => en.preview)
      const [idxs, info, order] = uf.search(haystack, needle)
      if (idxs === null) return rank(ordered.map((en) => ({ id: en.id, ranges: [] })))
```

- [ ] **Step 13: Run it and watch it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test -w @cairn/search
```

Expected: `Tests 14 passed (14)`.

- [ ] **Step 14: Commit.**

```sh
git add packages/search/src/index.ts packages/search/src/index.test.ts
git commit -m "feat(search): pinned-then-recency ordering, deterministic tiebreak and a capacity cap"
```

- [ ] **Step 15: Write the security test for the index's plaintext surface.** Spec §11 control 5: the
      index holds the masked preview and never the raw secret. This one lives in the `security`
      vitest project because of its `*.security.test.ts` name.

Create `packages/search/src/index.security.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ItemId } from '@cairn/protocol'
import { mask } from '@cairn/privacy'
import { createSearchIndex } from './index'

/** The exact key from the M1 demo. `mask()` must render it `AKIA••••A7QD`. */
const RAW_AWS_KEY = 'AKIA2E0PQIN4XA7QD'

describe('the in-memory index never holds a raw secret', () => {
  it('stores the masked preview, so the raw value is neither searchable nor readable', () => {
    const masked = mask(RAW_AWS_KEY).preview
    expect(masked).toBe('AKIA••••A7QD')

    const ix = createSearchIndex()
    ix.add({ id: 'ITEM1' as ItemId, preview: masked, pinned: false, updatedAt: 1, ord: 1 })

    // debugHaystack() is the WHOLE plaintext surface of the index. Read all of it.
    expect(ix.debugHaystack()).toEqual(['AKIA••••A7QD'])
    expect(JSON.stringify(ix.debugHaystack())).not.toContain(RAW_AWS_KEY)
    // Searching for the raw key finds nothing, because the raw key is not here.
    expect(ix.query(RAW_AWS_KEY, 10)).toEqual([])
    // The masked row is still findable by its visible prefix.
    expect(ix.query('akia', 10).map((h) => String(h.id))).toEqual(['ITEM1'])
  })

  it('a pinned row is no exception — the haystack is masked previews only', () => {
    const ix = createSearchIndex()
    ix.add({
      id: 'P' as ItemId,
      preview: mask(`token ${RAW_AWS_KEY} end`).preview,
      pinned: true,
      updatedAt: 1,
      ord: 1,
    })
    expect(ix.debugHaystack()).toEqual(['token AKIA••••A7QD end'])
    expect(JSON.stringify(ix.debugHaystack())).not.toContain(RAW_AWS_KEY)
  })

  it('clear() leaves no plaintext behind for a later query to find', () => {
    const ix = createSearchIndex()
    ix.add({ id: 'ITEM1' as ItemId, preview: 'AKIA••••A7QD', pinned: false, updatedAt: 1, ord: 1 })
    ix.clear()
    expect(ix.size).toBe(0)
    expect(ix.debugHaystack()).toEqual([])
    expect(ix.query('akia', 10)).toEqual([])
  })
})
```

- [ ] **Step 16: Run the security project and watch it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test:security -w @cairn/search
```

Expected: `Tests 3 passed (3)`. This test passes on first run because the control it guards is
structural — the index simply has no field for a raw value. Step 17 proves it can still fail.

- [ ] **Step 17: Prove the security test fails when the control is removed.** The contract makes
      "fails if its control is removed" the acceptance criterion for every security test, so
      demonstrate it once, by hand, and revert.

Temporarily change `debugHaystack` in `packages/search/src/index.ts` to leak an unmasked value:

```ts
    debugHaystack() {
      rebuild()
      return ordered.map((en) => en.preview.replace('AKIA••••A7QD', 'AKIA2E0PQIN4XA7QD'))
    },
```

Then:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test:security -w @cairn/search
```

Expected: **FAIL** with
`AssertionError: expected '["AKIA2E0PQIN4XA7QD"]' not to contain 'AKIA2E0PQIN4XA7QD'`.
Now revert the edit:

```sh
git checkout -- packages/search/src/index.ts
npm run test:security -w @cairn/search
```

Expected: back to `Tests 3 passed (3)`.

- [ ] **Step 18: Commit.**

```sh
git add packages/search/src/index.security.test.ts
git commit -m "test(search): assert the in-memory index holds only masked previews"
```

- [ ] **Step 19: Write the failing retention test.** Retention is a pure function of `(items, now,
      limits)`, which is what makes all three limits testable separately and with no store at all.
      Note that each limit gets its own `it`, and each asserts the exact boundary — an off-by-one
      here silently deletes a user's history.

Create `packages/history/src/retention.test.ts`:

```ts
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
```

- [ ] **Step 20: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run packages/history/src/retention.test.ts
```

Expected: **FAIL** with
`Error: Cannot find module './retention' imported from .../packages/history/src/retention.test.ts`.

- [ ] **Step 21: Write the retention implementation.**

Create `packages/history/src/retention.ts`:

```ts
import {
  RETENTION_MAX_AGE_MS,
  RETENTION_MAX_BYTES,
  RETENTION_MAX_ITEMS,
  SECRET_TTL_MS,
  type DeleteReason,
  type Item,
  type ItemId,
} from '@cairn/protocol'

export interface RetentionLimits {
  readonly maxItems: number
  readonly maxAgeMs: number
  readonly maxBytes: number
  readonly secretTtlMs: number
}

export const DEFAULT_RETENTION: RetentionLimits = {
  maxItems: RETENTION_MAX_ITEMS,
  maxAgeMs: RETENTION_MAX_AGE_MS,
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
    if (nowMs - it.createdAt >= limits.maxAgeMs) condemn(it, 'retention-age')
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
```

- [ ] **Step 22: Run it and watch it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run packages/history/src/retention.test.ts
```

Expected: `Tests 9 passed (9)`.

- [ ] **Step 23: Commit.**

```sh
git add packages/history/src/retention.ts packages/history/src/retention.test.ts
git commit -m "feat(history): pure retention planner for 500 items / 30 days / 512 MiB / 5 min secrets"
```

- [ ] **Step 24: Write the failing history test — ingest, masking at ingest, the concealed skip,
      preview truncation, and recall.** These run against the **real** `@cairn/store` in a real
      tmpdir and the **real** `@cairn/privacy`, because a fake store would not prove the M1 demo's
      persistence claim. `tempStoreDir`/`randomTestKey` come from `@cairn/store`'s barrel rather than
      from a local `mkdtempSync`, for two separate reasons:

      1. **`packages/history/src/history.ts` must never mention `tmpdir` or `mkdtemp` at all.**
         `security/no-plaintext-on-disk.security.test.ts` — created by **Task 6**, in its step that
         writes contract §8's repo-wide no-plaintext-on-disk test, not by Task 9 — scans `packages/**`
         and `apps/desktop/**` with comments stripped and bans `mkdtemp`, `tmpdir(`, `os.tmpdir`,
         `spool`, `writeFileSync(`, `appendFileSync(` and `createWriteStream(`. Its only exemptions
         are any path ending `.test.ts`, the WRITE identifiers under `packages/store/`, and
         `packages/store/src/testing.ts` for the temp-dir ones. `@cairn/history` is on the wrong side
         of every one of those, and `@cairn/store` is the only package allowed to touch a file.
      2. **This file is a `.test.ts`, so the scan would let it roll its own temp dir — and it still
         must not.** A second temp-dir helper is a second thing to get 0700 wrong on. One helper, one
         `mode: 0o700`, one place to audit. Task 8 therefore asks for **no exemption at all**: the
         scan's `.test.ts` rule is not a licence this task cashes in.

Create `packages/history/src/history.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PREVIEW_MAX_CHARS,
  SECRET_TTL_MS,
  contentHash,
  createTestClock,
  type Candidate,
  type ItemId,
  type Logger,
  type ResolvedRep,
} from '@cairn/protocol'
import { DEFAULT_RULES, classify, mask } from '@cairn/privacy'
import { openStore, randomTestKey, tempStoreDir } from '@cairn/store'
import { createSearchIndex } from '@cairn/search'
import { createHistory, primaryRep, type History, type PrivacyPort } from './history'

const silentLogger: Logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} }
const privacy: PrivacyPort = { rules: DEFAULT_RULES, classify, mask }

function textRep(text: string): ResolvedRep {
  const bytes = new TextEncoder().encode(text)
  return {
    mime: 'text/plain',
    uti: 'public.utf8-plain-text',
    bytes,
    byteLength: bytes.length,
    sha256: contentHash(bytes),
  }
}
function textCandidate(text: string, at: number, over: Partial<Candidate> = {}): Candidate {
  const rep = textRep(text)
  return {
    reps: [rep],
    kind: 'text',
    contentHash: rep.sha256,
    primaryText: text,
    hints: [],
    sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
    thumbnailJpeg: null,
    changeToken: String(at),
    capturedAt: at,
    ...over,
  }
}

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

/** One tmpdir, one clock, one key, ONE search index — and `mk()` builds a FRESH History over the
 *  SAME dir, which is how a "quit and relaunch" is simulated without a process boundary. The index
 *  is shared exactly as it is in the real app (one per process) and is returned so a test can look
 *  inside it; `load()` clears it first, so reuse across two History instances is safe. */
function harness() {
  const { dir, cleanup } = tempStoreDir()
  cleanups.push(cleanup)
  const clock = createTestClock()
  const key = randomTestKey()
  const index = createSearchIndex()
  const mk = (): History => {
    // openStore returns Result<Store> (Task 6): a wrong key or a tampered log is a value, not a
    // throw. A test has nothing useful to do with that, so unwrap loudly here.
    const opened = openStore({ dir, key, clock, logger: silentLogger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    return createHistory({
      store: opened.value,
      privacy,
      search: index,
      clock,
      logger: silentLogger,
    })
  }
  return { dir, clock, index, mk }
}

describe('history.ingest', () => {
  it('persists the candidate and returns the new Item', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('warehouse inventory report', clock.now()))
    expect(r.ok).toBe(true)
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect(r.value.item.preview).toBe('warehouse inventory report')
    expect(r.value.item.previewTruncated).toBe(false)
    expect(r.value.item.kind).toBe('text')
    expect(r.value.item.pinned).toBe(false)
    expect(r.value.item.expiresAt).toBeNull()
    expect(r.value.item.createdAt).toBe(clock.now())
    expect(r.value.item.updatedAt).toBe(clock.now())
    expect(r.value.item.repRefs).toHaveLength(1)
    expect(r.value.item.byteLength).toBe(26)
    expect(hist.list().total).toBe(1)
    expect(hist.search('wrhs', 10).map((s) => s.item.id)).toEqual([r.value.item.id])
  })

  it('skips a concealed copy and writes absolutely nothing', async () => {
    const { mk, clock, dir } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('hunter2', clock.now(), { hints: ['concealed'] }))
    expect(r.ok && r.value.outcome).toBe('skipped')
    expect(hist.list().total).toBe(0)
    // The real "nothing was written" evidence: not one blob body reached the disk.
    expect(readdirSync(join(dir, 'blobs'))).toEqual([])
    // The log is NOT empty — Task 6's openStore seals an anchor CHECKPOINT as line 0 of every new
    // log, so "nothing appended" means exactly one line, not zero bytes.
    expect(readFileSync(join(dir, 'history.ndjson'), 'utf8').trimEnd().split('\n')).toHaveLength(1)
  })

  it('masks a secret AT INGEST, so the raw value never reaches the preview or the index', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('AKIA2E0PQIN4XA7QD', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect(r.value.item.preview).toBe('AKIA••••A7QD')
    expect(r.value.item.flags).toContain('secret')
    expect(r.value.item.expiresAt).toBe(clock.now() + SECRET_TTL_MS)
    expect(r.value.item.maskSpans).toEqual([{ start: 0, end: 17, detector: 'aws-access-key' }])
    expect(hist.search('AKIA2E0PQIN4XA7QD', 10)).toEqual([])
    expect(hist.search('akia', 10)).toHaveLength(1)
  })

  it('truncates a long preview to PREVIEW_MAX_CHARS and flags it', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('x'.repeat(PREVIEW_MAX_CHARS + 50), clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect(r.value.item.preview).toHaveLength(PREVIEW_MAX_CHARS)
    expect(r.value.item.previewTruncated).toBe(true)
  })

  it('collapses whitespace so a multi-line copy is one palette row', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('  line one\n\tline two  ', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect(r.value.item.preview).toBe('line one line two')
  })

  it('notifies onChange with the reason and the new total', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const seen: { reason: string; total: number }[] = []
    const unsub = hist.onChange((ev) => seen.push(ev))
    await hist.ingest(textCandidate('one', clock.now()))
    unsub()
    await hist.ingest(textCandidate('two', clock.now()))
    expect(seen).toEqual([{ reason: 'ingest', total: 1 }])
  })
})

describe('history recall and removal', () => {
  it('resolveReps returns the original bytes', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('round trip me', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    const reps = await hist.resolveReps(r.value.item.id)
    expect(reps.ok).toBe(true)
    if (!reps.ok) return
    expect(new TextDecoder().decode(reps.value[0]!.bytes)).toBe('round trip me')
    expect(reps.value[0]!.mime).toBe('text/plain')
    // `primaryRep` is the frozen surface Task 9's recall path reads to decide what to put on the
    // clipboard first, so it is asserted here rather than left as an untested export. `text/plain`
    // wins over `text/html` even when html is listed first, because PRIMARY_ORDER decides, not order.
    expect(primaryRep(reps.value)).toBe(reps.value[0])
    const html: ResolvedRep = { ...reps.value[0]!, mime: 'text/html', uti: 'public.html' }
    expect(primaryRep([html, reps.value[0]!])!.mime).toBe('text/plain')
    expect(primaryRep([html])!.mime).toBe('text/html')
    expect(primaryRep([])).toBeUndefined()
  })

  it('resolveReps returns E_ITEM_NOT_FOUND for an unknown id', async () => {
    const { mk } = harness()
    const hist = mk()
    const r = await hist.resolveReps('01ABCDEFGHJKMNPQRSTVWXYZ00' as ItemId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_ITEM_NOT_FOUND')
  })

  it('remove(id) deletes the item AND its blobs', async () => {
    const { mk, clock, dir } = harness()
    const hist = mk()
    const r = await hist.ingest(textCandidate('delete me', clock.now()))
    if (!r.ok || r.value.outcome !== 'added') throw new Error('expected outcome "added"')
    expect(readdirSync(join(dir, 'blobs'))).toHaveLength(1)
    const removed = await hist.remove(r.value.item.id)
    expect(removed.ok && removed.value.removed).toBe(true)
    expect(readdirSync(join(dir, 'blobs'))).toEqual([])
    expect(hist.list().total).toBe(0)
    expect(hist.search('', 10)).toEqual([])
    expect(hist.get(r.value.item.id)).toBeUndefined()
    const again = await hist.remove(r.value.item.id)
    expect(again.ok && again.value.removed).toBe(false)
  })

  it('list() filters by kind, by pinnedOnly, and paginates', async () => {
    const { mk, clock } = harness()
    const hist = mk()
    await hist.ingest(textCandidate('alpha', clock.now()))
    clock.advance(1_000)
    await hist.ingest(textCandidate('beta', clock.now()))
    expect(hist.list().items.map((i) => i.preview)).toEqual(['beta', 'alpha'])
    expect(hist.list({ limit: 1 }).items.map((i) => i.preview)).toEqual(['beta'])
    expect(hist.list({ limit: 1, offset: 1 }).items.map((i) => i.preview)).toEqual(['alpha'])
    expect(hist.list({ limit: 1, offset: 1 }).total).toBe(2)
    expect(hist.list({ kind: 'image' }).items).toEqual([])
    expect(hist.list({ pinnedOnly: true }).items).toEqual([])
  })
})
```

- [ ] **Step 25: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run packages/history/src/history.test.ts
```

Expected: **FAIL** with
`Error: Cannot find module './history' imported from .../packages/history/src/history.test.ts`.

- [ ] **Step 26: Write the history service.** Note there is deliberately no dedupe branch, no
      `load()`, no `pin()` and no `evictNow()` yet — those are the next three cycles, each with its
      own failing test first.

Create `packages/history/src/history.ts`:

```ts
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
import { secretExpiresAt } from '@cairn/privacy'
import type { SearchIndex } from '@cairn/search'
import type { Store } from '@cairn/store'
import { DEFAULT_RETENTION, type RetentionLimits } from './retention'

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
      throw new Error('not implemented')
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

    async pin() {
      throw new Error('not implemented')
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
      throw new Error('not implemented')
    },

    evictPreviewCache() {
      throw new Error('not implemented')
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
```

- [ ] **Step 27: Run it and watch it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run packages/history/src/history.test.ts
```

Expected: `Tests 10 passed (10)`.

- [ ] **Step 28: Commit.**

```sh
git add packages/history/src/history.ts packages/history/src/history.test.ts
git commit -m "feat(history): ingest with masking at ingest, list, search, resolveReps and remove"
```

- [ ] **Step 29: Write the failing dedupe test.** Copying the same thing twice must yield one row
      with a bumped `updatedAt`, and one blob — not two rows and not two blobs.

Create `packages/history/src/dedupe.test.ts`:

```ts
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
```

- [ ] **Step 30: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run packages/history/src/dedupe.test.ts
```

Expected: **FAIL** with
`Error: Cannot find module './dedupe' imported from .../packages/history/src/dedupe.test.ts`.

- [ ] **Step 31: Write `dedupe.ts` and wire the dedupe branch into `ingest`.**

Create `packages/history/src/dedupe.ts`:

```ts
import type { ContentHash, Item, ItemId, ItemPatch } from '@cairn/protocol'

/** Rebuilt from scratch on every `load()`, which is why it is a plain function of the items. */
export function indexByContentHash(items: Iterable<Item>): Map<ContentHash, ItemId> {
  const m = new Map<ContentHash, ItemId>()
  for (const it of items) m.set(it.contentHash, it.id)
  return m
}

/** A re-copy bumps `updatedAt` and writes an ITEM_UPDATED — never a second row (spec §4). */
export function bumpUpdatedAt(item: Item, nowMs: number): { readonly item: Item; readonly patch: ItemPatch } {
  return { item: { ...item, updatedAt: nowMs }, patch: { updatedAt: nowMs } }
}
```

In `packages/history/src/history.ts`, add the import (`indexByContentHash` joins it in Step 36, when
`load()` needs it — importing it now would trip `noUnusedLocals`):

```ts
import { bumpUpdatedAt } from './dedupe'
```

and insert this block inside `ingest`, immediately after `const now = clock.now()` and before
`const masked = ...`:

```ts
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
```

Leave `load()`, `pin()`, `evictNow()` and `evictPreviewCache()` throwing `not implemented` — their
tests come in Steps 34 and 39.

- [ ] **Step 32: Run both history test files and watch them pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test -w @cairn/history
```

Expected: `Test Files 3 passed (3)`, `Tests 24 passed (24)` (9 retention + 10 history + 5 dedupe).

- [ ] **Step 33: Commit.**

```sh
git add packages/history/src/dedupe.ts packages/history/src/dedupe.test.ts packages/history/src/history.ts
git commit -m "feat(history): dedupe by content hash, bumping updatedAt instead of adding a row"
```

- [ ] **Step 34: Write the failing restart / pin / eviction tests.** The restart round-trip is the M1
      demo's "quit and relaunch: the history is still there" claim, so it asserts **deep equality of
      the whole list**, not just a count.

Append to `packages/history/src/history.test.ts`:

```ts
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
```

Append to `packages/history/src/retention.test.ts`:

```ts
import { createTestClock, contentHash as hashOf, type Candidate, type Logger, type ResolvedRep } from '@cairn/protocol'
import { DEFAULT_RULES, classify, mask } from '@cairn/privacy'
import { openStore, randomTestKey, tempStoreDir } from '@cairn/store'
import { createSearchIndex } from '@cairn/search'
import { afterEach } from 'vitest'
import { createHistory, type History, type PrivacyPort } from './history'
import { DEFAULT_RETENTION, type RetentionLimits } from './retention'

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
  const mk = (): History => {
    const opened = openStore({ dir, key, clock, logger: silentLogger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    return createHistory({
      store: opened.value,
      privacy: privacyPort,
      search: createSearchIndex(),
      clock,
      logger: silentLogger,
      ...(retention === undefined ? {} : { retention }),
    })
  }
  return { dir, clock, mk }
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
```

- [ ] **Step 35: Run both files and watch them fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test -w @cairn/history
```

Expected: **FAIL** with `Error: not implemented` raised from `load()`, `pin()` and `evictNow()`.

- [ ] **Step 36: Implement `load()`, `pin()` and `evictNow()`.**

In `packages/history/src/history.ts`, widen the `@cairn/privacy` import and the two local imports:

```ts
import { isPinnable, secretExpiresAt } from '@cairn/privacy'
import { bumpUpdatedAt, indexByContentHash } from './dedupe'
import { DEFAULT_RETENTION, planEviction, type Eviction, type RetentionLimits } from './retention'
```

Replace the whole `async load()` member with:

```ts
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
```

Replace the `async pin()` stub with:

```ts
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
```

Replace the `async evictNow()` stub with:

```ts
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
```

Finally add the flag `load()` sets, just below the `listeners` declaration:

```ts
  /** False after evictPreviewCache() until the next load(). Guards `search()` (spec §11 control 6). */
  let previewsLoaded = true
```

…and, in the same step, the guard that READS it, as the first line of `search`:

```ts
    search(q, limit) {
      if (!previewsLoaded) return []
```

The guard goes in now rather than with `evictPreviewCache()` two cycles later for a hard reason:
`noUnusedLocals` is on, and a `let` that is only ever assigned is still `error TS6133: 'previewsLoaded'
is declared but its value is never read` (`[verified]` — a write-only local does not satisfy
`noUnusedLocals`). Adding the declaration without its reader would leave `npx tsc -p tsconfig.json`
red between here and Step 41. It changes no behaviour today: `previewsLoaded` starts `true` and only
`evictPreviewCache()` ever clears it, and that member still throws until Step 41.

- [ ] **Step 37: Run the whole history workspace and watch it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test -w @cairn/history
```

Expected: `Test Files 3 passed (3)`, `Tests 34 passed (34)` (14 retention + 15 history + 5 dedupe).

- [ ] **Step 38: Commit.**

```sh
git add packages/history/src/history.ts packages/history/src/history.test.ts packages/history/src/retention.test.ts
git commit -m "feat(history): restart replay, pin with a loud secret refusal, and retention eviction"
```

- [ ] **Step 39: Write the failing test for `evictPreviewCache()`.** Spec §10 says plainly that
      "encrypted store" is an at-rest claim and that a long-lived process holds previews decrypted.
      This is the control that bounds that window, so it is asserted rather than described.

Append to `packages/history/src/history.test.ts`:

```ts
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
```

- [ ] **Step 40: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run packages/history/src/history.test.ts -t 'clears the index and blanks'
```

Expected: **FAIL** with `Error: not implemented` from `evictPreviewCache`.

- [ ] **Step 41: Implement `evictPreviewCache()`.** Replace the stub in
      `packages/history/src/history.ts`:

```ts
    evictPreviewCache() {
      search.clear()
      previewsLoaded = false
      // JavaScript cannot zero a string, so the honest control is to drop every reference and stop
      // answering searches until load() re-reads the encrypted store.
      for (const [id, it] of items) items.set(id, { ...it, preview: '', maskSpans: [] })
    },
```

That is the whole change. The `if (!previewsLoaded) return []` guard at the top of `search` and the
`let previewsLoaded = true` declaration both went in during Step 36, so this step flips exactly one
member from `throw` to real work — which is why Step 40's failure is `Error: not implemented` and
nothing else.

- [ ] **Step 42: Run the workspace and watch it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npm run test -w @cairn/history
```

Expected: `Tests 36 passed (36)`.

- [ ] **Step 43: Commit.**

```sh
git add packages/history/src/history.ts packages/history/src/history.test.ts
git commit -m "feat(history): evictPreviewCache clears the decrypted preview cache and the index"
```

- [ ] **Step 44: Write the two barrels.** These are the only entry points the manifests declare, so
      every other package imports through them.

`packages/history/src/index.ts`:

```ts
export * from './dedupe'
export * from './history'
export * from './retention'
```

`packages/search/src/index.ts` is already the implementation file and needs no barrel — leave it.

- [ ] **Step 45: Typecheck and run the suite.** `vitest.config.ts` has **three** projects — `unit`,
      `security` and `renderer`. Task 8 adds files to the first two and none at all to the third: this
      task creates nothing under `apps/desktop/renderer/src/`. Run all three anyway with the bare
      `npm test`, so a green claim here is a green claim about the repo and not about a subset.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx tsc -p tsconfig.json
npm run typecheck
npm run test:unit
npm run test:security
npm test
```

Expected: `npx tsc -p tsconfig.json` exits 0 with no output — that is the config whose `include` globs
`packages/*/src/**/*.ts`, so it is the one that actually typechecks every file this task wrote.
`npm run typecheck` runs that same `tsc` and then `svelte-check` against
`apps/desktop/renderer/tsconfig.json`, and also exits 0; it must, because it is the repo's gate, and
the renderer tsconfig deliberately does **not** glob `../../../packages/*/src/**/*.ts`, so nothing
Task 8 wrote can reach `svelte-check` at all. The unit project reports `Tests 50 passed` for these two
packages' four unit files (14 search + 36 history) alongside whatever earlier tasks contribute; the
security project includes `packages/search/src/index.security.test.ts` with `3 passed`; `npm test`
reports all three projects with `0 failed` and the `renderer` project unchanged by this task. If `tsc`
complains `'indexByContentHash' is declared but its value is never read`, you skipped the `load()`
rewrite in Step 36; if it complains the same about `previewsLoaded`, you added the flag without the
`if (!previewsLoaded) return []` guard that Step 36 puts at the top of `search`.

- [ ] **Step 46: Commit and push the branch for the user to merge.**

```sh
git add packages/history/src/index.ts
git commit -m "feat(history): barrel exporting dedupe, retention and the history service"
git push -u origin m1/08-history-search
```

Expected: `branch 'm1/08-history-search' set up to track 'origin/m1/08-history-search'`. Do not
merge; do not add any `Co-Authored-By` trailer.

---

**Task 8 done when:**

- [ ] `git branch --show-current` prints `m1/08-history-search`, and `git log --oneline origin/main..`
      shows **9** commits (Steps 9, 14, 18, 23, 28, 33, 38, 43 and 46 — Steps 2, 3 and 4 verify and
      commit nothing), none containing `Co-Authored-By` or any other AI-attribution trailer.
- [ ] `git status --short packages/search/package.json packages/history/package.json` prints nothing
      — Task 8 verified those two manifests and did not rewrite them.
- [ ] `npm run test -w @cairn/search` prints `Tests 14 passed (14)`.
- [ ] `npm run test:security -w @cairn/search` prints `Tests 3 passed (3)`.
- [ ] `npm run test -w @cairn/history` prints `Test Files 3 passed (3)` and `Tests 36 passed (36)`.
- [ ] `npx tsc -p tsconfig.json` exits 0 with no output, and `npm run typecheck` (that same `tsc` plus
      `svelte-check` against the renderer tsconfig) also exits 0.
- [ ] `npm test` reports all **three** vitest projects — `unit`, `security`, `renderer` — with
      `0 failed`. Task 8 adds no renderer test, so the `renderer` count is whatever it was before.
- [ ] `grep -rn "SECRET_TTL_MS\|includes('secret')" packages/history/src/history.ts` returns nothing —
      the 5-minute TTL and the never-pinnable rule come from `@cairn/privacy`'s `secretExpiresAt` and
      `isPinnable`, so there is exactly one implementation of each.
- [ ] `grep -rnE "exec\(|execSync|execFile|shell: true|child_process" packages/history/src packages/search/src`
      returns nothing. Spec §11 control 3 promises no shell in the capture or recall path, and these
      two packages sit squarely in it: a copied file path is a string Cairn displays and hands to the
      OS clipboard, never something it interpolates into a command. Task 9's security suite bans these
      identifiers across `packages/**` and `apps/desktop/**`; this line is the local proof that Task 8
      does not put the first violation in the tree.
- [ ] `npx vitest run packages/search/src/index.test.ts -t 'matches out-of-order letters'` passes —
      i.e. `wrhs` really does find `warehouse`, which is the M1 demo sentence.
- [ ] `npx vitest run packages/history/src/retention.test.ts -t 'listed at t+299_999'` passes — the
      5-minute secret TTL is exact on the injected clock, with no real timer anywhere.
- [ ] `npx vitest run packages/history/src/retention.test.ts -t 'no tombstone'` passes and
      `isSyncableDelete` returns `false` for all four retention reasons.
- [ ] `npx vitest run packages/history/src/history.test.ts -t 'rebuilds identical in-memory state'`
      passes, so "quit and relaunch: the history is still there" is a test and not a claim.
- [ ] `npx vitest run packages/history/src/history.test.ts -t 'REFUSED'` passes with code
      `E_PIN_REFUSED_SECRET` — pinning a secret fails loudly rather than being ignored.
- [ ] `npx vitest run packages/history/src/history.test.ts -t 'clears the index and blanks'` passes.
- [ ] `grep -rn "tmpdir\|mkdtemp\|Date.now()\|setTimeout(" packages/history/src packages/search/src`
      returns nothing — no temp files and no clock outside the injected one.
- [ ] `grep -rn "console\." packages/history/src packages/search/src` returns nothing — all output
      goes through the metadata-only `Logger`.
- [ ] Deliberately deleting the `compare: () => 0` line from `UFUZZY_OPTIONS` makes
      `-t 'breaks relevance ties by recency'` fail with
      `AssertionError: expected [ 'OLDER', 'NEWER' ] to deeply equal [ 'NEWER', 'OLDER' ]`; and
      deleting the `search.clear()` line from `evictPreviewCache` makes
      `-t 'clears the index and blanks'` fail with `AssertionError: expected 1 to be +0`. Both
      reverted before pushing.
