### Task 7: @cairn/capture + @cairn/privacy — normalise, suppress self-writes, thumbnail, and never record a secret

You are building the two modules that stand between the OS and the history: `@cairn/capture` turns a
stream of raw agent events into **at most one** clean `Candidate`, and `@cairn/privacy` is the single
place that answers *"may this be recorded?"* and *"may this ever leave the machine?"*.

Read this before you start, because it is the reason the task is shaped this way: the privacy layer
ships in **Milestone 1**, not later (spec §11 control 5). The whole point is that there is no window
in which the app records passwords in the clear. So masking happens **at ingest**, the OS
concealed-type hint is checked **before any byte is read**, and `@cairn/capture` writes **nothing to
disk, ever** — no spool file, no temp file, no cache (spec §4, §11 control 1). Three tests in this
task fail if any of those controls is removed, and you will prove that by removing them.

Neither module touches the OS. Everything is tested against byte fixtures, a stub agent and recorded
transcripts, so it runs on any machine with no compiler and no permissions.

---

**Files:**

*Create — `@cairn/privacy`*
```
packages/privacy/src/entropy.ts                        shannonBits + highEntropyRuns (the frozen rule)
packages/privacy/src/detectors.ts                      the 10 named detectors + span merging
packages/privacy/src/mask.ts                           mask(text): {preview, spans}
packages/privacy/src/classify.ts                       classify(snapshot, rules): three layers, fail closed
packages/privacy/src/retention-policy.ts               secretExpiresAt + isPinnable (the 5-minute TTL)
packages/privacy/src/assert-syncable.ts                assertSyncable(item): void — THROWS by design
packages/privacy/src/index.ts                          the public barrel
```

*Create — `@cairn/capture`*
```
packages/capture/src/classify-kind.ts                  classifyKind + PRIMARY_REP_ORDER + selectPrimaryRep
packages/capture/src/normalize-reps.ts                 TIFF->PNG, CF_HTML strip, uri-list, alias dedupe
packages/capture/src/thumbnail.ts                      sharp -> JPEG 256 px q70, <= 24 KiB guaranteed
packages/capture/src/capture.ts                        debounce, self-write suppression, candidate assembly
packages/capture/src/stub-agent.ts                     createStubAgent(): a hand-driven ClipboardAgent
packages/capture/src/testing.ts                        rep(), changed(), createSpyLogger()
packages/capture/src/index.ts                          the public barrel
```

*Create — tests*
```
packages/privacy/src/entropy.test.ts
packages/privacy/src/detectors.test.ts
packages/privacy/src/corpus.test.ts
packages/privacy/src/mask.test.ts
packages/privacy/src/classify.test.ts
packages/privacy/src/retention-policy.test.ts
packages/privacy/src/assert-syncable.security.test.ts
packages/capture/src/classify-kind.test.ts
packages/capture/src/normalize-reps.test.ts
packages/capture/src/thumbnail.test.ts
packages/capture/src/capture.test.ts
packages/capture/src/capture.security.test.ts
```

*Create — fixtures*
```
fixtures/formats/plain-utf8.txt                        24 bytes: an emoji and a CRLF
fixtures/formats/cf-html-wrapper.txt                   202 bytes: a CF_HTML blob with the Windows header
fixtures/formats/screenshot.tiff                       444 bytes: 64x40 deflate TIFF
fixtures/formats/screenshot.png                        6739 bytes: the expected PNG conversion result
fixtures/formats/uri-list-two-files.txt                77 bytes: two file:// URIs, LF terminated
fixtures/formats/rtf-minimal.rtf                       113 bytes: a minimal RTF document
fixtures/secrets/detector-corpus.json                  16 entries: must trip, >=1 per detector
fixtures/secrets/false-positive-corpus.json            the 13 frozen cases: must NOT trip
fixtures/agent-transcripts/duplicate-notify.ndjson     two ticks, one changeCount, one candidate
fixtures/agent-transcripts/self-write-suppression.ndjson  our own write() must not be recaptured
fixtures/agent-transcripts/concealed-1password.ndjson  a concealed-hint change, never recorded
fixtures/agent-transcripts/finder-multifile.ndjson     a two-file Finder copy as text/uri-list
fixtures/agent-transcripts/chrome-source-url.ndjson    text/x-source-url rider alongside text/plain
```

*Verify, do not create* — `packages/privacy/package.json` and `packages/capture/package.json` (both
written by Task 1) and `packages/protocol/src/index.ts` (Task 1 + Task 2). Steps 2-4 check them.

*Modify* — **nothing.** Task 1 created `packages/privacy/package.json`, `packages/capture/package.json`
and the `package-lock.json` entries for both, and Task 1 (`./constants`, `./testing`) plus Task 2 (the
other nine lines) own every line of `packages/protocol/src/index.ts`. This task **verifies** those
three files in Steps 2-4 and edits none of them; every other path it touches is new. The single
exception is spelled out in Step 2: if `packages/capture/package.json` is missing its
`@cairn/agent-host` line because the branch point predates that reconciliation, add that one line and
commit it there — nothing else in another task's file is ever edited from this branch.

*Not created here* — `fixtures/agent-transcripts/hello-watch-text.ndjson` and
`fixtures/agent-transcripts/image-tiff-chunked.ndjson` belong to Task 3 (`@cairn/agent-host`); they
exercise the reassembler, not capture. Do not create them, and do not depend on them.

---

**Interfaces:**

*Consumes* — all from `@cairn/protocol` (Task 1), imported as `import { … } from '@cairn/protocol'`,
never a deep path:

```ts
export function contentHash(bytes: Uint8Array): ContentHash            // 'sha256-<43 char base64url>'
export type ContentHash = string & { readonly [contentHashBrand]: 'sha256-b64url' }
export type ItemKind = 'text' | 'richtext' | 'image' | 'files'
export type PasteboardHint = 'concealed' | 'transient' | 'auto-generated' | 'password-manager'
export type Flag = 'secret' | 'concealed' | 'transient' | 'auto-generated' | 'excluded' | 'no-sync' | 'cut'
export type DetectorName =
  | 'pem-private-key' | 'aws-access-key' | 'github-token' | 'openai-key' | 'anthropic-key'
  | 'slack-token' | 'stripe-live-key' | 'google-api-key' | 'jwt' | 'high-entropy'
export interface MaskSpan { readonly start: number; readonly end: number; readonly detector: DetectorName }
export interface PrivacyRules { readonly detectors: readonly DetectorName[]; readonly honourHints: boolean; readonly excludedBundleIds: readonly string[] }
export interface Classification { readonly action: 'record' | 'skip'; readonly flags: readonly Flag[]; readonly reason: string }
export interface SourceApp { readonly bundleId: string | null; readonly name: string | null; readonly confidence: 'heuristic' | 'unknown' }
export interface ResolvedRep { readonly mime: string; readonly uti: string | null; readonly bytes: Uint8Array; readonly byteLength: number; readonly sha256: ContentHash }
export interface Snapshot { readonly reps: readonly ResolvedRep[]; readonly primaryText: string | null; readonly kind: ItemKind; readonly hints: readonly PasteboardHint[]; readonly sourceApp: SourceApp | null; readonly totalBytes: number }
export interface Candidate { readonly reps: readonly ResolvedRep[]; readonly kind: ItemKind; readonly contentHash: ContentHash; readonly primaryText: string | null; readonly hints: readonly PasteboardHint[]; readonly sourceApp: SourceApp | null; readonly thumbnailJpeg: Uint8Array | null; readonly changeToken: string; readonly capturedAt: number }
export interface Item { /* §5.6 of the contract — 15 readonly fields */ }
export interface ClipboardChangedPayload { readonly changeCount: number; readonly changeToken: string; readonly hints: readonly PasteboardHint[]; readonly reps: readonly ResolvedRep[]; readonly sourceApp: SourceApp | null; readonly droppedReps: readonly { readonly mime: string; readonly code: ErrorCode }[] }
export interface ClipboardAgent {
  start(): Promise<AgentCapabilities>
  request<M extends AgentMethod>(method: M, params: AgentParams<M>, timeoutMs?: number): Promise<Result<AgentResult<M>>>
  on<E extends keyof AgentEventMap>(event: E, cb: (payload: AgentEventMap[E]) => void): Unsub
  dispose(): Promise<void>
}
export type Unsub = () => void
export type Cancel = () => void
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Cancel }
export interface TestClock extends Clock { advance(ms: number): void; readonly pending: number }
export function createTestClock(startMs?: number): TestClock
export interface Logger { log(level, event, fields?) + debug/info/warn/error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void }
export type Result<T> = Ok<T> | Err
export const ok: <T>(value: T) => Ok<T>
export const err: (code: ErrorCode, message: string, detail?: LogFields) => Err
export function maskToken(raw: string): string                         // 'AKIA••••A7QD'
export const MASK_BULLET: '•'
export const NON_SYNCABLE_FLAGS: readonly ['secret', 'concealed', 'excluded', 'no-sync']
export const CAPTURE_DEBOUNCE_MS: 150
export const WATCH_INTERVAL_MS: 500
export const SECRET_TTL_MS: 300_000
export const THUMBNAIL_MAX_EDGE_PX: 256
export const THUMBNAIL_JPEG_QUALITY: 70
export const THUMBNAIL_MAX_BYTES: 24576
export const TEST_CANARY: 'CAIRN-CANARY-9f3a1c7e'
export const MIME_SOURCE_URL: 'text/x-source-url'                      // the mime the macOS agent pairs with org.chromium.source-url
export const fixturePath: (...p: string[]) => string                   // from packages/protocol/src/testing.ts
```

From Task 3 (`@cairn/agent-host`) — used only by `packages/capture/src/capture.test.ts`, and
therefore still a **declared** dependency in `packages/capture/package.json` (Step 2):

```ts
export interface FakeAgent extends ClipboardAgent { assertDrained(): void; readonly framesPlayed: number }
export function createFakeAgent(opts: { transcriptPath: string; clock: Clock; logger: Logger }): FakeAgent
```

*Produces* — `@cairn/privacy`:

```ts
// entropy.ts
export const ENTROPY_MIN_RUN: 20
export const ENTROPY_MAX_RUN: 512
export const ENTROPY_BITS_PER_CHAR: 4.0
export function shannonBits(s: string): number
export function highEntropyRuns(text: string): readonly { start: number; end: number }[]

// detectors.ts
export const ALL_DETECTORS: readonly DetectorName[]                    // all ten, in the frozen order
export function detectSpans(text: string, enabled: readonly DetectorName[]): readonly MaskSpan[]
export function mergeSpans(spans: readonly MaskSpan[]): readonly MaskSpan[]

// mask.ts
export function mask(text: string): { readonly preview: string; readonly spans: readonly MaskSpan[] }

// classify.ts — `PrivacyRules` and `Classification` are NOT declared here. They are frozen in
// `packages/protocol/src/types.ts` (contract §5.7) and imported; contract §5 forbids redeclaring
// any frozen shape locally, and Task 8 already takes both types from '@cairn/protocol'.
export const DEFAULT_RULES: PrivacyRules
export const SKIP_HINTS: readonly PasteboardHint[]                     // ['concealed', 'password-manager']
export function shouldSkipOnHints(hints: readonly PasteboardHint[], rules: PrivacyRules): boolean
export function classify(snapshot: Snapshot, rules: PrivacyRules): Classification

// retention-policy.ts  — Task 8 (@cairn/history) MUST call these, not re-derive the numbers
export function secretExpiresAt(createdAt: number, flags: readonly Flag[]): number | null
export function isPinnable(flags: readonly Flag[]): boolean

// assert-syncable.ts
export function assertSyncable(item: Item): void                       // THROWS for any NON_SYNCABLE_FLAGS
```

*Produces* — `@cairn/capture`:

```ts
// classify-kind.ts
export function classifyKind(reps: readonly ResolvedRep[]): ItemKind
export const PRIMARY_REP_ORDER: readonly string[]                      // frozen, contract §5.5
export function selectPrimaryRep(reps: readonly ResolvedRep[]): ResolvedRep | null

// normalize-reps.ts
export function normalizeReps(raw: readonly ResolvedRep[]): Promise<readonly ResolvedRep[]>
export function stripCfHtml(bytes: Uint8Array): Uint8Array | null
export function canonicaliseUriList(bytes: Uint8Array): Uint8Array
export const DROPPED_UTIS: readonly string[]
export const LEGACY_UTI_ALIASES: Readonly<Record<string, string>>

// thumbnail.ts
export function thumbnail(png: Uint8Array): Promise<Uint8Array>        // JPEG, <=256 px, <=24 KiB

// capture.ts
export interface CaptureConfig {
  readonly debounceMs: number
  readonly watchIntervalMs: number
  readonly rules: PrivacyRules
}
export interface CaptureDeps {
  readonly agent: ClipboardAgent
  /** Structurally satisfied by `import * as privacy from '@cairn/privacy'`. */
  readonly privacy: {
    classify: (s: Snapshot, r: PrivacyRules) => Classification
    mask: (t: string) => { readonly preview: string; readonly spans: readonly { readonly start: number; readonly end: number }[] }
    shouldSkipOnHints: (h: readonly PasteboardHint[], r: PrivacyRules) => boolean
  }
  readonly config: CaptureConfig
  readonly clock: Clock
  readonly logger: Logger
}
export interface Capture {
  start(): Promise<Result<{ intervalMs: number }>>
  stop(): Promise<void>
  onCandidate(cb: (c: Candidate) => void): Unsub
  suppressToken(token: string): void
  /** Resolves when no candidate is mid-assembly. */
  whenIdle(): Promise<void>
}
export function createCapture(deps: CaptureDeps): Capture
export function defaultCaptureConfig(rules: PrivacyRules): CaptureConfig

// testing.ts + stub-agent.ts — ordinary source, re-exported from the barrel so another package can
// reach them without a deep path (contract §2 allows only the single '.' export). Inside this package
// the tests import './testing' and './stub-agent' directly. Task 9's wiring.test.ts drives the real
// pipeline with `createFakeAgent` from @cairn/agent-host instead, so nothing there depends on these.
export function rep(mime: string, uti: string | null, body: string | Uint8Array): ResolvedRep
export function changed(changeCount: number, reps: readonly ResolvedRep[], hints?: readonly PasteboardHint[]): ClipboardChangedPayload
export function createSpyLogger(): { logger: Logger; events: LogEvent[] }
export function createStubAgent(): StubAgent
export interface StubAgent extends ClipboardAgent {
  emitChanged(p: ClipboardChangedPayload): void
  readonly requests: readonly { method: AgentMethod; params: Record<string, unknown> }[]
  nextChangeToken: string
}
```

**Three decisions later tasks depend on, spelled out so nobody re-derives them:**

1. **`Candidate.primaryText` is already masked.** When `classify` returns a `secret` flag, capture
   replaces the primary text with `mask(raw).preview` **before** the candidate leaves the module.
   The raw bytes still travel in `Candidate.reps` — they are destined for the encrypted store and
   nothing else. This is spec §11 control 5: the in-memory search index can never hold the raw value,
   because nothing upstream of it ever holds it.
2. **`@cairn/capture` does not dedupe items.** Two identical copies produce **two** candidates with
   the same `contentHash` and different `capturedAt`. That is deliberate: Task 8's
   `packages/history/src/dedupe.ts` is what turns the second candidate into a bumped `updatedAt` on
   the existing row instead of a new row. If capture swallowed the second candidate, recency would
   never bump and your most-recent copy would sort as old. A test in this task asserts capture emits
   both.
3. **The only `exec(` in these two packages is `RegExp#exec`.** `packages/privacy/src/detectors.ts`
   drives every detector with `while ((m = re.exec(text)) !== null)` and
   `packages/capture/src/normalize-reps.ts` parses the CF_HTML offsets with
   `new RegExp(…).exec(text)`. Neither package imports `node:child_process` at all, and nothing here
   ever builds a command string out of a copied file path — the paths are strings we hash, display and
   hand to the OS clipboard. The wiring task's shell-execution ban (spec §11 control 3: "no shell in
   the capture or recall path at all on macOS") must therefore be written to match the
   `node:child_process` surface — `execSync`, `execFile`, `execFileSync`, `shell: true`, and `exec`
   only as an import or member of `child_process` — and **not** a bare `exec(` substring, or these two
   files fail a ban they do not violate. Keep the ban; make the pattern precise.

---

**Branch:** `m1/07-capture-privacy`

---

- [ ] **Step 1: Create the branch.**
  ```sh
  cd /Users/santoshkumarreddy/copy-clipboard-app
  git fetch origin && git checkout -b m1/07-capture-privacy origin/main
  ```
  Expected: `Switched to a new branch 'm1/07-capture-privacy'`. Never commit to `main`.

- [ ] **Step 2: Verify both package manifests — do not create them.**
  `packages/privacy/package.json` and `packages/capture/package.json` were both written by **Task 1's
  step that writes the ten workspace manifests**, and `package-lock.json` already has entries for
  both. Creating them again here is how the two documents drifted the last time; this step only
  checks them.
  ```sh
  cd /Users/santoshkumarreddy/copy-clipboard-app
  node -e "
  const r=(p)=>require('./packages/'+p+'/package.json')
  const cap=r('capture'), priv=r('privacy')
  const want=['@cairn/agent-host','@cairn/privacy','@cairn/protocol','sharp']
  const got=Object.keys(cap.dependencies).sort()
  if(JSON.stringify(got)!==JSON.stringify(want))throw new Error('capture deps '+got.join(',')+' != '+want.join(','))
  if(JSON.stringify(Object.keys(priv.dependencies))!==JSON.stringify(['@cairn/protocol']))throw new Error('privacy deps wrong')
  for(const p of [cap,priv]){
    if(p.type!=='module'||p.private!==true)throw new Error(p.name+': not a private ESM package')
    if(p.exports['.']!=='./src/index.ts')throw new Error(p.name+': single \".\" export missing')
    if(!p.scripts.test.includes('--project unit')||!p.scripts['test:security'].includes('--project security'))throw new Error(p.name+': test scripts wrong')
  }
  console.log('manifests ok:',cap.name,got.join(' '),'|',priv.name,'@cairn/protocol')
  "
  ```
  Expected, exactly:
  ```
  manifests ok: @cairn/capture @cairn/agent-host @cairn/privacy @cairn/protocol sharp | @cairn/privacy @cairn/protocol
  ```
  Four dependencies for `@cairn/capture` is the number contract §2's dependency table and Task 1 both
  state. `@cairn/agent-host` is declared even though only `capture.test.ts` imports it
  (`createFakeAgent`, Step 56), because npm links every workspace into the root `node_modules`, so an
  undeclared import resolves today and breaks the first time anyone runs `--install-strategy=nested`
  or extracts the package. `@cairn/hotkey` declares `@cairn/agent-host` the same way.

  If — and only if — the check throws exactly
  `Error: capture deps @cairn/privacy,@cairn/protocol,sharp != @cairn/agent-host,@cairn/privacy,@cairn/protocol,sharp`,
  you are on a `main` that predates that reconciliation. Add the one missing line to
  `packages/capture/package.json`, keeping the keys alphabetical:
  ```json
      "@cairn/agent-host": "0.1.0",
  ```
  then re-run the check until it prints `manifests ok`, and commit exactly that:
  ```sh
  git add packages/capture/package.json
  git commit -m "chore(capture): declare the @cairn/agent-host dependency capture.test.ts imports"
  ```
  That repair is the only commit this task makes outside its own new files, and it makes the branch 14
  commits instead of 13.

- [ ] **Step 3: Confirm both workspaces are linked and `sharp` resolves.**
  Nothing new to install — Task 1 committed the lock file with both workspaces in it — so `npm install`
  must be a no-op here. `ignore-scripts=true` is in `.npmrc`; sharp needs no install script because it
  ships its prebuilds as optional dependencies, so this must just work.
  ```sh
  npm install
  node -e "const s=require('sharp');console.log('sharp',s.versions.sharp,'vips',s.versions.vips)"
  node -e "console.log(require('fs').realpathSync('node_modules/@cairn/capture'),require('fs').realpathSync('node_modules/@cairn/privacy'))"
  ```
  Expected: `up to date, audited N packages` with no peer warnings and **no `package-lock.json`
  change** (`git status --porcelain` stays empty), then `sharp 0.35.4 vips 8.18.6`, then the two
  absolute paths `/Users/santoshkumarreddy/copy-clipboard-app/packages/capture` and
  `…/packages/privacy` — npm links workspaces as symlinks, so a real path under `packages/` proves the
  link rather than a published copy.

- [ ] **Step 4: Confirm the fixture-path helper is reachable.**
  Contract §7 requires every test to read fixtures through one helper. It lives in
  `packages/protocol/src/testing.ts` — created by **Task 1's step that writes the fixture-path helper
  and appends the second barrel line** — and must be reachable from the package's single `"."` export.

  Do **not** reach for `node -e "import('@cairn/protocol')"` here: relative imports in this repo are
  extensionless by contract §2, which vite, vitest and tsc resolve and Node's own ESM resolver does
  not — that command dies with `ERR_MODULE_NOT_FOUND` for `.../packages/protocol/src/constants` no
  matter whether the barrel line is present. Task 2 records the same trap. So check the barrel
  structurally, then prove reachability through vite's resolver with a throwaway test.

  ```sh
  cd /Users/santoshkumarreddy/copy-clipboard-app
  grep -c '' packages/protocol/src/index.ts
  grep -c "^export \* from '\./" packages/protocol/src/index.ts
  sort -c packages/protocol/src/index.ts && echo 'alphabetical'
  grep -q "from './testing'" packages/protocol/src/index.ts && echo 'testing exported' || echo 'MISSING'
  ```
  Expected: `11`, then `11`, then `alphabetical`, then `testing exported` — every line is an
  `export * from './…'` and nothing else. (Use `grep -c ''` for the line count, not `wc -l`: BSD `wc`
  pads its output to `          11`, which is annoying to compare.) Eleven is the finished barrel —
  `./agent`, `./clock`, `./constants`, `./hash`, `./id`, `./ipc`, `./log`, `./parse-agent-line`,
  `./result`, `./testing`, `./types` — two lines from Task 1 (`./constants`, `./testing`) and nine
  appended by Task 2. If any of the four outputs differs, **stop and do not edit that file**: this task
  owns no line of it, and a barrel with ten lines means the branch point is missing part of Task 2's
  work. `git fetch origin && git log --oneline -1 origin/main`, then re-cut the branch off a `main`
  that has both tasks merged.

  Now prove `fixturePath` actually resolves to the repo-root `fixtures/` directory. This file is
  created, run and deleted inside this step — it is a probe, not part of the suite:
  ```sh
  mkdir -p packages/privacy/src
  cat > packages/privacy/src/fixture-path.probe.test.ts <<'EOF'
  import { expect, it } from 'vitest'
  import { fixturePath } from '@cairn/protocol'

  it('resolves a fixture path from the repo root, not from the test cwd', () => {
    expect(typeof fixturePath).toBe('function')
    expect(fixturePath('formats', 'x.txt')).toBe(`${process.cwd()}/fixtures/formats/x.txt`)
  })
  EOF
  npx vitest run --project unit packages/privacy/src/fixture-path.probe.test.ts
  rm packages/privacy/src/fixture-path.probe.test.ts
  ```
  Expected: `Tests  1 passed (1)`. The `EOF` terminator must sit at column 0 when you paste.
  `fixturePath` only joins strings, so it does not matter that `fixtures/formats/x.txt` does not
  exist yet; `process.cwd()` is the repo root because that is where you ran `npx vitest`.

  There is deliberately **no commit here.** Steps 2-4 verified three files this task does not own and
  changed none of them, so `git status --porcelain` is still empty and the first commit of the branch
  is the entropy rule below. If you have staged anything at this point, you edited a file that belongs
  to Task 1 or Task 2 — `git checkout` it.

- [ ] **Step 5: Write the failing entropy test.**
  This is the most load-bearing arithmetic in the repo, so it is tested as arithmetic. The `> 4.0`
  cut point is not taste: a uniform lowercase-hex string is **exactly** 4.0 bits/char
  (16 equiprobable symbols, log₂16 = 4), so git SHAs and UUIDs mathematically cannot exceed it, while
  the 64-symbol base64url alphabet tops out at 6.0 and comfortably does. The four extra guards
  (`URLISH_RE`, the path prefixes, `CODEISH_RE`, and the 512-char ceiling) exist because the bare rule
  **fails its own false-positive corpus** — a tracking-laden URL scores 4.317 and minified JS 4.622.

  `packages/privacy/src/entropy.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { highEntropyRuns, shannonBits } from './entropy'

  describe('shannonBits', () => {
    it('scores uniform lowercase hex at EXACTLY 4.0, which is why git SHAs cannot trip a > 4.0 rule', () => {
      expect(shannonBits('0123456789abcdef')).toBe(4)
    })
    it('scores a 64-char uniform base64 alphabet run at 6.0, the base64url maximum', () => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
      expect(shannonBits(alphabet)).toBe(6)
    })
    it('scores a single repeated character at 0', () => {
      expect(shannonBits('aaaaaaaaaaaaaaaaaaaa')).toBe(0)
    })
    it('puts a real git SHA and a UUID below the cut point', () => {
      expect(shannonBits('e3b0c44298fc1c149afbf4c8996fb92427ae41e4')).toBeCloseTo(3.565, 3)
      expect(shannonBits('550e8400-e29b-41d4-a716-446655440000')).toBeCloseTo(3.391, 3)
    })
  })

  describe('highEntropyRuns', () => {
    it('ignores a run shorter than 20 chars even at high entropy', () => {
      expect(highEntropyRuns('aB3dE5fG7hJ9kL1mN3p')).toEqual([])
    })
    it('ignores a run longer than 512 chars, which is what saves a raw base64 image body', () => {
      expect(highEntropyRuns('aB3dE5fG7h'.repeat(52))).toEqual([])
    })
    it('ignores anything with a scheme prefix, which is what saves URLs and data: URLs', () => {
      expect(highEntropyRuns('https://x.example/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toEqual([])
    })
    it('ignores anything containing a code character, which is what saves minified JS', () => {
      expect(highEntropyRuns('a(bC3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY)')).toEqual([])
    })
    it('ignores absolute and relative filesystem paths', () => {
      expect(highEntropyRuns('/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toEqual([])
      expect(highEntropyRuns('./aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toEqual([])
    })
    it('reports the offsets of a bare high-entropy token inside a sentence', () => {
      expect(highEntropyRuns('token is aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY ok')).toEqual([{ start: 9, end: 41 }])
    })
    it('strips trailing sentence punctuation before measuring', () => {
      expect(highEntropyRuns('key: aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY.')).toEqual([{ start: 5, end: 37 }])
    })
  })
  ```

- [ ] **Step 6: Run it and watch it fail.**
  ```sh
  npx vitest run packages/privacy/src/entropy.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './entropy' imported from
  .../packages/privacy/src/entropy.test.ts`.

- [ ] **Step 7: Write `entropy.ts`.**
  This is the frozen rule from contract §5.7 — copy it exactly; the constants and every guard are
  load-bearing.

  `packages/privacy/src/entropy.ts`:
  ```ts
  export const ENTROPY_MIN_RUN = 20
  export const ENTROPY_MAX_RUN = 512
  export const ENTROPY_BITS_PER_CHAR = 4.0

  const TOKEN_RE = /^[A-Za-z0-9+/_=.-]{20,512}$/
  const URLISH_RE = /^[a-z][a-z0-9+.-]*:/i          // http:, https:, data:, file:, mailto:
  const CODEISH_RE = /[(){}\[\];,<>"'`|\\!@#$%^&*?~]/

  export function shannonBits(s: string): number {
    const freq = new Map<string, number>()
    for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
    let h = 0
    for (const n of freq.values()) {
      const p = n / s.length
      h -= p * Math.log2(p)
    }
    return h
  }

  /** Returns [start, end) offsets of every high-entropy token-shaped run. */
  export function highEntropyRuns(text: string): readonly { start: number; end: number }[] {
    const hits: { start: number; end: number }[] = []
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const run = m[0].replace(/[.,;:!?)\]}'"]+$/, '')     // strip sentence punctuation
      if (run.length < ENTROPY_MIN_RUN || run.length > ENTROPY_MAX_RUN) continue
      if (URLISH_RE.test(run)) continue                     // a URL or data: URL is not a secret
      if (run.startsWith('/') || run.startsWith('./') || run.startsWith('../') || run.startsWith('~/')) continue
      if (CODEISH_RE.test(run)) continue                    // code, not a bare token
      if (!TOKEN_RE.test(run)) continue
      if (shannonBits(run) > ENTROPY_BITS_PER_CHAR) hits.push({ start: m.index, end: m.index + run.length })
    }
    return hits
  }
  ```

- [ ] **Step 8: Run it and watch it pass.**
  ```sh
  npx vitest run packages/privacy/src/entropy.test.ts
  ```
  Expected: `Tests  11 passed (11)`.

- [ ] **Step 9: Commit the entropy rule.**
  ```sh
  git add packages/privacy/src/entropy.ts packages/privacy/src/entropy.test.ts
  git commit -m "feat(privacy): Shannon entropy rule with the guards its own corpus requires"
  ```

- [ ] **Step 10: Write the failing detector test.**
  Ten detectors, each with a positive **and** a near-miss, because a detector that fires on everything
  is as useless as one that fires on nothing. Note two deliberate asymmetries: `openai-key` must
  **not** claim an `sk-ant-` key (that is what the `(?!ant-)` lookahead is for), and
  `stripe-live-key` must never fire on `sk_test_`.

  `packages/privacy/src/detectors.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import type { DetectorName } from '@cairn/protocol'
  import { ALL_DETECTORS, detectSpans, mergeSpans } from './detectors'

  const names = (t: string): DetectorName[] => [...new Set(detectSpans(t, ALL_DETECTORS).map((s) => s.detector))]

  describe('detectors: one positive and one near-miss each', () => {
    it('pem-private-key fires on a BEGIN line and not on a public key or certificate', () => {
      expect(names('-----BEGIN EC PRIVATE KEY-----')).toContain('pem-private-key')
      expect(names('-----BEGIN PUBLIC KEY-----')).not.toContain('pem-private-key')
      expect(names('-----BEGIN CERTIFICATE-----')).not.toContain('pem-private-key')
    })
    it('aws-access-key needs 12+ uppercase chars after AKIA/ASIA', () => {
      expect(names('AKIA2E0PQIN4XA7QD')).toContain('aws-access-key')
      expect(names('ASIA2E0PQIN4XA7QD')).toContain('aws-access-key')
      expect(names('AKIA2E0PQ')).not.toContain('aws-access-key')
      expect(names('akia2e0pqin4xa7qd')).not.toContain('aws-access-key')
    })
    it('github-token fires on ghp_ and github_pat_ but not on a stub', () => {
      expect(names('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).toContain('github-token')
      expect(names('github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWX')).toContain('github-token')
      expect(names('ghp_tooshort')).not.toContain('github-token')
    })
    it('openai-key fires on sk- but explicitly not on an sk-ant- key', () => {
      expect(names('sk-proj-Th1sIsNotARealKeyJustFiller99')).toContain('openai-key')
      expect(names('sk-ant-api03-Th1sIsNotARealKeyJustFiller99')).not.toContain('openai-key')
      expect(names('sk-short')).not.toContain('openai-key')
    })
    it('anthropic-key claims the sk-ant- prefix', () => {
      expect(names('sk-ant-api03-Th1sIsNotARealKeyJustFiller99')).toContain('anthropic-key')
      expect(names('sk-ant-tiny')).not.toContain('anthropic-key')
    })
    it('slack-token fires on each of xoxb/xoxa/xoxp/xoxr/xoxs', () => {
      for (const p of ['xoxb', 'xoxa', 'xoxp', 'xoxr', 'xoxs']) {
        expect(names(`${p}-123456789012-abcdefGHIJKL`)).toContain('slack-token')
      }
      expect(names('xoxb-short')).not.toContain('slack-token')
    })
    it('stripe-live-key fires on live secret and restricted keys but never on a test key', () => {
      // Assembled from fragments on purpose — see "Why these strings are split" above.
      const body = '51H8xQwEXAMPLEKEY0123456789'
      expect(names('sk_' + 'live_' + body)).toContain('stripe-live-key')
      expect(names('rk_' + 'live_' + body)).toContain('stripe-live-key')
      expect(names('sk_test_51H8xQwEXAMPLEKEY0123456789')).not.toContain('stripe-live-key')
    })
    it('google-api-key needs exactly 35 chars after AIza', () => {
      expect(names('AIzaSyB1234567890abcdefghijklmnopqrstuv')).toContain('google-api-key')
      expect(names('AIzaSyD-tooShort')).not.toContain('google-api-key')
    })
    it('jwt needs three dot-separated base64url segments', () => {
      expect(names('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toContain('jwt')
      expect(names('eyJhbGciOi.short.x')).not.toContain('jwt')
    })
    it('high-entropy fires on a bare 32-char mixed token', () => {
      expect(names('aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toContain('high-entropy')
    })
    it('honours the enabled-detector list', () => {
      expect(detectSpans('AKIA2E0PQIN4XA7QD', ['jwt'])).toEqual([])
    })
  })

  describe('mergeSpans', () => {
    it('merges an overlapping high-entropy run into the specific detector that named it', () => {
      expect(mergeSpans([
        { start: 7, end: 42, detector: 'high-entropy' },
        { start: 25, end: 42, detector: 'aws-access-key' },
      ])).toEqual([{ start: 7, end: 42, detector: 'aws-access-key' }])
    })
    it('keeps disjoint spans separate and in offset order', () => {
      expect(mergeSpans([
        { start: 20, end: 30, detector: 'jwt' },
        { start: 0, end: 10, detector: 'high-entropy' },
      ])).toEqual([
        { start: 0, end: 10, detector: 'high-entropy' },
        { start: 20, end: 30, detector: 'jwt' },
      ])
    })
  })
  ```

- [ ] **Step 11: Run it and watch it fail.**
  ```sh
  npx vitest run packages/privacy/src/detectors.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './detectors' imported from
  .../packages/privacy/src/detectors.test.ts`.

- [ ] **Step 12: Write `detectors.ts`.**
  The patterns are frozen in contract §5.7 — do not "improve" them. `mergeSpans` takes the **union**
  of overlapping spans rather than picking one: a high-entropy run that straddles a named token
  covers non-whitespace characters that may themselves be secret, so masking the union leaks nothing,
  while keeping the specific detector's name means the UI and the log still say *why*.

  `packages/privacy/src/detectors.ts`:
  ```ts
  import type { DetectorName, MaskSpan } from '@cairn/protocol'
  import { highEntropyRuns } from './entropy'

  export const ALL_DETECTORS: readonly DetectorName[] = [
    'pem-private-key', 'aws-access-key', 'github-token', 'openai-key', 'anthropic-key',
    'slack-token', 'stripe-live-key', 'google-api-key', 'jwt', 'high-entropy',
  ]

  const PATTERNS: readonly (readonly [DetectorName, RegExp])[] = [
    ['pem-private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
    ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{12,20}\b/g],
    ['github-token', /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
    ['openai-key', /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g],
    ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
    ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
    ['stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
    ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ]

  /** Every span a detector claims, merged so no two overlap. Offsets are into the RAW text. */
  export function detectSpans(text: string, enabled: readonly DetectorName[]): readonly MaskSpan[] {
    const spans: MaskSpan[] = []
    for (const [name, re] of PATTERNS) {
      if (!enabled.includes(name)) continue
      re.lastIndex = 0                                   // these RegExps are module-level and sticky
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        spans.push({ start: m.index, end: m.index + m[0].length, detector: name })
        if (m[0].length === 0) re.lastIndex += 1
      }
    }
    if (enabled.includes('high-entropy')) {
      for (const r of highEntropyRuns(text)) spans.push({ start: r.start, end: r.end, detector: 'high-entropy' })
    }
    return mergeSpans(spans)
  }

  /** Union of overlapping spans; a named detector always wins the label over 'high-entropy'. */
  export function mergeSpans(spans: readonly MaskSpan[]): readonly MaskSpan[] {
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
    const out: MaskSpan[] = []
    for (const s of sorted) {
      const last = out[out.length - 1]
      if (last !== undefined && s.start < last.end) {
        out[out.length - 1] = {
          start: last.start,
          end: Math.max(last.end, s.end),
          detector: last.detector !== 'high-entropy' ? last.detector : s.detector,
        }
      } else out.push(s)
    }
    return out
  }
  ```

- [ ] **Step 13: Run it and watch it pass.**
  ```sh
  npx vitest run packages/privacy/src/detectors.test.ts
  ```
  Expected: `Tests  13 passed (13)`.

- [ ] **Step 14: Commit the detectors.**
  ```sh
  git add packages/privacy/src/detectors.ts packages/privacy/src/detectors.test.ts
  git commit -m "feat(privacy): the ten secret detectors with union span merging"
  ```

- [ ] **Step 15: Create the two committed corpora.**
  `fixtures/secrets/false-positive-corpus.json` — **exactly** the 13 frozen cases from contract §5.7.
  The `big base64 png body` value is `'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH'`
  repeated 9 times, 639 characters, written out in full below.
  ```json
  {
    "git sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    "git log line": "commit 9f2b1c8a4d6e7f0a1b2c3d4e5f60718293a4b5c6 Author: Someone",
    "uuid v4": "550e8400-e29b-41d4-a716-446655440000",
    "uuid upper": "F47AC10B-58CC-4372-A567-0E02B2C3D479",
    "long url": "https://example.com/some/very/long/path/to/a/page?utm_source=newsletter&utm_medium=email",
    "data url png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "minified js": "function a(b,c){return b+c}var d=a(1,2);console.log(d);",
    "minified js 2": "!function(e,t){\"object\"==typeof exports?module.exports=t():e.x=t()}(this,function(){return 42});",
    "posix path": "/Users/someone/Library/Application Support/Cairn/history.ndjson",
    "sentence": "The quick brown fox jumps over the lazy dog and then keeps going for a while",
    "big base64 png body": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAHiVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH",
    "semver list": "electron@44.1.1 vite@7.3.6 vitest@4.1.11 typescript@5.9.3",
    "lorem hex table": "0123456789abcdef 0123456789abcdef 0123456789abcdef"
  }
  ```

  **Why one of these strings is split — do not "simplify" it.** GitHub push protection scans every
  push and **rejects the whole push** if a file contains something matching a partner secret pattern,
  and it does not care that the value is synthetic. A literal `sk_` + `live_` Stripe key in this corpus
  is enough to make `git push` fail with `GH013: Repository rule violations found` — measured, not
  hypothetical: it blocked this very plan until the literal was broken up. So the Stripe entry stores
  `textParts` and the loader joins them, and the two Stripe assertions below build the string from
  fragments. Any future corpus entry for a pattern GitHub partners on (Stripe, Slack app tokens, npm,
  Twilio, SendGrid, AWS with a full-length id) must do the same. The other entries are safe because they
  are structurally invalid — the AWS ids are 17 characters where a real one is 20, the `sk-`/`ghp_`
  values are the wrong length, and the PEM bodies are single truncated lines.

  `fixtures/secrets/detector-corpus.json` — every entry must trip, and every one of the ten detectors
  must appear at least once. All values are synthetic filler; none is a real credential. An entry
  carries either `text` or `textParts` (joined with no separator).
  ```json
  [
    { "key": "openssh private key", "detector": "pem-private-key", "text": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\n-----END OPENSSH PRIVATE KEY-----" },
    { "key": "rsa private key", "detector": "pem-private-key", "text": "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Kk9vQ2sJmT4lNpZ8yRbWc3dFgHjKlMnOpQrStUvWxYzA1B\n-----END RSA PRIVATE KEY-----" },
    { "key": "aws access key", "detector": "aws-access-key", "text": "AKIA2E0PQIN4XA7QD" },
    { "key": "aws session key", "detector": "aws-access-key", "text": "ASIA2E0PQIN4XA7QD" },
    { "key": "github classic pat", "detector": "github-token", "text": "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" },
    { "key": "github fine grained pat", "detector": "github-token", "text": "github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWX" },
    { "key": "openai key", "detector": "openai-key", "text": "sk-proj-Th1sIsNotARealKeyJustFiller99" },
    { "key": "anthropic key", "detector": "anthropic-key", "text": "sk-ant-api03-Th1sIsNotARealKeyJustFiller99" },
    { "key": "slack bot token", "detector": "slack-token", "text": "xoxb-123456789012-abcdefGHIJKL" },
    { "key": "stripe live key", "detector": "stripe-live-key", "textParts": ["sk_", "live_51H8xQwEXAMPLEKEY0123456789"] },
    { "key": "google api key", "detector": "google-api-key", "text": "AIzaSyB1234567890abcdefghijklmnopqrstuv" },
    { "key": "jwt", "detector": "jwt", "text": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk" },
    { "key": "base64url 43 secret", "detector": "high-entropy", "text": "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ" },
    { "key": "random 32-byte b64", "detector": "high-entropy", "text": "q7mHKp2vX9Lz4NsRt6Wc1YbEgJd0AfUiOo3xQlZn8kM=" },
    { "key": "hex-ish mixed case api key", "detector": "high-entropy", "text": "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY" },
    { "key": "db password blob", "detector": "high-entropy", "text": "Tr0ub4dor-and-3-ZzQq9WvXm2Lk8Np" }
  ]
  ```

- [ ] **Step 16: Write the corpus test.**
  There is no new implementation in this cycle — the corpora are the test. This is the file that stops
  a "small tweak" to a regex from quietly starting to mask every git SHA in your history, or quietly
  stopping masking an AWS key.

  `packages/privacy/src/corpus.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs'
  import { describe, expect, it } from 'vitest'
  import { fixturePath, type DetectorName } from '@cairn/protocol'
  import { ALL_DETECTORS, detectSpans } from './detectors'

  const read = (n: string): string => readFileSync(fixturePath('secrets', n), 'utf8')
  const FALSE_POSITIVES = JSON.parse(read('false-positive-corpus.json')) as Record<string, string>
  type CorpusEntry = { key: string; detector: DetectorName; text?: string; textParts?: string[] }
  // `textParts` exists so no literal partner-scanned secret pattern is committed — a literal one makes
  // GitHub push protection reject the push. Join here, once, so no test needs to care.
  const TRUE_POSITIVES = (JSON.parse(read('detector-corpus.json')) as CorpusEntry[]).map((e) => ({
    ...e,
    text: e.text ?? (e.textParts ?? []).join(''),
  }))

  describe('secret corpora', () => {
    it('has exactly the 13 frozen false-positive cases', () => {
      expect(Object.keys(FALSE_POSITIVES)).toHaveLength(13)
    })

    it.each(Object.entries(FALSE_POSITIVES))('does NOT trip on %s', (_key, text) => {
      expect(detectSpans(text, ALL_DETECTORS)).toEqual([])
    })

    it('covers every one of the ten detectors', () => {
      expect(new Set(TRUE_POSITIVES.map((e) => e.detector))).toEqual(new Set(ALL_DETECTORS))
    })

    it.each(TRUE_POSITIVES.map((e) => [e.key, e.detector, e.text] as const))(
      'trips %s with detector %s',
      (_key, detector, text) => {
        expect(detectSpans(text, ALL_DETECTORS).map((s) => s.detector)).toContain(detector)
      },
    )
  })
  ```

- [ ] **Step 17: Run it, then prove it can fail.**
  ```sh
  npx vitest run packages/privacy/src/corpus.test.ts
  ```
  Expected: `Tests  31 passed (31)`.
  Now break the control on purpose — in `entropy.ts` change `ENTROPY_BITS_PER_CHAR = 4.0` to `3.0`
  and re-run:
  ```sh
  npx vitest run packages/privacy/src/corpus.test.ts
  ```
  Expected: FAIL — `does NOT trip on git sha`, `does NOT trip on uuid v4` and others now report
  `expected [ { start: 0, … } ] to deeply equal []`. **Restore `4.0`** and confirm 31 pass again.

- [ ] **Step 18: Commit the corpora.**
  ```sh
  git add fixtures/secrets packages/privacy/src/corpus.test.ts
  git commit -m "test(privacy): committed detector and false-positive corpora"
  ```

- [ ] **Step 19: Write the failing mask test.**
  `AKIA••••A7QD` is the literal string in the M1 demo, so it is asserted literally. The last test is
  the one that matters most: no matter what a detector matched, the raw value must not survive into
  the preview, because the preview is what the in-memory search index holds forever.

  `packages/privacy/src/mask.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs'
  import { describe, expect, it } from 'vitest'
  import { fixturePath } from '@cairn/protocol'
  import { mask } from './mask'

  describe('mask', () => {
    it('produces the exact AKIA••••A7QD preview from the M1 demo, with exact span metadata', () => {
      expect(mask('AKIA2E0PQIN4XA7QD')).toEqual({
        preview: 'AKIA••••A7QD',
        spans: [{ start: 0, end: 17, detector: 'aws-access-key' }],
      })
    })
    it('never leaves the raw secret inside the masked preview', () => {
      const raw = 'AKIA2E0PQIN4XA7QD'
      expect(mask(`export AWS_ACCESS_KEY_ID=${raw}`).preview).not.toContain(raw)
      const gh = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
      expect(mask(`token: ${gh}`).preview).not.toContain(gh)
    })
    it('leaves clean text and its offsets completely alone', () => {
      expect(mask('the quick brown fox')).toEqual({ preview: 'the quick brown fox', spans: [] })
    })
    it('masks every secret in a multi-secret paste, with offsets into the RAW text', () => {
      const raw = 'aws AKIA2E0PQIN4XA7QD stripe ' + 'sk_' + 'live_51H8xQwEXAMPLEKEY0123456789'
      const { preview, spans } = mask(raw)
      expect(spans).toEqual([
        { start: 4, end: 21, detector: 'aws-access-key' },
        { start: 29, end: 64, detector: 'stripe-live-key' },
      ])
      expect(raw.slice(4, 21)).toBe('AKIA2E0PQIN4XA7QD')
      expect(raw.slice(29, 64)).toBe('sk_' + 'live_51H8xQwEXAMPLEKEY0123456789')
      expect(preview).toBe('aws AKIA••••A7QD stripe sk_l••••6789')
    })
    it('swallows an overlapping high-entropy run into the specific detector, masking the union', () => {
      const { preview, spans } = mask('AWS_ACCESS_KEY_ID=AKIA2E0PQIN4XA7QD')
      expect(spans).toEqual([{ start: 0, end: 35, detector: 'aws-access-key' }])
      expect(preview).toBe('AWS_••••A7QD')
    })
    it('never produces an all-bullet preview, because no detector can match under 12 chars', () => {
      const corpus = (JSON.parse(readFileSync(fixturePath('secrets', 'detector-corpus.json'), 'utf8')) as
        { text?: string; textParts?: string[] }[]).map((e) => ({ text: e.text ?? (e.textParts ?? []).join('') }))
      for (const { text } of corpus) {
        for (const s of mask(text).spans) expect(s.end - s.start).toBeGreaterThanOrEqual(12)
      }
    })
  })
  ```

- [ ] **Step 20: Run it and watch it fail.**
  ```sh
  npx vitest run packages/privacy/src/mask.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './mask' imported from
  .../packages/privacy/src/mask.test.ts`.

- [ ] **Step 21: Write `mask.ts`.**
  `maskToken` already lives in `@cairn/protocol` (contract §5.7) — do not reimplement it here.

  `packages/privacy/src/mask.ts`:
  ```ts
  import { maskToken, type MaskSpan } from '@cairn/protocol'
  import { ALL_DETECTORS, detectSpans } from './detectors'

  /**
   * Replaces every detected span with `maskToken` of the same text. `spans` are offsets into the RAW
   * input, so a caller can highlight what was masked without ever holding the raw value again.
   */
  export function mask(text: string): { readonly preview: string; readonly spans: readonly MaskSpan[] } {
    const spans = detectSpans(text, ALL_DETECTORS)
    let preview = ''
    let cursor = 0
    for (const s of spans) {
      preview += text.slice(cursor, s.start) + maskToken(text.slice(s.start, s.end))
      cursor = s.end
    }
    preview += text.slice(cursor)
    return { preview, spans }
  }
  ```

- [ ] **Step 22: Run it and watch it pass.**
  ```sh
  npx vitest run packages/privacy/src/mask.test.ts
  ```
  Expected: `Tests  6 passed (6)`.

- [ ] **Step 23: Commit the mask.**
  ```sh
  git add packages/privacy/src/mask.ts packages/privacy/src/mask.test.ts
  git commit -m "feat(privacy): mask() with AKIA••••A7QD previews and raw-text span offsets"
  ```

- [ ] **Step 24: Write the failing classify + retention-policy tests.**
  `classify` is the three-layer gate. Layer order is fixed and short-circuits: **hints, then the
  exclusion list, then the detectors.** The hint layer must be decidable without inspecting a single
  byte, which is why `shouldSkipOnHints` exists as a separate export — `@cairn/capture` calls it
  *before* it converts a TIFF or builds a thumbnail. The exclusion list is empty in M1 but its
  fail-closed behaviour is tested now, because M2 turns it on and a fail-open default would be a
  silent privacy hole.

  `packages/privacy/src/classify.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { contentHash, type PasteboardHint, type Snapshot, type SourceApp } from '@cairn/protocol'
  import { DEFAULT_RULES, SKIP_HINTS, classify, shouldSkipOnHints } from './classify'

  const snap = (text: string | null, hints: readonly PasteboardHint[] = [], sourceApp: SourceApp | null = null): Snapshot => {
    const bytes = Buffer.from(text ?? '', 'utf8')
    return {
      reps: [{ mime: 'text/plain', uti: 'public.utf8-plain-text', bytes, byteLength: bytes.length, sha256: contentHash(bytes) }],
      primaryText: text, kind: 'text', hints, sourceApp, totalBytes: bytes.length,
    }
  }

  describe('classify layer 1 — OS hints, before any byte is read', () => {
    it('skips a concealed pasteboard and flags it concealed', () => {
      expect(classify(snap('hunter2', ['concealed']), DEFAULT_RULES)).toEqual({
        action: 'skip', flags: ['concealed'], reason: 'os-hint',
      })
    })
    it('skips the KDE password-manager hint too', () => {
      expect(classify(snap('hunter2', ['password-manager']), DEFAULT_RULES).action).toBe('skip')
    })
    it('records but flags transient and auto-generated rather than skipping', () => {
      const c = classify(snap('hello world', ['transient', 'auto-generated']), DEFAULT_RULES)
      expect(c.action).toBe('record')
      expect(c.flags).toEqual(['transient', 'auto-generated'])
    })
    it('exposes the same decision as a cheap predicate capture can call before touching bytes', () => {
      expect(shouldSkipOnHints(['concealed'], DEFAULT_RULES)).toBe(true)
      expect(shouldSkipOnHints(['transient'], DEFAULT_RULES)).toBe(false)
      expect(shouldSkipOnHints(['concealed'], { ...DEFAULT_RULES, honourHints: false })).toBe(false)
      expect(SKIP_HINTS).toEqual(['concealed', 'password-manager'])
    })
    it('wins over the detector layer: a concealed AWS key is skipped, not masked', () => {
      expect(classify(snap('AKIA2E0PQIN4XA7QD', ['concealed']), DEFAULT_RULES).flags).toEqual(['concealed'])
    })
  })

  describe('classify layer 2 — exclusion list, failing closed', () => {
    it('is inert in M1 because excludedBundleIds is empty', () => {
      expect(DEFAULT_RULES.excludedBundleIds).toEqual([])
      expect(classify(snap('hello world', [], null), DEFAULT_RULES).action).toBe('record')
    })
    it('skips when a rule is active and the owner is unknowable', () => {
      const rules = { ...DEFAULT_RULES, excludedBundleIds: ['com.agilebits.onepassword7'] }
      expect(classify(snap('hello world', [], null), rules)).toEqual({
        action: 'skip', flags: ['excluded'], reason: 'owner-unknown-fail-closed',
      })
    })
    it('skips a matching bundle id and records a non-matching one', () => {
      const rules = { ...DEFAULT_RULES, excludedBundleIds: ['com.agilebits.onepassword7'] }
      const app = (bundleId: string): SourceApp => ({ bundleId, name: null, confidence: 'heuristic' })
      expect(classify(snap('hello world', [], app('com.agilebits.onepassword7')), rules).action).toBe('skip')
      expect(classify(snap('hello world', [], app('com.apple.TextEdit')), rules).action).toBe('record')
    })
  })

  describe('classify layer 3 — detectors', () => {
    it('records a secret rather than dropping it, and names the detectors in the reason', () => {
      const c = classify(snap('AKIA2E0PQIN4XA7QD'), DEFAULT_RULES)
      expect(c.action).toBe('record')
      expect(c.flags).toEqual(['secret'])
      expect(c.reason).toBe('detectors:aws-access-key')
    })
    it('records clean text with no flags at all', () => {
      expect(classify(snap('the quick brown fox'), DEFAULT_RULES)).toEqual({ action: 'record', flags: [], reason: 'clean' })
    })
    it('records an image with no primaryText without inspecting text', () => {
      expect(classify(snap(null), DEFAULT_RULES).flags).toEqual([])
    })
  })
  ```

  `packages/privacy/src/retention-policy.test.ts` — the 5-minute TTL and the pin exemption live in
  `@cairn/privacy` so there is exactly one place that knows the policy; Task 8's `retention.ts` calls
  these rather than re-deriving them.
  ```ts
  import { describe, expect, it } from 'vitest'
  import { SECRET_TTL_MS, createTestClock } from '@cairn/protocol'
  import { isPinnable, secretExpiresAt } from './retention-policy'

  describe('secret retention policy', () => {
    it('gives a secret exactly a 5-minute TTL from createdAt', () => {
      expect(SECRET_TTL_MS).toBe(300_000)
      const clock = createTestClock()
      const t = clock.now()
      expect(secretExpiresAt(t, ['secret'])).toBe(t + 300_000)
    })
    it('gives everything else no TTL at all', () => {
      const clock = createTestClock()
      for (const flags of [[], ['transient'], ['auto-generated'], ['concealed'], ['cut']] as const) {
        expect(secretExpiresAt(clock.now(), [...flags])).toBeNull()
      }
    })
    it('refuses to pin a secret and allows pinning everything else', () => {
      expect(isPinnable(['secret'])).toBe(false)
      expect(isPinnable(['secret', 'transient'])).toBe(false)
      expect(isPinnable([])).toBe(true)
      expect(isPinnable(['transient', 'auto-generated', 'cut', 'no-sync'])).toBe(true)
    })
  })
  ```

- [ ] **Step 25: Run both and watch them fail.**
  ```sh
  npx vitest run packages/privacy/src/classify.test.ts packages/privacy/src/retention-policy.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './classify' imported from …` and
  `Error: Cannot find module './retention-policy' imported from …`.

- [ ] **Step 26: Write `classify.ts` and `retention-policy.ts`.**

  `PrivacyRules` and `Classification` are **imported, never declared here.** Both are frozen in
  `packages/protocol/src/types.ts` by Task 2, and contract §5 says no task may redeclare a frozen
  shape locally. Task 8's `packages/history/src/history.ts` already imports both from
  `@cairn/protocol` while taking `DEFAULT_RULES`/`classify` from `@cairn/privacy`; if this file
  declared its own copies the repo would carry two structurally-identical names for one shape and
  every future change to `detectors` or `reason` would have to be made twice.

  `packages/privacy/src/classify.ts`:
  ```ts
  import type { Classification, Flag, PasteboardHint, PrivacyRules, Snapshot } from '@cairn/protocol'
  import { ALL_DETECTORS, detectSpans } from './detectors'

  export const DEFAULT_RULES: PrivacyRules = {
    detectors: ALL_DETECTORS,
    honourHints: true,
    excludedBundleIds: [],          // always [] in M1; M2 fills this from the exclusion UI
  }

  /**
   * Hints that mean "do not record at all". `concealed` is the macOS
   * `org.nspasteboard.ConcealedType` convention every password manager sets; `password-manager` is
   * KDE's `x-kde-passwordManagerHint: secret` (spec §4, Tier C). Both are honoured, both fail closed.
   */
  export const SKIP_HINTS: readonly PasteboardHint[] = ['concealed', 'password-manager']

  /** Layer 1 on its own, so a caller can decide before reading, converting or thumbnailing a byte. */
  export function shouldSkipOnHints(hints: readonly PasteboardHint[], rules: PrivacyRules): boolean {
    if (!rules.honourHints) return false
    return hints.some((h) => SKIP_HINTS.includes(h))
  }

  export function classify(snapshot: Snapshot, rules: PrivacyRules): Classification {
    // Layer 1: OS hints. Short-circuits before anything looks at bytes.
    if (shouldSkipOnHints(snapshot.hints, rules)) {
      return { action: 'skip', flags: ['concealed'], reason: 'os-hint' }
    }
    const flags: Flag[] = []
    for (const h of snapshot.hints) {
      if (h === 'transient') flags.push('transient')
      if (h === 'auto-generated') flags.push('auto-generated')
    }
    // Layer 2: app exclusion list. Inert in M1, and fails CLOSED when a rule is active and the
    // owner is unknowable — source-app attribution is a heuristic on every OS (spec §10).
    if (rules.excludedBundleIds.length > 0) {
      const bundleId = snapshot.sourceApp?.bundleId ?? null
      if (bundleId === null) return { action: 'skip', flags: ['excluded'], reason: 'owner-unknown-fail-closed' }
      if (rules.excludedBundleIds.includes(bundleId)) {
        return { action: 'skip', flags: ['excluded'], reason: 'excluded-app' }
      }
    }
    // Layer 3: detectors. A secret is RECORDED and flagged, not dropped: a masked, TTL'd,
    // unpinnable, unsyncable row is more useful than a hole in the history (contract §5.7).
    const text = snapshot.primaryText
    if (text !== null && text !== '') {
      const spans = detectSpans(text, rules.detectors)
      if (spans.length > 0) {
        const names = [...new Set(spans.map((s) => s.detector))].join(',')
        return { action: 'record', flags: [...flags, 'secret'], reason: `detectors:${names}` }
      }
    }
    return { action: 'record', flags, reason: 'clean' }
  }
  ```

  `packages/privacy/src/retention-policy.ts`:
  ```ts
  import { SECRET_TTL_MS, type Flag } from '@cairn/protocol'

  /** The one place the secret TTL is applied. `null` means "no TTL — normal retention rules". */
  export function secretExpiresAt(createdAt: number, flags: readonly Flag[]): number | null {
    return flags.includes('secret') ? createdAt + SECRET_TTL_MS : null
  }

  /** Secrets are exempt from pinning, because a pin would defeat the 5-minute TTL. */
  export function isPinnable(flags: readonly Flag[]): boolean {
    return !flags.includes('secret')
  }
  ```

- [ ] **Step 27: Run both and watch them pass.**
  ```sh
  npx vitest run packages/privacy/src/classify.test.ts packages/privacy/src/retention-policy.test.ts
  ```
  Expected: `Tests  14 passed (14)` (11 classify + 3 retention-policy).

- [ ] **Step 28: Commit the policy layer.**
  ```sh
  git add packages/privacy/src/classify.ts packages/privacy/src/classify.test.ts \
          packages/privacy/src/retention-policy.ts packages/privacy/src/retention-policy.test.ts
  git commit -m "feat(privacy): three-layer classify, fail-closed exclusions and the 5-minute secret TTL"
  ```

- [ ] **Step 29: Write the failing `assertSyncable` security test.**
  This one lives in the `security` vitest project (`*.security.test.ts`). It throws rather than
  filtering because a silent filter is how *"why didn't my item sync?"* becomes unanswerable — and
  the thrown message must carry the id and the flags and **nothing else**, since an exception message
  ends up in logs.

  `packages/privacy/src/assert-syncable.security.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { NON_SYNCABLE_FLAGS, TEST_CANARY, type Flag, type Item, type ItemId, type ContentHash } from '@cairn/protocol'
  import { assertSyncable } from './assert-syncable'

  const ID = '01JQ8V7Z9X0000000000000000' as ItemId
  const HASH = 'sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek' as ContentHash

  const itemWith = (flags: readonly Flag[]): Item => ({
    id: ID,
    kind: 'text',
    contentHash: HASH,
    preview: 'hello world',
    previewTruncated: false,
    maskSpans: [],
    flags,
    repRefs: [],
    thumbnailBlobId: null,
    sourceApp: null,
    byteLength: 11,
    createdAt: 1_767_225_600_000,
    updatedAt: 1_767_225_600_000,
    pinned: false,
    expiresAt: null,
  })

  describe('assertSyncable throws for every flag in the secret set', () => {
    it('covers exactly four flags', () => {
      expect([...NON_SYNCABLE_FLAGS]).toEqual(['secret', 'concealed', 'excluded', 'no-sync'])
    })
    it.each([...NON_SYNCABLE_FLAGS])('throws for flag %s', (flag) => {
      expect(() => { assertSyncable(itemWith([flag])) }).toThrow(/refusing to sync/)
    })
    it('throws for a combination and names every offending flag', () => {
      expect(() => { assertSyncable(itemWith(['secret', 'transient', 'no-sync'])) })
        .toThrow(`cairn: refusing to sync item ${ID}: flags secret,no-sync`)
    })
    it('returns undefined for a clean item and for syncable-but-flagged ones', () => {
      expect(assertSyncable(itemWith([]))).toBeUndefined()
      expect(assertSyncable(itemWith(['transient', 'auto-generated', 'cut']))).toBeUndefined()
    })
    it('never puts content in the message — only the id and the flags', () => {
      let message = ''
      try { assertSyncable(itemWith(['secret'])) } catch (e) { message = (e as Error).message }
      expect(message).not.toContain(TEST_CANARY)
      expect(message).not.toContain('AKIA')
      expect(message).toBe(`cairn: refusing to sync item ${ID}: flags secret`)
    })
  })
  ```

- [ ] **Step 30: Run it and watch it fail.**
  ```sh
  npx vitest run --project security packages/privacy/src/assert-syncable.security.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './assert-syncable' imported from …`.

- [ ] **Step 31: Write `assert-syncable.ts`.**
  Copy contract §6 verbatim.

  `packages/privacy/src/assert-syncable.ts`:
  ```ts
  import { NON_SYNCABLE_FLAGS, type Flag, type Item } from '@cairn/protocol'

  /** THROWS on purpose. A silent filter is how "why didn't my item sync?" becomes unanswerable. */
  export function assertSyncable(item: Item): void {
    const offending = item.flags.filter((f) => (NON_SYNCABLE_FLAGS as readonly Flag[]).includes(f))
    if (offending.length > 0) {
      throw new Error(`cairn: refusing to sync item ${item.id}: flags ${offending.join(',')}`)
    }
  }
  ```

- [ ] **Step 32: Run it, then prove it can fail.**
  ```sh
  npx vitest run --project security packages/privacy/src/assert-syncable.security.test.ts
  ```
  Expected: `Tests  8 passed (8)`.
  Now remove the control: comment out the `throw` line and re-run.
  Expected: FAIL on all four `throws for flag …` cases with
  `AssertionError: expected [Function] to throw error matching /refusing to sync/ but it didn't`.
  **Restore the `throw`** and confirm 8 pass again.

- [ ] **Step 33: Write the `@cairn/privacy` barrel and run the whole package.**
  `packages/privacy/src/index.ts`:
  ```ts
  export { ENTROPY_BITS_PER_CHAR, ENTROPY_MAX_RUN, ENTROPY_MIN_RUN, highEntropyRuns, shannonBits } from './entropy'
  export { ALL_DETECTORS, detectSpans, mergeSpans } from './detectors'
  export { mask } from './mask'
  // No `type Classification` / `type PrivacyRules` here: both live in `@cairn/protocol` (contract
  // §5.7). Re-exporting them from this barrel would give consumers two import paths for one shape.
  export { DEFAULT_RULES, SKIP_HINTS, classify, shouldSkipOnHints } from './classify'
  export { isPinnable, secretExpiresAt } from './retention-policy'
  export { assertSyncable } from './assert-syncable'
  ```
  Confirm the barrel exports no type that `@cairn/protocol` already owns:
  ```sh
  grep -nE 'type (Classification|PrivacyRules)' packages/privacy/src/index.ts packages/privacy/src/classify.ts || echo 'no local redeclaration'
  ```
  Expected: `no local redeclaration`.
  ```sh
  npm run test -w @cairn/privacy && npm run test:security -w @cairn/privacy
  ```
  Expected: `Tests  75 passed (75)` for the unit project and `Tests  8 passed (8)` for security.

- [ ] **Step 34: Commit `@cairn/privacy` complete.**
  ```sh
  git add packages/privacy/src/assert-syncable.ts packages/privacy/src/assert-syncable.security.test.ts packages/privacy/src/index.ts
  git commit -m "feat(privacy): assertSyncable throws for every non-syncable flag, plus the public barrel"
  ```

- [ ] **Step 35: Generate and commit the byte fixtures.**
  The TIFF and PNG are binary, so they are generated once by a throwaway script and then committed.
  The script is **not** committed — the fixtures are.
  ```sh
  cat > /tmp/cairn-gen-fixtures.mjs <<'EOF'
  import sharp from 'sharp'
  import { writeFileSync } from 'node:fs'
  const W = 64, H = 40
  const raw = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    raw[i] = (x * 4) & 0xff; raw[i + 1] = (y * 6) & 0xff; raw[i + 2] = ((x + y) * 3) & 0xff
  }
  const src = { raw: { width: W, height: H, channels: 3 } }
  writeFileSync('fixtures/formats/screenshot.tiff', await sharp(raw, src).tiff({ compression: 'deflate' }).toBuffer())
  writeFileSync('fixtures/formats/screenshot.png', await sharp(raw, src).png({ compressionLevel: 9 }).toBuffer())
  writeFileSync('fixtures/formats/plain-utf8.txt', Buffer.from('Hello \u{1F30D}\r\nsecond line\n', 'utf8'))
  writeFileSync('fixtures/formats/uri-list-two-files.txt', Buffer.from('file:///Users/dev/Documents/report.pdf\nfile:///Users/dev/Documents/notes.txt\n', 'utf8'))
  writeFileSync('fixtures/formats/cf-html-wrapper.txt', Buffer.from(
    'Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000202\r\nStartFragment:0000000138\r\nEndFragment:0000000168\r\n' +
    '<html><body>\n<!--StartFragment--><p>Hello <b>bold</b> world</p><!--EndFragment-->\n</body></html>\n', 'utf8'))
  writeFileSync('fixtures/formats/rtf-minimal.rtf', Buffer.from(
    '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2822\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n\\f0\\fs24 Hello \\b bold\\b0  world}\n', 'utf8'))
  EOF
  mkdir -p fixtures/formats && node /tmp/cairn-gen-fixtures.mjs && rm /tmp/cairn-gen-fixtures.mjs
  node -e "const f=require('fs'),c=require('crypto');for(const n of f.readdirSync('fixtures/formats').sort()){const b=f.readFileSync('fixtures/formats/'+n);console.log(n.padEnd(24),String(b.length).padStart(5),'sha256-'+c.createHash('sha256').update(b).digest('base64url'))}"
  ```
  Expected, exactly (measured on sharp 0.35.4 / vips 8.18.6):
  ```
  cf-html-wrapper.txt        202 sha256-P70vLOlHaN7ztpKOTDCP5JEoVxbbZjVK_0w4KFvcDh4
  plain-utf8.txt              24 sha256-AjsoYxR-gn2Rhw0DnoTeK67PqIqXNDqqNFxXRBuPlXc
  rtf-minimal.rtf            113 sha256-UF_3kMTlbav7sWPEPb6GMPcOBfvwMZudfkoXzxtril8
  screenshot.png            6739 sha256-wm0aDulrSIjS9y_7Uy-F6KvfdOrn5VhLg5KaHEnPII8
  screenshot.tiff            444 sha256-kORIXEm9saIDoBIEe7S1pQPy-TZpM-bcXTzkxpJ8pwk
  uri-list-two-files.txt      77 sha256-5II58ebcX0p61WxP5aNTJzbQmqc1TxBuNxWkjI79QdA
  ```
  The two image hashes depend on libvips' encoder version, so the tests below compare **pixels**, not
  bytes — a future sharp bump must not turn into a red test. The four text hashes are stable forever.
  ```sh
  git add fixtures/formats && git commit -m "test(capture): per-format byte fixtures for normalizeReps"
  ```

- [ ] **Step 36: Write the capture test helpers.**
  These are ordinary source, re-exported from the package barrel, rather than `*.test.ts` files: a
  `.test.ts` file is not importable through the package's single `"."` export, and contract §2 bans
  deep paths, so a helper that lives in a test file can never be reused outside this package.

  `packages/capture/src/testing.ts`:
  ```ts
  import {
    contentHash,
    type ClipboardChangedPayload, type LogEvent, type Logger,
    type PasteboardHint, type ResolvedRep,
  } from '@cairn/protocol'

  /** A ResolvedRep from a string or a Buffer, with byteLength and sha256 computed for you. */
  export function rep(mime: string, uti: string | null, body: string | Uint8Array): ResolvedRep {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
    return { mime, uti, bytes, byteLength: bytes.length, sha256: contentHash(bytes) }
  }

  /** A post-reassembly clipboard.changed payload. `changeToken` is String(changeCount) on macOS. */
  export function changed(
    changeCount: number,
    reps: readonly ResolvedRep[],
    hints: readonly PasteboardHint[] = [],
  ): ClipboardChangedPayload {
    return {
      changeCount,
      changeToken: String(changeCount),
      hints,
      reps,
      sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
      droppedReps: [],
    }
  }

  /** Records only the LogEvent ids, which is all a metadata-only logger is allowed to carry. */
  export function createSpyLogger(): { logger: Logger; events: LogEvent[] } {
    const events: LogEvent[] = []
    const push = (e: LogEvent): void => { events.push(e) }
    const logger: Logger = {
      log: (_level, e) => push(e),
      debug: (e) => push(e),
      info: (e) => push(e),
      warn: (e) => push(e),
      error: (e) => push(e),
    }
    return { logger, events }
  }
  ```

  `packages/capture/src/stub-agent.ts` — a hand-driven `ClipboardAgent`. Transcripts (Step 55) drive
  the integration path; this drives the unit path, where a test needs to emit an event at an exact
  clock offset that no transcript file can express.
  ```ts
  import {
    ok,
    type AgentEventMap, type AgentMethod, type ClipboardAgent,
    type ClipboardChangedPayload, type Result,
  } from '@cairn/protocol'

  export interface StubAgent extends ClipboardAgent {
    emitChanged(p: ClipboardChangedPayload): void
    readonly requests: readonly { method: AgentMethod; params: Record<string, unknown> }[]
    /** What the next `write` request will report back as its changeToken. */
    nextChangeToken: string
  }

  export function createStubAgent(): StubAgent {
    const cbs = new Set<(p: ClipboardChangedPayload) => void>()
    const requests: { method: AgentMethod; params: Record<string, unknown> }[] = []
    const self = {
      requests,
      nextChangeToken: '999',
      async start() { return {} },
      async request(method: AgentMethod, params: Record<string, unknown>): Promise<Result<Record<string, unknown>>> {
        requests.push({ method, params })
        if (method === 'write') return ok({ changeToken: self.nextChangeToken })
        if (method === 'watch.start') return ok({ watching: true, intervalMs: 500 })
        return ok({})
      },
      on(event: keyof AgentEventMap, cb: (p: never) => void) {
        if (event !== 'clipboard.changed') return () => {}
        const fn = cb as unknown as (p: ClipboardChangedPayload) => void
        cbs.add(fn)
        return () => { cbs.delete(fn) }
      },
      async dispose() { cbs.clear() },
      emitChanged(p: ClipboardChangedPayload) { for (const cb of [...cbs]) cb(p) },
    } as unknown as StubAgent
    return self
  }
  ```

- [ ] **Step 37: Write the failing `classifyKind` test.**
  The fixture set the task names, one case each. The precedence is `files → image → richtext → text`
  and it is **not** the same list as `PRIMARY_REP_ORDER`: a Finder copy always also carries
  `text/plain`, and a web copy usually carries all three, so deriving the kind from the
  hash-selection order would make `files` and `image` unreachable and break the M1 demo.

  `packages/capture/src/classify-kind.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import { MIME_SOURCE_URL } from '@cairn/protocol'
  import { PRIMARY_REP_ORDER, classifyKind, selectPrimaryRep } from './classify-kind'
  import { rep } from './testing'

  describe('classifyKind', () => {
    it('text: a bare text/plain copy', () => {
      expect(classifyKind([rep('text/plain', 'public.utf8-plain-text', 'hello world')])).toBe('text')
    })
    it('richtext: html WITH a text fallback still reads as richtext', () => {
      expect(classifyKind([
        rep('text/html', 'public.html', '<p>hi</p>'),
        rep('text/plain', 'public.utf8-plain-text', 'hi'),
      ])).toBe('richtext')
    })
    it('richtext: rtf with a text fallback', () => {
      expect(classifyKind([
        rep('text/rtf', 'public.rtf', '{\\rtf1}'),
        rep('text/plain', 'public.utf8-plain-text', 'hi'),
      ])).toBe('richtext')
    })
    it('image: png', () => {
      expect(classifyKind([rep('image/png', 'public.png', 'x')])).toBe('image')
    })
    it('image: jpeg', () => {
      expect(classifyKind([rep('image/jpeg', 'public.jpeg', 'x')])).toBe('image')
    })
    it('files: a Finder copy, even though it also carries the paths as text/plain', () => {
      expect(classifyKind([
        rep('text/uri-list', 'public.file-url', 'file:///a\n'),
        rep('text/plain', 'public.utf8-plain-text', '/a\n'),
      ])).toBe('files')
    })
    it('mixed: a web copy carrying text + html + an image reads as image', () => {
      expect(classifyKind([
        rep('text/plain', 'public.utf8-plain-text', 'hi'),
        rep('text/html', 'public.html', '<p>hi</p>'),
        rep('image/png', 'public.png', 'x'),
      ])).toBe('image')
    })
    it('a text/x-source-url rider is text, never files', () => {
      // Chrome's org.chromium.source-url rider carries a URL. normalizeReps drops it long before
      // this runs, but if it ever survives it must not turn a copied paragraph into a file row.
      expect(classifyKind([rep(MIME_SOURCE_URL, 'org.chromium.source-url', 'https://example.com/a')])).toBe('text')
      expect(classifyKind([
        rep('text/plain', 'public.utf8-plain-text', 'hello world'),
        rep(MIME_SOURCE_URL, 'org.chromium.source-url', 'https://example.com/a'),
      ])).toBe('text')
    })
    it('unknown mimes fall back to text rather than throwing', () => {
      expect(classifyKind([rep('application/octet-stream', null, 'x')])).toBe('text')
      expect(classifyKind([])).toBe('text')
    })
  })

  describe('selectPrimaryRep', () => {
    it('follows the frozen order', () => {
      expect(PRIMARY_REP_ORDER).toEqual(['text/plain', 'text/uri-list', 'image/png', 'text/html', 'text/rtf'])
    })
    it('prefers text/plain over everything, so two machines hash the same copy identically', () => {
      expect(selectPrimaryRep([
        rep('image/png', 'public.png', 'x'),
        rep('text/plain', 'public.utf8-plain-text', 'hello world'),
      ])?.mime).toBe('text/plain')
    })
    it('falls through to the first remaining rep for an unlisted mime', () => {
      expect(selectPrimaryRep([rep('application/pdf', 'com.adobe.pdf', 'x')])?.mime).toBe('application/pdf')
    })
    it('returns null for an empty rep set', () => {
      expect(selectPrimaryRep([])).toBeNull()
    })
  })
  ```

- [ ] **Step 38: Run it and watch it fail.**
  ```sh
  npx vitest run packages/capture/src/classify-kind.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './classify-kind' imported from …`.

- [ ] **Step 39: Write `classify-kind.ts`.**
  `packages/capture/src/classify-kind.ts`:
  ```ts
  import type { ItemKind, ResolvedRep } from '@cairn/protocol'

  /**
   * Kind precedence, most specific first. Deliberately NOT the same list as PRIMARY_REP_ORDER: a
   * Finder copy also offers text/plain, so a primary-rep-derived kind would never say 'files'.
   */
  export function classifyKind(reps: readonly ResolvedRep[]): ItemKind {
    if (reps.some((r) => r.mime === 'text/uri-list')) return 'files'
    if (reps.some((r) => r.mime.startsWith('image/'))) return 'image'
    if (reps.some((r) => r.mime === 'text/html' || r.mime === 'text/rtf')) return 'richtext'
    return 'text'
  }

  /** Frozen by contract §5.5: which representation's bytes are hashed into `Candidate.contentHash`. */
  export const PRIMARY_REP_ORDER: readonly string[] = [
    'text/plain', 'text/uri-list', 'image/png', 'text/html', 'text/rtf',
  ]

  export function selectPrimaryRep(reps: readonly ResolvedRep[]): ResolvedRep | null {
    if (reps.length === 0) return null
    for (const mime of PRIMARY_REP_ORDER) {
      const hit = reps.find((r) => r.mime === mime)
      if (hit !== undefined) return hit
    }
    return reps[0] ?? null
  }
  ```

- [ ] **Step 40: Run it and watch it pass, then commit.**
  ```sh
  npx vitest run packages/capture/src/classify-kind.test.ts
  ```
  Expected: `Tests  13 passed (13)` (9 `classifyKind` cases + 4 `selectPrimaryRep`).
  ```sh
  git add packages/capture/src/classify-kind.ts packages/capture/src/classify-kind.test.ts \
          packages/capture/src/testing.ts packages/capture/src/stub-agent.ts
  git commit -m "feat(capture): classifyKind, the frozen primary-rep order and the test harness"
  ```

- [ ] **Step 41: Write the failing `thumbnail` test.**
  Measured on this machine before writing the assertion: a 256×256 image of **pure random noise**
  encodes to **34 791 bytes** of JPEG at q70 — 42 % over the 24 KiB ceiling. A single-quality
  implementation therefore cannot honour `THUMBNAIL_MAX_BYTES`, so `thumbnail` walks a quality ladder
  and the test proves both halves: that the naive q70 encode really does overflow, and that
  `thumbnail` really does not.

  `packages/capture/src/thumbnail.test.ts`:
  ```ts
  import { randomBytes } from 'node:crypto'
  import { readFileSync } from 'node:fs'
  import { describe, expect, it } from 'vitest'
  import sharp from 'sharp'
  import { THUMBNAIL_MAX_BYTES, THUMBNAIL_MAX_EDGE_PX, fixturePath } from '@cairn/protocol'
  import { thumbnail } from './thumbnail'

  describe('thumbnail', () => {
    it('emits JPEG with the longest edge at 256 px', async () => {
      const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 90, b: 160 } } }).png().toBuffer()
      const meta = await sharp(Buffer.from(await thumbnail(png))).metadata()
      expect(meta.format).toBe('jpeg')
      expect(meta.width).toBe(THUMBNAIL_MAX_EDGE_PX)
      expect(meta.height).toBe(171)
    })

    it('never enlarges a small image', async () => {
      const png = readFileSync(fixturePath('formats', 'screenshot.png'))
      const meta = await sharp(Buffer.from(await thumbnail(png))).metadata()
      expect([meta.width, meta.height]).toEqual([64, 40])
    })

    it('stays under 24 KiB for the pathological case: 256x256 of pure noise', async () => {
      const noise = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer()
      const q70 = await sharp(noise).resize({ width: 256, height: 256, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()
      expect(q70.length).toBeGreaterThan(THUMBNAIL_MAX_BYTES)      // ~34.8 KiB: the naive encode overflows
      const out = await thumbnail(noise)
      expect(out.length).toBeLessThanOrEqual(THUMBNAIL_MAX_BYTES)
    })

    it('rejects bytes that are not an image, rather than writing anything', async () => {
      await expect(thumbnail(Buffer.from('not an image at all', 'utf8')))
        .rejects.toThrow('Input buffer contains unsupported image format')
    })
  })
  ```

- [ ] **Step 42: Run it and watch it fail.**
  ```sh
  npx vitest run packages/capture/src/thumbnail.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './thumbnail' imported from …`.

- [ ] **Step 43: Write `thumbnail.ts`.**
  Measured rungs for the 256×256-noise worst case: q70 → 34 791 B, q50 → 25 404 B, q35 → 19 615 B
  (first pass), q20 → 11 753 B, and 128 px @ q50 → 3 555 B. `sharp` reads a Buffer and returns a
  Buffer with **zero** filesystem access — verified by snapshotting `TMPDIR` around a TIFF→PNG plus a
  thumbnail and seeing no new entries.

  `packages/capture/src/thumbnail.ts`:
  ```ts
  import sharp from 'sharp'
  import { THUMBNAIL_JPEG_QUALITY, THUMBNAIL_MAX_BYTES, THUMBNAIL_MAX_EDGE_PX } from '@cairn/protocol'

  /** [longest edge px, JPEG quality]. Walked in order until the output fits THUMBNAIL_MAX_BYTES. */
  const LADDER: readonly (readonly [number, number])[] = [
    [THUMBNAIL_MAX_EDGE_PX, THUMBNAIL_JPEG_QUALITY],
    [THUMBNAIL_MAX_EDGE_PX, 50],
    [THUMBNAIL_MAX_EDGE_PX, 35],
    [THUMBNAIL_MAX_EDGE_PX, 20],
    [THUMBNAIL_MAX_EDGE_PX / 2, 50],
  ]

  /**
   * A list-row thumbnail, generated ONCE at capture so no phone ever pulls a 5 MB PNG to draw a row.
   * Buffer in, Buffer out: sharp touches no file, which is what keeps spec §11 control 1 true.
   */
  export async function thumbnail(png: Uint8Array): Promise<Uint8Array> {
    let smallest: Buffer | null = null
    for (const [edge, quality] of LADDER) {
      const out = await sharp(png)
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer()
      if (out.length <= THUMBNAIL_MAX_BYTES) return out
      smallest = out
    }
    throw new Error(`thumbnail: cannot fit under ${THUMBNAIL_MAX_BYTES} bytes; smallest was ${smallest?.length ?? -1}`)
  }
  ```

- [ ] **Step 44: Run it and watch it pass, then commit.**
  ```sh
  npx vitest run packages/capture/src/thumbnail.test.ts
  ```
  Expected: `Tests  4 passed (4)`.
  ```sh
  git add packages/capture/src/thumbnail.ts packages/capture/src/thumbnail.test.ts
  git commit -m "feat(capture): thumbnail() with a quality ladder that guarantees the 24 KiB ceiling"
  ```

- [ ] **Step 45: Write the failing `normalizeReps` test.**
  Four normalisations, each with a reason. **TIFF→PNG**: macOS screenshots arrive as `public.tiff` and
  a promised TIFF read from Photoshop can be tens of megabytes; PNG is what the store and the phone
  want. **CF_HTML strip**: Windows wraps `text/html` in a byte-offset header, so a Windows copy and a
  Linux copy of the same selection must reduce to identical bytes or they will never dedupe — the test
  asserts the two hashes are equal. **uri-list canonicalisation**: CRLF, comment lines and
  `file://localhost/` are all legal and all produce different hashes for the same two files. **Legacy
  alias dedupe**: `pb.types` leaks `NSStringPboardType` alongside `public.utf8-plain-text`, so the same
  text arrives twice.

  `packages/capture/src/normalize-reps.test.ts`:
  ```ts
  import { readFileSync } from 'node:fs'
  import { describe, expect, it } from 'vitest'
  import sharp from 'sharp'
  import { MIME_SOURCE_URL, contentHash, fixturePath } from '@cairn/protocol'
  import { canonicaliseUriList, normalizeReps, stripCfHtml } from './normalize-reps'
  import { rep } from './testing'

  const fx = (n: string): Buffer => readFileSync(fixturePath('formats', n))

  describe('normalizeReps', () => {
    it('converts a TIFF rep to a pixel-identical PNG rep and reseals the hash', async () => {
      const out = await normalizeReps([rep('image/tiff', 'public.tiff', fx('screenshot.tiff'))])
      expect(out).toHaveLength(1)
      const png = out[0]!
      expect(png.mime).toBe('image/png')
      expect(png.uti).toBe('public.png')
      expect([...png.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(png.byteLength).toBe(png.bytes.length)
      expect(png.sha256).toBe(contentHash(png.bytes))
      const got = await sharp(Buffer.from(png.bytes)).raw().toBuffer()
      const want = await sharp(fx('screenshot.png')).raw().toBuffer()
      expect(Buffer.compare(got, want)).toBe(0)
      expect((await sharp(Buffer.from(png.bytes)).metadata()).width).toBe(64)
    })

    it('drops the TIFF entirely when the source app also offered a PNG', async () => {
      const out = await normalizeReps([
        rep('image/tiff', 'public.tiff', fx('screenshot.tiff')),
        rep('image/png', 'public.png', fx('screenshot.png')),
      ])
      expect(out.map((r) => r.mime)).toEqual(['image/png'])
      expect(out[0]!.sha256).toBe(contentHash(fx('screenshot.png')))
    })

    it('strips the CF_HTML wrapper to the exact bytes a Linux copy produces', async () => {
      const out = await normalizeReps([rep('text/html', 'public.html', fx('cf-html-wrapper.txt'))])
      expect(Buffer.from(out[0]!.bytes).toString('utf8')).toBe('<p>Hello <b>bold</b> world</p>')
      expect(out[0]!.sha256).toBe('sha256-DS9cTGJFVDsb2fuiJHH-dgp2PbQSofvQW6e6tAtiFQQ')
      const linux = await normalizeReps([rep('text/html', 'text/html', Buffer.from('<p>Hello <b>bold</b> world</p>', 'utf8'))])
      expect(linux[0]!.sha256).toBe(out[0]!.sha256)
    })

    it('falls back to the first < when the CF_HTML offsets are nonsense', () => {
      const broken = Buffer.from('Version:0.9\r\nStartHTML:9999999999\r\nEndHTML:0000000001\r\n<p>fallback</p>', 'utf8')
      expect(Buffer.from(stripCfHtml(broken)!).toString('utf8')).toBe('<p>fallback</p>')
      expect(stripCfHtml(Buffer.from('<p>bare</p>', 'utf8'))).toBeNull()
    })

    it('canonicalises uri-list: CRLF, comments, blanks and file://localhost all collapse to the fixture', () => {
      const want = fx('uri-list-two-files.txt')
      const dirty = Buffer.from(
        '# a comment\r\nfile://localhost/Users/dev/Documents/report.pdf\r\n\r\nfile:///Users/dev/Documents/notes.txt',
        'utf8',
      )
      expect(Buffer.compare(Buffer.from(canonicaliseUriList(dirty)), want)).toBe(0)
      expect(Buffer.compare(Buffer.from(canonicaliseUriList(want)), want)).toBe(0)
      expect(contentHash(canonicaliseUriList(dirty))).toBe('sha256-5II58ebcX0p61WxP5aNTJzbQmqc1TxBuNxWkjI79QdA')
    })

    it('dedupes the NSStringPboardType legacy alias against public.utf8-plain-text', async () => {
      const body = 'hello world'
      const out = await normalizeReps([
        rep('text/plain', 'NSStringPboardType', body),
        rep('text/plain', 'public.utf8-plain-text', body),
      ])
      expect(out).toHaveLength(1)
      expect(out[0]!.uti).toBe('public.utf8-plain-text')
      expect(out[0]!.sha256).toBe(contentHash(Buffer.from(body, 'utf8')))
    })

    it('drops the org.chromium.source-url rep so a Chrome copy hashes like any other', async () => {
      expect(MIME_SOURCE_URL).toBe('text/x-source-url')
      const out = await normalizeReps([
        rep('text/plain', 'public.utf8-plain-text', 'hello world'),
        rep(MIME_SOURCE_URL, 'org.chromium.source-url', 'https://example.com/article'),
      ])
      expect(out.map((r) => r.uti)).toEqual(['public.utf8-plain-text'])
      expect(out.map((r) => r.mime)).toEqual(['text/plain'])
      expect(out[0]!.sha256).toBe(contentHash(Buffer.from('hello world', 'utf8')))
    })

    it('leaves text/plain bytes untouched, CRLF and emoji included', async () => {
      const raw = fx('plain-utf8.txt')
      const out = await normalizeReps([rep('text/plain', 'public.utf8-plain-text', raw)])
      expect(Buffer.compare(Buffer.from(out[0]!.bytes), raw)).toBe(0)
      expect(Buffer.from(out[0]!.bytes).toString('utf8')).toBe('Hello \u{1F30D}\r\nsecond line\n')
    })

    it('orders the output by the frozen primary-rep order so two machines emit identical rows', async () => {
      const out = await normalizeReps([
        rep('text/rtf', 'public.rtf', fx('rtf-minimal.rtf')),
        rep('application/pdf', 'com.adobe.pdf', 'x'),
        rep('image/png', 'public.png', fx('screenshot.png')),
        rep('text/plain', 'public.utf8-plain-text', 'hello world'),
      ])
      expect(out.map((r) => r.mime)).toEqual(['text/plain', 'image/png', 'text/rtf', 'application/pdf'])
    })
  })
  ```

- [ ] **Step 46: Run it and watch it fail.**
  ```sh
  npx vitest run packages/capture/src/normalize-reps.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './normalize-reps' imported from …`.

- [ ] **Step 47: Write `normalize-reps.ts`.**
  Note what this function deliberately does **not** do: it never touches `text/plain` bytes. Rewriting
  CRLF to LF would hand the user back something different from what they copied, and no cross-platform
  identity claim requires it.

  `packages/capture/src/normalize-reps.ts`:
  ```ts
  import sharp from 'sharp'
  import { contentHash, type ResolvedRep } from '@cairn/protocol'
  import { PRIMARY_REP_ORDER } from './classify-kind'

  /** Metadata riders and hint markers. Never content, never hashed, never stored. */
  export const DROPPED_UTIS: readonly string[] = [
    'org.chromium.source-url', 'org.chromium.web-custom-data', 'org.nspasteboard.source',
    'org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'org.nspasteboard.AutoGeneratedType',
    'com.apple.pasteboard.promised-file-content-type',
  ]

  /** `pb.types` leaks these old NeXT/AppKit aliases beside the modern UTI for the same bytes. */
  export const LEGACY_UTI_ALIASES: Readonly<Record<string, string>> = {
    NSStringPboardType: 'public.utf8-plain-text',
    NSPasteboardTypeString: 'public.utf8-plain-text',
    'NeXT plain ascii pasteboard type': 'public.utf8-plain-text',
    NSHTMLPboardType: 'public.html',
    NSPasteboardTypeHTML: 'public.html',
    NSRTFPboardType: 'public.rtf',
    'NeXT Rich Text Format pasteboard type': 'public.rtf',
    NSFilenamesPboardType: 'public.file-url',
    NSTIFFPboardType: 'public.tiff',
    NSPasteboardTypeTIFF: 'public.tiff',
    NSURLPboardType: 'public.url',
  }

  const CF_HTML_HEADER_RE = /^Version:\s*\d+\.\d+/

  function reseal(rep: ResolvedRep, bytes: Uint8Array, mime = rep.mime, uti = rep.uti): ResolvedRep {
    return { mime, uti, bytes, byteLength: bytes.length, sha256: contentHash(bytes) }
  }

  /**
   * Windows `HTML Format` wraps the markup in a byte-offset header. Returns the bare fragment, or
   * `null` when the input is already bare HTML. Offsets are read leniently: prefer
   * StartFragment/EndFragment, fall back to StartHTML/EndHTML, then to the first `<`.
   */
  export function stripCfHtml(bytes: Uint8Array): Uint8Array | null {
    const buf = Buffer.from(bytes)
    const text = buf.toString('utf8')
    if (!CF_HTML_HEADER_RE.test(text)) return null
    const num = (name: string): number => {
      const m = new RegExp(`^${name}:\\s*(\\d+)\\s*$`, 'm').exec(text)
      return m?.[1] === undefined ? -1 : Number(m[1])
    }
    const usable = (s: number, e: number): boolean => s >= 0 && e > s && e <= buf.length
    let start = num('StartFragment')
    let end = num('EndFragment')
    if (!usable(start, end)) { start = num('StartHTML'); end = num('EndHTML') }
    if (!usable(start, end)) {
      const lt = buf.indexOf(0x3c)
      if (lt < 0) return null
      start = lt
      end = buf.length
    }
    const inner = buf.subarray(start, end).toString('utf8').replace(/<!--\s*(?:Start|End)Fragment\s*-->/g, '')
    return Buffer.from(inner.trim(), 'utf8')
  }

  /** RFC 2483 canonical form: LF endings, no comments, no blanks, one trailing LF, no localhost. */
  export function canonicaliseUriList(bytes: Uint8Array): Uint8Array {
    const out: string[] = []
    for (const rawLine of Buffer.from(bytes).toString('utf8').split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim()
      if (line === '' || line.startsWith('#')) continue
      out.push(line.replace(/^file:\/\/localhost\//i, 'file:///'))
    }
    return Buffer.from(out.length === 0 ? '' : `${out.join('\n')}\n`, 'utf8')
  }

  /**
   * One rep per mime, canonical bytes, resealed hashes, deterministic order. Never writes a file:
   * sharp is Buffer-in/Buffer-out. An unreadable image is dropped, never spooled.
   */
  export async function normalizeReps(raw: readonly ResolvedRep[]): Promise<readonly ResolvedRep[]> {
    const staged: ResolvedRep[] = []
    for (const rep of raw) {
      if (rep.uti !== null && DROPPED_UTIS.includes(rep.uti)) continue
      const uti = rep.uti !== null ? (LEGACY_UTI_ALIASES[rep.uti] ?? rep.uti) : null
      if (rep.mime === 'image/tiff') {
        try {
          const png = await sharp(Buffer.from(rep.bytes)).png({ compressionLevel: 9 }).toBuffer()
          staged.push(reseal(rep, png, 'image/png', 'public.png'))
        } catch { /* an unreadable image is dropped; the other reps still make a candidate */ }
        continue
      }
      if (rep.mime === 'text/html') {
        const stripped = stripCfHtml(rep.bytes)
        staged.push(stripped === null ? reseal(rep, rep.bytes, rep.mime, uti) : reseal(rep, stripped, 'text/html', uti))
        continue
      }
      if (rep.mime === 'text/uri-list') {
        staged.push(reseal(rep, canonicaliseUriList(rep.bytes), rep.mime, uti))
        continue
      }
      staged.push(reseal(rep, rep.bytes, rep.mime, uti))     // text/plain passes through byte-exact
    }
    const byMime = new Map<string, ResolvedRep>()
    for (const rep of staged) if (!byMime.has(rep.mime)) byMime.set(rep.mime, rep)
    const rank = (mime: string): number => {
      const i = PRIMARY_REP_ORDER.indexOf(mime)
      return i < 0 ? PRIMARY_REP_ORDER.length : i
    }
    return [...byMime.values()].sort((a, b) => rank(a.mime) - rank(b.mime) || a.mime.localeCompare(b.mime))
  }
  ```

- [ ] **Step 48: Run it and watch it pass, then commit.**
  ```sh
  npx vitest run packages/capture/src/normalize-reps.test.ts
  ```
  Expected: `Tests  9 passed (9)`.
  ```sh
  git add packages/capture/src/normalize-reps.ts packages/capture/src/normalize-reps.test.ts
  git commit -m "feat(capture): normalizeReps — TIFF to PNG, CF_HTML strip, uri-list, alias dedupe"
  ```

- [ ] **Step 49: Write the failing capture-behaviour test.**
  Six behaviours, six reasons. **Debounce**: macOS polls `changeCount` at 500 ms and an app can bump
  it twice while assembling a copy; 150 ms of quiet is what turns that into one row. **Self-write
  suppression**: every `agent.write()` returns the token it caused, and if capture does not ignore
  exactly that token the app recaptures its own paste forever — this is the loop that makes a
  clipboard manager eat its own tail. **Same-hash pair**: capture must *not* dedupe (see the decision
  note above). **Concealed ordering**: `capture.thumbnail` must never appear in the log for a
  concealed change, which is the observable proof that nothing read a byte. **Masking at ingest**: the
  candidate that leaves this module already carries `AKIA••••A7QD`.

  `packages/capture/src/capture.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest'
  import sharp from 'sharp'
  import { createTestClock, type Candidate } from '@cairn/protocol'
  import * as privacy from '@cairn/privacy'
  import { createCapture, defaultCaptureConfig } from './capture'
  import { createStubAgent } from './stub-agent'
  import { changed, createSpyLogger, rep } from './testing'

  const setup = () => {
    const clock = createTestClock()
    const agent = createStubAgent()
    const { logger, events } = createSpyLogger()
    const got: Candidate[] = []
    const capture = createCapture({
      agent, privacy, config: defaultCaptureConfig(privacy.DEFAULT_RULES), clock, logger,
    })
    capture.onCandidate((c) => { got.push(c) })
    return { clock, agent, capture, got, events }
  }

  describe('capture', () => {
    it('debounces two changes 40 ms apart into ONE candidate carrying the later text', async () => {
      const { clock, agent, capture, got } = setup()
      await capture.start()
      agent.emitChanged(changed(365, [rep('text/plain', 'public.utf8-plain-text', 'second copy')]))
      clock.advance(40)
      agent.emitChanged(changed(366, [rep('text/plain', 'public.utf8-plain-text', 'third copy')]))
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(1)
      expect(got[0]?.primaryText).toBe('third copy')
      expect(got[0]?.changeToken).toBe('366')
    })

    it('ignores exactly the suppressed token and still records the next change', async () => {
      const { clock, agent, capture, got } = setup()
      await capture.start()
      const res = await agent.request('write', { reps: [], transient: true })
      expect(res.ok).toBe(true)
      if (res.ok) capture.suppressToken(String(res.value.changeToken))
      agent.emitChanged(changed(999, [rep('text/plain', 'public.utf8-plain-text', 'our own write')]))
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(0)
      agent.emitChanged(changed(1000, [rep('text/plain', 'public.utf8-plain-text', 'typed by hand')]))
      clock.advance(150)
      await capture.whenIdle()
      expect(got.map((c) => c.primaryText)).toEqual(['typed by hand'])
    })

    it('emits two candidates with the SAME contentHash for the same text copied twice', async () => {
      const { clock, agent, capture, got } = setup()
      await capture.start()
      agent.emitChanged(changed(370, [rep('text/plain', 'public.utf8-plain-text', 'hello world')]))
      clock.advance(150)
      await capture.whenIdle()
      agent.emitChanged(changed(371, [rep('text/plain', 'public.utf8-plain-text', 'hello world')]))
      clock.advance(150)
      await capture.whenIdle()
      // Two candidates on purpose: @cairn/history collapses these into one row with a bumped
      // updatedAt. If capture swallowed the second, recency could never bump.
      expect(got).toHaveLength(2)
      expect(got[0]?.contentHash).toBe(got[1]?.contentHash)
      expect(got[1]!.capturedAt).toBeGreaterThan(got[0]!.capturedAt)
    })

    it('skips a concealed change BEFORE reading a byte: no candidate and no thumbnail', async () => {
      const { clock, agent, capture, got, events } = setup()
      await capture.start()
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
      agent.emitChanged(changed(380, [rep('image/png', 'public.png', png)], ['concealed']))
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(0)
      expect(events).toContain('privacy.skipped')
      expect(events).not.toContain('capture.thumbnail')
    })

    it('hands on a MASKED preview for a secret, never the raw value', async () => {
      const { clock, agent, capture, got } = setup()
      await capture.start()
      agent.emitChanged(changed(390, [rep('text/plain', 'public.utf8-plain-text', 'AKIA2E0PQIN4XA7QD')]))
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(1)
      expect(got[0]?.primaryText).toBe('AKIA••••A7QD')
      expect(got[0]?.primaryText).not.toContain('AKIA2E0PQIN4XA7QD')
    })

    it('thumbnails an image candidate under the 24 KiB ceiling', async () => {
      const { clock, agent, capture, got } = setup()
      await capture.start()
      const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: 9, g: 40, b: 200 } } }).png().toBuffer()
      agent.emitChanged(changed(400, [rep('image/png', 'public.png', png)]))
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(1)
      expect(got[0]?.kind).toBe('image')
      expect(got[0]!.thumbnailJpeg!.length).toBeLessThanOrEqual(24 * 1024)
    })
  })
  ```

- [ ] **Step 50: Run it and watch it fail.**
  ```sh
  npx vitest run packages/capture/src/capture.test.ts
  ```
  Expected: FAIL with `Error: Cannot find module './capture' imported from
  .../packages/capture/src/capture.test.ts`.

- [ ] **Step 51: Write `capture.ts`.**
  `packages/capture/src/capture.ts`:
  ```ts
  import {
    CAPTURE_DEBOUNCE_MS, WATCH_INTERVAL_MS, err, ok,
    type Candidate, type ClipboardAgent, type ClipboardChangedPayload, type Clock,
    type Logger, type PasteboardHint, type Result, type Snapshot, type Unsub,
  } from '@cairn/protocol'
  import type { Classification, PrivacyRules } from '@cairn/privacy'
  import { classifyKind, selectPrimaryRep } from './classify-kind'
  import { normalizeReps } from './normalize-reps'
  import { thumbnail } from './thumbnail'

  export interface CaptureConfig {
    readonly debounceMs: number
    readonly watchIntervalMs: number
    readonly rules: PrivacyRules
  }

  export interface CaptureDeps {
    readonly agent: ClipboardAgent
    /** Structurally satisfied by `import * as privacy from '@cairn/privacy'`. */
    readonly privacy: {
      classify: (s: Snapshot, r: PrivacyRules) => Classification
      mask: (t: string) => { readonly preview: string; readonly spans: readonly { readonly start: number; readonly end: number }[] }
      shouldSkipOnHints: (h: readonly PasteboardHint[], r: PrivacyRules) => boolean
    }
    readonly config: CaptureConfig
    readonly clock: Clock
    readonly logger: Logger
  }

  export interface Capture {
    start(): Promise<Result<{ intervalMs: number }>>
    stop(): Promise<void>
    onCandidate(cb: (c: Candidate) => void): Unsub
    suppressToken(token: string): void
    /** Resolves when no candidate is mid-assembly. */
    whenIdle(): Promise<void>
  }

  export const defaultCaptureConfig = (rules: PrivacyRules): CaptureConfig => ({
    debounceMs: CAPTURE_DEBOUNCE_MS,
    watchIntervalMs: WATCH_INTERVAL_MS,
    rules,
  })

  export function createCapture(deps: CaptureDeps): Capture {
    const { agent, privacy, config, clock, logger } = deps
    const listeners = new Set<(c: Candidate) => void>()
    const suppressed = new Set<string>()
    let pending: ClipboardChangedPayload | null = null
    let cancelDebounce: (() => void) | null = null
    let unsubAgent: Unsub | null = null
    // Flushes are chained rather than fired in parallel, so a 5 MB PNG that thumbnails slowly can
    // never emit its candidate after the 12-byte text copied a moment later.
    let inFlight: Promise<void> = Promise.resolve()

    const emit = async (ev: ClipboardChangedPayload): Promise<void> => {
      // LAYER 1 of the privacy model, and it runs BEFORE normalizeReps or thumbnail read a byte.
      if (privacy.shouldSkipOnHints(ev.hints, config.rules)) {
        logger.info('privacy.skipped', { count: ev.reps.length })
        return
      }
      const reps = await normalizeReps(ev.reps)
      const primary = selectPrimaryRep(reps)
      if (primary === null) {
        logger.info('privacy.skipped', { count: 0 })
        return
      }
      const kind = classifyKind(reps)
      const rawText = primary.mime.startsWith('text/') ? Buffer.from(primary.bytes).toString('utf8') : null
      const snapshot: Snapshot = {
        reps,
        primaryText: rawText,
        kind,
        hints: ev.hints,
        sourceApp: ev.sourceApp,
        totalBytes: reps.reduce((n, r) => n + r.byteLength, 0),
      }
      const verdict = privacy.classify(snapshot, config.rules)
      if (verdict.action === 'skip') {
        logger.info('privacy.skipped', { kind, flags: verdict.flags })
        return
      }
      // MASKING AT INGEST (spec §11 control 5). The candidate that leaves this module carries the
      // masked preview, so nothing downstream — least of all the in-memory index — holds the raw
      // secret. The raw bytes stay in `reps`, bound for the encrypted store and nowhere else.
      let previewText = rawText
      if (verdict.flags.includes('secret') && rawText !== null) {
        const masked = privacy.mask(rawText)
        previewText = masked.preview
        logger.info('privacy.masked', { kind, count: masked.spans.length })
      }
      let thumb: Uint8Array | null = null
      const pngRep = reps.find((r) => r.mime === 'image/png')
      if (pngRep !== undefined) {
        thumb = await thumbnail(pngRep.bytes)
        logger.debug('capture.thumbnail', { byteLength: thumb.length })
      }
      const candidate: Candidate = {
        reps,
        kind,
        contentHash: primary.sha256,          // already contentHash(primary.bytes), resealed above
        primaryText: previewText,
        hints: ev.hints,
        sourceApp: ev.sourceApp,
        thumbnailJpeg: thumb,
        changeToken: ev.changeToken,
        capturedAt: clock.now(),
      }
      logger.info('capture.candidate', {
        kind,
        repCount: reps.length,
        byteLength: snapshot.totalBytes,
        hashPrefix: candidate.contentHash.slice(0, 12),
        flags: verdict.flags,
      })
      for (const cb of [...listeners]) cb(candidate)
    }

    const flush = (): void => {
      cancelDebounce = null
      const ev = pending
      pending = null
      if (ev === null) return
      inFlight = inFlight.then(() => emit(ev))
    }

    const onChanged = (ev: ClipboardChangedPayload): void => {
      // SELF-WRITE SUPPRESSION. One-shot: the token is consumed, so an unrelated later change with a
      // recycled token is still recorded.
      if (suppressed.has(ev.changeToken)) {
        suppressed.delete(ev.changeToken)
        logger.info('capture.self-write-suppressed', { count: suppressed.size })
        return
      }
      if (pending !== null) logger.debug('capture.debounced', { count: 1 })
      pending = ev
      // Fixed window from the FIRST event of a burst: a chatty app cannot postpone capture forever.
      if (cancelDebounce === null) cancelDebounce = clock.setTimeout(flush, config.debounceMs)
    }

    return {
      async start() {
        unsubAgent = agent.on('clipboard.changed', onChanged)
        const res = await agent.request('watch.start', { intervalMs: config.watchIntervalMs })
        if (!res.ok) return err(res.code, res.message)
        return ok({ intervalMs: config.watchIntervalMs })
      },
      async stop() {
        if (cancelDebounce !== null) { cancelDebounce(); cancelDebounce = null }
        pending = null
        unsubAgent?.()
        unsubAgent = null
        await agent.request('watch.stop', {})
      },
      onCandidate(cb) {
        listeners.add(cb)
        return () => { listeners.delete(cb) }
      },
      suppressToken(token) { suppressed.add(token) },
      whenIdle() { return inFlight },
    }
  }
  ```

- [ ] **Step 52: Run it and watch it pass.**
  ```sh
  npx vitest run packages/capture/src/capture.test.ts
  ```
  Expected: `Tests  6 passed (6)`.

- [ ] **Step 53: Prove the self-write suppression test can fail.**
  Delete the three lines of the `suppressed.has(...)` block in `onChanged` and re-run:
  ```sh
  npx vitest run packages/capture/src/capture.test.ts
  ```
  Expected: FAIL on `ignores exactly the suppressed token and still records the next change` with
  `AssertionError: expected [ { reps: …, primaryText: 'our own write', … } ] to have a length of +0 but got 1`.
  **Restore the block** and confirm 6 pass again.

- [ ] **Step 54: Commit the capture engine.**
  ```sh
  git add packages/capture/src/capture.ts packages/capture/src/capture.test.ts
  git commit -m "feat(capture): debounce, one-shot self-write suppression and masked-at-ingest candidates"
  ```

- [ ] **Step 55: Create the five capture transcripts.**
  These replay a whole OS session and assert the host's outbound request script (contract §7).
  `dir: "in"` is a request the host is expected to send; `dir: "out"` is a line the agent emits;
  `"*"` means "any value"; `delayMs` advances the **injected clock** before emitting. All content is
  synthetic, all bundle ids are on the scan allowlist, and every `sha256` below was computed with
  `contentHash` so `scripts/scan-transcripts.mjs` will accept them.

  `fixtures/agent-transcripts/duplicate-notify.ndjson` — two poll ticks report the **same**
  `changeCount`; exactly one candidate must result.
  ```
  {"v":1,"t":"meta","transcript":"duplicate-notify","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"hand written 2026-09-02"}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"wireMajor":1,"agent":"macos","agentVersion":"0.1.0","platformVersion":"26.5.1","tier":"A","clipboardWatch":"changecount-poll","paste":"none","hotkey":"carbon","focusApp":true,"concealedTypeHints":true,"maxRepBytes":20971520,"chunkThresholdBytes":65536,"missingTools":[]}}}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"watch.start","params":{"intervalMs":500}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"watching":true,"intervalMs":500}}}
  {"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":364,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic"}}}
  {"dir":"out","delayMs":40,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":364,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic"}}}
  ```

  `fixtures/agent-transcripts/self-write-suppression.ndjson` — our own `write` returns changeToken
  `377`; the `377` change must be dropped and the `378` change must not be.
  ```
  {"v":1,"t":"meta","transcript":"self-write-suppression","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"hand written 2026-09-02"}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"wireMajor":1,"agent":"macos","agentVersion":"0.1.0","platformVersion":"26.5.1","tier":"A","clipboardWatch":"changecount-poll","paste":"none","hotkey":"carbon","focusApp":true,"concealedTypeHints":true,"maxRepBytes":20971520,"chunkThresholdBytes":65536,"missingTools":[]}}}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"watch.start","params":{"intervalMs":500}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"watching":true,"intervalMs":500}}}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"write","params":{"reps":"*","transient":true}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"changeToken":"377"}}}
  {"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":377,"hints":["auto-generated"],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"app.cairn.desktop","frontmostName":"Cairn","attributionConfidence":"heuristic"}}}
  {"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":378,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":13,"sha256":"sha256-Jg2T_7wD4zcr6rARUrUw-_aPUtJDcV-f9pas_IjKbiE","inline":"dHlwZWQgYnkgaGFuZA=="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic"}}}
  ```

  `fixtures/agent-transcripts/concealed-1password.ndjson` — the concealed hint arrives with an image
  rep on purpose: if capture inspected bytes before checking hints it would log `capture.thumbnail`,
  and the test asserts it does not.
  ```
  {"v":1,"t":"meta","transcript":"concealed-1password","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"hand written 2026-09-02; a 1x1 PNG stands in for any payload"}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"wireMajor":1,"agent":"macos","agentVersion":"0.1.0","platformVersion":"26.5.1","tier":"A","clipboardWatch":"changecount-poll","paste":"none","hotkey":"carbon","focusApp":true,"concealedTypeHints":true,"maxRepBytes":20971520,"chunkThresholdBytes":65536,"missingTools":[]}}}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"watch.start","params":{"intervalMs":500}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"watching":true,"intervalMs":500}}}
  {"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":401,"hints":["concealed"],"reps":[{"mime":"image/png","uti":"public.png","byteLength":90,"sha256":"sha256-Lmki808os8xtGGu4M9tnxnAuYm2YLzU4mvWcOBMqqY8","inline":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQI12NgaPgPAAIDAYD1QurIAAAAAElFTkSuQmCC"}],"frontmostBundleId":"com.1password.1password","frontmostName":"1Password","attributionConfidence":"heuristic"}}}
  ```

  `fixtures/agent-transcripts/finder-multifile.ndjson` — a two-file Finder copy: `text/uri-list` plus
  the plain-text paths. Kind must be `files`; the hash must be over the frozen primary (`text/plain`).
  ```
  {"v":1,"t":"meta","transcript":"finder-multifile","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"hand written 2026-09-02"}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"wireMajor":1,"agent":"macos","agentVersion":"0.1.0","platformVersion":"26.5.1","tier":"A","clipboardWatch":"changecount-poll","paste":"none","hotkey":"carbon","focusApp":true,"concealedTypeHints":true,"maxRepBytes":20971520,"chunkThresholdBytes":65536,"missingTools":[]}}}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"watch.start","params":{"intervalMs":500}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"watching":true,"intervalMs":500}}}
  {"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":410,"hints":[],"reps":[{"mime":"text/uri-list","uti":"public.file-url","byteLength":77,"sha256":"sha256-5II58ebcX0p61WxP5aNTJzbQmqc1TxBuNxWkjI79QdA","inline":"ZmlsZTovLy9Vc2Vycy9kZXYvRG9jdW1lbnRzL3JlcG9ydC5wZGYKZmlsZTovLy9Vc2Vycy9kZXYvRG9jdW1lbnRzL25vdGVzLnR4dAo="},{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":63,"sha256":"sha256-TMzQkSJCLZ77TIEH0y6EpXef-dooeUO_CpP1EVbQBwA","inline":"L1VzZXJzL2Rldi9Eb2N1bWVudHMvcmVwb3J0LnBkZgovVXNlcnMvZGV2L0RvY3VtZW50cy9ub3Rlcy50eHQK"}],"frontmostBundleId":"com.apple.finder","frontmostName":"Finder","attributionConfidence":"heuristic"}}}
  ```

  `fixtures/agent-transcripts/chrome-source-url.ndjson` — Chrome adds an `org.chromium.source-url`
  rider; the row must hash identically to the same text copied from TextEdit. The rider's mime is
  `text/x-source-url` (`MIME_SOURCE_URL`, frozen in `packages/protocol/src/constants.ts`), **not**
  `text/plain`: that is exactly what the macOS agent emits for the `org.chromium.source-url` UTI, and
  Task 4's `record-transcript diff` compares the real binary's output against this file rep for rep.
  The UTI stays `org.chromium.source-url` — that is the string `DROPPED_UTIS` matches on,
  so the rider is discarded on mime and UTI alike.
  ```
  {"v":1,"t":"meta","transcript":"chrome-source-url","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"hand written 2026-09-02"}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"wireMajor":1,"agent":"macos","agentVersion":"0.1.0","platformVersion":"26.5.1","tier":"A","clipboardWatch":"changecount-poll","paste":"none","hotkey":"carbon","focusApp":true,"concealedTypeHints":true,"maxRepBytes":20971520,"chunkThresholdBytes":65536,"missingTools":[]}}}
  {"dir":"in","line":{"v":1,"t":"req","id":"*","method":"watch.start","params":{"intervalMs":500}}}
  {"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"watching":true,"intervalMs":500}}}
  {"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":420,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="},{"mime":"text/x-source-url","uti":"org.chromium.source-url","byteLength":27,"sha256":"sha256-YyU4KQRo56OcBjI8njrpjzEHLWQcuzfqN5F_VrvrVTk","inline":"aHR0cHM6Ly9leGFtcGxlLmNvbS9hcnRpY2xl"}],"frontmostBundleId":"com.google.Chrome","frontmostName":"Google Chrome","attributionConfidence":"heuristic"}}}
  ```

  Then confirm the CI scanner accepts them:
  ```sh
  npm run scan:transcripts
  ```
  Expected: exit 0 with no findings.

- [ ] **Step 56: Add the transcript-driven block to `capture.test.ts`.**
  Same behaviours as Step 49, now end-to-end through the real agent host with the real NDJSON
  contract, which is what catches a mismatch between what capture asks for and what the agent expects.
  Append to `packages/capture/src/capture.test.ts`:
  ```ts
  import { createFakeAgent } from '@cairn/agent-host'
  import { fixturePath } from '@cairn/protocol'

  const replay = async (name: string) => {
    const clock = createTestClock()
    const { logger, events } = createSpyLogger()
    const agent = createFakeAgent({ transcriptPath: fixturePath('agent-transcripts', name), clock, logger })
    const got: Candidate[] = []
    const capture = createCapture({
      agent, privacy, config: defaultCaptureConfig(privacy.DEFAULT_RULES), clock, logger,
    })
    capture.onCandidate((c) => { got.push(c) })
    await agent.start()
    await capture.start()
    return { agent, capture, clock, got, events }
  }

  describe('capture, transcript-driven', () => {
    it('duplicate-notify: two ticks at one changeCount produce ONE candidate', async () => {
      const { capture, clock, got } = await replay('duplicate-notify.ndjson')
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(1)
      expect(got[0]?.primaryText).toBe('hello world')
      expect(got[0]?.contentHash).toBe('sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek')
    })

    it('self-write-suppression: our own write is dropped, the next copy is not', async () => {
      const { agent, capture, clock, got, events } = await replay('self-write-suppression.ndjson')
      const res = await agent.request('write', { reps: [{ mime: 'text/plain', uti: null, b64: 'aGVsbG8gd29ybGQ=' }], transient: true })
      expect(res.ok).toBe(true)
      if (res.ok) capture.suppressToken(res.value.changeToken)
      clock.advance(150)
      await capture.whenIdle()
      expect(events).toContain('capture.self-write-suppressed')
      expect(got.map((c) => c.primaryText)).toEqual(['typed by hand'])
    })

    it('concealed-1password: nothing is recorded and no byte is read', async () => {
      const { capture, clock, got, events } = await replay('concealed-1password.ndjson')
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toEqual([])
      expect(events).toContain('privacy.skipped')
      expect(events).not.toContain('capture.thumbnail')
      expect(events).not.toContain('capture.candidate')
    })

    it('finder-multifile: kind files, uri-list canonical, hash over the frozen primary rep', async () => {
      const { capture, clock, got } = await replay('finder-multifile.ndjson')
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(1)
      expect(got[0]?.kind).toBe('files')
      expect(got[0]?.reps.map((r) => r.mime)).toEqual(['text/plain', 'text/uri-list'])
      expect(got[0]?.contentHash).toBe('sha256-TMzQkSJCLZ77TIEH0y6EpXef-dooeUO_CpP1EVbQBwA')
      expect(got[0]?.primaryText).toBe('/Users/dev/Documents/report.pdf\n/Users/dev/Documents/notes.txt\n')
    })

    it('chrome-source-url: the rider is dropped so the row hashes like any other copy', async () => {
      const { capture, clock, got } = await replay('chrome-source-url.ndjson')
      clock.advance(150)
      await capture.whenIdle()
      expect(got).toHaveLength(1)
      expect(got[0]?.reps).toHaveLength(1)
      expect(got[0]?.reps[0]?.uti).toBe('public.utf8-plain-text')
      expect(got[0]?.contentHash).toBe('sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek')
    })
  })
  ```

- [ ] **Step 57: Run the transcript block and reconcile the outbound script.**
  ```sh
  npx vitest run packages/capture/src/capture.test.ts
  ```
  Expected: `Tests  11 passed (11)`.
  If instead you get `FakeAgent: outbound request #N did not match the transcript script.` the fake
  agent prints the transcript line and the actual request side by side — edit the `dir:"in"` line of
  the named transcript to match the `actual:` line verbatim, keeping `"id":"*"`, and re-run. If you get
  `FakeAgent: transcript not fully consumed — N of M frames unplayed`, add another
  `clock.advance(150)` and `await capture.whenIdle()` to that test until every `out` frame has played.

- [ ] **Step 58: Commit the transcripts and the integration block.**
  ```sh
  git add fixtures/agent-transcripts packages/capture/src/capture.test.ts
  git commit -m "test(capture): transcript-driven debounce, self-write, concealed, Finder and Chrome cases"
  ```

- [ ] **Step 59: Write the capture security test — no plaintext ever reaches the disk.**
  Three independent angles on the same invariant. Angle one spies on every `node:fs` write API and
  asserts **zero** calls. Angle two diffs `TMPDIR` around a 200 KB capture. Angle three points
  `TMPDIR` at a `0500` directory, so any write attempt would raise `EACCES` and fail the test loudly
  rather than passing quietly.

  One verified gotcha that will cost you an hour if you get it wrong: **you must use the default
  import.** `import * as fs from 'node:fs'` then `vi.spyOn(fs, 'writeFile')` throws
  `TypeError: Cannot spy on export "writeFile". Module namespace is not configurable in ESM.`
  `import fs from 'node:fs'` gives the configurable CJS module object and works.

  `packages/capture/src/capture.security.test.ts`:
  ```ts
  import fs from 'node:fs'
  import fsp from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { describe, expect, it, vi } from 'vitest'
  import sharp from 'sharp'
  import { TEST_CANARY, createTestClock, type Candidate } from '@cairn/protocol'
  import * as privacy from '@cairn/privacy'
  import { createCapture, defaultCaptureConfig } from './capture'
  import { createStubAgent } from './stub-agent'
  import { changed, createSpyLogger, rep } from './testing'

  const WRITE_SURFACE = [
    'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
    'open', 'openSync', 'mkdtemp', 'mkdtempSync', 'writeSync', 'write',
  ] as const

  const build = () => {
    const clock = createTestClock()
    const agent = createStubAgent()
    const { logger } = createSpyLogger()
    const got: Candidate[] = []
    const capture = createCapture({
      agent, privacy, config: defaultCaptureConfig(privacy.DEFAULT_RULES), clock, logger,
    })
    capture.onCandidate((c) => { got.push(c) })
    return { clock, agent, capture, got }
  }

  describe('capture writes nothing to disk', () => {
    it('calls no fs write API during a text + image capture', async () => {
      const spies = WRITE_SURFACE.map((n) => vi.spyOn(fs, n as 'writeFileSync'))
      const pspies = (['writeFile', 'appendFile', 'mkdtemp', 'open'] as const).map((n) => vi.spyOn(fsp, n))
      const { clock, agent, capture } = build()
      await capture.start()
      const png = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 7, g: 7, b: 7 } } }).png().toBuffer()
      agent.emitChanged(changed(500, [rep('text/plain', 'public.utf8-plain-text', TEST_CANARY)]))
      clock.advance(150); await capture.whenIdle()
      agent.emitChanged(changed(501, [rep('image/png', 'public.png', png)]))
      clock.advance(150); await capture.whenIdle()
      for (const s of [...spies, ...pspies]) expect(s).not.toHaveBeenCalled()
      for (const s of [...spies, ...pspies]) s.mockRestore()
    })

    it('creates no new file under TMPDIR while capturing a 200 KB payload', async () => {
      const { clock, agent, capture } = build()
      await capture.start()
      const before = fs.readdirSync(tmpdir())
      agent.emitChanged(changed(600, [rep('text/plain', 'public.utf8-plain-text', `${TEST_CANARY} ${'x'.repeat(200_000)}`)]))
      clock.advance(150); await capture.whenIdle()
      const created = fs.readdirSync(tmpdir()).filter((n) => !before.includes(n))
      expect(created).toEqual([])
      for (const name of created) {
        expect(fs.readFileSync(`${tmpdir()}/${name}`).includes(TEST_CANARY)).toBe(false)
      }
    })

    it('captures fine with TMPDIR pointed at a 0500 dir, and that dir stays empty', async () => {
      const ro = fs.mkdtempSync(`${tmpdir()}/cairn-ro-`)
      const prev = process.env.TMPDIR
      fs.chmodSync(ro, 0o500)
      process.env.TMPDIR = ro
      try {
        const { clock, agent, capture, got } = build()
        await capture.start()
        const png = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 3, g: 9, b: 27 } } }).png().toBuffer()
        agent.emitChanged(changed(700, [rep('image/png', 'public.png', png)]))
        clock.advance(150); await capture.whenIdle()
        expect(got).toHaveLength(1)
        expect(fs.readdirSync(ro)).toEqual([])
      } finally {
        if (prev === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = prev
        fs.chmodSync(ro, 0o700)
        fs.rmSync(ro, { recursive: true, force: true })
      }
    })
  })
  ```

- [ ] **Step 60: Run it, then prove all three angles can fail.**
  ```sh
  npx vitest run --project security packages/capture/src/capture.security.test.ts
  ```
  Expected: `Tests  3 passed (3)`.
  Now reintroduce the vulnerability this task exists to prevent. Add these two lines to `capture.ts`
  immediately after `const reps = await normalizeReps(ev.reps)`:
  ```ts
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${(await import('node:os')).tmpdir()}/cairn-spool-${ev.changeCount}`, Buffer.from(reps[0]!.bytes))
  ```
  Re-run. Expected: all three FAIL, each for its own reason:
  ```
  AssertionError: expected "writeFileSync" to not be called at all, but actually been called 2 times
  AssertionError: expected [ 'cairn-spool-600' ] to deeply equal []
  Error: EACCES: permission denied, open '/.../cairn-ro-XXXXXX/cairn-spool-700'
  ```
  **Delete the two lines**, re-run, and confirm 3 pass. Then clean up any files the broken run left:
  ```sh
  rm -f "${TMPDIR}"cairn-spool-*
  ```

- [ ] **Step 61: Write the `@cairn/capture` barrel.**
  `packages/capture/src/index.ts`:
  ```ts
  export {
    createCapture, defaultCaptureConfig,
    type Capture, type CaptureConfig, type CaptureDeps,
  } from './capture'
  export { PRIMARY_REP_ORDER, classifyKind, selectPrimaryRep } from './classify-kind'
  export {
    DROPPED_UTIS, LEGACY_UTI_ALIASES, canonicaliseUriList, normalizeReps, stripCfHtml,
  } from './normalize-reps'
  export { thumbnail } from './thumbnail'
  export { changed, createSpyLogger, rep } from './testing'
  export { createStubAgent, type StubAgent } from './stub-agent'
  ```

- [ ] **Step 62: Typecheck and run the whole repo suite.**
  ```sh
  npm run typecheck
  npm run test
  ```
  `npm test` is a bare `vitest run`, which runs **all three** projects in `vitest.config.ts` — `unit`,
  `security` and `renderer`. This task adds files to the first two and none to the third, so the
  `renderer` project's count must be unchanged by this branch.
  Expected: `tsc` exit 0 with no output, then all three projects green — including
  `packages/privacy` at 75 unit + 8 security, and `packages/capture` at 37 unit + 3 security.
  If `tsc` reports `TS6133: '<name>' is declared but its value is never read`, the config has
  `noUnusedLocals` on: remove the unused import rather than suppressing it.

- [ ] **Step 63: Commit and push the branch for review.**
  ```sh
  git add packages/capture/src/index.ts packages/capture/src/capture.security.test.ts
  git commit -m "feat(capture): public barrel, plus the security suite proving capture never writes to disk"
  git push -u origin m1/07-capture-privacy
  ```
  Expected: `branch 'm1/07-capture-privacy' set up to track 'origin/m1/07-capture-privacy'`. Do not
  merge it yourself.

---

**Task 7 done when:**

- [ ] `git rev-parse --abbrev-ref HEAD` prints `m1/07-capture-privacy`, and `git log origin/main..HEAD --oneline` lists 13 commits — 14 if Step 2's manifest repair was needed — none with a `Co-Authored-By` line (`git log origin/main..HEAD --format=%B | grep -ci co-authored` prints `0`).
- [ ] `git log origin/main..HEAD --name-only --format= | sort -u | grep -v '^\(packages/privacy\|packages/capture\|fixtures\)/'` prints nothing, or the single line `packages/capture/package.json` if Step 2's repair ran. This task creates its own files and touches no other task's.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run test -w @cairn/privacy` prints `Tests  75 passed (75)`.
- [ ] `npm run test:security -w @cairn/privacy` prints `Tests  8 passed (8)`.
- [ ] `npm run test -w @cairn/capture` prints `Tests  37 passed (37)`.
- [ ] `npm run test:security -w @cairn/capture` prints `Tests  3 passed (3)`.
- [ ] `npm test` (a bare `vitest run`, all three projects — `unit`, `security`, `renderer`) is green, and the `renderer` project's test count is the same as on `origin/main`: this branch adds no renderer file.
- [ ] `npm run scan:transcripts` exits 0 over the seven committed transcripts (this task adds five; the agent-host task already committed `hello-watch-text` and `image-tiff-chunked`).
- [ ] `npx vitest run packages/privacy/src/corpus.test.ts` passes all 13 false positives and all 16 true positives, and you have **seen it fail** with `ENTROPY_BITS_PER_CHAR` at `3.0`.
- [ ] You have **seen** `packages/privacy/src/assert-syncable.security.test.ts` fail for all four `NON_SYNCABLE_FLAGS` with the `throw` commented out.
- [ ] You have **seen** all three tests in `packages/capture/src/capture.security.test.ts` fail — with `expected "writeFileSync" to not be called at all`, `expected [ 'cairn-spool-600' ] to deeply equal []`, and `EACCES: permission denied` — after adding a spool write, and pass again after removing it.
- [ ] You have **seen** `ignores exactly the suppressed token and still records the next change` fail with the `suppressed.has` block deleted.
- [ ] `npx vitest run packages/capture/src/capture.test.ts -t 'hands on a MASKED preview'` passes, and `git grep -n 'AKIA2E0PQIN4XA7QD' packages/capture/src/capture.ts` prints nothing — the raw value exists only in tests and fixtures.
- [ ] `ls -1 fixtures/formats | wc -l` prints `6` and `ls -1 fixtures/secrets | wc -l` prints `2`.
- [ ] `node -e "const c=require('crypto'),f=require('fs');console.log('sha256-'+c.createHash('sha256').update(f.readFileSync('fixtures/formats/uri-list-two-files.txt')).digest('base64url'))"` prints `sha256-5II58ebcX0p61WxP5aNTJzbQmqc1TxBuNxWkjI79QdA`.
- [ ] `git grep -nE 'mkdtemp|tmpdir\(|os\.tmpdir|spool|writeFileSync|createWriteStream' packages/capture/src packages/privacy/src -- ':!*.test.ts'` prints nothing.
- [ ] `git grep -nE "child_process|execSync|execFile|shell: true" packages/capture/src packages/privacy/src` prints nothing — no shell anywhere in the capture path (spec §11 control 3), and the only `exec(` in either package is `RegExp#exec` (`git grep -c '\.exec(' packages/privacy/src/detectors.ts` prints a non-zero count and every hit is a regex).
- [ ] `git grep -nE 'export (interface|type) (PrivacyRules|Classification)' packages/privacy/src` prints nothing — both shapes are frozen in `@cairn/protocol` and only imported here (contract §5).
- [ ] `node -e "const d=require('./packages/capture/package.json').dependencies;for(const k of ['@cairn/protocol','@cairn/privacy','@cairn/agent-host','sharp'])if(!d[k])throw new Error('missing '+k);if(Object.keys(d).length!==4)throw new Error('want exactly 4 deps, got '+Object.keys(d).length);console.log('deps ok')"` prints `deps ok` — the same four the contract §2 table and Task 1's manifest step list — and every `@cairn/*` package `@cairn/capture` imports appears there.
- [ ] `grep -c 'text/x-source-url' fixtures/agent-transcripts/chrome-source-url.ndjson` prints `1` and `grep -c '"uti":"org.chromium.source-url"' fixtures/agent-transcripts/chrome-source-url.ndjson` prints `1`, so the rider in the fixture is `{"mime":"text/x-source-url","uti":"org.chromium.source-url"}` — exactly what the macOS agent emits and what `MIME_SOURCE_URL` says. `git grep -n "'text/plain', 'org.chromium.source-url'" packages/capture/src` prints nothing.
- [ ] `packages/privacy/src/fixture-path.probe.test.ts` does **not** exist — the Step 4 probe was deleted in the same step.
- [ ] `git status --porcelain` is empty and `git log origin/m1/07-capture-privacy..HEAD` is empty (everything is pushed).
