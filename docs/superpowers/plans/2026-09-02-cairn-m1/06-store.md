### Task 6: @cairn/store — encrypted append-only log with a hash chain, and content-addressed blobs

This package is the only place in Cairn that writes clipboard-derived bytes to disk. Everything it
writes is AES-256-GCM sealed, so the README's claim — *"grep for your copied string finds nothing in
any file on disk"* — is true or this package is broken. It knows nothing about clipboards, previews or
policy: it stores opaque `StoreEvent` records and opaque blobs, and it takes its 32-byte key as an
**argument**, so every test in it is a temp dir plus `randomBytes(32)` on a machine with no compiler,
no keychain and no OS permission (spec §4).

Read this before you start, because two design points are unobvious and the tests will not make sense
without them:

1. **The reader has to be able to compute the AAD before it can decrypt anything.** The AAD is
   `'cairn/store/v1' || u64be(lineIndex) || u64be(seq) || recordKind` (spec §4). `lineIndex` is
   obvious. `seq` is derivable because **within one log generation seq is contiguous**: line 0 is
   always a `CHECKPOINT` (the *anchor*), sealed under the fixed AAD seq `0`, and its payload declares
   the generation's first seq — so `seq(line i) = anchorSeq + i`. `recordKind` is *not* derivable, so
   the reader tries all four kinds (four GCM opens of a ~1 KB record: microseconds) and then
   cross-checks the opened payload's own `kind` against the AAD kind it succeeded under.
2. **The AAD and the hash chain catch overlapping but different attacks.** The AAD binds a record to
   its line and seq, so swapping, deleting or duplicating lines shifts everything after the edit and
   those records stop authenticating. What the AAD *cannot* see is a record **replaced by a different
   record that held the same line index, seq and kind in an older state of the log** — e.g. lifted out
   of yesterday's Time Machine copy of `history.ndjson`. Every AAD field still matches, so it decrypts
   cleanly. The `prevRecordHash` chain is what catches that, one line later. Without the chain,
   splicing in yesterday's line 12 in place of today's `ITEM_DELETED` **resurrects a deleted secret**
   (spec §4). Step 36's last test is exactly that attack, and it is the reason the chain exists.

Known, deliberate limits, documented here so nobody "fixes" them by inventing a plaintext sidecar:
truncating or removing the **last** line of the log is indistinguishable from a crash and is accepted
(the next `CHECKPOINT` bounds the damage); and rolling the whole file back to an earlier copy of
itself is undetectable without an anchor outside the file, which M1 does not have.

One more limit, on the blob side, because spec §11 control 7 makes a claim this package has to be
precise about: **`deleteBlob` unlinks, it does not shred.** Unlinking leaves the sealed bytes in free
space. What control 7 actually rests on is that those bytes were never plaintext and that the subkey
that opens them is **per blob** — `HKDF-SHA256(master, salt = the blob id, info = 'cairn/blob/v1')`,
Step 23. The salt is the plaintext sha256, which appears nowhere on disk except inside the sealed
record that referenced the blob (the filename is an HMAC of it, not the id), so once the blob is
unlinked and its record has been compacted away, nothing left on disk lets that subkey be re-derived
— even from the master key. That is the honest form of the claim: not shredding, but a destroyed key.

---

**Files:**

*Create*
- `packages/store/src/index.ts`
- `packages/store/src/testing.ts`
- `packages/store/src/paths.ts`
- `packages/store/src/record.ts`
- `packages/store/src/chain.ts`
- `packages/store/src/blobs.ts`
- `packages/store/src/log-store.ts`

*Verify — created by Task 1, NOT by this task*
- `packages/store/package.json`. Task 1's step that writes the ten workspace manifests already wrote
  it, with exactly the name, `type`, `exports`, two scripts and single `@cairn/protocol` dependency
  this task needs, and Task 1's install committed the `package-lock.json` entry for it. Step 2 diffs
  it instead of rewriting it, so the manifest is created exactly once in the repo and
  `package-lock.json` is not touched here at all.

*Test*
- `packages/store/src/paths.security.test.ts` (security project)
- `packages/store/src/record.test.ts` (unit project)
- `packages/store/src/chain.test.ts` (unit project)
- `packages/store/src/blobs.test.ts` (unit project)
- `packages/store/src/log-store.test.ts` (unit project)
- `packages/store/src/store.security.test.ts` (security project)
- `security/no-plaintext-on-disk.security.test.ts` (security project) — contract §8's repo-wide
  canary-and-temp-file scan. It is created **here**, by the task that owns the data dir, because
  every other task that mentions it only *reasons about* it. Step 57.

No other file in the repo is touched. In particular: no `dist/`, no SQLite, no native module, no
rewrite of `vitest.config.ts` (Task 1 wrote all three of its projects — `unit`, `security`,
`renderer` — and this task only *uses* two of them), and `node:crypto` is the only crypto dependency.

One note for whoever owns the contract-wide files, recorded in this plan's `concerns`:
`security/no-plaintext-on-disk.security.test.ts` was orphaned — contract §8 names it and Tasks 3, 4,
5 and 8 all distort their own code or ask for exemptions to satisfy a scan no task created. Step 57
creates it, and it settles the three open questions those tasks left hanging:

1. Its source scan **exempts every path ending `.test.ts`**, so Task 5's requested exemption for
   keyring's four test files is granted, and so is Task 9's `config.security.test.ts`.
2. It exempts `packages/store/src/testing.ts` (the shared `tempStoreDir()` helper every other
   package's tests import) for the temp-dir identifiers, and all of `packages/store/` for the
   file-write identifiers. That is the whole allowance list: **three clauses, three identifiers in the
   write set**, and no per-file escape hatches beyond them.
3. It scans `packages/**` and `apps/desktop/**` **with comments stripped**, and never scans
   `security/**`. So the fragment-assembly hack in Task 3's
   `packages/agent-host/src/spawn-agent.test.ts` — added by Task 3's step that appends the
   no-bytes-on-disk test and the source scan, which spells its needles as `'mkd' + 'temp'` and
   `'sp' + 'ool'` — **must stay fragment-assembled. Do not "simplify" it.** Task 3's guard is a
   *local, in-package* scan that does NOT skip test files, so a needle written plainly inside
   `spawn-agent.test.ts` is a literal occurrence of the very token it bans and the test fails on its
   own source. The repo-wide scan below exempts `*.test.ts`; Task 3's does not. Two scans with
   different scopes need the fragment trick in exactly one of them.

Task 3 is right that this scan goes through `findInSources()` from `security/source-scan.ts`: Step 57
does exactly that, so there is one comment stripper in the repo rather than a second, weaker copy.
What Task 3 has wrong is only the owner — the file is created **here, by Task 6**, not by Task 9,
which creates no such file. `security/source-scan.ts` and `security/source-scan.test.ts` are now
listed in contract §1, and **Task 1** creates them; treat them as ordinary contract files, not as a
deviation.

---

**Interfaces:**

`Consumes:` — all from `@cairn/protocol` (the package name, never a deep path):

```ts
function contentHash(bytes: Uint8Array): ContentHash          // 'sha256-<43 char base64url>'
type ContentHash = string & { readonly [k: symbol]: 'sha256-b64url' }   // branded
type BlobId = ContentHash
type ItemId = string & { readonly [k: symbol]: 'cairn-id' }             // branded, 26 chars
interface Ok<T> { readonly ok: true; readonly value: T }
interface Err { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly detail?: LogFields }
type Result<T> = Ok<T> | Err
const ok: <T>(value: T) => Ok<T>
const err: (code: ErrorCode, message: string, detail?: LogFields) => Err
// ErrorCode members used here: 'E_STORE_CORRUPT' | 'E_STORE_CHAIN_BROKEN' | 'E_STORE_DECRYPT'
//                             | 'E_STORE_IO' | 'E_BLOB_MISSING'
interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Cancel }
interface Logger { log(level: LogLevel, event: LogEvent, fields?): void; debug/info/warn/error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void }
// The interface and the `LogEvent`/`LogFields` types come from `packages/protocol/src/log.ts`, which
// Task 2 creates. `@cairn/protocol` deliberately exports NO `createLogger`; the one concrete
// NDJSON-to-stderr logger lives in `apps/desktop/main/src/logger.ts` (Task 9). This package only ever
// receives a `Logger`, so `silentLogger` in `testing.ts` is the only implementation it contains — and
// it implements all FIVE methods, `log` included.
// LogEvent ids used here: 'store.opened' | 'store.appended' | 'store.compacted'
//                        | 'store.torn-line-discarded' | 'store.blob-written'
interface Item { readonly id: ItemId; readonly repRefs: readonly RepRef[]; readonly thumbnailBlobId: BlobId | null; /* … §5.6 */ }
interface RepRef { readonly mime: string; readonly uti: string | null; readonly byteLength: number; readonly sha256: ContentHash; readonly blobId: BlobId }
interface ItemPatch { readonly updatedAt: number; readonly pinned?: boolean; readonly expiresAt?: number | null }
type DeleteReason = 'user' | 'retention-count' | 'retention-age' | 'retention-bytes' | 'secret-ttl' | 'rekey'
type StoreEvent = /* the four-variant union in contract §5.6 */
type StoreEventKind = StoreEvent['kind']
const STORE_AAD_MAGIC = 'cairn/store/v1'
const BLOB_HKDF_INFO = 'cairn/blob/v1'
const STORE_LOG_FILE = 'history.ndjson'
const STORE_META_FILE = 'meta.json'
const STORE_KEY_FILE = 'key.bin'
const STORE_BLOB_DIR = 'blobs'
const TEST_CANARY = 'CAIRN-CANARY-9f3a1c7e'
```

`Produces:` — every export of `@cairn/store`, in full:

```ts
// --- the store itself -------------------------------------------------------
interface OpenStoreOptions {
  readonly dir: string
  readonly key: Buffer                       // EXACTLY 32 bytes; a wrong length THROWS
  readonly clock: Clock
  readonly logger: Logger
  readonly unsafeTestHooks?: UnsafeTestHooks  // tests only
}
/** Returns Err (never throws) for a corrupt or wrong-keyed store; throws only for a bad key length. */
function openStore(opts: OpenStoreOptions): Result<Store>

interface Store {
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
  close(): void                                 // see the note below: zero-fills `nameKey`, and that is all
}

/**
 * What `close()` zero-fills, stated exactly, because a sibling task's prose is stale on this point:
 * after the per-blob rework in Step 23 the ONLY long-lived derived key material in this package is
 * the single blob **name** subkey (`nameKey`) — one per store, HKDF salt = empty, used to HMAC a blob
 * id into a filename. `close()` runs `nameKey.fill(0)` and nothing else, and Step 21's test asserts on
 * the buffer's CONTENTS. There are no long-lived per-blob subkeys to wipe: a blob **body** subkey is
 * derived inside `put`/`get`, used for exactly one GCM operation, and `fill(0)`-ed in that call's
 * `finally` before it returns, so none of them outlives the call that made it. `close()` never touches
 * the caller's master key — `@cairn/keyring` owns that buffer's lifetime, and Step 21 proves a fresh
 * `createBlobStore` with the same master key can still read a blob written before the close.
 */

/** seq and at are the store's to assign; CHECKPOINT is the store's to write, so it is not here. */
type StoreEventInput =
  | { readonly kind: 'ITEM_ADDED'; readonly item: Item }
  | { readonly kind: 'ITEM_UPDATED'; readonly id: ItemId; readonly patch: ItemPatch }
  | { readonly kind: 'ITEM_DELETED'; readonly id: ItemId; readonly reason: DeleteReason }

/**
 * `meta.json` — the ONLY plaintext file this package writes, and it holds three fields, none of them
 * clipboard-derived.
 *
 * `keyMode` is EXACTLY these three members. `@cairn/keyring`'s runtime `KeyringMode` has a fourth,
 * `'locked'`, and that one is **not persistable**: it means "a key exists but is not in memory right
 * now", which is a property of the process, not of the store on disk. Writing it would make the next
 * cold start unable to tell how to get the key back. `writeMeta` therefore takes this narrower union,
 * so handing it `'locked'` is a COMPILE error rather than a corrupt meta file, and Step 26's meta test
 * pins the accepted members.
 */
interface StoreMeta {
  readonly schemaVersion: 1
  readonly keyMode: 'os-keyring' | 'passphrase' | 'unknown'
  readonly scryptSaltB64: string | null
}
interface StoreStats {
  readonly lineCount: number
  readonly anchorSeq: number
  readonly maxSeq: number
  readonly logBytes: number
  readonly blobCount: number
  readonly blobBytes: number
  readonly tornLineRepairedOnOpen: boolean
}
interface CompactSummary {
  readonly liveItemCount: number
  readonly linesBefore: number
  readonly linesAfter: number
  readonly blobsRemoved: number
  readonly maxSeq: number
}
interface UnsafeTestHooks { readonly onBeforeRename?: () => void; readonly onAfterRename?: () => void }

// --- paths ------------------------------------------------------------------
interface DataDirLayout {
  readonly dir: string
  readonly logPath: string
  readonly tmpLogPath: string
  readonly metaPath: string
  readonly keyPath: string
  readonly blobDir: string
}
function dataDirLayout(dir: string): DataDirLayout
function ensureDir0700(dir: string): void
function writeFile0600(filePath: string, bytes: string | Uint8Array): void
function appendLine0600(filePath: string, line: string): void
function fsyncPath(target: string): void          // works on a file OR a directory

// --- record sealing ---------------------------------------------------------
const RECORD_KINDS: readonly ['ITEM_ADDED', 'ITEM_UPDATED', 'ITEM_DELETED', 'CHECKPOINT']
const NONCE_BYTES: 12
const TAG_BYTES: 16
const ANCHOR_AAD_SEQ: 0
function recordAad(lineIndex: number, seq: number, kind: StoreEventKind): Buffer
function sealRecord(args: { key: Buffer; lineIndex: number; seq: number; kind: StoreEventKind; payload: Uint8Array }): string
function openRecord(args: { key: Buffer; lineIndex: number; seq: number; kind: StoreEventKind; line: string }): Result<Buffer>
function openRecordAnyKind(args: { key: Buffer; lineIndex: number; seq: number; line: string }): Result<{ kind: StoreEventKind; payload: Buffer }>

// --- hash chain -------------------------------------------------------------
const CHAIN_GENESIS: ContentHash                  // 'sha256-65kkf25TFtOBWoOISYgGREW0uYOzKyXTZbpV_niBLM4'
function chainNext(prev: ContentHash, sealedLine: string): ContentHash
function chainTip(sealedLines: readonly string[]): ContentHash
interface ChainVerifier {
  check(lineIndex: number, sealedLine: string, prevRecordHash: ContentHash): Result<void>
  tip(): ContentHash
}
function createChainVerifier(): ChainVerifier

// --- blobs ------------------------------------------------------------------
interface BlobStore {
  put(bytes: Uint8Array): Result<BlobId>
  get(id: BlobId): Result<Buffer>
  remove(id: BlobId): Result<boolean>
  has(id: BlobId): boolean
  fileFor(id: BlobId): string
  files(): readonly string[]
  totalBytes(): number
  close(): void
}
function createBlobStore(opts: { blobDir: string; key: Buffer; logger: Logger }): BlobStore

// --- test helpers (exported: @cairn/history's tests need them too) -----------
function tempStoreDir(): { dir: string; cleanup: () => void }
function randomTestKey(): Buffer
const silentLogger: Logger
function fixedClock(startMs?: number): Clock
function testItemId(n: number): ItemId                 // deterministic 26-char id
function itemFixture(id: ItemId, blobId: BlobId, text: string): Item
```

Two deliberate refinements of the contract's one-line summaries, both recorded in this plan's
`concerns` for central reconciliation:

- The contract writes `openStore({dir, key, clock, logger}) -> Store`. It returns **`Result<Store>`**,
  because a wrong key or a tampered log is a *state* `@cairn/keyring`'s `rekeyAfterCorruption()` has to
  be able to see, not a programmer error.
- Every method except `readAll` is **synchronous**. The log has exactly one writer and the
  fsync-before-append ordering must never interleave; sync `node:fs` makes an interleaving bug
  impossible. `readAll` is an `AsyncIterable` as the spec requires. `await` on a sync method is
  harmless if a caller writes it.

---

**Branch:** `m1/06-store`

---

- [ ] **Step 1: Cut the branch.**
  ```sh
  cd "$(git rev-parse --show-toplevel)"
  git fetch origin && git checkout -b m1/06-store origin/main
  ```
  Expected: `Switched to a new branch 'm1/06-store'`. Never commit to `main`.

- [ ] **Step 2: VERIFY the workspace manifest Task 1 already created. Do not rewrite it.**
  `packages/store/package.json` is created **once** in this repo, by Task 1's step that writes the ten
  workspace manifests, and Task 1's install already committed its `package-lock.json` entry. Rewriting
  it here would either be a no-op diff or a silent divergence, so this step only checks it.
  ```sh
  cat packages/store/package.json
  ls -l node_modules/@cairn/store
  ```
  Expected — exactly this content, byte for byte:
  ```json
  {
    "name": "@cairn/store",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "description": "encrypted append-only log + blobs",
    "exports": { ".": "./src/index.ts" },
    "scripts": {
      "test": "vitest run --root ../.. --project unit packages/store",
      "test:security": "vitest run --root ../.. --project security packages/store"
    },
    "dependencies": { "@cairn/protocol": "0.1.0" }
  }
  ```
  and `node_modules/@cairn/store -> ../packages/store`, so `@cairn/protocol` resolves from inside
  `packages/store` and `npm run … -w @cairn/store` works. **One** dependency, `@cairn/protocol`, which
  is what contract §2's dependency table lists for this package.

  If the file is missing or the symlink is absent, Task 1 is not merged — stop and merge it first
  rather than writing the manifest here. If the content differs, that is a real conflict to raise, not
  something to overwrite. Only if `ls -l` fails while the manifest is correct, run `npm install` to
  re-link the workspace; it must leave `package-lock.json` unchanged (`git status --short` prints
  nothing).

- [ ] **Step 3: Write the test helpers every later test imports.**
  `packages/store/src/testing.ts`:
  ```ts
  import { mkdtempSync, rmSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { randomBytes } from 'node:crypto'
  import { contentHash, type BlobId, type Clock, type Item, type ItemId, type Logger } from '@cairn/protocol'

  /** A fresh directory that is removed on cleanup. Never reused between tests. */
  export function tempStoreDir(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-test-'))
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  /** A random 32-byte master key: the store takes a key as an argument precisely so every test
   *  runs on a machine with no keychain and no compiler (spec §4). */
  export function randomTestKey(): Buffer {
    return randomBytes(32)
  }

  export const silentLogger: Logger = {
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  /** The store never needs timers, only `now()`. 2026-01-01T00:00:00Z by default. */
  export function fixedClock(startMs = 1_767_225_600_000): Clock {
    return { now: () => startMs, setTimeout: () => () => {} }
  }

  /** A deterministic 26-char Crockford base32 item id, so fixtures are reproducible. */
  export const testItemId = (n: number): ItemId =>
    `0000000000000000000000000${n}`.slice(-26).toUpperCase() as ItemId

  /** A minimal text `Item` with one representation, pointing at an already-stored blob. These two
   *  live here rather than in a `*.test.ts` file because importing one test file from another makes
   *  vitest collect the imported file's `describe` blocks twice. */
  export function itemFixture(id: ItemId, blobId: BlobId, text: string): Item {
    const hash = contentHash(Buffer.from(text, 'utf8'))
    return {
      id,
      kind: 'text',
      contentHash: hash,
      preview: text,
      previewTruncated: false,
      maskSpans: [],
      flags: [],
      repRefs: [
        { mime: 'text/plain', uti: 'public.utf8-plain-text', byteLength: text.length, sha256: hash, blobId },
      ],
      thumbnailBlobId: null,
      sourceApp: null,
      byteLength: text.length,
      createdAt: 1_767_225_600_000,
      updatedAt: 1_767_225_600_000,
      pinned: false,
      expiresAt: null,
    }
  }
  ```

- [ ] **Step 4: Write the failing permissions test.**
  `packages/store/src/paths.security.test.ts`:
  ```ts
  import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { afterEach, beforeEach, describe, expect, it } from 'vitest'
  import { appendLine0600, dataDirLayout, ensureDir0700, writeFile0600 } from './paths'

  const mode = (p: string): number => statSync(p).mode & 0o777

  describe('data dir layout and permissions (spec §11: 0700 dir, 0600 files)', () => {
    let dir = ''
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cairn-test-'))
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('names every file the store owns', () => {
      expect(dataDirLayout('/data/Cairn')).toEqual({
        dir: '/data/Cairn',
        logPath: '/data/Cairn/history.ndjson',
        tmpLogPath: '/data/Cairn/history.ndjson.tmp',
        metaPath: '/data/Cairn/meta.json',
        keyPath: '/data/Cairn/key.bin',
        blobDir: '/data/Cairn/blobs',
      })
    })

    it('creates every directory 0700, intermediates included', () => {
      const layout = dataDirLayout(join(dir, 'nested', 'Cairn'))
      ensureDir0700(layout.dir)
      ensureDir0700(layout.blobDir)
      expect(mode(join(dir, 'nested'))).toBe(0o700)
      expect(mode(layout.dir)).toBe(0o700)
      expect(mode(layout.blobDir)).toBe(0o700)
    })

    it('writes every file 0600 and does not widen the mode on a second append', () => {
      const layout = dataDirLayout(dir)
      ensureDir0700(layout.dir)
      writeFile0600(layout.metaPath, '{"schemaVersion":1}')
      writeFile0600(layout.keyPath, new Uint8Array([1, 2, 3]))
      appendLine0600(layout.logPath, 'AAAA')
      expect(mode(layout.metaPath)).toBe(0o600)
      expect(mode(layout.keyPath)).toBe(0o600)
      expect(mode(layout.logPath)).toBe(0o600)
      appendLine0600(layout.logPath, 'BBBB')
      expect(mode(layout.logPath)).toBe(0o600)
      expect(readFileSync(layout.logPath, 'utf8')).toBe('AAAA\nBBBB\n')
    })

    it('terminates every appended line with \\n, which is the commit marker', () => {
      const layout = dataDirLayout(dir)
      ensureDir0700(layout.dir)
      appendLine0600(layout.logPath, 'only-line')
      expect(readFileSync(layout.logPath, 'utf8').endsWith('\n')).toBe(true)
      expect(existsSync(layout.tmpLogPath)).toBe(false)
    })

    it('keeps 0700 and 0600 even under a hostile umask, because chmod is not masked', () => {
      // `mkdirSync`'s and `writeFileSync`'s `mode` argument is masked by the process umask: under
      // `umask 0222` a mode-0700 mkdir actually lands at 0500 and a mode-0600 write at 0400. The
      // explicit chmod in paths.ts is the only reason this test passes. The umask is set inside the
      // test, not in the shell, because vite cannot write its own temp files under it.
      const previous = process.umask(0o222)
      try {
        const layout = dataDirLayout(join(dir, 'Cairn'))
        ensureDir0700(layout.dir)
        expect(mode(layout.dir)).toBe(0o700)
        ensureDir0700(layout.blobDir)
        expect(mode(layout.blobDir)).toBe(0o700)
        writeFile0600(layout.metaPath, '{"schemaVersion":1}')
        expect(mode(layout.metaPath)).toBe(0o600)
        appendLine0600(layout.logPath, 'AAAA')
        appendLine0600(layout.logPath, 'BBBB')
        expect(mode(layout.logPath)).toBe(0o600)
      } finally {
        process.umask(previous)
      }
    })
  })
  ```

- [ ] **Step 5: Run it and watch it fail for the right reason.**
  ```sh
  npx vitest run --project security packages/store/src/paths.security.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './paths' imported from …/paths.security.test.ts`.

- [ ] **Step 6: Implement `paths.ts`.**
  `packages/store/src/paths.ts`:
  ```ts
  import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
  import { join } from 'node:path'
  import { STORE_BLOB_DIR, STORE_KEY_FILE, STORE_LOG_FILE, STORE_META_FILE } from '@cairn/protocol'

  export interface DataDirLayout {
    readonly dir: string
    readonly logPath: string
    readonly tmpLogPath: string
    readonly metaPath: string
    readonly keyPath: string
    readonly blobDir: string
  }

  export function dataDirLayout(dir: string): DataDirLayout {
    return {
      dir,
      logPath: join(dir, STORE_LOG_FILE),
      tmpLogPath: join(dir, `${STORE_LOG_FILE}.tmp`),
      metaPath: join(dir, STORE_META_FILE),
      keyPath: join(dir, STORE_KEY_FILE),
      blobDir: join(dir, STORE_BLOB_DIR),
    }
  }

  /** mkdir -p 0700, then an explicit chmod: the `mode` argument is masked by the process umask,
   *  chmod is not. Under `umask 0222` a mode-0700 mkdir actually lands at 0500. */
  export function ensureDir0700(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }

  export function writeFile0600(filePath: string, bytes: string | Uint8Array): void {
    writeFileSync(filePath, bytes, { mode: 0o600 })
    chmodSync(filePath, 0o600)
  }

  /** Appends one `\n`-terminated line and fsyncs it. The trailing newline is the commit marker:
   *  a line without one never became durable. `appendFileSync`'s `mode` option is ignored for an
   *  existing file, so the chmod is what keeps 0600 across appends. */
  export function appendLine0600(filePath: string, line: string): void {
    if (!existsSync(filePath)) writeFile0600(filePath, '')
    const fd = openSync(filePath, 'a')
    try {
      writeSync(fd, `${line}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(filePath, 0o600)
  }

  /** fsync a file OR a directory, so a create or a rename is durable before the next step. */
  export function fsyncPath(target: string): void {
    const fd = openSync(target, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  ```

- [ ] **Step 7: Run it green.**
  ```sh
  npx vitest run --project security packages/store/src/paths.security.test.ts
  ```
  Expected: `Test Files 1 passed (1)`, `Tests 5 passed (5)`.

- [ ] **Step 8: Prove the two `chmod` lines are load-bearing.**
  Delete both `chmodSync` calls — the one in `ensureDir0700` and the one in `writeFile0600` — and
  re-run the same command.
  Expected: FAIL in *keeps 0700 and 0600 even under a hostile umask* with
  `AssertionError: expected 320 to be 448 // Object.is equality` at
  `expect(mode(layout.dir)).toBe(0o700)` — 320 is `0o500`, 448 is `0o700`. Restore both `chmodSync`
  lines and re-run to get back to `Tests 5 passed (5)`. (Do **not** try to force the umask from the
  shell instead: `umask 0222 && npx vitest` fails inside vite, which cannot write
  `node_modules/.vite-temp/vitest.config.ts.timestamp-*.mjs`, and it leaves that directory
  unwritable afterwards.)

- [ ] **Step 9: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): 0700 data dir and 0600 files with an explicit chmod"
  ```
  `package-lock.json` is deliberately not staged: Task 1 created this workspace's manifest and lock
  entry, so `git status --short` shows no change to it.

- [ ] **Step 10: Write the failing record-sealing test.**
  `packages/store/src/record.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { STORE_AAD_MAGIC } from '@cairn/protocol'
  import {
    ANCHOR_AAD_SEQ,
    NONCE_BYTES,
    RECORD_KINDS,
    TAG_BYTES,
    openRecord,
    openRecordAnyKind,
    recordAad,
    sealRecord,
  } from './record'
  import { randomTestKey } from './testing'

  const PAYLOAD = Buffer.from('{"seq":7,"kind":"ITEM_ADDED"}', 'utf8')

  describe('recordAad', () => {
    it('is magic || u64be(lineIndex) || u64be(seq) || kind', () => {
      const aad = recordAad(3, 7, 'ITEM_ADDED')
      expect(aad.subarray(0, 14).toString('utf8')).toBe(STORE_AAD_MAGIC)
      expect(aad.readBigUInt64BE(14)).toBe(3n)
      expect(aad.readBigUInt64BE(22)).toBe(7n)
      expect(aad.subarray(30).toString('utf8')).toBe('ITEM_ADDED')
      expect(aad.length).toBe(14 + 16 + 'ITEM_ADDED'.length)
    })

    it('covers all four record kinds and the anchor seq is 0', () => {
      expect(RECORD_KINDS).toEqual(['ITEM_ADDED', 'ITEM_UPDATED', 'ITEM_DELETED', 'CHECKPOINT'])
      expect(ANCHOR_AAD_SEQ).toBe(0)
    })
  })

  describe('sealRecord / openRecord', () => {
    it('round-trips base64(nonce12 || ct || tag16)', () => {
      const key = randomTestKey()
      const line = sealRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', payload: PAYLOAD })
      expect(line).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
      const raw = Buffer.from(line, 'base64')
      expect(raw.length).toBe(NONCE_BYTES + PAYLOAD.length + TAG_BYTES)
      const opened = openRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', line })
      expect(opened.ok).toBe(true)
      if (!opened.ok) throw new Error('unreachable')
      expect(opened.value.toString('utf8')).toBe(PAYLOAD.toString('utf8'))
    })

    it('uses a fresh nonce per record, so the same payload never seals to the same line', () => {
      const key = randomTestKey()
      const a = sealRecord({ key, lineIndex: 0, seq: 0, kind: 'CHECKPOINT', payload: PAYLOAD })
      const b = sealRecord({ key, lineIndex: 0, seq: 0, kind: 'CHECKPOINT', payload: PAYLOAD })
      expect(a).not.toBe(b)
    })

    it('refuses a record moved to a different LINE', () => {
      const key = randomTestKey()
      const line = sealRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', payload: PAYLOAD })
      const moved = openRecord({ key, lineIndex: 4, seq: 7, kind: 'ITEM_ADDED', line })
      expect(moved.ok).toBe(false)
      if (moved.ok) throw new Error('unreachable')
      expect(moved.code).toBe('E_STORE_DECRYPT')
      expect(moved.message).toContain('line 4')
    })

    it('refuses a record replayed under a different SEQ or a different KIND', () => {
      const key = randomTestKey()
      const line = sealRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', payload: PAYLOAD })
      const wrongSeq = openRecord({ key, lineIndex: 3, seq: 8, kind: 'ITEM_ADDED', line })
      const wrongKind = openRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_DELETED', line })
      expect(wrongSeq.ok).toBe(false)
      expect(wrongKind.ok).toBe(false)
      if (wrongSeq.ok || wrongKind.ok) throw new Error('unreachable')
      expect(wrongSeq.code).toBe('E_STORE_DECRYPT')
      expect(wrongKind.code).toBe('E_STORE_DECRYPT')
    })

    it('refuses a record sealed under a different key', () => {
      const line = sealRecord({ key: randomTestKey(), lineIndex: 0, seq: 0, kind: 'CHECKPOINT', payload: PAYLOAD })
      const opened = openRecord({ key: randomTestKey(), lineIndex: 0, seq: 0, kind: 'CHECKPOINT', line })
      expect(opened.ok).toBe(false)
    })

    it('never throws on garbage, however short', () => {
      const key = randomTestKey()
      for (const line of ['', '!!!', 'AAAA', 'not base64 at all']) {
        const opened = openRecord({ key, lineIndex: 0, seq: 0, kind: 'CHECKPOINT', line })
        expect(opened.ok).toBe(false)
        if (opened.ok) throw new Error('unreachable')
        expect(opened.code).toBe('E_STORE_DECRYPT')
      }
    })
  })

  describe('openRecordAnyKind', () => {
    it('finds the kind the record was sealed under', () => {
      const key = randomTestKey()
      const line = sealRecord({ key, lineIndex: 2, seq: 5, kind: 'ITEM_DELETED', payload: PAYLOAD })
      const opened = openRecordAnyKind({ key, lineIndex: 2, seq: 5, line })
      expect(opened.ok).toBe(true)
      if (!opened.ok) throw new Error('unreachable')
      expect(opened.value.kind).toBe('ITEM_DELETED')
      expect(opened.value.payload.toString('utf8')).toBe(PAYLOAD.toString('utf8'))
    })

    it('still refuses a record at the wrong line, under every kind', () => {
      const key = randomTestKey()
      const line = sealRecord({ key, lineIndex: 2, seq: 5, kind: 'ITEM_DELETED', payload: PAYLOAD })
      const opened = openRecordAnyKind({ key, lineIndex: 9, seq: 5, line })
      expect(opened.ok).toBe(false)
      if (opened.ok) throw new Error('unreachable')
      expect(opened.message).toContain('every record kind')
    })
  })
  ```

- [ ] **Step 11: Run it and watch it fail for the right reason.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: FAIL with `Error: Cannot find module './record' imported from …/record.test.ts`.

- [ ] **Step 12: Implement `record.ts`.**
  `packages/store/src/record.ts`:
  ```ts
  import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
  import { STORE_AAD_MAGIC, err, ok, type Result, type StoreEventKind } from '@cairn/protocol'

  export const RECORD_KINDS = [
    'ITEM_ADDED',
    'ITEM_UPDATED',
    'ITEM_DELETED',
    'CHECKPOINT',
  ] as const satisfies readonly StoreEventKind[]

  export const NONCE_BYTES = 12
  export const TAG_BYTES = 16
  /** Line 0 of every log generation is the anchor CHECKPOINT, sealed under this fixed AAD seq —
   *  the reader cannot know the generation's first seq before it has decrypted something. */
  export const ANCHOR_AAD_SEQ = 0

  /** `'cairn/store/v1' || u64be(lineIndex) || u64be(seq) || recordKind` (spec §4). */
  export function recordAad(lineIndex: number, seq: number, kind: StoreEventKind): Buffer {
    const counters = Buffer.alloc(16)
    counters.writeBigUInt64BE(BigInt(lineIndex), 0)
    counters.writeBigUInt64BE(BigInt(seq), 8)
    return Buffer.concat([Buffer.from(STORE_AAD_MAGIC, 'utf8'), counters, Buffer.from(kind, 'utf8')])
  }

  export function sealRecord(args: {
    key: Buffer
    lineIndex: number
    seq: number
    kind: StoreEventKind
    payload: Uint8Array
  }): string {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', args.key, nonce)
    cipher.setAAD(recordAad(args.lineIndex, args.seq, args.kind))
    const ct = Buffer.concat([cipher.update(args.payload), cipher.final()])
    return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64')
  }

  export function openRecord(args: {
    key: Buffer
    lineIndex: number
    seq: number
    kind: StoreEventKind
    line: string
  }): Result<Buffer> {
    const raw = Buffer.from(args.line, 'base64')
    if (raw.length < NONCE_BYTES + TAG_BYTES) {
      return err('E_STORE_DECRYPT', `record at line ${args.lineIndex} is too short to be a record`)
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', args.key, raw.subarray(0, NONCE_BYTES))
      decipher.setAAD(recordAad(args.lineIndex, args.seq, args.kind))
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
      const head = decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES))
      return ok(Buffer.concat([head, decipher.final()]))
    } catch {
      return err('E_STORE_DECRYPT', `record at line ${args.lineIndex} failed to authenticate`)
    }
  }

  /**
   * The reader cannot know a record's kind before opening it, and the kind is in the AAD, so it
   * tries all four (microseconds each). This is not a hole: forging a GCM tag under a different AAD
   * is what is infeasible, and `log-store` additionally cross-checks the opened payload's own `kind`
   * against the kind it opened under.
   */
  export function openRecordAnyKind(args: {
    key: Buffer
    lineIndex: number
    seq: number
    line: string
  }): Result<{ kind: StoreEventKind; payload: Buffer }> {
    for (const kind of RECORD_KINDS) {
      const opened = openRecord({ ...args, kind })
      if (opened.ok) return ok({ kind, payload: opened.value })
    }
    return err(
      'E_STORE_DECRYPT',
      `record at line ${args.lineIndex} failed to authenticate under every record kind`,
    )
  }
  ```

- [ ] **Step 13: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 1 passed (1)`, `Tests 10 passed (10)`.

- [ ] **Step 14: Prove the AAD's line binding is load-bearing.**
  In `recordAad`, replace `counters.writeBigUInt64BE(BigInt(lineIndex), 0)` with
  `counters.writeBigUInt64BE(0n, 0)` — i.e. stop binding the line index — and re-run
  `npm run test -w @cairn/store`.
  Expected: FAIL with `expected 3n to be 0n` in *recordAad* **and**
  `AssertionError: expected true to be false` in *refuses a record moved to a different LINE*, because
  a record now opens at any line. Restore the line and re-run to get `Tests 10 passed (10)`.

- [ ] **Step 15: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): AES-256-GCM records bound to line index, seq and kind"
  ```

- [ ] **Step 16: Write the failing hash-chain test (pure part).**
  `packages/store/src/chain.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { contentHash } from '@cairn/protocol'
  import { CHAIN_GENESIS, chainNext, chainTip, createChainVerifier } from './chain'

  describe('chain primitives', () => {
    it('has a fixed, domain-separated genesis hash', () => {
      expect(CHAIN_GENESIS).toBe('sha256-65kkf25TFtOBWoOISYgGREW0uYOzKyXTZbpV_niBLM4')
      expect(CHAIN_GENESIS).toBe(contentHash(Buffer.from('cairn/store/v1/genesis', 'utf8')))
    })

    it('folds the SEALED line into the running hash', () => {
      const first = chainNext(CHAIN_GENESIS, 'AAAA')
      expect(first).toBe(
        contentHash(Buffer.concat([Buffer.from(CHAIN_GENESIS, 'utf8'), Buffer.from('AAAA', 'utf8')])),
      )
      expect(first).not.toBe(chainNext(CHAIN_GENESIS, 'AAAB'))
      expect(chainNext(first, 'BBBB')).not.toBe(chainNext(CHAIN_GENESIS, 'BBBB'))
    })

    it('chainTip is order-sensitive', () => {
      expect(chainTip(['A', 'B', 'C'])).toBe(chainNext(chainNext(chainNext(CHAIN_GENESIS, 'A'), 'B'), 'C'))
      expect(chainTip(['A', 'B', 'C'])).not.toBe(chainTip(['A', 'C', 'B']))
      expect(chainTip([])).toBe(CHAIN_GENESIS)
    })

    it('accepts a well-formed chain and advances the tip', () => {
      const verifier = createChainVerifier()
      const first = verifier.check(0, 'AAAA', CHAIN_GENESIS)
      expect(first.ok).toBe(true)
      expect(verifier.tip()).toBe(chainNext(CHAIN_GENESIS, 'AAAA'))
      expect(verifier.check(1, 'BBBB', chainNext(CHAIN_GENESIS, 'AAAA')).ok).toBe(true)
      expect(verifier.tip()).toBe(chainTip(['AAAA', 'BBBB']))
    })

    it('rejects a record whose declared prev is not the running hash', () => {
      const verifier = createChainVerifier()
      expect(verifier.check(0, 'AAAA', CHAIN_GENESIS).ok).toBe(true)
      const broken = verifier.check(1, 'BBBB', CHAIN_GENESIS)
      expect(broken.ok).toBe(false)
      if (broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_CHAIN_BROKEN')
      expect(broken.message).toContain('chain broken at line 1')
    })
  })
  ```

- [ ] **Step 17: Run it and watch it fail for the right reason.**
  ```sh
  npx vitest run --project unit packages/store/src/chain.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './chain' imported from …/chain.test.ts`.

- [ ] **Step 18: Implement `chain.ts`.**
  `packages/store/src/chain.ts`:
  ```ts
  import { contentHash, err, ok, type ContentHash, type Result } from '@cairn/protocol'

  /** The hash every generation's line 0 declares as its `prev`. */
  export const CHAIN_GENESIS: ContentHash = contentHash(Buffer.from('cairn/store/v1/genesis', 'utf8'))

  /** h(i) = sha256(h(i-1) || sealedLine(i)). Hashed over the SEALED line, never over plaintext. */
  export function chainNext(prev: ContentHash, sealedLine: string): ContentHash {
    return contentHash(Buffer.concat([Buffer.from(prev, 'utf8'), Buffer.from(sealedLine, 'utf8')]))
  }

  /** The tip after folding every line of a log in file order. */
  export function chainTip(sealedLines: readonly string[]): ContentHash {
    let tip = CHAIN_GENESIS
    for (const line of sealedLines) tip = chainNext(tip, line)
    return tip
  }

  export interface ChainVerifier {
    /** Checks one record's declared `prev` against the running hash, then folds the line in. */
    check(lineIndex: number, sealedLine: string, prevRecordHash: ContentHash): Result<void>
    tip(): ContentHash
  }

  /**
   * Streaming chain check. This is what catches a record REPLACED by a different record that held
   * the same line index, seq and kind in an older state of the log — a rollback the AAD cannot see,
   * because every AAD field still matches. Without it, splicing yesterday's line 12 over today's
   * ITEM_DELETED resurrects a deleted secret.
   */
  export function createChainVerifier(): ChainVerifier {
    let expected: ContentHash = CHAIN_GENESIS
    return {
      check(lineIndex, sealedLine, prevRecordHash) {
        if (prevRecordHash !== expected) {
          return err(
            'E_STORE_CHAIN_BROKEN',
            `chain broken at line ${lineIndex}: record declares prev ${prevRecordHash}, log hashes to ${expected}`,
          )
        }
        expected = chainNext(expected, sealedLine)
        return ok(undefined)
      },
      tip: () => expected,
    }
  }
  ```

- [ ] **Step 19: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 2 passed (2)`, `Tests 15 passed (15)`.

- [ ] **Step 20: Commit.**
  ```sh
  git add packages/store && git commit -m "feat(store): prevRecordHash chain primitives"
  ```

- [ ] **Step 21: Write the failing blob-store test.**
  `packages/store/src/blobs.test.ts`:
  ```ts
  import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto'
  import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
  import { basename, join } from 'node:path'
  import { afterEach, describe, expect, it } from 'vitest'
  import { BLOB_HKDF_INFO, contentHash, type BlobId } from '@cairn/protocol'
  import { createBlobStore } from './blobs'
  import { randomTestKey, silentLogger, tempStoreDir } from './testing'

  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function freshBlobStore() {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    const blobDir = join(dir, 'blobs')
    const key = randomTestKey()
    return { dir, blobDir, key, blobs: createBlobStore({ blobDir, key, logger: silentLogger }) }
  }

  const MISSING = ('sha256-' + 'C'.repeat(43)) as BlobId

  describe('createBlobStore', () => {
    it('addresses a blob by the sha256 of its PLAINTEXT and round-trips it', () => {
      const { blobs } = freshBlobStore()
      const bytes = Buffer.from('a fairly secret blob body')
      const put = blobs.put(bytes)
      expect(put.ok).toBe(true)
      if (!put.ok) throw new Error('unreachable')
      expect(put.value).toBe(contentHash(bytes))
      expect(put.value).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/)
      const got = blobs.get(put.value)
      expect(got.ok).toBe(true)
      if (!got.ok) throw new Error('unreachable')
      expect(got.value.equals(bytes)).toBe(true)
    })

    it('is idempotent: the same bytes twice is one file', () => {
      const { blobDir, blobs } = freshBlobStore()
      const bytes = Buffer.from('same body')
      const first = blobs.put(bytes)
      const second = blobs.put(bytes)
      expect(first.ok && second.ok && first.value === second.value).toBe(true)
      expect(readdirSync(blobDir)).toHaveLength(1)
    })

    it('stores nonce || ct || tag and never the plaintext', () => {
      const { blobDir, blobs } = freshBlobStore()
      const bytes = Buffer.from('the-plaintext-marker')
      const put = blobs.put(bytes)
      if (!put.ok) throw new Error('unreachable')
      const files = readdirSync(blobDir)
      expect(files).toHaveLength(1)
      const file = join(blobDir, files[0] as string)
      expect(statSync(file).size).toBe(bytes.length + 12 + 16)
      expect(readFileSync(file).includes('the-plaintext-marker')).toBe(false)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(blobDir).mode & 0o777).toBe(0o700)
    })

    it('does not put the blob id in the filename, so the disk is no confirmation oracle', () => {
      const { blobDir, blobs } = freshBlobStore()
      const put = blobs.put(Buffer.from('guessable'))
      if (!put.ok) throw new Error('unreachable')
      const name = readdirSync(blobDir)[0] as string
      expect(name.endsWith('.blob')).toBe(true)
      expect(name).not.toContain(put.value.slice(7))
      expect(blobs.fileFor(put.value)).toBe(join(blobDir, name))
    })

    it('is keyed: another key cannot read the same file', () => {
      const { blobDir, blobs } = freshBlobStore()
      const put = blobs.put(Buffer.from('under key A'))
      if (!put.ok) throw new Error('unreachable')
      const other = createBlobStore({ blobDir, key: randomTestKey(), logger: silentLogger })
      expect(other.has(put.value)).toBe(false)
      expect(other.get(put.value).ok).toBe(false)
    })

    it('reports a missing blob as E_BLOB_MISSING and never throws', () => {
      const { blobs } = freshBlobStore()
      const got = blobs.get(MISSING)
      expect(got.ok).toBe(false)
      if (got.ok) throw new Error('unreachable')
      expect(got.code).toBe('E_BLOB_MISSING')
      expect(blobs.has(MISSING)).toBe(false)
    })

    it('refuses a tampered body and a tampered nonce', () => {
      const { blobDir, blobs } = freshBlobStore()
      const put = blobs.put(Buffer.from('tamper me please, at length'))
      if (!put.ok) throw new Error('unreachable')
      const file = join(blobDir, readdirSync(blobDir)[0] as string)
      const body = readFileSync(file)
      body[body.length - 20] ^= 0xff
      writeFileSync(file, body)
      const got = blobs.get(put.value)
      expect(got.ok).toBe(false)
      if (got.ok) throw new Error('unreachable')
      expect(got.code).toBe('E_STORE_DECRYPT')
      const nonceTampered = readFileSync(file)
      nonceTampered[0] ^= 0xff
      writeFileSync(file, nonceTampered)
      expect(blobs.get(put.value).ok).toBe(false)
    })

    it('deletes once, then reports false, and totals bytes', () => {
      const { blobs } = freshBlobStore()
      const put = blobs.put(Buffer.from('0123456789'))
      if (!put.ok) throw new Error('unreachable')
      expect(blobs.totalBytes()).toBe(10 + 28)
      expect(blobs.files()).toHaveLength(1)
      const first = blobs.remove(put.value)
      const second = blobs.remove(put.value)
      expect(first.ok && first.value).toBe(true)
      expect(second.ok && second.value).toBe(false)
      expect(blobs.files()).toHaveLength(0)
    })

    it('derives a DIFFERENT body subkey per blob, so one blob cannot open another (spec §11 control 7)', () => {
      const { blobDir, key, blobs } = freshBlobStore()
      const a = blobs.put(Buffer.from('body of blob A'))
      const b = blobs.put(Buffer.from('body of blob B'))
      if (!a.ok || !b.ok) throw new Error('unreachable')

      // The derivation this test pins: HKDF-SHA256(master, salt = the blob id, info = 'cairn/blob/v1').
      const subkey = (id: BlobId): Buffer =>
        Buffer.from(hkdfSync('sha256', key, Buffer.from(id, 'utf8'), BLOB_HKDF_INFO, 32))
      expect(subkey(a.value).equals(subkey(b.value))).toBe(false)

      const openWith = (id: BlobId, bodyKey: Buffer): Buffer => {
        const raw = readFileSync(blobs.fileFor(id))
        const decipher = createDecipheriv('aes-256-gcm', bodyKey, raw.subarray(0, 12))
        decipher.setAAD(Buffer.from(id, 'utf8'))
        decipher.setAuthTag(raw.subarray(raw.length - 16))
        return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()])
      }
      // A's own subkey opens A's body…
      expect(openWith(a.value, subkey(a.value)).toString('utf8')).toBe('body of blob A')
      // …and B's subkey opens nothing of A's. That is what makes destroying one blob's key mean
      // something: it is not also every other blob's key.
      expect(() => openWith(a.value, subkey(b.value))).toThrow(/unable to authenticate data/)
      expect(readdirSync(blobDir)).toHaveLength(2)
    })

    it('zero-fills the derived name subkey on close, without touching the caller master key', () => {
      const { blobDir, key } = freshBlobStore()
      const blobs = createBlobStore({ blobDir, key, logger: silentLogger })
      const put = blobs.put(Buffer.from('before close'))
      if (!put.ok) throw new Error('unreachable')
      const fileBefore = blobs.fileFor(put.value)
      blobs.close()
      // The name subkey is a closure local, so its CONTENTS are asserted through the one function
      // that reads it: after `close()`, `fileFor` must produce the HMAC taken under 32 ZERO bytes.
      // Only an all-zero buffer can give that answer, so this is a contents assertion, not a
      // behavioural one.
      const zeroKeyName = `${createHmac('sha256', Buffer.alloc(32)).update(put.value).digest('base64url')}.blob`
      expect(basename(blobs.fileFor(put.value))).toBe(zeroKeyName)
      expect(basename(fileBefore)).not.toBe(zeroKeyName)
      // Naming a file that does not exist is reported as state; `get` does not throw, and it destroys
      // nothing on disk.
      const after = blobs.get(put.value)
      expect(after.ok).toBe(false)
      if (after.ok) throw new Error('unreachable')
      expect(after.code).toBe('E_BLOB_MISSING')
      // Proof that only the DERIVED material was wiped: the caller's master key still opens the blob.
      const fresh = createBlobStore({ blobDir, key, logger: silentLogger })
      const reread = fresh.get(put.value)
      expect(reread.ok && reread.value.toString('utf8')).toBe('before close')
    })
  })
  ```

- [ ] **Step 22: Run it and watch it fail for the right reason.**
  ```sh
  npx vitest run --project unit packages/store/src/blobs.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './blobs' imported from …/blobs.test.ts`.

- [ ] **Step 23: Implement `blobs.ts`.**
  `packages/store/src/blobs.ts`:
  ```ts
  import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
  import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
  import { join } from 'node:path'
  import {
    BLOB_HKDF_INFO,
    contentHash,
    err,
    ok,
    type BlobId,
    type Logger,
    type Result,
  } from '@cairn/protocol'
  import { NONCE_BYTES, TAG_BYTES } from './record'
  import { ensureDir0700, fsyncPath, writeFile0600 } from './paths'

  export interface BlobStore {
    put(bytes: Uint8Array): Result<BlobId>
    get(id: BlobId): Result<Buffer>
    remove(id: BlobId): Result<boolean>
    has(id: BlobId): boolean
    /** Absolute path of the file that holds `id`, whether or not it exists. */
    fileFor(id: BlobId): string
    files(): readonly string[]
    totalBytes(): number
    close(): void
  }

  /**
   * Two HKDF-SHA256 derivations, both under the info string `'cairn/blob/v1'`:
   *
   * - the **name** subkey — one per store, empty salt — HMACs a blob id into a filename. The
   *   filename is an HMAC rather than the id itself because a plaintext content hash on disk is a
   *   confirmation oracle — "is one of these files sha256('hunter2')?" — and clipboard content is
   *   often guessable.
   * - the **body** subkey — one per blob, salt = that blob's id — seals that blob and no other.
   *   Spec §11 control 7 requires per-blob subkeys: unlinking a file does not erase it from free
   *   space, so what is supposed to make a deleted blob unrecoverable is that its key is gone. The
   *   salt is the plaintext sha256, which is recorded nowhere on disk except inside the sealed
   *   record that referenced the blob — so once `remove()` has unlinked the body and compaction has
   *   dropped that record, nothing left on disk lets the subkey be re-derived from the master key.
   */
  export function createBlobStore(opts: { blobDir: string; key: Buffer; logger: Logger }): BlobStore {
    ensureDir0700(opts.blobDir)
    const nameKey = Buffer.from(hkdfSync('sha256', opts.key, new Uint8Array(0), BLOB_HKDF_INFO, 32))

    /** The subkey for ONE blob. The salt is the blob id, so no two blobs share a body key. */
    const bodyKeyFor = (id: BlobId): Buffer =>
      Buffer.from(hkdfSync('sha256', opts.key, Buffer.from(id, 'utf8'), BLOB_HKDF_INFO, 32))

    const fileFor = (id: BlobId): string =>
      join(opts.blobDir, `${createHmac('sha256', nameKey).update(id).digest('base64url')}.blob`)

    return {
      fileFor,
      has: (id) => existsSync(fileFor(id)),
      files: () => readdirSync(opts.blobDir).map((f) => join(opts.blobDir, f)),
      totalBytes: () =>
        readdirSync(opts.blobDir).reduce((sum, f) => sum + statSync(join(opts.blobDir, f)).size, 0),
      put(bytes) {
        const id = contentHash(bytes) as BlobId
        const dest = fileFor(id)
        if (existsSync(dest)) return ok(id)
        const bodyKey = bodyKeyFor(id)
        const nonce = randomBytes(NONCE_BYTES)
        let sealed: Buffer
        try {
          const cipher = createCipheriv('aes-256-gcm', bodyKey, nonce)
          // The plaintext hash is both the AAD and the subkey salt, so a sealed body cannot be moved
          // onto another blob's id: it would be the wrong key AND the wrong AAD.
          cipher.setAAD(Buffer.from(id, 'utf8'))
          sealed = Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
        } finally {
          // The body subkey is derived per call and never outlives it, on EVERY exit path — the wipe
          // is in a `finally` so a throw out of `createCipheriv` cannot leave a live key behind.
          // `[verified]` `tsc --strict` accepts `sealed` as definitely assigned after a `try/finally`
          // with no `catch`, because a throw inside the try propagates instead of falling through.
          bodyKey.fill(0)
        }
        const tmp = `${dest}.tmp`
        try {
          // Write, fsync, rename, fsync the dir — all BEFORE the caller appends the referencing
          // event, so a crash can leak an orphan blob but never a dangling reference (spec §4).
          writeFile0600(tmp, sealed)
          fsyncPath(tmp)
          renameSync(tmp, dest)
          fsyncPath(opts.blobDir)
        } catch (cause) {
          return err('E_STORE_IO', `blob write failed: ${(cause as Error).message}`)
        }
        opts.logger.info('store.blob-written', {
          byteLength: bytes.byteLength,
          hashPrefix: id.slice(0, 12),
        })
        return ok(id)
      },
      get(id) {
        const file = fileFor(id)
        if (!existsSync(file)) return err('E_BLOB_MISSING', `blob ${id.slice(0, 12)} is not on disk`)
        const raw = readFileSync(file)
        if (raw.length < NONCE_BYTES + TAG_BYTES) {
          return err('E_STORE_DECRYPT', `blob ${id.slice(0, 12)} is too short to be a blob`)
        }
        const bodyKey = bodyKeyFor(id)
        let plaintext: Buffer
        try {
          const decipher = createDecipheriv('aes-256-gcm', bodyKey, raw.subarray(0, NONCE_BYTES))
          decipher.setAAD(Buffer.from(id, 'utf8'))
          decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
          const head = decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES))
          plaintext = Buffer.concat([head, decipher.final()])
        } catch {
          return err('E_STORE_DECRYPT', `blob ${id.slice(0, 12)} failed to authenticate`)
        } finally {
          // The body subkey is derived per call and never outlives it.
          bodyKey.fill(0)
        }
        if (contentHash(plaintext) !== id) {
          return err('E_STORE_CORRUPT', `blob ${id.slice(0, 12)} does not hash to its own id`)
        }
        return ok(plaintext)
      },
      remove(id) {
        const file = fileFor(id)
        if (!existsSync(file)) return ok(false)
        try {
          unlinkSync(file)
          fsyncPath(opts.blobDir)
        } catch (cause) {
          return err('E_STORE_IO', `blob delete failed: ${(cause as Error).message}`)
        }
        return ok(true)
      },
      close() {
        // The only derived material that outlives a call. After this, `fileFor` HMACs under 32 zero
        // bytes — legal, but it names a different file, so `get` reports E_BLOB_MISSING.
        nameKey.fill(0)
      },
    }
  }
  ```

- [ ] **Step 24: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 3 passed (3)`, `Tests 25 passed (25)`.

- [ ] **Step 25: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): content-addressed blobs sealed under per-blob HKDF subkeys"
  ```

- [ ] **Step 26: Write the failing append-only-log test.**
  `packages/store/src/log-store.test.ts`:
  ```ts
  import { readFileSync, statSync } from 'node:fs'
  import { join } from 'node:path'
  import { afterEach, describe, expect, it } from 'vitest'
  import type { ItemId, Result, StoreEvent } from '@cairn/protocol'
  import { openStore, type Store, type StoreMeta } from './log-store'
  import { fixedClock, itemFixture, randomTestKey, silentLogger, tempStoreDir, testItemId } from './testing'

  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  function openAt(dir: string, key: Buffer): Store {
    const opened = openStore({ dir, key, clock: fixedClock(), logger: silentLogger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    return opened.value
  }

  async function drain(store: Store): Promise<Result<StoreEvent>[]> {
    const out: Result<StoreEvent>[] = []
    for await (const record of store.readAll()) out.push(record)
    return out
  }

  /** A store holding `n` text items, each with its own blob. */
  function seeded(n: number): { dir: string; key: Buffer; store: Store; ids: ItemId[] } {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    const key = randomTestKey()
    const store = openAt(dir, key)
    const ids: ItemId[] = []
    for (let i = 0; i < n; i++) {
      const text = `payload-${i}`
      const blob = store.putBlob(Buffer.from(text, 'utf8'))
      if (!blob.ok) throw new Error(blob.message)
      const id = testItemId(i + 1)
      ids.push(id)
      const appended = store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(id, blob.value, text) })
      if (!appended.ok) throw new Error(appended.message)
    }
    return { dir, key, store, ids }
  }

  describe('openStore', () => {
    it('throws for a key that is not 32 bytes — that is a programmer error, not a state', () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      expect(() =>
        openStore({ dir, key: Buffer.alloc(16), clock: fixedClock(), logger: silentLogger }),
      ).toThrow('openStore: key must be exactly 32 bytes, got 16')
    })

    it('seals an anchor CHECKPOINT as line 0 of a brand new log', async () => {
      const { store } = seeded(0)
      const records = await drain(store)
      expect(records).toHaveLength(1)
      const first = records[0]
      if (first === undefined || !first.ok) throw new Error('unreachable')
      expect(first.value).toEqual({
        kind: 'CHECKPOINT',
        seq: 1,
        at: 1_767_225_600_000,
        maxSeq: 0,
        liveItemCount: 0,
        watermarks: {},
      })
    })

    it('reports E_STORE_DECRYPT for a store opened with the wrong key', () => {
      const { dir } = seeded(1)
      const wrong = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
      expect(wrong.ok).toBe(false)
      if (wrong.ok) throw new Error('unreachable')
      expect(wrong.code).toBe('E_STORE_DECRYPT')
    })
  })

  describe('appendEvent / readAll', () => {
    it('assigns contiguous seqs and returns the sealed event', async () => {
      const { store, ids } = seeded(3)
      const records = await drain(store)
      expect(records.every((r) => r.ok)).toBe(true)
      expect(records).toHaveLength(4)
      expect(records.map((r) => (r.ok ? r.value.seq : -1))).toEqual([1, 2, 3, 4])
      const deleted = store.appendEvent({ kind: 'ITEM_DELETED', id: ids[0] as ItemId, reason: 'user' })
      expect(deleted.ok).toBe(true)
      if (!deleted.ok) throw new Error('unreachable')
      expect(deleted.value).toEqual({
        kind: 'ITEM_DELETED',
        seq: 5,
        at: 1_767_225_600_000,
        id: ids[0],
        reason: 'user',
      })
    })

    it('round-trips all three caller-visible event kinds', async () => {
      const { store, ids } = seeded(1)
      store.appendEvent({ kind: 'ITEM_UPDATED', id: ids[0] as ItemId, patch: { updatedAt: 42, pinned: true } })
      store.appendEvent({ kind: 'ITEM_DELETED', id: ids[0] as ItemId, reason: 'retention-count' })
      const records = await drain(store)
      expect(records.map((r) => (r.ok ? r.value.kind : 'ERR'))).toEqual([
        'CHECKPOINT',
        'ITEM_ADDED',
        'ITEM_UPDATED',
        'ITEM_DELETED',
      ])
      const updated = records[2]
      if (updated === undefined || !updated.ok || updated.value.kind !== 'ITEM_UPDATED') {
        throw new Error('unreachable')
      }
      expect(updated.value.patch).toEqual({ updatedAt: 42, pinned: true })
    })

    it('survives quit and relaunch, and keeps counting from where it stopped', async () => {
      const { dir, key, store, ids } = seeded(3)
      store.close()
      const reopened = openAt(dir, key)
      const records = await drain(reopened)
      expect(records).toHaveLength(4)
      expect(records.every((r) => r.ok)).toBe(true)
      const appended = reopened.appendEvent({ kind: 'ITEM_DELETED', id: ids[1] as ItemId, reason: 'user' })
      expect(appended.ok && appended.value.seq).toBe(5)
      expect((await drain(reopened)).every((r) => r.ok)).toBe(true)
    })

    it('writes max_seq into a SEALED CHECKPOINT record, inside the log', async () => {
      const { store } = seeded(3)
      const checkpoint = store.checkpoint(3)
      expect(checkpoint.ok).toBe(true)
      if (!checkpoint.ok || checkpoint.value.kind !== 'CHECKPOINT') throw new Error('unreachable')
      expect(checkpoint.value.seq).toBe(5)
      expect(checkpoint.value.maxSeq).toBe(4)
      expect(checkpoint.value.liveItemCount).toBe(3)
      expect(checkpoint.value.watermarks).toEqual({})
      const last = (await drain(store)).at(-1)
      if (last === undefined || !last.ok) throw new Error('unreachable')
      expect(last.value.kind).toBe('CHECKPOINT')
    })

    it('reports stats without decrypting the whole log', () => {
      const { dir, store } = seeded(2)
      const stats = store.stat()
      expect(stats.ok).toBe(true)
      if (!stats.ok) throw new Error('unreachable')
      expect(stats.value.lineCount).toBe(3)
      expect(stats.value.anchorSeq).toBe(1)
      expect(stats.value.maxSeq).toBe(3)
      expect(stats.value.blobCount).toBe(2)
      expect(stats.value.logBytes).toBe(statSync(join(dir, 'history.ndjson')).size)
    })
  })

  describe('meta.json', () => {
    it('holds ONLY schema version, key mode and the scrypt salt — no sequence data', () => {
      const { dir, store } = seeded(3)
      store.checkpoint(3)
      const text = readFileSync(join(dir, 'meta.json'), 'utf8')
      expect(Object.keys(JSON.parse(text) as Record<string, unknown>).sort()).toEqual([
        'keyMode',
        'schemaVersion',
        'scryptSaltB64',
      ])
      // The watermark vector and max_seq live in the sealed CHECKPOINT, never here (spec §4).
      expect(/seq|watermark|line|count/i.test(text)).toBe(false)
      expect(statSync(join(dir, 'meta.json')).mode & 0o777).toBe(0o600)
    })

    it('round-trips a key mode and a salt without widening the mode', () => {
      const { dir, store } = seeded(0)
      expect(store.readMeta()).toEqual({
        ok: true,
        value: { schemaVersion: 1, keyMode: 'unknown', scryptSaltB64: null },
      })
      expect(store.writeMeta({ schemaVersion: 1, keyMode: 'passphrase', scryptSaltB64: 'AAAA' }).ok).toBe(true)
      const meta = store.readMeta()
      expect(meta.ok && meta.value.keyMode).toBe('passphrase')
      expect(statSync(join(dir, 'meta.json')).mode & 0o777).toBe(0o600)

      // `keyMode` is EXACTLY 'os-keyring' | 'passphrase' | 'unknown'. `@cairn/keyring`'s runtime
      // `KeyringMode` has a fourth member, `'locked'`, and it is NOT persistable — it describes this
      // process, not the store on disk, and writing it would leave the next cold start unable to work
      // out how to get the key back. This is a TYPE-level assertion on purpose: it never calls
      // `writeMeta`, so it cannot put a bad value in `meta.json`, and `tsc` fails with
      // `TS2578: Unused '@ts-expect-error' directive` the day somebody widens the union.
      // @ts-expect-error 'locked' is a runtime KeyringMode, never a persisted one
      const notPersistable: StoreMeta = { schemaVersion: 1, keyMode: 'locked', scryptSaltB64: null }
      void notPersistable
    })
  })
  ```

- [ ] **Step 27: Run it and watch it fail for the right reason.**
  ```sh
  npx vitest run --project unit packages/store/src/log-store.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './log-store' imported from …/log-store.test.ts`.

- [ ] **Step 28: Implement `log-store.ts`.**
  This version has no torn-line repair, no chain enforcement on read, no `compact` and no
  blob-reference guard — those arrive in steps 33, 38, 43 and 48, each with its own failing test first.
  `packages/store/src/log-store.ts`:
  ```ts
  import { existsSync, readFileSync, statSync } from 'node:fs'
  import {
    err,
    ok,
    type BlobId,
    type Clock,
    type ContentHash,
    type DeleteReason,
    type Item,
    type ItemId,
    type ItemPatch,
    type Logger,
    type Result,
    type StoreEvent,
    type StoreEventKind,
  } from '@cairn/protocol'
  import { CHAIN_GENESIS, chainNext, chainTip } from './chain'
  import { createBlobStore, type BlobStore } from './blobs'
  import { appendLine0600, dataDirLayout, ensureDir0700, fsyncPath, writeFile0600, type DataDirLayout } from './paths'
  import { ANCHOR_AAD_SEQ, openRecord, openRecordAnyKind, sealRecord } from './record'

  /** What a caller may append. `seq` and `at` are the store's to assign; CHECKPOINT is the store's
   *  to write, so it is deliberately absent from this union. */
  export type StoreEventInput =
    | { readonly kind: 'ITEM_ADDED'; readonly item: Item }
    | { readonly kind: 'ITEM_UPDATED'; readonly id: ItemId; readonly patch: ItemPatch }
    | { readonly kind: 'ITEM_DELETED'; readonly id: ItemId; readonly reason: DeleteReason }

  /** `meta.json` — the ONLY plaintext file the store writes. No sequence data, ever. */
  export interface StoreMeta {
    readonly schemaVersion: 1
    readonly keyMode: 'os-keyring' | 'passphrase' | 'unknown'
    readonly scryptSaltB64: string | null
  }

  export interface StoreStats {
    readonly lineCount: number
    readonly anchorSeq: number
    readonly maxSeq: number
    readonly logBytes: number
    readonly blobCount: number
    readonly blobBytes: number
  }

  export interface OpenStoreOptions {
    readonly dir: string
    /** Exactly 32 bytes. Owned by @cairn/keyring; the store never reads a key from disk. */
    readonly key: Buffer
    readonly clock: Clock
    readonly logger: Logger
  }

  export interface Store {
    appendEvent(input: StoreEventInput): Result<StoreEvent>
    readAll(): AsyncIterable<Result<StoreEvent>>
    checkpoint(liveItemCount: number): Result<StoreEvent>
    putBlob(bytes: Uint8Array): Result<BlobId>
    getBlob(id: BlobId): Result<Buffer>
    deleteBlob(id: BlobId): Result<boolean>
    stat(): Result<StoreStats>
    readMeta(): Result<StoreMeta>
    writeMeta(meta: StoreMeta): Result<void>
    layout(): DataDirLayout
    close(): void
  }

  interface RecordPayload {
    readonly seq: number
    readonly at: number
    readonly kind: StoreEventKind
    readonly prev: ContentHash
    readonly item?: Item
    readonly id?: ItemId
    readonly patch?: ItemPatch
    readonly reason?: DeleteReason
    readonly maxSeq?: number
    readonly liveItemCount?: number
    readonly watermarks?: Readonly<Record<string, number>>
  }

  const HASH_RE = /^sha256-[A-Za-z0-9_-]{43}$/
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

  /**
   * The record is AUTHENTICATED before it reaches here, so this guards against our own schema
   * drift, not against an attacker. Hence structural checks only, and no deep validation of `Item`.
   */
  function decodePayload(bytes: Buffer, lineIndex: number): Result<RecordPayload> {
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      return err('E_STORE_CORRUPT', `line ${lineIndex}: payload is not JSON`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return err('E_STORE_CORRUPT', `line ${lineIndex}: payload is not an object`)
    }
    const p = parsed as Record<string, unknown>
    if (!isInt(p['seq']) || !isInt(p['at'])) {
      return err('E_STORE_CORRUPT', `line ${lineIndex}: seq and at must be safe integers`)
    }
    if (typeof p['prev'] !== 'string' || !HASH_RE.test(p['prev'])) {
      return err('E_STORE_CORRUPT', `line ${lineIndex}: prev is not a content hash`)
    }
    if (typeof p['kind'] !== 'string') {
      return err('E_STORE_CORRUPT', `line ${lineIndex}: kind is missing`)
    }
    return ok(parsed as RecordPayload)
  }

  function toStoreEvent(p: RecordPayload, lineIndex: number): Result<StoreEvent> {
    switch (p.kind) {
      case 'ITEM_ADDED':
        if (p.item === undefined) return err('E_STORE_CORRUPT', `line ${lineIndex}: ITEM_ADDED has no item`)
        return ok({ kind: 'ITEM_ADDED', seq: p.seq, at: p.at, item: p.item })
      case 'ITEM_UPDATED':
        if (p.id === undefined || p.patch === undefined) {
          return err('E_STORE_CORRUPT', `line ${lineIndex}: ITEM_UPDATED needs id and patch`)
        }
        return ok({ kind: 'ITEM_UPDATED', seq: p.seq, at: p.at, id: p.id, patch: p.patch })
      case 'ITEM_DELETED':
        if (p.id === undefined || p.reason === undefined) {
          return err('E_STORE_CORRUPT', `line ${lineIndex}: ITEM_DELETED needs id and reason`)
        }
        return ok({ kind: 'ITEM_DELETED', seq: p.seq, at: p.at, id: p.id, reason: p.reason })
      case 'CHECKPOINT':
        if (p.maxSeq === undefined || p.liveItemCount === undefined || p.watermarks === undefined) {
          return err('E_STORE_CORRUPT', `line ${lineIndex}: CHECKPOINT needs maxSeq, liveItemCount, watermarks`)
        }
        return ok({
          kind: 'CHECKPOINT',
          seq: p.seq,
          at: p.at,
          maxSeq: p.maxSeq,
          liveItemCount: p.liveItemCount,
          watermarks: p.watermarks,
        })
      default:
        return err('E_STORE_CORRUPT', `line ${lineIndex}: unknown record kind`)
    }
  }

  const encodePayload = (p: RecordPayload): Buffer => Buffer.from(JSON.stringify(p), 'utf8')

  export function openStore(opts: OpenStoreOptions): Result<Store> {
    if (opts.key.length !== 32) {
      throw new Error(`openStore: key must be exactly 32 bytes, got ${opts.key.length}`)
    }
    const L = dataDirLayout(opts.dir)
    ensureDir0700(L.dir)
    const blobs: BlobStore = createBlobStore({ blobDir: L.blobDir, key: opts.key, logger: opts.logger })
    if (!existsSync(L.metaPath)) {
      writeFile0600(
        L.metaPath,
        JSON.stringify({ schemaVersion: 1, keyMode: 'unknown', scryptSaltB64: null } satisfies StoreMeta),
      )
    }

    const readLines = (): string[] => {
      if (!existsSync(L.logPath)) return []
      const text = readFileSync(L.logPath, 'utf8')
      if (text.length === 0) return []
      const lines = text.split('\n')
      lines.pop() // the empty string after the final terminator
      return lines
    }

    let anchorSeq = 0
    let lineCount = 0
    let tipHash: ContentHash = CHAIN_GENESIS
    /** Within one generation seq is contiguous, so this is exact and needs no decryption. */
    const maxSeq = (): number => anchorSeq + lineCount - 1

    const sealAndAppend = (
      kind: StoreEventKind,
      extra: Omit<RecordPayload, 'seq' | 'at' | 'kind' | 'prev'>,
    ): Result<{ seq: number; at: number }> => {
      const lineIndex = lineCount
      const seq = maxSeq() + 1
      const at = opts.clock.now()
      const line = sealRecord({
        key: opts.key,
        lineIndex,
        seq: lineIndex === 0 ? ANCHOR_AAD_SEQ : seq,
        kind,
        payload: encodePayload({ seq, at, kind, prev: tipHash, ...extra }),
      })
      try {
        appendLine0600(L.logPath, line)
        if (lineIndex === 0) fsyncPath(L.dir)
      } catch (cause) {
        return err('E_STORE_IO', `append failed: ${(cause as Error).message}`)
      }
      tipHash = chainNext(tipHash, line)
      lineCount += 1
      return ok({ seq, at })
    }

    const existing = readLines()
    if (existing.length === 0) {
      anchorSeq = 1
      const written = sealAndAppend('CHECKPOINT', { maxSeq: 0, liveItemCount: 0, watermarks: {} })
      if (!written.ok) return written
    } else {
      const first = existing[0]
      if (first === undefined) return err('E_STORE_CORRUPT', 'log has no anchor CHECKPOINT')
      const anchor = openRecord({
        key: opts.key,
        lineIndex: 0,
        seq: ANCHOR_AAD_SEQ,
        kind: 'CHECKPOINT',
        line: first,
      })
      if (!anchor.ok) return anchor
      const payload = decodePayload(anchor.value, 0)
      if (!payload.ok) return payload
      if (payload.value.kind !== 'CHECKPOINT') {
        return err('E_STORE_CORRUPT', 'line 0 of the log is not a CHECKPOINT')
      }
      anchorSeq = payload.value.seq
      lineCount = existing.length
      tipHash = chainTip(existing)
    }

    opts.logger.info('store.opened', { count: lineCount, seq: maxSeq() })

    async function* readAll(): AsyncIterable<Result<StoreEvent>> {
      const lines = readLines()
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line === undefined) return
        const opened = openRecordAnyKind({
          key: opts.key,
          lineIndex: i,
          seq: i === 0 ? ANCHOR_AAD_SEQ : anchorSeq + i,
          line,
        })
        if (!opened.ok) {
          yield opened
          return
        }
        const payload = decodePayload(opened.value.payload, i)
        if (!payload.ok) {
          yield payload
          return
        }
        if (payload.value.kind !== opened.value.kind) {
          yield err(
            'E_STORE_CORRUPT',
            `line ${i}: AAD kind ${opened.value.kind} != payload kind ${payload.value.kind}`,
          )
          return
        }
        if (payload.value.seq !== anchorSeq + i) {
          yield err('E_STORE_CORRUPT', `line ${i}: seq ${payload.value.seq} != expected ${anchorSeq + i}`)
          return
        }
        const event = toStoreEvent(payload.value, i)
        yield event
        if (!event.ok) return
      }
    }

    const store: Store = {
      layout: () => L,
      readAll,
      appendEvent(input) {
        const extra =
          input.kind === 'ITEM_ADDED'
            ? { item: input.item }
            : input.kind === 'ITEM_UPDATED'
              ? { id: input.id, patch: input.patch }
              : { id: input.id, reason: input.reason }
        const written = sealAndAppend(input.kind, extra)
        if (!written.ok) return written
        opts.logger.debug('store.appended', { seq: written.value.seq })
        switch (input.kind) {
          case 'ITEM_ADDED':
            return ok({ kind: 'ITEM_ADDED', seq: written.value.seq, at: written.value.at, item: input.item })
          case 'ITEM_UPDATED':
            return ok({
              kind: 'ITEM_UPDATED',
              seq: written.value.seq,
              at: written.value.at,
              id: input.id,
              patch: input.patch,
            })
          case 'ITEM_DELETED':
            return ok({
              kind: 'ITEM_DELETED',
              seq: written.value.seq,
              at: written.value.at,
              id: input.id,
              reason: input.reason,
            })
        }
      },
      checkpoint(liveItemCount) {
        const before = maxSeq()
        const written = sealAndAppend('CHECKPOINT', { maxSeq: before, liveItemCount, watermarks: {} })
        if (!written.ok) return written
        return ok({
          kind: 'CHECKPOINT',
          seq: written.value.seq,
          at: written.value.at,
          maxSeq: before,
          liveItemCount,
          watermarks: {},
        })
      },
      putBlob: (bytes) => blobs.put(bytes),
      getBlob: (id) => blobs.get(id),
      deleteBlob: (id) => blobs.remove(id),
      stat() {
        return ok({
          lineCount,
          anchorSeq,
          maxSeq: maxSeq(),
          logBytes: existsSync(L.logPath) ? statSync(L.logPath).size : 0,
          blobCount: blobs.files().length,
          blobBytes: blobs.totalBytes(),
        })
      },
      readMeta() {
        try {
          return ok(JSON.parse(readFileSync(L.metaPath, 'utf8')) as StoreMeta)
        } catch (cause) {
          return err('E_STORE_IO', `meta.json unreadable: ${(cause as Error).message}`)
        }
      },
      writeMeta(meta) {
        try {
          writeFile0600(L.metaPath, JSON.stringify(meta))
          return ok(undefined)
        } catch (cause) {
          return err('E_STORE_IO', `meta.json unwritable: ${(cause as Error).message}`)
        }
      },
      close() {
        blobs.close()
      },
    }
    return ok(store)
  }
  ```

- [ ] **Step 29: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 4 passed (4)`, `Tests 35 passed (35)`.

- [ ] **Step 30: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): append-only log with a sealed anchor CHECKPOINT"
  ```

- [ ] **Step 31: Write the failing torn-trailing-line test.**
  A crash mid-append leaves a line with no terminating `\n`. That is a crash, not an attack, and must
  be silently discarded — but the file has to be *repaired*, or the next append concatenates onto the
  half-record and corrupts it forever. Append to `packages/store/src/log-store.test.ts`:
  ```ts
  describe('a torn trailing line is a crash, not an attack', () => {
    it('discards it on open, repairs the file, and keeps appending cleanly', async () => {
      const { dir, key, store } = seeded(2)
      store.close()
      const path = join(dir, 'history.ndjson')
      writeFileSync(path, `${readFileSync(path, 'utf8')}AAAApartialrecordwithoutanewline`)
      const reopened = openAt(dir, key)
      const stats = reopened.stat()
      expect(stats.ok && stats.value.tornLineRepairedOnOpen).toBe(true)
      expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
      const records = await drain(reopened)
      expect(records).toHaveLength(3)
      expect(records.every((r) => r.ok)).toBe(true)
      const appended = reopened.appendEvent({ kind: 'ITEM_DELETED', id: testItemId(1), reason: 'user' })
      expect(appended.ok && appended.value.seq).toBe(4)
      expect((await drain(reopened)).every((r) => r.ok)).toBe(true)
    })

    it('does NOT discard a complete, newline-terminated line whose bytes were altered', async () => {
      const { dir, key, store } = seeded(2)
      store.close()
      const path = join(dir, 'history.ndjson')
      const lines = readFileSync(path, 'utf8').split('\n').slice(0, -1)
      lines[1] = (lines[1] as string).slice(0, -8) // still `\n`-terminated: a committed record
      writeFileSync(path, `${lines.join('\n')}\n`)
      const reopened = openAt(dir, key)
      const stats = reopened.stat()
      expect(stats.ok && stats.value.tornLineRepairedOnOpen).toBe(false)
      const broken = (await drain(reopened)).find((r) => !r.ok)
      expect(broken?.ok).toBe(false)
      if (broken === undefined || broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_DECRYPT')
    })
  })
  ```
  Add `writeFileSync` to the `node:fs` import at the top of the file.

- [ ] **Step 32: Run it and watch it fail for the right reason.**
  ```sh
  npx vitest run --project unit packages/store/src/log-store.test.ts -t 'torn trailing line'
  ```
  Expected: FAIL with `AssertionError: expected undefined to be true` — `StoreStats` has no
  `tornLineRepairedOnOpen` yet — and, in the second test, `expected undefined to be false`.

- [ ] **Step 33: Implement the repair.**
  In `log-store.ts`: extend the `node:fs` import to
  `import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, statSync } from 'node:fs'`,
  add `readonly tornLineRepairedOnOpen: boolean` as the last field of `StoreStats`, and insert this
  block immediately **after** the `meta.json` bootstrap and **before** `const readLines`:
  ```ts
    // A crash can leave a half-written last line. The trailing `\n` is the commit marker, so a line
    // without one never became durable: truncate it and log it. A complete line that fails to
    // authenticate is the other case entirely — that is tamper, and readAll reports it.
    let tornRepaired = false
    if (existsSync(L.logPath)) {
      const raw = readFileSync(L.logPath)
      if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
        const cut = raw.lastIndexOf(0x0a)
        const fd = openSync(L.logPath, 'r+')
        try {
          ftruncateSync(fd, cut + 1)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        tornRepaired = true
        opts.logger.warn('store.torn-line-discarded', { byteLength: raw.length - (cut + 1) })
      }
    }
  ```
  and add `tornLineRepairedOnOpen: tornRepaired,` as the last property of the object `stat()` returns.

- [ ] **Step 34: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 4 passed (4)`, `Tests 37 passed (37)`.

- [ ] **Step 35: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "fix(store): discard a torn trailing line on open and repair the log"
  ```

- [ ] **Step 36: Write the failing tamper matrix.**
  Five physical mutations of `history.ndjson`. The last one is the whole reason the hash chain
  exists: a record swapped for a *different* record that held the same line index, seq and kind in an
  older state of the same log — every AAD field matches, so only the chain can see it. Append to
  `packages/store/src/chain.test.ts`:
  ```ts
  import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { afterEach } from 'vitest'
  import type { Result, StoreEvent } from '@cairn/protocol'
  import { openStore, type Store } from './log-store'
  import { fixedClock, itemFixture, randomTestKey, silentLogger, tempStoreDir, testItemId } from './testing'

  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  const logPath = (dir: string): string => join(dir, 'history.ndjson')
  const readSealedLines = (dir: string): string[] =>
    readFileSync(logPath(dir), 'utf8').split('\n').slice(0, -1)
  const writeSealedLines = (dir: string, lines: readonly string[]): void =>
    writeFileSync(logPath(dir), `${lines.join('\n')}\n`)

  function openAt(dir: string, key: Buffer): Store {
    const opened = openStore({ dir, key, clock: fixedClock(), logger: silentLogger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    return opened.value
  }
  async function drain(store: Store): Promise<Result<StoreEvent>[]> {
    const out: Result<StoreEvent>[] = []
    for await (const record of store.readAll()) out.push(record)
    return out
  }
  function addItem(store: Store, n: number, text: string): void {
    const blob = store.putBlob(Buffer.from(text, 'utf8'))
    if (!blob.ok) throw new Error(blob.message)
    const appended = store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(testItemId(n), blob.value, text) })
    if (!appended.ok) throw new Error(appended.message)
  }
  function seededOnDisk(n: number): { dir: string; key: Buffer; store: Store } {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    const key = randomTestKey()
    const store = openAt(dir, key)
    for (let i = 0; i < n; i++) addItem(store, i + 1, `payload-${i}`)
    return { dir, key, store }
  }

  describe('at-rest integrity: every mutation of history.ndjson is detected', () => {
    it('detects two records SWAPPED, because the AAD binds the line index', async () => {
      const { dir, key, store } = seededOnDisk(4)
      store.close()
      const lines = readSealedLines(dir)
      const held = lines[2] as string
      lines[2] = lines[3] as string
      lines[3] = held
      writeSealedLines(dir, lines)
      const records = await drain(openAt(dir, key))
      expect(records.filter((r) => r.ok)).toHaveLength(2) // lines 0 and 1 are untouched
      const broken = records.at(-1)
      if (broken === undefined || broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_DECRYPT')
      expect(broken.message).toContain('line 2')
    })

    it('detects an ITEM_DELETED record DELETED from the middle — a deleted secret must not come back', async () => {
      const { dir, key, store } = seededOnDisk(3)
      store.appendEvent({ kind: 'ITEM_DELETED', id: testItemId(2), reason: 'user' })
      store.checkpoint(2)
      store.close()
      const lines = readSealedLines(dir)
      expect(lines).toHaveLength(6) // anchor + 3 adds + 1 delete + 1 checkpoint
      lines.splice(4, 1) // excise the ITEM_DELETED
      writeSealedLines(dir, lines)
      const records = await drain(openAt(dir, key))
      const broken = records.find((r) => !r.ok)
      if (broken === undefined || broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_DECRYPT')
      expect(broken.message).toContain('line 4')
    })

    it('detects a record DUPLICATED onto the end', async () => {
      const { dir, key, store } = seededOnDisk(3)
      store.close()
      const lines = readSealedLines(dir)
      lines.push(lines[2] as string)
      writeSealedLines(dir, lines)
      const broken = (await drain(openAt(dir, key))).find((r) => !r.ok)
      if (broken === undefined || broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_DECRYPT')
    })

    it('detects a record DUPLICATED into the middle', async () => {
      const { dir, key, store } = seededOnDisk(4)
      store.close()
      const lines = readSealedLines(dir)
      lines.splice(2, 0, lines[1] as string)
      writeSealedLines(dir, lines)
      const broken = (await drain(openAt(dir, key))).find((r) => !r.ok)
      if (broken === undefined || broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_DECRYPT')
    })

    it('detects a record ROLLED BACK to an older record with the same line, seq and kind', async () => {
      // This is the attack the AAD cannot see and the hash chain exists for: yesterday's line 2,
      // lifted out of a backup of the same log under the same key, spliced over today's line 2.
      const main = tempStoreDir()
      const backups = tempStoreDir()
      cleanups.push(main.cleanup, backups.cleanup)
      const key = randomTestKey()

      let store = openAt(main.dir, key)
      addItem(store, 1, 'first')
      store.close()
      copyFileSync(logPath(main.dir), join(backups.dir, 'prefix')) // 2 lines: anchor + line 1

      store = openAt(main.dir, key)
      addItem(store, 2, 'second-REAL')
      store.close()
      copyFileSync(logPath(main.dir), join(backups.dir, 'real'))

      // Fork from the identical 2-line prefix, so the alternative line 2 declares the same `prev`.
      copyFileSync(join(backups.dir, 'prefix'), logPath(main.dir))
      store = openAt(main.dir, key)
      addItem(store, 3, 'second-ROLLBACK')
      store.close()
      const rolledBackLine = readSealedLines(main.dir)[2] as string

      copyFileSync(join(backups.dir, 'real'), logPath(main.dir))
      store = openAt(main.dir, key)
      addItem(store, 4, 'third')
      store.close()
      const lines = readSealedLines(main.dir)
      expect(lines).toHaveLength(4)
      lines[2] = rolledBackLine
      writeSealedLines(main.dir, lines)

      const records = await drain(openAt(main.dir, key))
      const spliced = records[2]
      if (spliced === undefined || !spliced.ok || spliced.value.kind !== 'ITEM_ADDED') {
        throw new Error('the spliced record should still open: line, seq and kind all match')
      }
      expect(spliced.value.item.preview).toBe('second-ROLLBACK')
      const broken = records.at(-1)
      if (broken === undefined || broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_CHAIN_BROKEN')
      expect(broken.message).toContain('chain broken at line 3')
    })

    it('reads a clean log to the end with no error', async () => {
      const { dir, key, store } = seededOnDisk(3)
      store.close()
      const records = await drain(openAt(dir, key))
      expect(records).toHaveLength(4)
      expect(records.every((r) => r.ok)).toBe(true)
    })
  })
  ```
  Merge the two `vitest` imports into one (`describe, expect, it` are already imported at the top of
  the file from step 16) and keep the `node:fs`, `node:path` and `./testing` imports at the top with
  them, so the file has one import block.

- [ ] **Step 37: Run it and watch the rollback case fail.**
  ```sh
  npx vitest run --project unit packages/store/src/chain.test.ts
  ```
  Expected: five of the six new tests pass (the AAD already catches swap, delete and both
  duplications), and *detects a record ROLLED BACK…* FAILs with
  `AssertionError: expected true to be false` — `readAll` never looks at `prev`, so the tampered log
  reads clean. That is the resurrected secret.

- [ ] **Step 38: Enforce the chain on read.**
  In `log-store.ts`, change the chain import to
  `import { CHAIN_GENESIS, chainNext, chainTip, createChainVerifier } from './chain'`, then inside
  `readAll` add `const chain = createChainVerifier()` immediately after `const lines = readLines()`,
  and insert this check immediately **before** `const event = toStoreEvent(payload.value, i)`:
  ```ts
        const linked = chain.check(i, line, payload.value.prev)
        if (!linked.ok) {
          yield linked
          return
        }
  ```

- [ ] **Step 39: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 4 passed (4)`, `Tests 43 passed (43)`.

- [ ] **Step 40: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): enforce the prevRecordHash chain on every read"
  ```

- [ ] **Step 41: Write the failing compaction test.**
  Append to `packages/store/src/log-store.test.ts`:
  ```ts
  describe('compact', () => {
    it('rewrites the log as an anchor CHECKPOINT plus one materialised ITEM_ADDED per live id', async () => {
      const { store, ids } = seeded(5)
      store.appendEvent({ kind: 'ITEM_UPDATED', id: ids[0] as ItemId, patch: { updatedAt: 99, pinned: true } })
      store.appendEvent({ kind: 'ITEM_DELETED', id: ids[4] as ItemId, reason: 'retention-count' })
      const seqsBefore = (await drain(store)).map((r) => (r.ok ? r.value.seq : -1))
      expect(seqsBefore).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

      // ids[4] is asked for but was deleted: compaction must NOT resurrect it.
      const summary = store.compact([ids[0] as ItemId, ids[1] as ItemId, ids[4] as ItemId])
      expect(summary.ok).toBe(true)
      if (!summary.ok) throw new Error('unreachable')
      expect(summary.value).toEqual({
        liveItemCount: 2,
        linesBefore: 8,
        linesAfter: 3,
        blobsRemoved: 3,
        maxSeq: 11,
      })

      const records = await drain(store)
      expect(records.every((r) => r.ok)).toBe(true)
      expect(records.map((r) => (r.ok ? r.value.kind : 'ERR'))).toEqual([
        'CHECKPOINT',
        'ITEM_ADDED',
        'ITEM_ADDED',
      ])
      const anchor = records[0]
      const survivor = records[1]
      if (anchor === undefined || !anchor.ok || anchor.value.kind !== 'CHECKPOINT') throw new Error('unreachable')
      if (survivor === undefined || !survivor.ok || survivor.value.kind !== 'ITEM_ADDED') throw new Error('unreachable')
      expect(anchor.value.maxSeq).toBe(8) // the pre-compaction high-water mark, sealed in the log
      expect(anchor.value.liveItemCount).toBe(2)
      // The ITEM_UPDATED patch is materialised into the surviving record.
      expect(survivor.value.item.pinned).toBe(true)
      expect(survivor.value.item.updatedAt).toBe(99)
      // Seq is never reused across a compaction: a peer that already saw seq 8 cannot be told to
      // skip real events (spec §10).
      const seqsAfter = records.map((r) => (r.ok ? r.value.seq : -1))
      expect(Math.min(...seqsAfter)).toBeGreaterThan(Math.max(...seqsBefore))
    })

    it('GCs orphan blobs and keeps the live ones', async () => {
      const { store, ids } = seeded(3)
      const before = store.stat()
      expect(before.ok && before.value.blobCount).toBe(3)
      const summary = store.compact([ids[0] as ItemId])
      expect(summary.ok && summary.value.blobsRemoved).toBe(2)
      const after = store.stat()
      expect(after.ok && after.value.blobCount).toBe(1)
      const survivor = (await drain(store)).at(-1)
      if (survivor === undefined || !survivor.ok || survivor.value.kind !== 'ITEM_ADDED') throw new Error('unreachable')
      const ref = survivor.value.item.repRefs[0]
      if (ref === undefined) throw new Error('unreachable')
      expect(store.getBlob(ref.blobId).ok).toBe(true)
    })

    it('keeps appending and reopens cleanly after a compaction', async () => {
      const { dir, key, store, ids } = seeded(3)
      store.compact([ids[0] as ItemId, ids[1] as ItemId])
      expect(store.appendEvent({ kind: 'ITEM_DELETED', id: ids[1] as ItemId, reason: 'user' }).ok).toBe(true)
      expect((await drain(store)).every((r) => r.ok)).toBe(true)
      store.close()
      expect(existsSync(join(dir, 'history.ndjson.tmp'))).toBe(false)
      expect((await drain(openAt(dir, key))).every((r) => r.ok)).toBe(true)
    })

    it('refuses to compact a tampered log rather than laundering it', async () => {
      const { dir, key, store, ids } = seeded(3)
      store.close()
      const path = join(dir, 'history.ndjson')
      const lines = readFileSync(path, 'utf8').split('\n').slice(0, -1)
      const held = lines[1] as string
      lines[1] = lines[2] as string
      lines[2] = held
      writeFileSync(path, `${lines.join('\n')}\n`)
      const reopened = openAt(dir, key)
      const summary = reopened.compact([ids[0] as ItemId])
      expect(summary.ok).toBe(false)
      if (summary.ok) throw new Error('unreachable')
      expect(summary.code).toBe('E_STORE_DECRYPT')
    })

    it('leaves the OLD log completely intact if it crashes before the rename', async () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const key = randomTestKey()
      const crashing = openStore({
        dir,
        key,
        clock: fixedClock(),
        logger: silentLogger,
        unsafeTestHooks: {
          onBeforeRename: () => {
            throw new Error('simulated crash')
          },
        },
      })
      if (!crashing.ok) throw new Error('unreachable')
      const blob = crashing.value.putBlob(Buffer.from('body', 'utf8'))
      if (!blob.ok) throw new Error('unreachable')
      crashing.value.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(testItemId(1), blob.value, 'body') })
      const before = readFileSync(join(dir, 'history.ndjson'), 'utf8')

      const summary = crashing.value.compact([])
      expect(summary.ok).toBe(false)
      if (summary.ok) throw new Error('unreachable')
      expect(summary.code).toBe('E_STORE_IO')
      expect(readFileSync(join(dir, 'history.ndjson'), 'utf8')).toBe(before)
      expect(crashing.value.stat()).toEqual({
        ok: true,
        value: expect.objectContaining({ lineCount: 2, blobCount: 1 }),
      })
      crashing.value.close()

      // The stale .tmp is ignored on open and overwritten by the next compaction.
      const reopened = openAt(dir, key)
      expect(await drain(reopened)).toHaveLength(2)
      expect(reopened.compact([]).ok).toBe(true)
      expect(existsSync(join(dir, 'history.ndjson.tmp'))).toBe(false)
    })

    it('leaks an orphan blob rather than a dangling reference if it crashes after the rename', async () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const key = randomTestKey()
      const crashing = openStore({
        dir,
        key,
        clock: fixedClock(),
        logger: silentLogger,
        unsafeTestHooks: {
          onAfterRename: () => {
            throw new Error('simulated crash')
          },
        },
      })
      if (!crashing.ok) throw new Error('unreachable')
      const blob = crashing.value.putBlob(Buffer.from('body', 'utf8'))
      if (!blob.ok) throw new Error('unreachable')
      crashing.value.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(testItemId(1), blob.value, 'body') })
      expect(() => crashing.value.compact([])).toThrow('simulated crash')
      crashing.value.close()

      const reopened = openAt(dir, key)
      expect(await drain(reopened)).toHaveLength(1) // the new log is in place
      expect(reopened.stat()).toEqual({ ok: true, value: expect.objectContaining({ blobCount: 1 }) })
      expect(reopened.compact([]).ok).toBe(true)
      expect(reopened.stat()).toEqual({ ok: true, value: expect.objectContaining({ blobCount: 0 }) })
    })
  })
  ```
  Add `existsSync` to the `node:fs` import at the top of the file.

- [ ] **Step 42: Run it and watch it fail for the right reason.**
  ```sh
  npx vitest run --project unit packages/store/src/log-store.test.ts -t 'compact'
  ```
  Expected: FAIL with `TypeError: store.compact is not a function`.

- [ ] **Step 43: Implement `compact`.**
  In `log-store.ts`: extend the `node:fs` import to
  `import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'`,
  add these two declarations next to `StoreStats`:
  ```ts
  export interface CompactSummary {
    readonly liveItemCount: number
    readonly linesBefore: number
    readonly linesAfter: number
    readonly blobsRemoved: number
    readonly maxSeq: number
  }

  /** Test-only seams: the only way to prove crash-safety without actually killing a process. */
  export interface UnsafeTestHooks {
    readonly onBeforeRename?: () => void
    readonly onAfterRename?: () => void
  }
  ```
  add `readonly unsafeTestHooks?: UnsafeTestHooks` as the last field of `OpenStoreOptions`, add
  `compact(liveIds: readonly ItemId[]): Result<CompactSummary>` to the `Store` interface after
  `checkpoint`, and add this method to the `store` object literal after `deleteBlob`:
  ```ts
      compact(liveIds) {
        // 1. Replay the log to current state, refusing to launder a tampered one.
        const live = new Map<ItemId, Item>()
        const lines = readLines()
        const chain = createChainVerifier()
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (line === undefined) break
          const opened = openRecordAnyKind({
            key: opts.key,
            lineIndex: i,
            seq: i === 0 ? ANCHOR_AAD_SEQ : anchorSeq + i,
            line,
          })
          if (!opened.ok) return opened
          const payload = decodePayload(opened.value.payload, i)
          if (!payload.ok) return payload
          const linked = chain.check(i, line, payload.value.prev)
          if (!linked.ok) return linked
          const event = toStoreEvent(payload.value, i)
          if (!event.ok) return event
          if (event.value.kind === 'ITEM_ADDED') live.set(event.value.item.id, event.value.item)
          else if (event.value.kind === 'ITEM_UPDATED') {
            const current = live.get(event.value.id)
            if (current !== undefined) live.set(event.value.id, { ...current, ...event.value.patch })
          } else if (event.value.kind === 'ITEM_DELETED') live.delete(event.value.id)
        }

        // A deleted id asked for by the caller stays deleted: compaction never resurrects.
        const keep: Item[] = []
        for (const id of liveIds) {
          const item = live.get(id)
          if (item !== undefined) keep.push(item)
        }

        // 2. Build the whole new generation in memory. Seq continues above the old maxSeq, so no
        //    seq is ever reused (spec §10).
        const base = maxSeq() + 1
        let tip: ContentHash = CHAIN_GENESIS
        const out: string[] = []
        const anchorLine = sealRecord({
          key: opts.key,
          lineIndex: 0,
          seq: ANCHOR_AAD_SEQ,
          kind: 'CHECKPOINT',
          payload: encodePayload({
            seq: base,
            at: opts.clock.now(),
            kind: 'CHECKPOINT',
            prev: tip,
            maxSeq: maxSeq(),
            liveItemCount: keep.length,
            watermarks: {},
          }),
        })
        out.push(anchorLine)
        tip = chainNext(tip, anchorLine)
        keep.forEach((item, idx) => {
          const seq = base + idx + 1
          const line = sealRecord({
            key: opts.key,
            lineIndex: idx + 1,
            seq,
            kind: 'ITEM_ADDED',
            payload: encodePayload({ seq, at: opts.clock.now(), kind: 'ITEM_ADDED', prev: tip, item }),
          })
          out.push(line)
          tip = chainNext(tip, line)
        })

        // 3. Temp file + fsync + rename + fsync dir. A crash anywhere before the rename leaves the
        //    OLD log byte-for-byte intact.
        const linesBefore = lineCount
        try {
          writeFile0600(L.tmpLogPath, `${out.join('\n')}\n`)
          fsyncPath(L.tmpLogPath)
          opts.unsafeTestHooks?.onBeforeRename?.()
          renameSync(L.tmpLogPath, L.logPath)
          fsyncPath(L.dir)
        } catch (cause) {
          return err('E_STORE_IO', `compact failed before rename: ${(cause as Error).message}`)
        }
        anchorSeq = base
        lineCount = out.length
        tipHash = tip
        opts.unsafeTestHooks?.onAfterRename?.()

        // 4. Only now GC blobs. A crash here leaks an orphan; it can never orphan a reference.
        const keepFiles = new Set<string>()
        for (const item of keep) {
          for (const ref of item.repRefs) keepFiles.add(blobs.fileFor(ref.blobId))
          if (item.thumbnailBlobId !== null) keepFiles.add(blobs.fileFor(item.thumbnailBlobId))
        }
        let blobsRemoved = 0
        for (const file of blobs.files()) {
          if (keepFiles.has(file)) continue
          try {
            unlinkSync(file)
            blobsRemoved += 1
          } catch (cause) {
            return err('E_STORE_IO', `orphan blob GC failed: ${(cause as Error).message}`)
          }
        }
        opts.logger.info('store.compacted', { count: keep.length, seq: maxSeq() })
        return ok({ liveItemCount: keep.length, linesBefore, linesAfter: out.length, blobsRemoved, maxSeq: maxSeq() })
      },
  ```

- [ ] **Step 44: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 4 passed (4)`, `Tests 49 passed (49)`.

- [ ] **Step 45: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): crash-safe compaction with orphan blob GC"
  ```

- [ ] **Step 46: Write the failing blob-ordering test.**
  The spec's rule is "a crash can leak an orphan blob but never a dangling reference". A comment
  cannot enforce that; refusing to append an event that references a blob not yet on disk can.
  Append to `packages/store/src/blobs.test.ts`:
  ```ts
  import { openStore } from './log-store'
  import { fixedClock, itemFixture, testItemId } from './testing'

  describe('blob-before-event ordering (spec §4)', () => {
    function freshStore() {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const key = randomTestKey()
      const opened = openStore({ dir, key, clock: fixedClock(), logger: silentLogger })
      if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)
      return { dir, key, store: opened.value }
    }

    it('refuses an ITEM_ADDED whose rep blob is not on disk, and writes nothing', () => {
      const { store } = freshStore()
      const before = store.stat()
      const appended = store.appendEvent({
        kind: 'ITEM_ADDED',
        item: itemFixture(testItemId(1), MISSING, 'never-stored'),
      })
      expect(appended.ok).toBe(false)
      if (appended.ok) throw new Error('unreachable')
      expect(appended.code).toBe('E_BLOB_MISSING')
      expect(store.stat()).toEqual(before) // not one line was appended
    })

    it('refuses an ITEM_ADDED whose THUMBNAIL blob is not on disk', () => {
      const { store } = freshStore()
      const blob = store.putBlob(Buffer.from('real body', 'utf8'))
      if (!blob.ok) throw new Error('unreachable')
      const item = { ...itemFixture(testItemId(1), blob.value, 'real body'), thumbnailBlobId: MISSING }
      const appended = store.appendEvent({ kind: 'ITEM_ADDED', item })
      expect(appended.ok).toBe(false)
      if (appended.ok) throw new Error('unreachable')
      expect(appended.code).toBe('E_BLOB_MISSING')
    })

    it('a crash between putBlob and appendEvent leaves a readable ORPHAN, GCd at compaction', async () => {
      const { dir, key, store } = freshStore()
      const orphan = store.putBlob(Buffer.from('orphaned body', 'utf8'))
      if (!orphan.ok) throw new Error('unreachable')
      store.close() // the crash: the referencing event never gets appended

      const reopened = openStore({ dir, key, clock: fixedClock(), logger: silentLogger })
      if (!reopened.ok) throw new Error('unreachable')
      expect(reopened.value.getBlob(orphan.value).ok).toBe(true)
      const referenced = new Set<string>()
      for await (const record of reopened.value.readAll()) {
        if (record.ok && record.value.kind === 'ITEM_ADDED') {
          for (const ref of record.value.item.repRefs) referenced.add(ref.blobId)
        }
      }
      expect(referenced.has(orphan.value)).toBe(false)
      expect(reopened.value.compact([]).ok && reopened.value.stat()).toEqual({
        ok: true,
        value: expect.objectContaining({ blobCount: 0 }),
      })
      expect(reopened.value.getBlob(orphan.value).ok).toBe(false)
    })

    it('every blob referenced by a committed record is readable — the invariant that matters', async () => {
      const { store } = freshStore()
      for (let i = 0; i < 3; i++) {
        const text = `body-${i}`
        const blob = store.putBlob(Buffer.from(text, 'utf8'))
        if (!blob.ok) throw new Error('unreachable')
        store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(testItemId(i + 1), blob.value, text) })
      }
      for await (const record of store.readAll()) {
        if (record.ok && record.value.kind === 'ITEM_ADDED') {
          for (const ref of record.value.item.repRefs) expect(store.getBlob(ref.blobId).ok).toBe(true)
        }
      }
    })
  })
  ```

  Merge the new `./testing` import into the one already at the top of the file, so `fixedClock`,
  `itemFixture` and `testItemId` join `randomTestKey`, `silentLogger` and `tempStoreDir`.

- [ ] **Step 47: Run it and watch it fail for the right reason.**
  ```sh
  npx vitest run --project unit packages/store/src/blobs.test.ts -t 'ordering'
  ```
  Expected: FAIL — the first two tests report `expected true to be false`, because `appendEvent`
  happily writes a record pointing at a blob that does not exist. That is a dangling reference, i.e. an
  item the user can see in the palette and never recall.

- [ ] **Step 48: Implement the guard.**
  In `log-store.ts`, insert this at the very top of `appendEvent`, before `const extra = …`:
  ```ts
        // A record may only reference blobs that are already fsync'd on disk (spec §4). The
        // reverse ordering — event first — would make a crash produce an item that can never be
        // recalled, and the store is where that ordering is enforced, not in a caller's comment.
        if (input.kind === 'ITEM_ADDED') {
          const referenced: BlobId[] = input.item.repRefs.map((r) => r.blobId)
          if (input.item.thumbnailBlobId !== null) referenced.push(input.item.thumbnailBlobId)
          const missing = referenced.filter((id) => !blobs.has(id))
          if (missing.length > 0) {
            return err(
              'E_BLOB_MISSING',
              `refusing to append: ${missing.length} referenced blob(s) are not on disk`,
            )
          }
        }
  ```

- [ ] **Step 49: Run it green.**
  ```sh
  npm run test -w @cairn/store
  ```
  Expected: `Test Files 4 passed (4)`, `Tests 53 passed (53)`.

- [ ] **Step 50: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): refuse to append an event that references a missing blob"
  ```

- [ ] **Step 51: Write the headline security test.**
  This is the test that backs the README's *"grep for your copied string finds nothing in any file on
  disk"*. It scans **every byte of every file** under the data dir, and it checks its own scanner
  against a deliberately-plaintext control file so it can never pass vacuously.
  `packages/store/src/store.security.test.ts`:
  ```ts
  import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { afterEach, describe, expect, it } from 'vitest'
  import { TEST_CANARY } from '@cairn/protocol'
  import { openStore } from './log-store'
  import { fixedClock, itemFixture, randomTestKey, silentLogger, tempStoreDir, testItemId } from './testing'

  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  const walk = (p: string): string[] =>
    statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : [p]

  describe('nothing the store writes is plaintext (spec §11 control 1)', () => {
    it('never writes the canary to any file, under any name, through any code path', async () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const opened = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
      if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)
      const store = opened.value
      const id = testItemId(7)

      // Every write path the store has: a blob body, an event, a checkpoint and a compaction.
      const blob = store.putBlob(Buffer.from(`${TEST_CANARY} in a blob body`, 'utf8'))
      if (!blob.ok) throw new Error(blob.message)
      const appended = store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(id, blob.value, TEST_CANARY) })
      expect(appended.ok).toBe(true)
      store.checkpoint(1)
      expect(store.compact([id]).ok).toBe(true)

      const files = walk(dir)
      expect(files.length).toBeGreaterThanOrEqual(3) // history.ndjson, meta.json, one blob
      for (const file of files) {
        expect(readFileSync(file).includes(TEST_CANARY)).toBe(false)
        expect(file.includes(TEST_CANARY)).toBe(false)
        // Base64 of the canary would mean a plaintext body inside a base64 field.
        expect(readFileSync(file, 'utf8').includes(Buffer.from(TEST_CANARY, 'utf8').toString('base64'))).toBe(false)
      }

      // …and the canary really did go in, so the assertions above are not vacuous.
      const previews: string[] = []
      for await (const record of store.readAll()) {
        if (record.ok && record.value.kind === 'ITEM_ADDED') previews.push(record.value.item.preview)
      }
      expect(previews).toContain(TEST_CANARY)
      const readBack = store.getBlob(blob.value)
      expect(readBack.ok && readBack.value.toString('utf8')).toBe(`${TEST_CANARY} in a blob body`)
    })

    it('the scanner itself works: a plaintext file in the same tree IS found', () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      writeFileSync(join(dir, 'control.txt'), `leaked: ${TEST_CANARY}`)
      const hits = walk(dir).filter((f) => readFileSync(f).includes(TEST_CANARY))
      expect(hits).toHaveLength(1)
    })

    it('keeps 0700 on every directory and 0600 on every file after a full lifecycle', () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const opened = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
      if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)
      const store = opened.value
      const id = testItemId(8)
      const blob = store.putBlob(Buffer.from('body', 'utf8'))
      if (!blob.ok) throw new Error(blob.message)
      store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(id, blob.value, 'body') })
      store.checkpoint(1)
      store.compact([id])
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, 'blobs')).mode & 0o777).toBe(0o700)
      for (const file of walk(dir)) expect(statSync(file).mode & 0o777).toBe(0o600)
    })
  })
  ```

- [ ] **Step 52: Run the security project.**
  ```sh
  npm run test:security -w @cairn/store
  ```
  Expected: `Test Files 2 passed (2)`, `Tests 8 passed (8)` (5 in `paths.security.test.ts`, 3 here).

- [ ] **Step 53: Prove the canary test fails if either sealing path is removed.**
  Two temporary mutations, one at a time, each followed by `npm run test:security -w @cairn/store`.
  (a) In `blobs.ts`, replace the `sealed = Buffer.concat([nonce, …])` assignment inside `put`'s `try`
  with
  ```ts
          sealed = Buffer.from(bytes)   // TEMPORARY: no encryption
  ```
  Expected: FAIL in *never writes the canary to any file* with `AssertionError: expected true to be
  false` at `expect(readFileSync(file).includes(TEST_CANARY)).toBe(false)` — the blob body is now the
  copied text, sitting on disk. Restore the assignment. (Leave the `createCipheriv`/`setAAD` lines in
  place while you do this — they keep `nonce` and `bodyKey` used, so the only thing that changed is
  that the sealed bytes were replaced by the plaintext.)
  (b) In `record.ts`, make `sealRecord` return its payload unsealed:
  ```ts
    return Buffer.from(args.payload).toString('utf8')   // TEMPORARY: no encryption
  ```
  Expected: FAIL with `AssertionError: expected false to be true` at
  `expect(store.compact([id]).ok).toBe(true)` — an unsealed record no longer authenticates — and
  `grep -rl CAIRN-CANARY "$TMPDIR"cairn-test-*` now finds `history.ndjson`, which is the leak the test
  exists to catch. Restore `sealRecord` and re-run to get `Tests 8 passed (8)`.

- [ ] **Step 54: Commit.**
  ```sh
  git add packages/store && \
  git commit -m "test(store): a canary written through the store never appears on disk"
  ```

- [ ] **Step 55: Write the public barrel.**
  Every other package imports `@cairn/store`, which resolves to this file only.
  `packages/store/src/index.ts`:
  ```ts
  export {
    openStore,
    type CompactSummary,
    type OpenStoreOptions,
    type Store,
    type StoreEventInput,
    type StoreMeta,
    type StoreStats,
    type UnsafeTestHooks,
  } from './log-store'
  export {
    appendLine0600,
    dataDirLayout,
    ensureDir0700,
    fsyncPath,
    writeFile0600,
    type DataDirLayout,
  } from './paths'
  export {
    ANCHOR_AAD_SEQ,
    NONCE_BYTES,
    RECORD_KINDS,
    TAG_BYTES,
    openRecord,
    openRecordAnyKind,
    recordAad,
    sealRecord,
  } from './record'
  export { CHAIN_GENESIS, chainNext, chainTip, createChainVerifier, type ChainVerifier } from './chain'
  export { createBlobStore, type BlobStore } from './blobs'
  export { fixedClock, itemFixture, randomTestKey, silentLogger, tempStoreDir, testItemId } from './testing'
  ```

- [ ] **Step 56: Commit the barrel, so the next step can import `@cairn/store` by package name.**
  ```sh
  git add packages/store && \
  git commit -m "feat(store): public barrel for @cairn/store"
  ```

- [ ] **Step 57: Write contract §8's repo-wide no-plaintext-on-disk test.**
  This file is named in contract §8 and created by no other task, while Tasks 3, 4, 5 and 8 all bend
  their own code around it. It lives at the repo root because half of what it asserts is about every
  *other* package: that no source file outside `@cairn/store` so much as mentions a temp-file or
  file-write identifier. Three design points, all load-bearing:

  1. **`$TMPDIR` is redirected into a directory this test owns.** `os.tmpdir()` re-reads `$TMPDIR` on
     every call (`[verified]` on Node v20.16.0: `os.tmpdir()` returned
     `/var/folders/qp/…/T`, then after `process.env.TMPDIR = '<a dir>'` the next call returned that
     directory), so any code path that reached for a temp file during the ingest lands somewhere this
     test can assert is *empty* — under any filename. Asserting the **shared** temp dir's listing is
     unchanged is not usable: other vitest workers create and remove their own `cairn-test-*`
     directories concurrently, so it is flaky in both directions. The shared dir is still checked, by
     name, for anything that looks like a spool.
  2. **Comments are stripped before the source scan.** The ban is on *code*.
     `packages/protocol/src/agent.ts` documents "an oversized rep streams over the stdout pipe, it
     never spools to a file", and `apps/desktop/main/src/config.ts` (Task 9) documents why it does
     *not* use `writeFileSync`. Banning the words in prose would force every such comment to be
     written in code, which is the opposite of what this control wants.
  3. **The stripping is done by `findInSources()` from `security/source-scan.ts`, not by a regex
     written here.** Task 1 created that helper and eight security tests share it, and its stripper is
     quote- and escape-aware. A hand-rolled `/(^|[^:])\/\/[^\n]*/` — the obvious version, and what an
     earlier draft of this step used — treats the `\/\/` inside a regex literal such as
     `/^https?:\/\//` as the start of a line comment and deletes the rest of that line. That does not
     merely produce a false negative in the abstract: it means one regex literal earlier in a file can
     **hide a real `writeFileSync(` further down the same line**, which silently weakens spec §11
     control 1. Reusing the shared stripper is therefore a security decision, not a tidiness one.
     `[verified]` on the real helper: a file containing
     `/** … it never spools to a file. */` plus `export const ok = /^https?:\/\//.test('x')` yields
     **zero** offenders, while adding
     `export const unsafeSpoolProbe = (b: Uint8Array) => writeFileSync('/tmp/p', b)` to a fresh
     `packages/agent-host/src/reassembler.ts` yields exactly
     `packages/agent-host/src/reassembler.ts:4: writeFileSync(`.

  `security/no-plaintext-on-disk.security.test.ts`:
  ```ts
  /**
   * Spec §11 control 1, contract §8: clipboard bytes NEVER touch the disk unencrypted — no spool
   * file, no temp file, no plaintext cache. This file is the repo-wide layer of that control; the
   * per-package layers are `packages/store/src/store.security.test.ts` and, for the process that
   * holds the bytes first, `packages/agent-host/src/spawn-agent.test.ts`.
   *
   * The source scan below covers `packages/**` and `apps/desktop/**` only. `security/**` is
   * deliberately outside those globs, which is why this file spells the banned identifiers out in
   * full instead of assembling them from fragments.
   */
  import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { basename, join, relative, sep } from 'node:path'
  import { afterEach, describe, expect, it } from 'vitest'
  import { TEST_CANARY, contentHash, type BlobId, type Candidate, type ResolvedRep } from '@cairn/protocol'
  import {
    fixedClock,
    itemFixture,
    openStore,
    randomTestKey,
    silentLogger,
    tempStoreDir,
    testItemId,
    type Store,
  } from '@cairn/store'
  import { REPO_ROOT, findInSources, sourceFiles } from './source-scan'

  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.()
  })

  /**
   * `REPO_ROOT` is imported rather than recomputed: `security/source-scan.ts` already resolves it as
   * `security/..`, and `findInSources` reports its `file` paths relative to that same value, so the
   * two halves of this test cannot drift. This file never imports `@cairn/protocol`'s `REPO_ROOT`,
   * which resolves the same directory from a different depth.
   */

  /** Every FILE under `p`, recursively, never descending into `node_modules`. A missing root is an
   *  empty list, not a throw. Used for the two *data-dir* walks below; the SOURCE walk goes through
   *  `sourceFiles`, which prunes more and is shared with every other source ban. */
  function walk(p: string): string[] {
    if (!existsSync(p)) return []
    if (!statSync(p).isDirectory()) return [p]
    return readdirSync(p)
      .filter((f) => f !== 'node_modules')
      .flatMap((f) => walk(join(p, f)))
  }

  /** The canary, shaped exactly as `@cairn/capture` will hand it to `history.ingest` in Task 8. */
  function canaryCandidate(): Candidate {
    const bytes = Buffer.from(`${TEST_CANARY} and a little more text`, 'utf8')
    const rep: ResolvedRep = {
      mime: 'text/plain',
      uti: 'public.utf8-plain-text',
      bytes,
      byteLength: bytes.byteLength,
      sha256: contentHash(bytes),
    }
    return {
      reps: [rep],
      kind: 'text',
      contentHash: rep.sha256,
      primaryText: bytes.toString('utf8'),
      hints: [],
      sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
      thumbnailJpeg: null,
      changeToken: 'change-1',
      capturedAt: 1_767_225_600_000,
    }
  }

  describe('no plaintext clipboard bytes on disk (spec §11 control 1, contract §8)', () => {
    it('ingests a canary Candidate and leaves it in no byte, no filename and no temp file', async () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const sandboxTmp = join(dir, 'tmp-sandbox')
      mkdirSync(sandboxTmp, { recursive: true, mode: 0o700 })
      const candidate = canaryCandidate()
      const realTmp = tmpdir()

      let store: Store | null = null
      let blobId: BlobId | null = null
      const previousTmpdir = process.env['TMPDIR']
      process.env['TMPDIR'] = sandboxTmp
      try {
        // Every write path the store has, in the order a real ingest uses them: open (meta.json +
        // the anchor CHECKPOINT), one sealed blob per representation, ONE sealed ITEM_ADDED that
        // references them, a checkpoint, then a compaction that rewrites the whole log.
        const opened = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
        if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)
        store = opened.value
        const rep = candidate.reps[0]
        if (rep === undefined) throw new Error('unreachable')
        const put = store.putBlob(rep.bytes)
        if (!put.ok) throw new Error(put.message)
        blobId = put.value
        const item = itemFixture(testItemId(7), put.value, candidate.primaryText ?? '')
        const appended = store.appendEvent({ kind: 'ITEM_ADDED', item })
        if (!appended.ok) throw new Error(appended.message)
        expect(store.checkpoint(1).ok).toBe(true)
        expect(store.compact([item.id]).ok).toBe(true)
      } finally {
        if (previousTmpdir === undefined) delete process.env['TMPDIR']
        else process.env['TMPDIR'] = previousTmpdir
      }
      if (store === null || blobId === null) throw new Error('unreachable')
      cleanups.push(() => store?.close())

      // 1. The private temp dir the whole ingest ran under is still empty: no spool file, no temp
      //    file, under any name.
      expect(walk(sandboxTmp)).toEqual([])

      // 2. The shared temp dir gained nothing that looks like a spool. Its listing is NOT compared
      //    for equality: concurrent vitest workers add and remove their own `cairn-test-*`
      //    directories while this test runs.
      const tmpEntries = readdirSync(realTmp)
      expect(tmpEntries).toContain(basename(dir))
      for (const name of tmpEntries) {
        expect(name.includes(TEST_CANARY), `${name} names the canary`).toBe(false)
        expect(/spool/i.test(name), `${name} looks like a spool file`).toBe(false)
      }

      // 3. Every byte of every file under the data dir. This is the README's claim, mechanised.
      const files = walk(dir)
      expect(files.length).toBeGreaterThanOrEqual(3) // history.ndjson, meta.json, one blob
      const canaryB64 = Buffer.from(TEST_CANARY, 'utf8').toString('base64')
      for (const file of files) {
        const bytes = readFileSync(file)
        expect(bytes.includes(TEST_CANARY), `${file} contains the canary`).toBe(false)
        // An extra tripwire, not the primary control: base64 of the canary means a plaintext body
        // was base64'd into some field.
        expect(bytes.includes(canaryB64), `${file} contains the base64 canary`).toBe(false)
        expect(relative(dir, file).includes(TEST_CANARY), `${file} names the canary`).toBe(false)
      }

      // 4. …and the canary really did go in, so none of the above is vacuous.
      const previews: string[] = []
      for await (const record of store.readAll()) {
        if (record.ok && record.value.kind === 'ITEM_ADDED') previews.push(record.value.item.preview)
      }
      expect(previews.some((p) => p.includes(TEST_CANARY))).toBe(true)
      const body = store.getBlob(blobId)
      expect(body.ok && body.value.toString('utf8')).toBe(candidate.primaryText)
    })

    it('the scanner itself works: a plaintext file in the same tree IS found', () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      writeFileSync(join(dir, 'control.txt'), `leaked: ${TEST_CANARY}`)
      const hits = walk(dir).filter((f) => readFileSync(f).includes(TEST_CANARY))
      expect(hits).toHaveLength(1)
    })

    it('no source file outside @cairn/store mentions a temp-file or file-write identifier', () => {
      /** Contract §8's list, plus the two stream forms Task 3's local guard also bans. */
      const BANNED = [
        'mkdtemp',
        'tmpdir(',
        'os.tmpdir',
        'spool',
        'writeFileSync(',
        'appendFileSync(',
        'createWriteStream(',
      ]
      const WRITES = ['writeFileSync(', 'appendFileSync(', 'createWriteStream(']
      const ROOTS = ['packages', 'apps/desktop']

      /**
       * The allowance list, in full — three boolean clauses in `exempt()`, grouped below as two
       * bullets, and no others. (Contract §8 counts the clauses; this comment groups them.)
       * - any path ending `.test.ts` — a test file builds its own temp dir and writes hostile
       *   fixtures on purpose, which is exactly what keyring's four test files and Task 9's
       *   `config.security.test.ts` do. Granting this here is what lets those tasks drop their
       *   individual exemption requests.
       * - anything under `packages/store/` for the three WRITE identifiers, and the single file
       *   `packages/store/src/testing.ts` for the temp-dir ones: `@cairn/store` is the only package
       *   allowed to write a file at all, and its `tempStoreDir()` is the one temp-dir helper every
       *   other package's tests import instead of rolling their own.
       *
       * Note what is deliberately NOT exempt. `apps/desktop/main/src/config.ts` uses
       * `openSync`/`writeSync`/`fchmodSync` precisely so that it narrows a pre-existing
       * world-readable file, and exempting it here would let that regress silently. And no package —
       * `@cairn/store` included — may reach for a temp directory: `tmpdir(` and `mkdtemp` are banned
       * everywhere outside that one helper.
       */
      const exempt = (file: string, identifier: string): boolean =>
        file.endsWith('.test.ts') ||
        (WRITES.includes(identifier) && file.startsWith('packages/store/')) ||
        file === 'packages/store/src/testing.ts'

      /**
       * `findInSources` returns every NON-COMMENT line under `roots` containing the needle, with
       * `file` already repo-relative and POSIX-separated, and with the RAW line as `text` so a
       * failure message shows what is actually in the file. `sourceFiles` returns absolute paths and
       * has already pruned `node_modules`, `out`, `build`, `coverage`, `.git` and `.vitest-reports`.
       *
       * `.ts` only, both here and in the ban loop: the renderer is sandboxed with no `fs` at all,
       * every Node-side file in the repo is TypeScript, and `sourceFiles`'s extension set is wider —
       * `.ts .js .mjs .cjs .svelte .html .swift .json .plist` — so without this filter the scan would
       * also read `package.json` files and Svelte markup, where none of these identifiers can appear
       * as code. Narrowing here, not in `sourceFiles`, keeps the shared helper unchanged for the
       * other bans that DO want `.svelte` and `.plist`.
       */
      const scanned = sourceFiles(ROOTS)
        .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
        .filter((file) => file.endsWith('.ts'))

      // Not vacuous — asserted BEFORE the ban, so a scan that read nothing cannot pass.
      expect(scanned.length).toBeGreaterThan(10)
      expect(scanned).toContain('packages/store/src/blobs.ts')
      expect(scanned).toContain('packages/agent-host/src/reassembler.ts')

      const offenders: string[] = []
      for (const identifier of BANNED) {
        for (const hit of findInSources(identifier, ROOTS)) {
          if (!hit.file.endsWith('.ts')) continue
          if (exempt(hit.file, identifier)) continue
          offenders.push(`${hit.file}:${hit.line}: ${identifier}`)
        }
      }
      expect(offenders).toEqual([])
    })
  })
  ```

- [ ] **Step 58: Run it.**
  ```sh
  npx vitest run --project security security/no-plaintext-on-disk.security.test.ts
  ```
  Expected: `Test Files 1 passed (1)`, `Tests 3 passed (3)`. It passes on the first run because the
  code it guards is already correct — the next step is what proves it can fail.

- [ ] **Step 59: Prove both halves of it are load-bearing.**
  One temporary mutation trips both. In `packages/store/src/blobs.ts`, add `writeFileSync` to the
  `node:fs` import, add `import { tmpdir } from 'node:os'`, and make `put` spool the plaintext before
  it seals anything — insert as the first statement inside `put`:
  ```ts
        writeFileSync(join(tmpdir(), `cairn-spool-${bytes.byteLength}`), Buffer.from(bytes))
  ```
  Re-run `npx vitest run --project security security/no-plaintext-on-disk.security.test.ts`.
  Expected: **two** of the three tests fail.
  - *ingests a canary Candidate…* fails at `expect(walk(sandboxTmp)).toEqual([])` with
    `AssertionError: expected [ '…/cairn-test-XXXXXX/tmp-sandbox/cairn-spool-44' ] to deeply equal
    []` — 44 bytes of copied text, in the clear, in a file.
  - *no source file outside @cairn/store mentions…* fails at `expect(offenders).toEqual([])` with
    `offenders` holding two entries, both pointing at the line you inserted:
    `'packages/store/src/blobs.ts:<line>: tmpdir('` and `'packages/store/src/blobs.ts:<line>: spool'`
    (`<line>` is the 1-based line number of the inserted statement — `findInSources` reports it from
    the comment-stripped text, which preserves newlines, so it matches the file on disk).
    `[verified]` against the real `security/source-scan.ts` on a fixture tree: exactly these two
    identifiers fire, in this order. Note which one does **not**: `writeFileSync(` is silent, because
    `packages/store/` is the write exemption — reaching for a temp directory is what is banned
    everywhere, in every package, including this one.

  Now revert `blobs.ts` — delete that one statement, drop `writeFileSync` from the `node:fs` import
  and delete the `node:os` import — and prove the cross-package half instead. Add
  `import { writeFileSync } from 'node:fs'` to the top of
  `packages/agent-host/src/reassembler.ts` and these two lines to the bottom of the same file:
  ```ts
  // TEMPORARY: the spool this repo deliberately removed.
  export const unsafeSpoolProbe = (bytes: Uint8Array): void => writeFileSync('/tmp/cairn-probe', bytes)
  ```
  Re-run the same command.
  Expected: *no source file outside @cairn/store mentions…* fails with `offenders` holding exactly
  one entry, `'packages/agent-host/src/reassembler.ts:<line>: writeFileSync('` — that is the
  regression Task 3 removed (an oversized representation spooled to a plaintext file), caught in a
  package that is not the store. Note what is **not** in `offenders`: the word `spool` in the comment
  directly above it, because comments are stripped and only code is scanned. `[verified]` on a fixture
  tree with the real helper: the offender list was exactly
  `[ 'packages/agent-host/src/reassembler.ts:4: writeFileSync(' ]` — one entry, the comment absent.
  Delete both additions from `reassembler.ts` and re-run to get `Tests 3 passed (3)`.

- [ ] **Step 60: Commit.**
  ```sh
  git add security/no-plaintext-on-disk.security.test.ts && \
  git commit -m "test(store): the canary appears in no byte of any file under the data dir or TMPDIR"
  ```

- [ ] **Step 61: Typecheck and run everything.**
  ```sh
  npm run typecheck
  npm run test -w @cairn/store
  npm run test:security -w @cairn/store
  npx vitest run --project security security/no-plaintext-on-disk.security.test.ts
  ```
  Expected: `tsc` exits 0 (it typechecks `security/**/*.ts` too, per contract §2); `Tests 53 passed
  (53)` for the unit project; `Tests 8 passed (8)` for `@cairn/store`'s own security files; and
  `Tests 3 passed (3)` for the repo-wide one, which the `-w @cairn/store` script does not match
  because it lives outside `packages/store`. If `tsc` complains about `noUnusedLocals` in
  `log-store.ts`, an import from an earlier step is now unused — delete it rather than suppressing it.

- [ ] **Step 62: Confirm the whole repo is still green and the guards still pass.**
  ```sh
  npm run guard:no-rebuild
  npm test
  ```
  Expected: `guard-no-electron-rebuild OK …`, and **all three** of `vitest.config.ts`'s projects pass —
  `unit`, `security` and `renderer`. `npm test` is a bare `vitest run`, which runs every project in the
  config, so the `renderer` project is not skipped here. If the summary names only two projects, this
  task is not the cause: `vitest.config.ts` has lost a project and Task 1's three-project config needs
  restoring before you go further. This task never edits that file. `@cairn/store` adds no dependency,
  so the supply-chain security test is unaffected, and it adds no renderer code, so the `renderer`
  project's count is unchanged.

- [ ] **Step 63: Push the branch.**
  ```sh
  git status --short
  git push -u origin m1/06-store
  ```
  Expected: `git status --short` prints **nothing** — the barrel went in at Step 56 and the repo-wide
  security test at Step 60, and `package-lock.json` was never modified because Task 1 already
  committed this workspace's entry — and the branch appears on `origin` with a compare link. Do not
  merge it yourself.

---

**Task 6 done when:**

- [ ] `npm run test -w @cairn/store` prints `Tests 53 passed (53)` across
      `record.test.ts`, `chain.test.ts`, `blobs.test.ts` and `log-store.test.ts`.
- [ ] `npm run test:security -w @cairn/store` prints `Tests 8 passed (8)` across
      `paths.security.test.ts` and `store.security.test.ts`.
- [ ] `npx vitest run --project security security/no-plaintext-on-disk.security.test.ts` prints
      `Tests 3 passed (3)`. That file exists at all — contract §8 names it and no other task creates
      it, while Tasks 3, 4, 5 and 8 all reason about it. Its source scan exempts **every** path ending
      `.test.ts`, and its allowance list is exactly the two clauses in `exempt()`: `packages/store/`
      for the three write identifiers, and `packages/store/src/testing.ts` for the temp-dir ones.
- [ ] `npm run typecheck` exits 0 and `npm test` passes all **three** vitest projects — `unit`,
      `security` and `renderer`. This task creates `packages/store/package.json` NOT AT ALL (Task 1
      does) and edits `vitest.config.ts` not at all, so a missing project is someone else's
      regression, not this one's.
- [ ] `ls packages/store/src` lists exactly: `blobs.ts blobs.test.ts chain.ts chain.test.ts index.ts
      log-store.ts log-store.test.ts paths.ts paths.security.test.ts record.ts record.test.ts
      store.security.test.ts testing.ts` — no more, no fewer.
- [ ] `grep -rn "sqlite\|better-sqlite3\|node-gyp" packages/store` prints nothing, and
      `grep -rln "from 'node:crypto'" packages/store/src` lists only `blobs.ts`, `blobs.test.ts`,
      `record.ts` and `testing.ts` — `blobs.test.ts` imports it to re-derive a blob's subkey and pin
      the derivation.
- [ ] Every blob has its OWN body subkey: `hkdfSync('sha256', master, Buffer.from(blobId,'utf8'),
      BLOB_HKDF_INFO, 32)` in `blobs.ts`, with `derives a DIFFERENT body subkey per blob` proving two
      blobs' subkeys differ and that blob B's subkey cannot open blob A's body (spec §11 control 7).
- [ ] A tampered log is detected on read, with the exact code per mutation: swap → `E_STORE_DECRYPT`,
      middle-delete → `E_STORE_DECRYPT`, duplicate → `E_STORE_DECRYPT`, same-index rollback →
      `E_STORE_CHAIN_BROKEN`. A torn trailing line is discarded and the file repaired
      (`stat().tornLineRepairedOnOpen === true`); an altered but `\n`-terminated line is *not*
      discarded and reports `E_STORE_DECRYPT`.
- [ ] `cat` of a store's `meta.json` shows exactly `schemaVersion`, `keyMode`, `scryptSaltB64` — no
      sequence number and no watermark. `StoreMeta.keyMode` is exactly
      `'os-keyring' | 'passphrase' | 'unknown'`: `@cairn/keyring`'s runtime `'locked'` is not
      persistable and never reaches `writeMeta`, and `grep -n "'locked'" packages/store` prints
      nothing.
- [ ] `close()` zero-fills exactly one buffer, `nameKey`, and Step 21 asserts on its CONTENTS. There
      are no long-lived per-blob subkeys: each body subkey is derived inside `put`/`get`, used for one
      GCM operation and `fill(0)`-ed in that call's `finally`. The caller's master key is untouched —
      Step 21 proves a fresh `createBlobStore` with the same master key still reads a blob written
      before the close.
- [ ] Each of these mutations makes a named test fail, and each was demonstrated during the task:
      deleting the `chmodSync` calls in `paths.ts` (step 8), zeroing the `lineIndex` in `recordAad`
      (step 14), the absent `chain.check` in `readAll` (step 37's red run), the absent blob-reference
      guard in `appendEvent` (step 47's red run), skipping encryption in either `blobs.put` or
      `sealRecord` (step 53), and spooling the plaintext to `os.tmpdir()` from `blobs.put` or adding a
      `writeFileSync` to `packages/agent-host/src/reassembler.ts` (step 59).
- [ ] `git log --oneline origin/main..m1/06-store` shows 12 commits, all `feat(store):`/`fix(store):`/
      `test(store):`, none with an AI-attribution trailer, and `git branch --show-current` is
      `m1/06-store`, never `main`.
