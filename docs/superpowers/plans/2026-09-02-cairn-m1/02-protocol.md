### Task 2: @cairn/protocol — zod contracts, content hashing, the log type, the clock, the IPC union, and Swift codegen

This task builds the package every other package imports, and it builds the two security controls that
have to exist *before* any clipboard byte is read:

- **`LogFields`** — a closed, metadata-only type. Handing the logger an item body is a **compile
  error**, not a code-review question (spec §11 control 2).
- **`contentHash`** — computed over **raw representation bytes only, never over JSON**, so canonical
  JSON encoding stays out of the security TCB (spec §4).

It finishes `@cairn/protocol` **completely** — there is no module in contract §5 left for a later task.
Besides the two controls above that means `agent.ts` and `parse-agent-line.ts` (the NDJSON wire),
`clock.ts` (the one seam every timeout in the repo goes through, so no test needs a real timer),
`id.ts` (`newItemId`, which `@cairn/history` mints every item with) and `ipc.ts` (the frozen renderer
channel lists and both-directions zod schemas, spec §11 control 8). Tasks 3, 5, 6, 7, 8, 9 and 10 each
import several of these on their first step, so anything missing here stops six branches dead.

It also builds `tools/gen-agent-types.ts`, which emits `AgentProtocol.generated.swift` from the zod
schemas. That file is committed, and a test asserts the committed bytes are exactly what the generator
emits — so renaming a zod field turns into a Swift **compile** error instead of a runtime "why is
`uti` always nil" across the stdio pipe. The emitted Swift names, their field order (alphabetical) and
their types (`Data` for every base64 field) are a contract with Task 4: read the *Swift names this task
produces* table below before you change anything in `agent.ts`, because six Swift files are written
against it.

There is **no I/O, no platform code, no network, no `crashReporter`, no socket and no temp file
anywhere in this task.** The only file this task writes at runtime is
`agents/macos/Sources/AgentProtocol.generated.swift`, and only when you run `npm run gen:agent-types`.

---

**Files:**

*Create*

| Path | What |
|---|---|
| `packages/protocol/src/log.ts` | `LogLevel`, `LOG_EVENTS` (all **46** ids, complete — no later task appends), `LogEvent`, `LogFields`, `ExactLogFields`, `Logger` **interface only, no `createLogger`** (contract §5.3) |
| `packages/protocol/src/types.ts` | every other shared domain type (contract §5.1, §5.4–§5.7) |
| `packages/protocol/src/result.ts` | `Result<T>`, `ok()`, `err()`, `ERROR_CODES`, `ErrorCode` (contract §5.2) |
| `packages/protocol/src/hash.ts` | `contentHash(bytes) -> 'sha256-<b64url>'` (contract §5.1) |
| `packages/protocol/src/agent.ts` | the frozen agent NDJSON zod schemas (contract §3) |
| `packages/protocol/src/parse-agent-line.ts` | `parseAgentLine(s): Result<AgentLine>` (contract §3) |
| `packages/protocol/src/clock.ts` | `Cancel`, `Clock`, `TestClock`, `systemClock`, `createTestClock` (contract §5.8) |
| `packages/protocol/src/id.ts` | `newItemId(nowMs, rnd) -> ItemId` (contract §5.1) |
| `packages/protocol/src/ipc.ts` | the frozen renderer IPC zod schemas and channel lists (contract §5.9) |
| `tools/gen-agent-types.ts` | zod → Swift codegen |
| `agents/macos/Sources/AgentProtocol.generated.swift` | **generated and committed**; never hand-edited |

*Modify*

| Path | What |
|---|---|
| `packages/protocol/src/index.ts` | **append** nine `export * from` lines to the two-line barrel the scaffolding task shipped — six in Step 28, then one each as `clock.ts`, `id.ts` and `ipc.ts` land |

*Already on disk from the scaffolding task — verify, do NOT recreate*

| Path | Why it is not yours |
|---|---|
| `packages/protocol/package.json` | the manifest, with `zod: "4.5.4"` and `exports: { ".": "./src/index.ts" }` |
| `packages/protocol/src/constants.ts` | the frozen contract §10 constants file, complete |
| `packages/protocol/src/constants.test.ts` | 9 tests over those constants |
| `packages/protocol/src/testing.ts` | contract §7's `REPO_ROOT` + `fixturePath` |
| `packages/protocol/src/testing.test.ts` | 3 tests over the fixture-path helper |
| `packages/protocol/src/index.ts` | a two-line barrel: `export * from './constants'` then `export * from './testing'` |

If you rewrite `constants.ts` or `testing.ts` you will silently drop whatever the scaffolding task put
there. Step 2 checks all six before you touch anything.

*Test*

| Path | Project | Covers |
|---|---|---|
| `packages/protocol/src/types.test.ts` | `unit` + `typecheck` | `LogFields` is metadata-only — security invariant 2 |
| `packages/protocol/src/log.test.ts` | `unit` | the `LOG_EVENTS` list: 46 ids, no duplicates, no free-form message |
| `packages/protocol/src/hash.test.ts` | `unit` | known-answer vectors; raw-bytes-not-JSON |
| `packages/protocol/src/agent.test.ts` | `unit` | envelope, unknown-keys-ignored, `Rep` rules, `rep.chunk` |
| `packages/protocol/src/parse-agent-line.test.ts` | `unit` | torn lines, huge lines, wrong wire major |
| `packages/protocol/src/clock.test.ts` | `unit` | `createTestClock` fires timers in deadline order, deterministically |
| `packages/protocol/src/id.test.ts` | `unit` | 26 chars, Crockford alphabet, lexicographically sortable, throws on 9 bytes |
| `packages/protocol/src/ipc.test.ts` | `unit` | both directions validated; a malformed payload is rejected |
| `tools/gen-agent-types.test.ts` | `unit` | golden-file identity, drift alarm, fail-loudly mapping |

Every module the contract §5 barrel names is created here. Nothing in `@cairn/protocol` is left for a
later task: Tasks 3, 5, 6, 7, 8, 9 and 10 all import `Clock`, `createTestClock`, `newItemId`,
`LOG_EVENTS` and the IPC schemas from `@cairn/protocol` on their first step, so a missing module here
stops seven branches dead. The concrete NDJSON logger is **not** here: it is
`apps/desktop/main/src/logger.ts`, owned by the desktop-shell task, because a second logger
implementation inside `@cairn/protocol` would be a second place clipboard content could reach a sink.

---

**Interfaces:**

`Consumes:` — all of these come from the repo scaffolding task and must already exist. If any is
missing, stop and fix that task first; do not recreate them here.

```
.npmrc                     ignore-scripts=true, save-exact=true, package-lock=true
package.json               "workspaces": ["packages/*", "apps/desktop"], "type": "module"
                           devDependencies: zod 4.5.4, typescript 5.9.3, vitest 4.1.11,
                                            @types/node 24.9.2
                           scripts: "gen:agent-types": "node tools/gen-agent-types.ts"
                                    "typecheck": "tsc -p tsconfig.json && svelte-check …"
                                    "test": "vitest run"
tsconfig.base.json         strict, verbatimModuleSyntax, noUncheckedIndexedAccess,
                           exactOptionalPropertyTypes, moduleResolution: "bundler"
tsconfig.json              include: packages/*/src/**/*.ts, tools/**/*.ts, …
vitest.config.ts           three projects: "unit" (includes packages/*/src/**/*.test.ts,
                           tools/**/*.test.ts and security/**/*.test.ts for the source
                           scanner's own unit tests), "security" (**/*.security.test.ts,
                           jsdom) and "renderer" (apps/desktop/renderer/src/**/*.test.ts,
                           jsdom, resolve.conditions ['browser'])
.nvmrc                     24.20.0 — `node tools/gen-agent-types.ts` needs Node 24 type stripping

packages/protocol/package.json      { "type": "module", "exports": { ".": "./src/index.ts" },
                                      "dependencies": { "zod": "4.5.4" },
                                      "scripts": { "test": "vitest run --root ../.. --project unit packages/protocol" } }
packages/protocol/src/constants.ts  every constant in contract §10, complete
packages/protocol/src/testing.ts    contract §7: `export const REPO_ROOT` and
                                    `export const fixturePath = (...p: string[]) => string`
packages/protocol/src/index.ts      two lines: `export * from './constants'`
                                               `export * from './testing'`
```

`Produces:` — every name below is importable as `import { … } from '@cairn/protocol'`. **Never import
a deep path**: `@cairn/protocol/src/types` is wrong, `@cairn/protocol` is right, because
`exports: { ".": "./src/index.ts" }` is the only export the manifest declares.

```ts
// ---- constants.ts (values exactly as contract §10) --------------------------------------------
export const WIRE_MAJOR: 1
export const APP_NAME: string                 // 'Cairn'
export const BUNDLE_ID: string                // 'app.cairn.desktop'
export const APP_DESKTOP_NAME: string         // 'app.cairn.desktop'
export const MDNS_SERVICE_TYPE: string        // '_cairn._tcp'   (M5–M6 only; no socket in M1)
export const SYNC_PORT: number                // 47811           (M6 only; nothing binds it in M1)
export const NPM_SCOPE: string                // '@cairn'
export const DATA_DIR_NAME: string            // 'Cairn'
export const STORE_LOG_FILE: string
export const STORE_META_FILE: string
export const STORE_KEY_FILE: string
export const STORE_BLOB_DIR: string
export const AGENT_BIN_NAME: string
export const STORE_AAD_MAGIC: string
export const BLOB_HKDF_INFO: string
export const CHUNK_THRESHOLD_BYTES: number    // 65_536
export const CHUNK_PAYLOAD_BYTES: number      // 32_768
export const MAX_REP_BYTES: number            // 20_971_520
export const MAX_LINE_BYTES: number           // 1_048_576
export const REP_STREAM_TIMEOUT_MS: number    // 5_000
export const MAX_CONCURRENT_REP_STREAMS: number // 8
export const DEFAULT_ACCELERATOR: string
export const WATCH_INTERVAL_MS: number
export const CAPTURE_DEBOUNCE_MS: number
export const AGENT_REQUEST_TIMEOUT_MS: number
export const SECRET_TTL_MS: number            // 300_000
export const RETENTION_MAX_ITEMS: number
export const RETENTION_MAX_AGE_MS: number
export const RETENTION_MAX_BYTES: number
export const SEARCH_INDEX_DEFAULT: number
export const SEARCH_INDEX_HARD_CAP: number
export const PREVIEW_MAX_CHARS: number
export const THUMBNAIL_MAX_EDGE_PX: number
export const THUMBNAIL_JPEG_QUALITY: number
export const THUMBNAIL_MAX_BYTES: number
export const SCRYPT_PARAMS: { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number }
export const TOAST_COPIED_MANUAL: string      // 'Copied — press Cmd+V'
export const TOAST_COPIED_SECURE_INPUT: string
export const BANNER_KEYRING_WEAK: string
export const TEST_CANARY: string              // 'CAIRN-CANARY-9f3a1c7e'
export const UTI_CONCEALED: string
export const UTI_TRANSIENT: string
export const UTI_AUTO_GENERATED: string

// ---- result.ts -------------------------------------------------------------------------------
export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly detail?: LogFields }
export type Result<T> = Ok<T> | Err
export const ok: <T>(value: T) => Ok<T>
export const err: (code: ErrorCode, message: string, detail?: LogFields) => Err
export const ERROR_CODES: readonly string[]   // the 35 codes of contract §5.2, in that order
export type ErrorCode = (typeof ERROR_CODES)[number]

// ---- hash.ts ---------------------------------------------------------------------------------
export function contentHash(bytes: Uint8Array): ContentHash

// ---- log.ts ----------------------------------------------------------------------------------
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export const LOG_EVENTS: readonly string[]    // the 46 ids listed in Step 6, in that order
export type LogEvent = (typeof LOG_EVENTS)[number]
export interface LogFields { /* metadata only — contract §5.3, verbatim */ }
export type ExactLogFields<T> = LogFields & { readonly [K in Exclude<keyof T, keyof LogFields>]: never }
export interface Logger {
  log<T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>): void
  debug<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  info<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  warn<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
}

// ---- clock.ts --------------------------------------------------------------------------------
export type Cancel = () => void
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Cancel }
export interface TestClock extends Clock { advance(ms: number): void; readonly pending: number }
export const systemClock: Clock
export function createTestClock(startMs?: number): TestClock   // default 1_767_225_600_000

// ---- id.ts -----------------------------------------------------------------------------------
export function newItemId(nowMs: number, rnd: Uint8Array): ItemId   // rnd MUST be 10 bytes; throws otherwise

// ---- ipc.ts ----------------------------------------------------------------------------------
export const IPC_REQUEST_CHANNELS: readonly string[]   // the 8 channels of contract §5.9, in order
export const IPC_EVENT_CHANNELS: readonly string[]     // the 4 event channels, in order
export type IpcRequestChannel = (typeof IPC_REQUEST_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]
export const ItemIdSchema: z.ZodString
export const ItemSummarySchema                          // z.object, 12 keys
export type ItemSummary = z.output<typeof ItemSummarySchema>
export const IpcRequestSchema: { [C in IpcRequestChannel]: { params: z.ZodType; result: z.ZodType } }
export const IpcEventSchema: { [C in IpcEventChannel]: z.ZodType }
export type IpcRequest = …                              // per-channel { channel, params, result }
export type IpcEvent = …                                // per-channel { channel, payload }

// ---- types.ts --------------------------------------------------------------------------------
export type ContentHash = string & { readonly [brand]: 'sha256-b64url' }   // branded
export type BlobId = ContentHash
export type ItemId = string & { readonly [brand]: 'cairn-id' }             // branded
export type Unsub = () => void
export interface AgentEventMap { … }          // contract §5.4, the 4 event names
export interface ClipboardAgent { … }         // start / request / on / dispose
export interface ClipboardChangedPayload { … }
export interface RepChunkPayload { … }        // repId, seq, final — NEVER any bytes
export interface HotkeyFiredPayload { … }
export interface AgentLogPayload { … }        // level + event id only; the agent's fields are dropped
export type ItemKind = 'text' | 'richtext' | 'image' | 'files'
export type PasteboardHint = 'concealed' | 'transient' | 'auto-generated' | 'password-manager'
export type AgentPlatform = 'macos' | 'win32' | 'linux'
export interface SourceApp { … }              // contract §5.5, verbatim
export interface ResolvedRep { … }
export interface Snapshot { … }
export interface Candidate { … }
export type Flag = 'secret' | 'concealed' | 'transient' | 'auto-generated' | 'excluded' | 'no-sync' | 'cut'
export const NON_SYNCABLE_FLAGS: readonly ['secret', 'concealed', 'excluded', 'no-sync']
export type DetectorName = …                  // the 10 names of contract §5.6
export interface MaskSpan { … }
export interface RepRef { … }
export interface Item { … }
export interface ItemPatch { … }
export type DeleteReason = 'user' | 'retention-count' | 'retention-age' | 'retention-bytes' | 'secret-ttl' | 'rekey'
export type StoreEvent = …                    // the 4-member union of contract §5.6
export type StoreEventKind = StoreEvent['kind']
export interface ScoredItem { … }
export type KeyringMode = 'os-keyring' | 'passphrase' | 'locked'
export interface PrivacyRules { … }
export interface Classification { … }

// ---- agent.ts --------------------------------------------------------------------------------
export const ContentHashSchema: z.ZodString
export const MimeSchema: z.ZodString
export const IdSchema: z.ZodString
export const RepSchema            // object + 2 refinements
export const HintSchema           // z.enum(['concealed','transient','auto-generated','password-manager'])
export const AgentCapabilitiesSchema
export const AgentRequestSchema   // discriminatedUnion('method', 8 options)
export const AgentResultSchema    // a plain `as const` record keyed by method name
export const AgentErrorSchema
export const AgentResponseSchema  // discriminatedUnion('ok', 2 options)
export const AgentEventSchema     // discriminatedUnion('event', 4 options)
export const AgentLineSchema      // discriminatedUnion('t', [request, response, event])
export type Rep, PasteboardHintWire, AgentCapabilities, AgentRequest, AgentResponse, AgentEvent,
            AgentLine, AgentMethod, AgentEventName
export type AgentParams<M extends AgentMethod>
export type AgentResult<M extends AgentMethod>

// ---- parse-agent-line.ts ---------------------------------------------------------------------
export function parseAgentLine(line: string): Result<AgentLine>   // NEVER throws
```

`tools/gen-agent-types.ts` additionally exports, for its own test only (nothing in `packages/` or
`apps/` may import from `tools/`):

```ts
export class GenError extends Error
export interface GenInput {
  readonly wireMajor: number
  readonly named: readonly (readonly [z.ZodType, string])[]
  readonly requests: readonly (readonly [string, z.ZodType])[]
  readonly results: readonly (readonly [string, z.ZodType])[]
  readonly events: readonly (readonly [string, z.ZodType])[]
}
export interface ProtocolSchemas { /* the subset of @cairn/protocol the generator reads */ }
export function agentGenInput(m: ProtocolSchemas): GenInput
export function generateSwift(input: GenInput): string
export const GENERATED_PATH: string   // <repo>/agents/macos/Sources/AgentProtocol.generated.swift
```

**Swift names this task produces**, for whoever writes `Wire.swift`, `Pasteboard.swift`,
`Chunker.swift`, `Hotkey.swift`, `Writer.swift` and `main.swift`. All are `internal` in one
whole-module `swiftc` invocation, so no `public` is needed:

```swift
let protocolVersion = 1       // the ONLY constant in the generated file — see the note below
enum AgentMethod: String      { hello, watchStart, watchStop, read, write, hotkeyRegister, hotkeyUnregister, shutdown }
enum AgentEventName: String   { clipboardChanged, repChunk, hotkeyFired, log }
enum AgentLogValue            { case string(String), number(Double), bool(Bool), null }
enum Hint: String             { concealed, transient, autoGenerated, passwordManager }
struct Rep                    { byteLength: Int; inline: Data?; mime: String; repId: String?; sha256: String; uti: String? }
struct AgentCapabilities      { agent, agentVersion, chunkThresholdBytes, clipboardWatch, concealedTypeHints,
                                focusApp, hotkey, maxRepBytes, missingTools: [String]?, paste,
                                platformVersion, tier, wireMajor: Int }
struct AgentError             { code: String; message: String }
struct HelloParams            { hostVersion: String }
typealias HelloResult       = AgentCapabilities
struct WatchStartParams       { intervalMs: Int }
struct WatchStartResult       { intervalMs: Int; watching: Bool }
struct WatchStopParams        { }
struct WatchStopResult        { watching: Bool }
struct ReadParams             { changeCount: Int }
struct ReadResult             { changeCount: Int; hints: [Hint]?; reps: [Rep] }
struct WriteParams            { reps: [WriteParamsRepsItem]; transient: Bool }
struct WriteParamsRepsItem    { b64: Data; mime: String; uti: String? }
struct WriteResult            { changeToken: String }
struct HotkeyRegisterParams   { accelerator: String }
struct HotkeyRegisterResult   { accelerator: String; bound: Bool }
struct HotkeyUnregisterParams { }
struct HotkeyUnregisterResult { bound: Bool }
struct ShutdownParams         { }
struct ShutdownResult         { bye: Bool }
struct ClipboardChangedData   { attributionConfidence; changeCount: Int; frontmostBundleId: String?;
                                frontmostName: String?; hints: [Hint]?; reps: [Rep] }
struct RepChunkData           { b64: Data; final: Bool; repId: String; seq: Int }
struct HotkeyFiredData        { accelerator: String; firedAt: Int; focusToken: String }
struct LogData                { event: String; fields: [String: AgentLogValue]?; level: LogDataLevel }
// plus the nested enums AgentCapabilitiesAgent / …ClipboardWatch / …Hotkey / …Paste / …Tier,
// ClipboardChangedDataAttributionConfidence and LogDataLevel.
```

Four Swift-side facts you will otherwise waste an hour on:

1. **Every base64 field is `Data`, not `String`** — `Rep.inline`, `WriteParamsRepsItem.b64` and
   `RepChunkData.b64`. Swift's `JSONEncoder`/`JSONDecoder` use base64 for `Data` by default, so the
   agent never calls a base64 API for a payload at all: `JSONDecoder` has already *decoded* a
   `write` rep's bytes by the time `Writer.swift` sees them, and `JSONEncoder` encodes a chunk's raw
   bytes on the way out. `[verified]` `swiftc -O` compiles
   `RepChunkData(b64: Data("hello world".utf8), final: true, repId: "r1", seq: 0)` and `JSONEncoder`
   with `.sortedKeys` emits exactly `{"b64":"aGVsbG8gd29ybGQ=","final":true,"repId":"r1","seq":0}`.
   `Chunker.split` therefore returns `[Data]`, not `[String]`.
2. **The generated file carries no numeric limits, and that is deliberate.** A zod schema has nowhere
   to hang a bare number — `MAX_LINE_BYTES` is not a field of any message — so the generator has none
   to emit, and `protocolVersion` is the only `let` in the file. Task 4's `Wire.swift` declares the six
   limits it needs (`CHUNK_THRESHOLD_BYTES`, `CHUNK_PAYLOAD_BYTES`, `MAX_REP_BYTES`, `MAX_LINE_BYTES`,
   `AGENT_REQUEST_TIMEOUT_MS`, `WATCH_INTERVAL_MS`) as top-level `let`s mirroring
   `packages/protocol/src/constants.ts`, and its `tools/agent-selftest.test.ts` reads **both** files and
   fails if a literal drifts — so the duplication cannot rot. **Do not** teach this generator to emit
   them: they would then be declared twice in the same whole-module `swiftc` invocation, which is
   `error: invalid redeclaration of 'MAX_REP_BYTES'`. The wire major is *not* duplicated anywhere:
   everything on the Swift side reads the generated `protocolVersion`.
3. **`.none` cases need qualifying.** `AgentCapabilitiesPaste`, `…ClipboardWatch` and `…Hotkey` each
   have a `none` case, which is ambiguous with `Optional.none` at some call sites. Write
   `AgentCapabilitiesPaste.none`, not `.none`.
4. **There is no generated `res` envelope struct.** `AgentResponseSchema`'s `result` is
   `z.record(z.string(), z.unknown())` on the TypeScript side, which has no honest Swift Codable
   equivalent, so it is deliberately excluded from codegen. `Wire.swift` hand-writes the generic
   envelope (`{"v":1,"t":"res","id":…,"ok":true,"result":<T>}`) over the per-method `*Result` structs
   above.

---

**Branch:** `m1/02-protocol`

---

- [ ] **Step 1: Cut the branch off a freshly fetched `origin/main`.**
      Never commit to `main`.

      ```sh
      cd "$(git rev-parse --show-toplevel)"
      git fetch origin && git checkout -b m1/02-protocol origin/main
      git status --short --branch
      ```

      Expected: `## m1/02-protocol...origin/main` and a clean tree.
      Also confirm you are on Node 24 — the codegen step needs it:

      ```sh
      nvm use && node --version
      ```

      Expected: `v24.20.0`. (`.nvmrc` governs build tooling only; the app runs on Electron's Node.)

- [ ] **Step 2: Verify the scaffolding this task builds on, and do not recreate any of it.**
      The scaffolding task already shipped the `@cairn/protocol` manifest, the complete
      `constants.ts`, its 9-test `constants.test.ts`, `testing.ts` with its 3-test
      `testing.test.ts`, and a two-line barrel. Overwriting any of them is how a frozen constant
      quietly disappears. Check, then move on:

      ```sh
      cat packages/protocol/package.json
      cat packages/protocol/src/index.ts
      grep -cE '^export const (WIRE_MAJOR|TEST_CANARY|MAX_LINE_BYTES|CHUNK_THRESHOLD_BYTES|CHUNK_PAYLOAD_BYTES|MAX_REP_BYTES|SECRET_TTL_MS|APP_NAME|BUNDLE_ID|NPM_SCOPE|MDNS_SERVICE_TYPE|TOAST_COPIED_MANUAL|AGENT_REQUEST_TIMEOUT_MS|WATCH_INTERVAL_MS)\b' packages/protocol/src/constants.ts
      grep -n 'export const \(REPO_ROOT\|fixturePath\)' packages/protocol/src/testing.ts
      ls -l node_modules/@cairn/
      npm run test -w @cairn/protocol
      ```

      Expected:
      - the manifest has `"type": "module"`, `"exports": { ".": "./src/index.ts" }` and
        `"dependencies": { "zod": "4.5.4" }`;
      - `index.ts` is exactly two lines, `export * from './constants'` then
        `export * from './testing'` — you will **append** to it in Step 28 and again in Steps 32, 36
        and 40;
      - the grep prints `14` — every constant this task depends on (`WIRE_MAJOR`, `TEST_CANARY`,
        `MAX_LINE_BYTES`, `CHUNK_THRESHOLD_BYTES`, `CHUNK_PAYLOAD_BYTES`, `MAX_REP_BYTES`,
        `SECRET_TTL_MS`, `APP_NAME`, `BUNDLE_ID`, `NPM_SCOPE`, `MDNS_SERVICE_TYPE`,
        `TOAST_COPIED_MANUAL`, `AGENT_REQUEST_TIMEOUT_MS`, `WATCH_INTERVAL_MS`) is already there.
        `WIRE_MAJOR` is the only one the Swift codegen in Step 44 reads — it becomes
        `let protocolVersion = 1` and is the sole number in the generated file. The six numeric
        limits (`CHUNK_THRESHOLD_BYTES`, `CHUNK_PAYLOAD_BYTES`, `MAX_REP_BYTES`, `MAX_LINE_BYTES`,
        `AGENT_REQUEST_TIMEOUT_MS`, `WATCH_INTERVAL_MS`) are hand-declared in the macOS agent task's
        `Wire.swift` and drift-guarded against this same file by that task's
        `tools/agent-selftest.test.ts`, so a missing one there breaks `make agent`, not just this
        task;
      - `testing.ts` prints both `REPO_ROOT` and `fixturePath`;
      - `protocol -> ../../packages/protocol` is symlinked into `node_modules/@cairn/`;
      - `Test Files  2 passed (2)`, `Tests  12 passed (12)`.

      If `node_modules/@cairn/protocol` is missing, run `npm install` — the workspace link is what
      lets `tools/gen-agent-types.ts` and every other package import `@cairn/protocol` by name. If any
      of the six files is missing, stop: the scaffolding task is incomplete and this task will build
      on sand.

- [ ] **Step 3: Write the failing security test for `LogFields` — `packages/protocol/src/types.test.ts`.**
      This is **security invariant 2** and it is a *compile-time* control. The six
      `@ts-expect-error` directives are the test: `tsc` fails with `TS2578: Unused '@ts-expect-error'
      directive` the moment any of them stops being an error, which is exactly what happens if
      someone adds an index signature to `LogFields` or widens `LogEvent` to `string`. The runtime
      `it()` blocks exist so the file is also a real vitest test (a `.test.ts` with zero tests makes
      vitest fail with `No test suite found`), and so the assertions run in `npm test` too.

      The log types live in `./log`, not `./types` — contract §1's tree puts `LogFields`, `LogEvent`,
      `LOG_EVENTS` and `Logger` in `packages/protocol/src/log.ts`, which **this** task creates,
      complete, with all 46 ids. No later task appends to it: Task 9's step that verifies the log id
      list only asserts the 46 are already present, because appending its seven renderer /
      preview-cache / config ids a second time would give 53 with 7 duplicates and fail
      `log.test.ts`. Task 9 owns the *concrete* NDJSON-to-stderr logger at
      `apps/desktop/main/src/logger.ts`; `log.ts` exports the `Logger` **interface** and no factory,
      deliberately — a second logger implementation living inside `@cairn/protocol` would be a second
      place clipboard content could reach a sink. This file is still named `types.test.ts` because
      contract §1 assigns the `@ts-expect-error` block to it.

      ```ts
      import { describe, expect, expectTypeOf, it } from 'vitest'
      import type { LogEvent, LogFields, Logger } from './log'

      /**
       * SECURITY CONTROL (spec §11 control 2). The logger cannot be handed an item body: `LogFields`
       * is a closed set of metadata keys and `LogEvent` is a closed set of message ids, so putting
       * clipboard content into a log call is a COMPILE error rather than a code-review question.
       *
       * The six `@ts-expect-error` directives below are the test. `tsc` fails with
       * `TS2578: Unused '@ts-expect-error' directive` the moment any of them stops being an error.
       * Run `npm run typecheck` to execute this half of the file.
       */
      const log: Logger = {
        log: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      // @ts-expect-error extra key `text` is not a LogFields key
      log.info('history.ingested', { text: 'CANARY-SECRET' })
      // @ts-expect-error extra key `body` is not a LogFields key
      log.info('history.ingested', { kind: 'text', body: new Uint8Array([1, 2]) })
      // @ts-expect-error `preview` is not a LogFields key
      log.info('privacy.masked', { preview: 'AKIA...' })
      // @ts-expect-error mime must be a string, not bytes
      log.info('history.ingested', { mime: new Uint8Array([1]) })
      // @ts-expect-error the event name is a closed union: no free-form message strings
      log.info('the user copied ' + 'CANARY-SECRET')
      // @ts-expect-error byteLength must be a number
      log.info('history.ingested', { byteLength: 'CANARY-SECRET' })

      describe('LogFields is metadata-only (spec §11 control 2)', () => {
        it('has no index signature, so an arbitrary key cannot be assigned', () => {
          expectTypeOf<LogFields>().not.toHaveProperty('text')
          expectTypeOf<LogFields>().not.toHaveProperty('preview')
          expectTypeOf<LogFields>().not.toHaveProperty('bytes')
          expectTypeOf<LogFields>().not.toHaveProperty('body')
        })

        it('exposes only primitives and closed string unions — no Uint8Array, Buffer or unknown', () => {
          expectTypeOf<LogFields['mime']>().toEqualTypeOf<string | undefined>()
          expectTypeOf<LogFields['byteLength']>().toEqualTypeOf<number | undefined>()
          expectTypeOf<LogFields['ok']>().toEqualTypeOf<boolean | undefined>()
        })

        it('LogEvent is a closed union, not string', () => {
          expectTypeOf<LogEvent>().not.toEqualTypeOf<string>()
          expectTypeOf<'history.ingested'>().toExtend<LogEvent>()
        })

        it('a real logger implementation only ever receives keys drawn from LogFields', () => {
          const seen: string[] = []
          const spy: Logger = {
            log: (_l, _e, f) => seen.push(...Object.keys(f ?? {})),
            debug: (e, f) => spy.log('debug', e, f),
            info: (e, f) => spy.log('info', e, f),
            warn: (e, f) => spy.log('warn', e, f),
            error: (e, f) => spy.log('error', e, f),
          }
          spy.info('history.ingested', { kind: 'text', byteLength: 11, hashPrefix: 'sha256-LPJN' })
          spy.warn('rep.stream-aborted', { code: 'E_REP_HASH_MISMATCH', repCount: 2 })
          expect(seen).toEqual(['kind', 'byteLength', 'hashPrefix', 'code', 'repCount'])
          expect(JSON.stringify(seen)).not.toContain('text')
        })
      })
      ```

- [ ] **Step 4: Write the failing test for the id list — `packages/protocol/src/log.test.ts`.**
      The compile-time control in Step 3 proves no *extra key* reaches the logger. This file proves
      the other half: the id list itself is closed, complete and content-free, so nobody has to invent
      an id mid-task. It also pins the seven shell ids (`renderer.*`, `preview-cache.*`, `config.*`)
      that the desktop-shell task needs, so that task appends nothing to this array — a duplicate id
      would fail the first test here.

      ```ts
      import { describe, expect, it } from 'vitest'
      import { LOG_EVENTS, type LogEvent, type Logger } from './log'

      describe('LOG_EVENTS is the closed set of log message ids', () => {
        it('holds 46 ids with no duplicates', () => {
          expect(LOG_EVENTS).toHaveLength(46)
          expect(new Set(LOG_EVENTS).size).toBe(46)
        })

        it('every id is a dotted lowercase-kebab pair, so no sentence can ever be one', () => {
          for (const e of LOG_EVENTS) expect(e).toMatch(/^[a-z][a-z-]*\.[a-z][a-z-]*$/)
          expect(LOG_EVENTS).not.toContain('the user copied CANARY-SECRET')
        })

        it('covers exactly the fourteen subsystems that log in M1', () => {
          const prefixes = [...new Set(LOG_EVENTS.map((e) => e.split('.')[0]!))].sort()
          expect(prefixes).toEqual([
            'agent', 'app', 'capture', 'config', 'history', 'hotkey', 'ipc', 'keyring',
            'preview-cache', 'privacy', 'recall', 'renderer', 'rep', 'store',
          ])
        })

        it('already carries the seven desktop-shell ids, so no later task appends them again', () => {
          // `satisfies` is the assertion: if one of these is not in the union, this line fails tsc.
          const shellIds = [
            'renderer.navigation-blocked',
            'renderer.permission-denied',
            'preview-cache.evicted-lock',
            'preview-cache.evicted-suspend',
            'preview-cache.evicted-idle',
            'config.loaded-default',
            'config.saved',
          ] satisfies readonly LogEvent[]
          for (const e of shellIds) expect(LOG_EVENTS).toContain(e)
        })

        it('a Logger accepts every id, and the fields bag stays metadata-only', () => {
          const seen: { event: string; keys: string[] }[] = []
          const spy: Logger = {
            log: (_l, e, f) => seen.push({ event: e, keys: Object.keys(f ?? {}) }),
            debug: (e, f) => spy.log('debug', e, f),
            info: (e, f) => spy.log('info', e, f),
            warn: (e, f) => spy.log('warn', e, f),
            error: (e, f) => spy.log('error', e, f),
          }
          for (const e of LOG_EVENTS) spy.info(e, { ok: true })
          expect(seen).toHaveLength(46)
          expect(new Set(seen.flatMap((s) => s.keys))).toEqual(new Set(['ok']))
        })
      })
      ```

- [ ] **Step 5: Run both new tests and watch them fail.**

      ```sh
      npx vitest run packages/protocol/src/types.test.ts packages/protocol/src/log.test.ts
      ```

      Expected: FAIL — `Failed Suites 2`, each with
      `Error: Cannot find module './log' imported from .../packages/protocol/src/<name>.test.ts`.

- [ ] **Step 6: Write `packages/protocol/src/log.ts`.**
      Contract §5.3, plus the seven desktop-shell ids. This is **security invariant 2** in source
      form: every value type is a primitive or an array of a closed string union, so there is no field
      an item body could be assigned to. The three `import type` lines are type-only, so this module
      has **no** runtime dependency on `./types`, `./agent` or `./result` and there is no import cycle
      at runtime — only `LOG_EVENTS` survives compilation.

      ```ts
      import type { AgentEventName, AgentMethod } from './agent'
      import type { ErrorCode } from './result'
      import type { AgentPlatform, DetectorName, Flag, ItemId, ItemKind, KeyringMode } from './types'

      export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

      /** The closed set of log message ids. A free-form string is a compile error, which is what
       *  stops `log.info('the user copied ' + text)`. Add ids here; never inline a message.
       *  The order is frozen: `log.test.ts` pins the count, and appending is the only legal edit. */
      export const LOG_EVENTS = [
        'agent.spawning', 'agent.started', 'agent.exited', 'agent.restart-scheduled',
        'agent.request-timeout', 'agent.line-unparseable', 'agent.wire-major-mismatch',
        'rep.inline-received', 'rep.stream-begin', 'rep.stream-complete', 'rep.stream-aborted',
        'capture.candidate', 'capture.self-write-suppressed', 'capture.debounced', 'capture.thumbnail',
        'privacy.skipped', 'privacy.masked', 'privacy.sync-refused',
        'history.ingested', 'history.duplicate', 'history.evicted', 'history.pinned', 'history.removed',
        'store.opened', 'store.appended', 'store.compacted', 'store.torn-line-discarded',
        'store.blob-written',
        'keyring.mode', 'keyring.backend-refused', 'keyring.unlock-failed', 'keyring.zeroed',
        'hotkey.bound', 'hotkey.bind-failed', 'hotkey.fired',
        // The desktop shell's ids. The preview-cache eviction *reason* lives in the id rather than in
        // a field, because LogFields has no slot for it and inventing one would widen the
        // metadata-only type this whole control rests on.
        'renderer.navigation-blocked', 'renderer.permission-denied',
        'preview-cache.evicted-lock', 'preview-cache.evicted-suspend', 'preview-cache.evicted-idle',
        'config.loaded-default', 'config.saved',
        'ipc.rejected', 'recall.copied', 'app.ready', 'app.quitting',
      ] as const
      export type LogEvent = (typeof LOG_EVENTS)[number]

      /**
       * Metadata only. Every value type is a primitive or an array of a closed string union, so there
       * is no field into which clipboard bytes or a preview could be placed even by accident.
       * DO NOT ADD an index signature and DO NOT widen a value type to `unknown`.
       */
      export interface LogFields {
        readonly kind?: ItemKind
        readonly mime?: string
        readonly byteLength?: number
        readonly repCount?: number
        readonly seq?: number
        /** First 12 chars of a ContentHash, e.g. `sha256-LPJN`. Never the full hash of a short secret. */
        readonly hashPrefix?: string
        readonly itemId?: ItemId
        readonly flags?: readonly Flag[]
        readonly detectors?: readonly DetectorName[]
        readonly code?: ErrorCode
        readonly durationMs?: number
        readonly count?: number
        readonly agent?: AgentPlatform
        readonly method?: AgentMethod
        readonly event?: AgentEventName
        readonly bundleId?: string
        readonly mode?: KeyringMode
        readonly accelerator?: string
        readonly ok?: boolean
        readonly attempt?: number
      }

      /** Collapses every key not in LogFields to `never`, so an extra key is a compile error. */
      export type ExactLogFields<T> = LogFields & {
        readonly [K in Exclude<keyof T, keyof LogFields>]: never
      }

      export interface Logger {
        log<T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>): void
        debug<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
        info<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
        warn<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
        error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
      }
      ```

- [ ] **Step 7: Run both tests and watch them pass.**

      ```sh
      npx vitest run packages/protocol/src/types.test.ts packages/protocol/src/log.test.ts
      ```

      Expected: PASS — `Test Files  2 passed (2)`, `Tests  9 passed (9)` (4 in `types.test.ts`, 5 in
      `log.test.ts`). `tsc` is **not** green yet: `log.ts` type-imports `./types`, `./agent` and
      `./result`, none of which exists. That is expected; Steps 8 and 9 write two of them and the
      first full typecheck is Step 28.

- [ ] **Step 8: Write `packages/protocol/src/types.ts`.**
      Contract §5.1 + §5.4–§5.7. Note the deliberate `import type` cycles with `./agent`, `./log` and
      `./result`: every direction is **type-only**, so there is no runtime cycle. `constants.ts`
      imports nothing, which is what keeps that true — put a new constant there, never here.

      ```ts
      import type { AgentCapabilities, AgentMethod, AgentParams, AgentResult } from './agent'
      import type { LogLevel } from './log'
      import type { ErrorCode, Result } from './result'

      // -------------------------------------------------------------- branded primitives

      declare const contentHashBrand: unique symbol
      /** Always the string `sha256-` followed by 43 chars of unpadded base64url. */
      export type ContentHash = string & { readonly [contentHashBrand]: 'sha256-b64url' }
      export type BlobId = ContentHash

      declare const itemIdBrand: unique symbol
      /** 26-char Crockford base32: 10 chars of ms timestamp then 16 of randomness. Sorts by time. */
      export type ItemId = string & { readonly [itemIdBrand]: 'cairn-id' }

      // -------------------------------------------------------------- capture-side types

      export type ItemKind = 'text' | 'richtext' | 'image' | 'files'
      export type PasteboardHint = 'concealed' | 'transient' | 'auto-generated' | 'password-manager'
      export type AgentPlatform = 'macos' | 'win32' | 'linux'

      export interface SourceApp {
        readonly bundleId: string | null
        readonly name: string | null
        readonly confidence: 'heuristic' | 'unknown'
      }

      /** A representation with its bytes in memory. The wire form is `Rep` in ./agent.ts. */
      export interface ResolvedRep {
        readonly mime: string
        readonly uti: string | null
        readonly bytes: Uint8Array
        readonly byteLength: number
        readonly sha256: ContentHash
      }

      /** What `privacy.classify` is given. No clock, no I/O, no bytes it does not need. */
      export interface Snapshot {
        readonly reps: readonly ResolvedRep[]
        readonly primaryText: string | null
        readonly kind: ItemKind
        readonly hints: readonly PasteboardHint[]
        readonly sourceApp: SourceApp | null
        readonly totalBytes: number
      }

      /** What `capture` emits and `history.ingest` consumes. At most one per clipboard change. */
      export interface Candidate {
        readonly reps: readonly ResolvedRep[]
        readonly kind: ItemKind
        readonly contentHash: ContentHash        // over the PRIMARY representation's bytes only
        readonly primaryText: string | null
        readonly hints: readonly PasteboardHint[]
        readonly sourceApp: SourceApp | null
        readonly thumbnailJpeg: Uint8Array | null
        readonly changeToken: string
        readonly capturedAt: number              // from the injected Clock
      }

      // -------------------------------------------------------------- domain and store types

      export type Flag =
        | 'secret'          // a detector fired
        | 'concealed'       // the OS said so, before any byte was read
        | 'transient'       // org.nspasteboard.TransientType
        | 'auto-generated'  // org.nspasteboard.AutoGeneratedType — usually our own write
        | 'excluded'        // app exclusion list matched (M2 sets this; M1 only honours it)
        | 'no-sync'         // user marked it local-only (M5+ sets this; M1 only honours it)
        | 'cut'             // Windows Preferred DropEffect == 2 (M4)

      /** assertSyncable throws for any of these. */
      export const NON_SYNCABLE_FLAGS = ['secret', 'concealed', 'excluded', 'no-sync'] as const

      export type DetectorName =
        | 'pem-private-key' | 'aws-access-key' | 'github-token' | 'openai-key' | 'anthropic-key'
        | 'slack-token' | 'stripe-live-key' | 'google-api-key' | 'jwt' | 'high-entropy'

      export interface MaskSpan {
        readonly start: number          // UTF-16 code-unit offset into the RAW text
        readonly end: number            // exclusive
        readonly detector: DetectorName
      }

      export interface RepRef {
        readonly mime: string
        readonly uti: string | null
        readonly byteLength: number
        readonly sha256: ContentHash
        readonly blobId: BlobId
      }

      export interface Item {
        readonly id: ItemId
        readonly kind: ItemKind
        readonly contentHash: ContentHash
        /** Masked at ingest. For a secret this is `AKIA••••A7QD`, never the raw value. */
        readonly preview: string
        readonly previewTruncated: boolean
        readonly maskSpans: readonly MaskSpan[]
        readonly flags: readonly Flag[]
        readonly repRefs: readonly RepRef[]
        readonly thumbnailBlobId: BlobId | null
        readonly sourceApp: SourceApp | null
        readonly byteLength: number              // sum of repRefs[].byteLength
        readonly createdAt: number
        readonly updatedAt: number
        readonly pinned: boolean
        /** createdAt + SECRET_TTL_MS for secret-flagged items, else null. */
        readonly expiresAt: number | null
      }

      export interface ItemPatch {
        readonly updatedAt: number
        readonly pinned?: boolean
        readonly expiresAt?: number | null
      }

      export type DeleteReason =
        | 'user' | 'retention-count' | 'retention-age' | 'retention-bytes' | 'secret-ttl' | 'rekey'

      export type StoreEvent =
        | { readonly kind: 'ITEM_ADDED'; readonly seq: number; readonly at: number; readonly item: Item }
        | { readonly kind: 'ITEM_UPDATED'; readonly seq: number; readonly at: number; readonly id: ItemId; readonly patch: ItemPatch }
        | { readonly kind: 'ITEM_DELETED'; readonly seq: number; readonly at: number; readonly id: ItemId; readonly reason: DeleteReason }
        | { readonly kind: 'CHECKPOINT'; readonly seq: number; readonly at: number; readonly maxSeq: number; readonly liveItemCount: number; readonly watermarks: Readonly<Record<string, number>> }

      export type StoreEventKind = StoreEvent['kind']

      export interface ScoredItem {
        readonly item: Item
        readonly score: number
        /**
         * FLAT array of alternating [start, end) UTF-16 offsets into `item.preview`, exactly as
         * ufuzzy's `info.ranges[n]` produces it. NOT an array of pairs.
         */
        readonly ranges: readonly number[]
      }

      export type KeyringMode = 'os-keyring' | 'passphrase' | 'locked'

      // -------------------------------------------------------------- privacy API shapes

      export interface PrivacyRules {
        readonly detectors: readonly DetectorName[]     // default: all ten
        readonly honourHints: boolean                   // default true; false only in tests
        readonly excludedBundleIds: readonly string[]   // always [] in M1
      }

      export interface Classification {
        readonly action: 'record' | 'skip'
        readonly flags: readonly Flag[]
        readonly reason: string
      }

      // -------------------------------------------------------------- the agent's public surface

      export type Unsub = () => void

      export interface AgentEventMap {
        'clipboard.changed': ClipboardChangedPayload
        'rep.chunk': RepChunkPayload
        'hotkey.fired': HotkeyFiredPayload
        log: AgentLogPayload
      }

      /**
       * The interface `@cairn/agent-host` implements and every consumer depends on. `start()` returns
       * a bare promise that REJECTS on spawn failure — it is called once, at composition, and a
       * failure there is fatal, not a value to thread. Every other call returns `Result<T>`.
       */
      export interface ClipboardAgent {
        start(): Promise<AgentCapabilities>
        request<M extends AgentMethod>(
          method: M,
          params: AgentParams<M>,
          timeoutMs?: number,
        ): Promise<Result<AgentResult<M>>>
        on<E extends keyof AgentEventMap>(event: E, cb: (payload: AgentEventMap[E]) => void): Unsub
        dispose(): Promise<void>
      }

      /**
       * The POST-reassembly form. The host has already turned every wire `Rep` into a `ResolvedRep`,
       * so no consumer of `ClipboardAgent` ever sees `repId`, `inline` or a chunk.
       */
      export interface ClipboardChangedPayload {
        readonly changeCount: number
        readonly changeToken: string          // String(changeCount) on macOS
        readonly hints: readonly PasteboardHint[]
        readonly reps: readonly ResolvedRep[]
        readonly sourceApp: SourceApp | null
        readonly droppedReps: readonly { readonly mime: string; readonly code: ErrorCode }[]
      }

      /** Carries NO bytes. It exists only so a progress indicator and the tests can observe chunking. */
      export interface RepChunkPayload {
        readonly repId: string
        readonly seq: number
        readonly final: boolean
      }

      export interface HotkeyFiredPayload {
        readonly accelerator: string
        readonly focusToken: string
        readonly firedAt: number
      }

      /** No `fields`: the agent is not trusted to keep clipboard content out of them, so the host
       *  logs the level and the event id and drops the rest. */
      export interface AgentLogPayload {
        readonly level: LogLevel
        readonly event: string
      }
      ```

- [ ] **Step 9: Write `packages/protocol/src/result.ts`.**
      One convention: expected failures come back as `Result<T>`; unexpected failures throw. This
      makes forgetting a failure path a *compile* error, because you cannot read `.value` off a
      `Result<T>` without narrowing `.ok` first under `strict`.

      ```ts
      import type { LogFields } from './log'

      export interface Ok<T> { readonly ok: true; readonly value: T }
      export interface Err {
        readonly ok: false
        readonly code: ErrorCode
        readonly message: string
        readonly detail?: LogFields
      }
      export type Result<T> = Ok<T> | Err

      export const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
      export const err = (code: ErrorCode, message: string, detail?: LogFields): Err =>
        detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail }

      export const ERROR_CODES = [
        // wire / transport
        'E_PARSE', 'E_LINE_TOO_LONG', 'E_WIRE_MAJOR', 'E_BAD_PARAMS', 'E_UNKNOWN_METHOD', 'E_INTERNAL',
        'E_TIMEOUT', 'E_AGENT_SPAWN', 'E_AGENT_EXIT', 'E_AGENT_DISPOSED',
        // byte transport (spec §4)
        'E_REP_UNKNOWN_ID', 'E_REP_SEQ_GAP', 'E_REP_SEQ_DUPLICATE', 'E_REP_AFTER_FINAL',
        'E_REP_BAD_BASE64', 'E_REP_OVERFLOW', 'E_REP_SHORT', 'E_REP_HASH_MISMATCH',
        'E_REP_TIMEOUT', 'E_REP_TOO_MANY',
        // store
        'E_STORE_CORRUPT', 'E_STORE_CHAIN_BROKEN', 'E_STORE_DECRYPT', 'E_STORE_IO', 'E_BLOB_MISSING',
        // keyring
        'E_KEYRING_UNAVAILABLE', 'E_KEYRING_WEAK_BACKEND', 'E_KEYRING_BAD_PASSPHRASE', 'E_KEYRING_LOCKED',
        // domain
        'E_ITEM_NOT_FOUND', 'E_ITEM_EXPIRED', 'E_PIN_REFUSED_SECRET',
        // hotkey / ipc
        'E_HOTKEY_TAKEN', 'E_HOTKEY_INVALID', 'E_IPC_REJECTED',
      ] as const
      export type ErrorCode = (typeof ERROR_CODES)[number]
      ```

- [ ] **Step 10: Re-run both tests after the split and confirm nothing moved.**

      ```sh
      npx vitest run packages/protocol/src/types.test.ts packages/protocol/src/log.test.ts
      grep -c "^import type" packages/protocol/src/log.ts packages/protocol/src/types.ts packages/protocol/src/result.ts
      ```

      Expected: PASS — `Test Files  2 passed (2)`, `Tests  9 passed (9)`; then one count per file —
      `log.ts:3`, `types.ts:3` and `result.ts:1`, in whatever order your `grep` emits them. Every
      cross-module import inside this package is `import type`,
      which is what makes `log.ts ↔ types.ts ↔ result.ts` a compile-time cycle only — at runtime
      `log.ts` exports one array and imports nothing.
      (`tsc` is still not green: `types.ts` type-imports `./agent`, which arrives in Step 21. That is
      expected and is why the first `npm run typecheck` checkpoint is Step 28.)

- [ ] **Step 11: Prove the security control can fail — temporarily widen `LogFields`.**
      A type test you have never seen fail is decoration. Add an index signature at the top of
      `LogFields` in `packages/protocol/src/log.ts`:

      ```ts
      export interface LogFields {
        readonly [k: string]: unknown        // <-- TEMPORARY, to prove the test bites
        readonly kind?: ItemKind
      ```

      then run:

      ```sh
      npx tsc -p tsconfig.json
      ```

      Expected: FAIL with exactly **7** errors, `[verified]` on TypeScript 5.9.3 against the file as
      written in Step 3 — three of

      ```
      packages/protocol/src/types.test.ts(21,1): error TS2578: Unused '@ts-expect-error' directive.
      packages/protocol/src/types.test.ts(23,1): error TS2578: Unused '@ts-expect-error' directive.
      packages/protocol/src/types.test.ts(25,1): error TS2578: Unused '@ts-expect-error' directive.
      ```

      (the `text`, `body` and `preview` cases — an index signature makes `ExactLogFields<T>` collapse
      to `LogFields`, so those three stop being errors), plus four
      `types.test.ts(36..39,35): error TS2554: Expected 2 arguments, but got 1.` from the
      `expectTypeOf(...).not.toHaveProperty` assertions, which now find the property. That is the
      control biting. If you added a leading comment line to the test file the line numbers shift by
      that much; the **counts** — 3 × TS2578 and 4 × TS2554 — are the assertion.

- [ ] **Step 12: Revert the widening.**
      Delete the `readonly [k: string]: unknown` line you just added. Then:

      ```sh
      git status --short packages/protocol/src
      npx vitest run packages/protocol/src/types.test.ts packages/protocol/src/log.test.ts
      grep -n 'k: string' packages/protocol/src/log.ts
      ```

      Expected: the five files you authored in Steps 3, 4, 6, 8 and 9 show as `??` and nothing else is
      modified; the tests are `Tests  9 passed (9)`; and the `grep` prints nothing — no index signature
      survives anywhere in `log.ts`.

- [ ] **Step 13: Commit the type-level security control.**

      ```sh
      git add packages/protocol/src/log.ts packages/protocol/src/types.ts \
              packages/protocol/src/result.ts packages/protocol/src/types.test.ts \
              packages/protocol/src/log.test.ts
      git commit -m "test(protocol): prove the logger cannot be handed an item body

Adds the metadata-only LogFields type, the closed 46-id LogEvent union and the six
@ts-expect-error directives that make passing clipboard content to the logger a
compile error (spec section 11, control 2)."
      ```

- [ ] **Step 14: Write the failing test for `contentHash` — `packages/protocol/src/hash.test.ts`.**
      The load-bearing case is the last-but-one: **the same bytes wrapped in two different JSON
      encodings must produce the same hash**. Spec §4 keeps canonical encoding out of the security
      TCB precisely so a JSON key-order difference can never change a content hash — dedupe,
      blob addressing and the reassembler's integrity check all rest on that.

      ```ts
      import { createHash } from 'node:crypto'
      import { describe, expect, it } from 'vitest'
      import { contentHash } from './hash'

      describe('contentHash', () => {
        it('is the known-answer vector for "hello", 43 base64url chars after the prefix', () => {
          const h = contentHash(Buffer.from('hello', 'utf8'))
          expect(h).toBe('sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
          expect(h.slice('sha256-'.length)).toHaveLength(43)
          expect(h).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/)
        })

        it('is the known-answer vector for the empty input', () => {
          expect(contentHash(new Uint8Array(0))).toBe(
            'sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
          )
        })

        it('uses base64url, never standard base64 (no +, /, or = ever appears)', () => {
          const h = contentHash(Buffer.from([0x00, 0x01, 0x02, 0x03]))
          expect(h).not.toContain('+')
          expect(h).not.toContain('/')
          expect(h).not.toContain('=')
          expect(h).toBe(
            'sha256-' + createHash('sha256').update(Buffer.from([0, 1, 2, 3])).digest('base64url'),
          )
        })

        it('is stable across repeated calls and independent of the Uint8Array backing', () => {
          const bytes = Buffer.from('AKIA2E0PQIN4XA7QD', 'utf8')
          const viaBuffer = contentHash(bytes)
          const viaCopy = contentHash(new Uint8Array(bytes))
          const oversized = new Uint8Array(64)
          oversized.set(bytes, 8)
          const viaSubarray = contentHash(oversized.subarray(8, 8 + bytes.length))
          expect(viaCopy).toBe(viaBuffer)
          expect(viaSubarray).toBe(viaBuffer)
        })

        it('hashes RAW bytes, so two different JSON encodings of the same rep hash identically', () => {
          // Spec §4 keeps canonical encoding out of the security TCB: nothing is ever hashed over
          // JSON, only over raw representation bytes. If someone "helpfully" hashed the envelope
          // instead, these two lines — same bytes, different key order and whitespace — would diverge.
          const raw = Buffer.from('the primary representation bytes', 'utf8')
          const b64 = raw.toString('base64')
          const encodingA = `{"mime":"text/plain","byteLength":${raw.length},"inline":"${b64}"}`
          const encodingB = `{ "inline": "${b64}",\n  "byteLength": ${raw.length}, "mime": "text/plain" }`
          expect(encodingA).not.toBe(encodingB)

          const bytesFromA = Buffer.from(JSON.parse(encodingA).inline as string, 'base64')
          const bytesFromB = Buffer.from(JSON.parse(encodingB).inline as string, 'base64')

          expect(contentHash(bytesFromA)).toBe(contentHash(bytesFromB))
          expect(contentHash(bytesFromA)).toBe(contentHash(raw))
          // And hashing the JSON text itself is a DIFFERENT value — the thing we must never do.
          expect(contentHash(Buffer.from(encodingA, 'utf8'))).not.toBe(contentHash(raw))
        })

        it('is order-sensitive: swapping two bytes changes the hash', () => {
          expect(contentHash(Buffer.from([1, 2]))).not.toBe(contentHash(Buffer.from([2, 1])))
        })
      })
      ```

- [ ] **Step 15: Run it and watch it fail.**

      ```sh
      npx vitest run packages/protocol/src/hash.test.ts
      ```

      Expected: FAIL — `Failed Suites 1`, with
      `Error: Cannot find module './hash' imported from .../packages/protocol/src/hash.test.ts`.

- [ ] **Step 16: Write `packages/protocol/src/hash.ts` — the minimal implementation.**

      ```ts
      import { createHash } from 'node:crypto'
      import type { ContentHash } from './types'

      /** `sha256-<43 char base64url>`. Hashed over RAW representation bytes, never over JSON. */
      export function contentHash(bytes: Uint8Array): ContentHash {
        return ('sha256-' + createHash('sha256').update(bytes).digest('base64url')) as ContentHash
      }
      ```

- [ ] **Step 17: Run it and watch it pass.**

      ```sh
      npx vitest run packages/protocol/src/hash.test.ts
      ```

      Expected: PASS — `Tests  6 passed (6)`.
      Sanity check that the macOS agent will agree, since `Chunker.swift` computes the same string
      with CryptoKit: `sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ` is 43 chars after the
      prefix and matches `ContentHashSchema`'s regex, which Step 19 asserts.

- [ ] **Step 18: Commit the hash.**

      ```sh
      git add packages/protocol/src/hash.ts packages/protocol/src/hash.test.ts
      git commit -m "feat(protocol): contentHash over raw representation bytes, never over JSON"
      ```

- [ ] **Step 19: Write the failing test for the agent schemas — `packages/protocol/src/agent.test.ts`.**
      Four things here are non-negotiable and each is a separate `describe`: the envelope round-trips;
      **unknown map keys are IGNORED, never an error** (spec §4 — a future agent must not break an
      older host); the `Rep` inline-vs-`repId` rules that keep clipboard bytes off the disk; and the
      `rep.chunk` sequence, including rejecting a negative or non-integer `seq`.

      ```ts
      import { describe, expect, it } from 'vitest'
      import {
        AgentCapabilitiesSchema,
        AgentEventSchema,
        AgentLineSchema,
        AgentRequestSchema,
        AgentResponseSchema,
        AgentResultSchema,
        RepSchema,
      } from './agent'
      import { CHUNK_PAYLOAD_BYTES, CHUNK_THRESHOLD_BYTES, MAX_REP_BYTES, WIRE_MAJOR } from './constants'

      const inlineRep = {
        mime: 'text/plain',
        uti: 'public.utf8-plain-text',
        byteLength: 11,
        sha256: 'sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek',
        inline: 'aGVsbG8gd29ybGQ=',
      }

      describe('the envelope', () => {
        it('round-trips a request unchanged', () => {
          const line = { v: WIRE_MAJOR, t: 'req', id: '7', method: 'read', params: { changeCount: 363 } }
          const parsed = AgentLineSchema.parse(line)
          expect(parsed).toEqual(line)
          expect(JSON.parse(JSON.stringify(parsed))).toEqual(line)
        })

        it('round-trips an ok response and an error response, discriminated by `ok`', () => {
          const okLine = { v: 1, t: 'res', id: '7', ok: true, result: { changeToken: '364' } }
          const errLine = {
            v: 1, t: 'res', id: '7', ok: false,
            error: { code: 'E_TIMEOUT', message: 'promised read timed out' },
          }
          expect(AgentResponseSchema.parse(okLine)).toEqual(okLine)
          expect(AgentResponseSchema.parse(errLine)).toEqual(errLine)
        })

        it('rejects a response carrying both result and error, by dropping the unknown one', () => {
          // `ok: true` selects the first union option, whose shape has no `error` key, so `error` is
          // stripped rather than accepted. The invariant is "there is never both" on the output side.
          const parsed = AgentResponseSchema.parse({
            v: 1, t: 'res', id: '9', ok: true, result: { bye: true },
            error: { code: 'E_INTERNAL', message: 'nope' },
          })
          expect(parsed).not.toHaveProperty('error')
        })

        it('rejects an unknown outer discriminator with issue code invalid_union', () => {
          const r = AgentLineSchema.safeParse({ v: 1, t: 'nope', id: '1' })
          expect(r.success).toBe(false)
          expect(r.error?.issues[0]?.code).toBe('invalid_union')
        })

        it('rejects an M2-reserved method name — an M1 host has no business sending it', () => {
          for (const method of ['paste', 'focus.capture', 'permission.request', 'capture.now']) {
            const r = AgentRequestSchema.safeParse({ v: 1, t: 'req', id: '1', method, params: {} })
            expect(r.success, `${method} must not parse in M1`).toBe(false)
          }
        })
      })

      describe('unknown keys are IGNORED, never an error (spec §4)', () => {
        const line = {
          v: 1, t: 'ev', event: 'clipboard.changed',
          alsoNew: 'top-level key from a future agent',
          data: {
            changeCount: 364, hints: [], reps: [inlineRep],
            frontmostBundleId: 'com.apple.TextEdit', frontmostName: 'TextEdit',
            attributionConfidence: 'heuristic',
            futureField: { nested: true },
          },
        }

        it('parses successfully', () => {
          expect(AgentLineSchema.safeParse(line).success).toBe(true)
        })

        it('strips both the top-level and the nested unknown key from the output', () => {
          const parsed = AgentLineSchema.parse(line)
          expect(parsed).not.toHaveProperty('alsoNew')
          expect(JSON.stringify(parsed)).not.toContain('futureField')
          expect(JSON.stringify(parsed)).not.toContain('alsoNew')
        })

        it('still parses when a wholly unknown key appears inside a Rep', () => {
          const r = RepSchema.safeParse({ ...inlineRep, tomorrowsField: 42 })
          expect(r.success).toBe(true)
          expect(r.data).not.toHaveProperty('tomorrowsField')
        })
      })

      describe('Rep transport rules', () => {
        it('accepts an inline rep under the chunk threshold', () => {
          expect(RepSchema.safeParse(inlineRep).success).toBe(true)
        })

        it('defaults a missing uti to null rather than leaving it undefined', () => {
          const { uti: _drop, ...withoutUti } = inlineRep
          expect(RepSchema.parse(withoutUti).uti).toBeNull()
        })

        it('rejects a rep carrying both inline and repId', () => {
          const r = RepSchema.safeParse({ ...inlineRep, repId: 'r1' })
          expect(r.success).toBe(false)
          expect(r.error?.issues.some((i) => i.message.includes('exactly one of inline | repId'))).toBe(true)
        })

        it('rejects a rep carrying neither inline nor repId', () => {
          const { inline: _drop, ...naked } = inlineRep
          expect(RepSchema.safeParse(naked).success).toBe(false)
        })

        it('requires repId at or over the chunk threshold, and inline below it', () => {
          const big = {
            mime: 'image/png', uti: 'public.png', byteLength: CHUNK_THRESHOLD_BYTES,
            sha256: 'sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
          }
          expect(RepSchema.safeParse({ ...big, repId: 'r1' }).success).toBe(true)
          expect(RepSchema.safeParse({ ...big, inline: 'AAAA' }).success).toBe(false)
          const small = { ...big, byteLength: CHUNK_THRESHOLD_BYTES - 1 }
          expect(RepSchema.safeParse({ ...small, repId: 'r1' }).success).toBe(false)
          expect(RepSchema.safeParse({ ...small, inline: 'AAAA' }).success).toBe(true)
        })

        it('rejects a byteLength over MAX_REP_BYTES so the reassembler never allocates it', () => {
          const r = RepSchema.safeParse({ ...inlineRep, byteLength: MAX_REP_BYTES + 1, inline: undefined, repId: 'r1' })
          expect(r.success).toBe(false)
        })

        it('rejects a malformed sha256 that is not sha256-<43 base64url chars>', () => {
          for (const bad of ['sha256-tooshort', 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ', 'sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmC=']) {
            expect(RepSchema.safeParse({ ...inlineRep, sha256: bad }).success, bad).toBe(false)
          }
        })
      })

      describe('rep.chunk events', () => {
        const chunk = (seq: number, final: boolean) => ({
          v: 1, t: 'ev', event: 'rep.chunk',
          data: { repId: 'r1', seq, final, b64: Buffer.alloc(CHUNK_PAYLOAD_BYTES, 7).toString('base64') },
        })

        it('validates a real 7-chunk sequence for a 200 000-byte payload', () => {
          // 200000 / 32768 = 6 full chunks + a 3 392-byte remainder = 7 chunks, seq 0..6.
          const total = 200_000
          const chunkCount = Math.ceil(total / CHUNK_PAYLOAD_BYTES)
          expect(chunkCount).toBe(7)
          for (let seq = 0; seq < chunkCount; seq++) {
            const ev = chunk(seq, seq === chunkCount - 1)
            const parsed = AgentEventSchema.parse(ev)
            expect(parsed).toMatchObject({ event: 'rep.chunk', data: { repId: 'r1', seq } })
          }
        })

        it('rejects a negative seq', () => {
          const r = AgentEventSchema.safeParse(chunk(-1, false))
          expect(r.success).toBe(false)
          expect(r.error?.issues[0]?.code).toBe('too_small')
        })

        it('rejects a non-integer seq', () => {
          const r = AgentEventSchema.safeParse(chunk(1.5, false))
          expect(r.success).toBe(false)
          expect(r.error?.issues[0]?.code).toBe('invalid_type')
        })

        it('rejects a b64 payload that is not base64 at all', () => {
          const bad = { v: 1, t: 'ev', event: 'rep.chunk', data: { repId: 'r1', seq: 0, final: true, b64: 'not base64!!' } }
          expect(AgentEventSchema.safeParse(bad).success).toBe(false)
        })
      })

      describe('AgentResultSchema', () => {
        it('is keyed by every method AgentRequestSchema accepts, and by nothing else', () => {
          const methods = AgentRequestSchema.options.map((o) => o.shape.method.value as string).sort()
          expect(Object.keys(AgentResultSchema).sort()).toEqual(methods)
          expect(methods).toEqual([
            'hello', 'hotkey.register', 'hotkey.unregister', 'read', 'shutdown',
            'watch.start', 'watch.stop', 'write',
          ])
        })

        it('hello returns the capability block with wireMajor pinned to WIRE_MAJOR', () => {
          const caps = {
            wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1', tier: 'A',
            clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon',
            focusApp: true, concealedTypeHints: true,
            maxRepBytes: MAX_REP_BYTES, chunkThresholdBytes: CHUNK_THRESHOLD_BYTES, missingTools: [],
          }
          expect(AgentCapabilitiesSchema.parse(caps)).toEqual(caps)
          expect(AgentCapabilitiesSchema.safeParse({ ...caps, wireMajor: 2 }).success).toBe(false)
          expect(AgentResultSchema.hello).toBe(AgentCapabilitiesSchema)
        })

        it('hotkey.register returns a boolean `bound`, never an error — a dead hotkey is a state', () => {
          expect(AgentResultSchema['hotkey.register'].parse({ bound: false, accelerator: 'Cmd+Shift+V' }))
            .toEqual({ bound: false, accelerator: 'Cmd+Shift+V' })
        })
      })
      ```

- [ ] **Step 20: Run it and watch it fail.**

      ```sh
      npx vitest run packages/protocol/src/agent.test.ts
      ```

      Expected: FAIL — `Failed Suites 1`, with
      `Error: Cannot find module './agent' imported from .../packages/protocol/src/agent.test.ts`.

- [ ] **Step 21: Write `packages/protocol/src/agent.ts` — the frozen schemas, verbatim.**
      Do not "improve" these. `hotkey.register` returning `{bound: boolean}` instead of an error
      response is deliberate: spec §4 makes a silently dead hotkey a first-class state, so the
      boolean must be inspected by `@cairn/hotkey`, not swallowed by a rejected promise.

      ```ts
      import * as z from 'zod'
      import { CHUNK_THRESHOLD_BYTES, MAX_REP_BYTES, WIRE_MAJOR } from './constants'

      export const ContentHashSchema = z
        .string()
        .regex(/^sha256-[A-Za-z0-9_-]{43}$/, 'expected sha256-<43 char base64url>')
      export const MimeSchema = z.string().min(1).max(255)
      export const IdSchema = z.string().min(1).max(64)

      /**
       * A representation as it travels on the wire. Exactly one of `inline` / `repId` is present, and
       * which one is a pure function of `byteLength` — spec §4. There is NO third option: an
       * oversized rep streams over the stdout pipe, it never spools to a file.
       */
      export const RepSchema = z
        .object({
          mime: MimeSchema,
          uti: z.string().max(255).nullable().default(null),
          byteLength: z.int().min(0).max(MAX_REP_BYTES),
          sha256: ContentHashSchema,
          inline: z.base64().optional(),
          repId: IdSchema.optional(),
        })
        .refine((r) => (r.inline === undefined) !== (r.repId === undefined), {
          error: 'exactly one of inline | repId must be present',
        })
        .refine(
          (r) => (r.byteLength < CHUNK_THRESHOLD_BYTES ? r.inline !== undefined : r.repId !== undefined),
          { error: `reps under ${CHUNK_THRESHOLD_BYTES} bytes travel inline; at or over that they travel as repId` },
        )

      export const HintSchema = z.enum(['concealed', 'transient', 'auto-generated', 'password-manager'])

      export const AgentCapabilitiesSchema = z.object({
        wireMajor: z.literal(WIRE_MAJOR),
        agent: z.enum(['macos', 'win32', 'linux']),
        agentVersion: z.string().min(1),
        platformVersion: z.string().min(1),
        tier: z.enum(['A', 'B', 'C', 'D']),
        clipboardWatch: z.enum([
          'changecount-poll', 'sequence-poll', 'xfixes', 'wl-paste-watch', 'focus-only', 'none',
        ]),
        paste: z.enum(['cgevent', 'sendinput', 'ydotool', 'none']),
        hotkey: z.enum(['carbon', 'win32-hotkey', 'portal', 'electron', 'none']),
        focusApp: z.boolean(),
        concealedTypeHints: z.boolean(),
        maxRepBytes: z.int().positive(),
        chunkThresholdBytes: z.int().positive(),
        missingTools: z.array(z.string()).default([]),
      })

      const req = <M extends string, P extends z.ZodType>(method: M, params: P) =>
        z.object({
          v: z.literal(WIRE_MAJOR),
          t: z.literal('req'),
          id: IdSchema,
          method: z.literal(method),
          params,
        })

      export const AgentRequestSchema = z.discriminatedUnion('method', [
        req('hello', z.object({ hostVersion: z.string().min(1) })),
        req('watch.start', z.object({ intervalMs: z.int().min(50).max(60_000) })),
        req('watch.stop', z.object({})),
        req('read', z.object({ changeCount: z.int() })),
        req(
          'write',
          z.object({
            // Inline on purpose: the Swift codegen names a nested object after its owner, so this
            // becomes `struct WriteParamsRepsItem`, which is the name Task 4's `Writer.swift` is
            // written against. Do not hoist it to a named export — that would rename the Swift type.
            reps: z
              .array(z.object({ mime: MimeSchema, uti: z.string().nullable().default(null), b64: z.base64() }))
              .min(1),
            transient: z.boolean(),
          }),
        ),
        req('hotkey.register', z.object({ accelerator: z.string().min(1).max(64) })),
        req('hotkey.unregister', z.object({})),
        req('shutdown', z.object({})),
      ])

      /** The per-method result payload. Keyed by method name so `AgentResult<M>` can index it. */
      export const AgentResultSchema = {
        hello: AgentCapabilitiesSchema,
        'watch.start': z.object({ watching: z.literal(true), intervalMs: z.int() }),
        'watch.stop': z.object({ watching: z.literal(false) }),
        read: z.object({
          changeCount: z.int(),
          hints: z.array(HintSchema).default([]),
          reps: z.array(RepSchema),
        }),
        write: z.object({ changeToken: z.string().min(1) }),
        'hotkey.register': z.object({ bound: z.boolean(), accelerator: z.string() }),
        'hotkey.unregister': z.object({ bound: z.literal(false) }),
        shutdown: z.object({ bye: z.literal(true) }),
      } as const

      export const AgentErrorSchema = z.object({
        code: z.string().min(1).max(64),
        message: z.string().max(2_048),
      })

      export const AgentResponseSchema = z.discriminatedUnion('ok', [
        z.object({
          v: z.literal(WIRE_MAJOR),
          t: z.literal('res'),
          id: IdSchema,
          ok: z.literal(true),
          result: z.record(z.string(), z.unknown()),
        }),
        z.object({
          v: z.literal(WIRE_MAJOR),
          t: z.literal('res'),
          id: IdSchema,
          ok: z.literal(false),
          error: AgentErrorSchema,
        }),
      ])

      const ev = <E extends string, D extends z.ZodType>(event: E, data: D) =>
        z.object({ v: z.literal(WIRE_MAJOR), t: z.literal('ev'), event: z.literal(event), data })

      export const AgentEventSchema = z.discriminatedUnion('event', [
        ev(
          'clipboard.changed',
          z.object({
            changeCount: z.int(),
            hints: z.array(HintSchema).default([]),
            reps: z.array(RepSchema),
            frontmostBundleId: z.string().nullable().default(null),
            frontmostName: z.string().nullable().default(null),
            attributionConfidence: z.enum(['heuristic', 'unknown']),
          }),
        ),
        ev(
          'rep.chunk',
          z.object({ repId: IdSchema, seq: z.int().min(0), final: z.boolean(), b64: z.base64() }),
        ),
        ev(
          'hotkey.fired',
          z.object({ accelerator: z.string().min(1), focusToken: z.string().min(1), firedAt: z.int() }),
        ),
        ev(
          'log',
          z.object({
            level: z.enum(['debug', 'info', 'warn', 'error']),
            event: z.string().min(1).max(64),
            fields: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
              .default({}),
          }),
        ),
      ])

      export const AgentLineSchema = z.discriminatedUnion('t', [
        AgentRequestSchema,
        AgentResponseSchema,
        AgentEventSchema,
      ])

      export type Rep = z.output<typeof RepSchema>
      export type PasteboardHintWire = z.output<typeof HintSchema>
      export type AgentCapabilities = z.output<typeof AgentCapabilitiesSchema>
      export type AgentRequest = z.output<typeof AgentRequestSchema>
      export type AgentResponse = z.output<typeof AgentResponseSchema>
      export type AgentEvent = z.output<typeof AgentEventSchema>
      export type AgentLine = z.output<typeof AgentLineSchema>
      export type AgentMethod = AgentRequest['method']
      export type AgentEventName = AgentEvent['event']
      export type AgentParams<M extends AgentMethod> = Extract<AgentRequest, { method: M }>['params']
      export type AgentResult<M extends AgentMethod> = z.output<(typeof AgentResultSchema)[M]>
      ```

- [ ] **Step 22: Run it and watch it pass.**

      ```sh
      npx vitest run packages/protocol/src/agent.test.ts
      ```

      Expected: PASS — `Tests  22 passed (22)`.

- [ ] **Step 23: Commit the agent schemas.**

      ```sh
      git add packages/protocol/src/agent.ts packages/protocol/src/agent.test.ts
      git commit -m "feat(protocol): the frozen agent NDJSON zod schemas

Unknown map keys are stripped, never rejected, so a newer agent cannot break an
older host. Rep carries exactly one of inline | repId, chosen purely by
byteLength against CHUNK_THRESHOLD_BYTES: there is no spool-file path."
      ```

- [ ] **Step 24: Write the failing test for `parseAgentLine` — `packages/protocol/src/parse-agent-line.test.ts`.**
      Three properties matter. It **never throws** — it is fed by a pipe, and a wedged or hostile
      agent must not be able to crash the host with a torn line. It distinguishes `E_WIRE_MAJOR` from
      `E_PARSE`, because "future agent" and "garbage" get different recovery. And it refuses a line
      over `MAX_LINE_BYTES` **in bytes**, before `JSON.parse` ever sees it, because an unbounded line
      is a memory attack.

      ```ts
      import { describe, expect, it } from 'vitest'
      import { MAX_LINE_BYTES, WIRE_MAJOR } from './constants'
      import { parseAgentLine } from './parse-agent-line'

      const helloRes = JSON.stringify({
        v: WIRE_MAJOR, t: 'res', id: '1', ok: true,
        result: {
          wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1', tier: 'A',
          clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon',
          focusApp: true, concealedTypeHints: true,
          maxRepBytes: 20971520, chunkThresholdBytes: 65536, missingTools: [],
        },
      })

      describe('parseAgentLine — happy path', () => {
        it('parses each of the three envelope shapes and narrows on Result.ok', () => {
          const req = parseAgentLine('{"v":1,"t":"req","id":"7","method":"read","params":{"changeCount":363}}')
          expect(req.ok).toBe(true)
          if (!req.ok) throw new Error(req.message)
          expect(req.value.t).toBe('req')

          const res = parseAgentLine(helloRes)
          expect(res.ok).toBe(true)

          const ev = parseAgentLine(
            '{"v":1,"t":"ev","event":"hotkey.fired","data":{"accelerator":"Cmd+Shift+V","focusToken":"tok-1","firedAt":1767225600000}}',
          )
          expect(ev.ok).toBe(true)
          if (!ev.ok) throw new Error(ev.message)
          expect(ev.value).toMatchObject({ t: 'ev', event: 'hotkey.fired' })
        })
      })

      describe('parseAgentLine — unknown keys are ignored, never an error (spec §4)', () => {
        const line =
          '{"v":1,"t":"ev","event":"clipboard.changed","alsoNew":true,"data":{"changeCount":364,"hints":[],"reps":[],"frontmostBundleId":null,"frontmostName":null,"attributionConfidence":"heuristic","futureField":"whatever"}}'

        it('does not throw and does not return an error', () => {
          expect(() => parseAgentLine(line)).not.toThrow()
          expect(parseAgentLine(line).ok).toBe(true)
        })

        it('strips the unknown keys from the parsed value', () => {
          const r = parseAgentLine(line)
          if (!r.ok) throw new Error(r.message)
          expect(JSON.stringify(r.value)).not.toContain('alsoNew')
          expect(JSON.stringify(r.value)).not.toContain('futureField')
        })
      })

      describe('parseAgentLine — malformed input returns a typed error, never a crash', () => {
        it('returns E_PARSE for a torn half-line rather than throwing', () => {
          const torn = '{"v":1,"t":"ev","event":"clipboard.chan'
          expect(() => parseAgentLine(torn)).not.toThrow()
          const r = parseAgentLine(torn)
          expect(r).toMatchObject({ ok: false, code: 'E_PARSE', message: 'line is not valid JSON' })
        })

        it('returns E_PARSE for a human-readable line that leaked onto stdout', () => {
          const r = parseAgentLine('cairn-agent: starting up')
          expect(r).toMatchObject({ ok: false, code: 'E_PARSE' })
        })

        it('returns E_PARSE with a prettified reason for a valid-JSON line of the wrong shape', () => {
          const r = parseAgentLine('{"v":1,"t":"req","id":"1","method":"teleport","params":{}}')
          expect(r.ok).toBe(false)
          if (r.ok) throw new Error('expected a failure')
          expect(r.code).toBe('E_PARSE')
          expect(r.message.length).toBeGreaterThan(0)
          expect(r.message).toContain('✖')
        })

        it('returns E_PARSE for a JSON scalar, an array and null', () => {
          for (const line of ['42', '"hello"', '[]', 'null', 'true']) {
            expect(parseAgentLine(line)).toMatchObject({ ok: false, code: 'E_PARSE' })
          }
        })

        it('returns E_PARSE for the empty string', () => {
          expect(parseAgentLine('')).toMatchObject({ ok: false, code: 'E_PARSE' })
        })
      })

      describe('parseAgentLine — wire major', () => {
        it('returns E_WIRE_MAJOR, not E_PARSE, for a future wire version', () => {
          const r = parseAgentLine('{"v":2,"t":"req","id":"1","method":"read","params":{"changeCount":1}}')
          expect(r).toMatchObject({ ok: false, code: 'E_WIRE_MAJOR' })
          if (r.ok) throw new Error('expected a failure')
          expect(r.message).toBe('unsupported wire major 2')
        })

        it('returns E_WIRE_MAJOR for a non-numeric v', () => {
          const r = parseAgentLine('{"v":"1","t":"req","id":"1","method":"read","params":{"changeCount":1}}')
          expect(r).toMatchObject({ ok: false, code: 'E_WIRE_MAJOR', message: 'unsupported wire major 1' })
        })
      })

      describe('parseAgentLine — the line-length cap is checked BEFORE JSON.parse', () => {
        it('returns E_LINE_TOO_LONG for a line one byte over the cap instead of buffering it', () => {
          // The guard exists because an unbounded line is a memory attack: a wedged or hostile agent
          // could stream a gigabyte with no newline. We must refuse without parsing.
          const padding = 'A'.repeat(MAX_LINE_BYTES)
          const line = `{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"x","fields":{"pad":"${padding}"}}}`
          expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(MAX_LINE_BYTES)
          const r = parseAgentLine(line)
          expect(r).toMatchObject({
            ok: false, code: 'E_LINE_TOO_LONG', message: `line exceeds ${MAX_LINE_BYTES} bytes`,
          })
        })

        it('accepts a line of exactly MAX_LINE_BYTES — the guard is > not >=', () => {
          const prefix = '{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"x","fields":{"p":"'
          const suffix = '"}}}'
          const pad = 'A'.repeat(MAX_LINE_BYTES - prefix.length - suffix.length)
          const line = prefix + pad + suffix
          expect(Buffer.byteLength(line, 'utf8')).toBe(MAX_LINE_BYTES)
          expect(parseAgentLine(line).ok).toBe(true)
        })

        it('measures BYTES not characters, so a multi-byte line cannot sneak past the cap', () => {
          // '€' is 3 UTF-8 bytes. A char-based guard would accept this; a byte-based guard must not.
          const prefix = '{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"x","fields":{"p":"'
          const suffix = '"}}}'
          const euros = '€'.repeat(Math.ceil((MAX_LINE_BYTES - prefix.length - suffix.length) / 3) + 1)
          const line = prefix + euros + suffix
          expect(line.length).toBeLessThan(MAX_LINE_BYTES)
          expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(MAX_LINE_BYTES)
          expect(parseAgentLine(line)).toMatchObject({ ok: false, code: 'E_LINE_TOO_LONG' })
        })
      })
      ```

- [ ] **Step 25: Run it and watch it fail.**

      ```sh
      npx vitest run packages/protocol/src/parse-agent-line.test.ts
      ```

      Expected: FAIL — `Failed Suites 1`, with `Error: Cannot find module './parse-agent-line'
      imported from .../packages/protocol/src/parse-agent-line.test.ts`.

- [ ] **Step 26: Write `packages/protocol/src/parse-agent-line.ts`.**
      Order matters: length cap → `JSON.parse` in a `try` → wire-major check → schema. Reordering
      any of those loses a guarantee (checking the schema first would parse a 1 GB line).

      ```ts
      import * as z from 'zod'
      import { AgentLineSchema, type AgentLine } from './agent'
      import { MAX_LINE_BYTES } from './constants'
      import { err, ok, type Result } from './result'

      /** Parses one NDJSON line. Never throws. Unknown keys are stripped, not rejected. */
      export function parseAgentLine(line: string): Result<AgentLine> {
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          return err('E_LINE_TOO_LONG', `line exceeds ${MAX_LINE_BYTES} bytes`)
        }
        let json: unknown
        try {
          json = JSON.parse(line)
        } catch {
          return err('E_PARSE', 'line is not valid JSON')
        }
        if (typeof json === 'object' && json !== null && 'v' in json && (json as { v: unknown }).v !== 1) {
          return err('E_WIRE_MAJOR', `unsupported wire major ${String((json as { v: unknown }).v)}`)
        }
        const parsed = AgentLineSchema.safeParse(json)
        if (!parsed.success) return err('E_PARSE', z.prettifyError(parsed.error))
        return ok(parsed.data)
      }
      ```

- [ ] **Step 27: Run it and watch it pass.**

      ```sh
      npx vitest run packages/protocol/src/parse-agent-line.test.ts
      ```

      Expected: PASS — `Tests  13 passed (13)`.

- [ ] **Step 28: Append six lines to the barrel, and take the first full typecheck.**
      The scaffolding task shipped `packages/protocol/src/index.ts` containing exactly
      `export * from './constants'` and `export * from './testing'`. **Append**, do not overwrite —
      deleting the `./testing` line breaks the eight fixture-reading test files in the capture and
      privacy task. The barrel is the **only** export the manifest declares.

      After this step the barrel has **eight** lines. The final three — `./clock`, `./id` and `./ipc` —
      are appended one at a time by Steps 32, 36 and 40 as those files land, giving **eleven**. Adding
      them now would fail hard with `Cannot find module './clock'`. (Contract §5's barrel snippet lists
      the finished **eleven** lines, `./log` and `./testing` included; if the copy you are reading has
      ten, one module is unreachable through the package's only export — fix the contract, not this
      step.)

      The whole file after your edit, sorted so appends are conflict-free:

      ```ts
      // packages/protocol/src/index.ts
      export * from './agent'
      export * from './constants'
      export * from './hash'
      export * from './log'
      export * from './parse-agent-line'
      export * from './result'
      export * from './testing'
      export * from './types'
      ```

      ```sh
      npx tsc -p tsconfig.json
      npm run test -w @cairn/protocol
      grep -c '^export \* from' packages/protocol/src/index.ts
      ```

      Expected: `tsc` prints nothing and exits 0 (check with `echo $?`); the workspace test run reports
      `Test Files  7 passed (7)`, `Tests  62 passed (62)` — your five files plus the scaffolding task's
      `constants.test.ts` and `testing.test.ts`; and the grep prints `8`.

      Do **not** try to smoke-test the barrel with `node -e "import('@cairn/protocol')"`. Node's ESM
      resolver has no extension search, so the extensionless `./agent` inside this barrel is
      `ERR_MODULE_NOT_FOUND` there. `moduleResolution: "bundler"` resolves it for `tsc`, and vite and
      vitest resolve it at runtime — which is every consumer this repo has. The one exception is
      `node tools/gen-agent-types.ts`, and that is exactly why Step 44 installs a `registerHooks`
      resolver that appends `.ts`.

- [ ] **Step 29: Commit `parseAgentLine` and the barrel.**

      ```sh
      git add packages/protocol/src/parse-agent-line.ts \
              packages/protocol/src/parse-agent-line.test.ts packages/protocol/src/index.ts
      git commit -m "feat(protocol): parseAgentLine returns a typed Result and never throws

Refuses a line over MAX_LINE_BYTES in bytes before JSON.parse sees it, so an
unbounded line from a wedged agent cannot be buffered."
      ```

- [ ] **Step 30: Write the failing test for the injected clock — `packages/protocol/src/clock.test.ts`.**
      Nothing outside `systemClock` may ever call `Date.now()`, `setTimeout`, `setInterval` or
      `performance.now()`, so this module is the single seam every timeout in the repo goes through:
      the agent host's request timeouts and restart backoff, the rep-stream timeout, the capture
      debounce, the secret TTL and retention. Test 3 is the sequence the contract §5.8 marks
      `[verified]`; if it does not reproduce exactly, `advance()` is wrong and every timing test
      downstream is meaningless.

      ```ts
      import { describe, expect, it, vi } from 'vitest'
      import { createTestClock, systemClock, type Cancel } from './clock'

      describe('systemClock', () => {
        it('reads the real clock, and its Cancel closure clears the timer', () => {
          vi.useFakeTimers()
          try {
            vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
            expect(systemClock.now()).toBe(Date.parse('2026-09-02T00:00:00.000Z'))

            const fired: string[] = []
            const cancel: Cancel = systemClock.setTimeout(() => fired.push('cancelled'), 50)
            cancel()
            vi.advanceTimersByTime(100)
            expect(fired).toEqual([])

            systemClock.setTimeout(() => fired.push('kept'), 50)
            vi.advanceTimersByTime(50)
            expect(fired).toEqual(['kept'])
          } finally {
            vi.useRealTimers()
          }
        })
      })

      describe('createTestClock', () => {
        it('starts at 2026-01-01T00:00:00Z, so every test timestamp is recognisable', () => {
          const clock = createTestClock()
          expect(clock.now()).toBe(1_767_225_600_000)
          expect(new Date(clock.now()).toISOString()).toBe('2026-01-01T00:00:00.000Z')
          expect(clock.pending).toBe(0)
        })

        it('fires only the timers inside the window, in deadline order, leaving now at the target', () => {
          const clock = createTestClock(1_000)
          const fired: string[] = []
          clock.setTimeout(() => fired.push('a'), 100)
          clock.setTimeout(() => fired.push('b'), 200)
          const cancelC = clock.setTimeout(() => fired.push('c'), 150)
          expect(clock.pending).toBe(3)

          cancelC()
          expect(clock.pending).toBe(2)

          clock.advance(150)
          expect(fired).toEqual(['a'])
          expect(clock.now()).toBe(1_150)
          expect(clock.pending).toBe(1)

          clock.advance(100)
          expect(fired).toEqual(['a', 'b'])
          expect(clock.now()).toBe(1_250)
          expect(clock.pending).toBe(0)
        })

        it('orders by deadline, not by scheduling order', () => {
          const clock = createTestClock(0)
          const fired: string[] = []
          clock.setTimeout(() => fired.push('late'), 300)
          clock.setTimeout(() => fired.push('early'), 100)
          clock.setTimeout(() => fired.push('middle'), 200)
          clock.advance(300)
          expect(fired).toEqual(['early', 'middle', 'late'])
        })

        it('runs a callback with `now` sitting on its own deadline, not on the sweep target', () => {
          const clock = createTestClock(0)
          const seen: number[] = []
          clock.setTimeout(() => seen.push(clock.now()), 10)
          clock.setTimeout(() => seen.push(clock.now()), 40)
          clock.advance(100)
          expect(seen).toEqual([10, 40])
          expect(clock.now()).toBe(100)
        })

        it('fires a re-entrant timer in the same sweep when it lands inside the window', () => {
          // This is what makes the agent host's restart backoff testable in one advance() call.
          const clock = createTestClock(0)
          const seen: string[] = []
          clock.setTimeout(() => {
            seen.push('outer')
            clock.setTimeout(() => seen.push('inner'), 10)
          }, 10)
          clock.advance(25)
          expect(seen).toEqual(['outer', 'inner'])
          expect(clock.now()).toBe(25)
          expect(clock.pending).toBe(0)
        })

        it('a cancel closure is idempotent and touches only its own timer', () => {
          const clock = createTestClock(0)
          const fired: string[] = []
          const cancelA = clock.setTimeout(() => fired.push('a'), 10)
          clock.setTimeout(() => fired.push('b'), 10)
          cancelA()
          cancelA()
          expect(clock.pending).toBe(1)
          clock.advance(10)
          expect(fired).toEqual(['b'])
        })
      })
      ```

- [ ] **Step 31: Run it and watch it fail.**

      ```sh
      npx vitest run packages/protocol/src/clock.test.ts
      ```

      Expected: FAIL — `Failed Suites 1`, with
      `Error: Cannot find module './clock' imported from .../packages/protocol/src/clock.test.ts`.

- [ ] **Step 32: Write `packages/protocol/src/clock.ts` and append its barrel line.**
      Contract §5.8, verbatim. A cancel **closure** rather than an opaque handle type, so there is no
      `TimerHandle` to brand and no way to hand a handle to the wrong clock. The `for (;;)` re-scans
      the timer map on every iteration precisely so a timer scheduled *during* the sweep still fires
      inside it.

      ```ts
      export type Cancel = () => void

      export interface Clock {
        now(): number
        setTimeout(fn: () => void, ms: number): Cancel
      }

      export interface TestClock extends Clock {
        advance(ms: number): void
        readonly pending: number
      }

      export const systemClock: Clock = {
        now: () => Date.now(),
        setTimeout: (fn, ms) => {
          const t = setTimeout(fn, ms)
          return () => clearTimeout(t)
        },
      }

      /** 2026-01-01T00:00:00Z by default, so every test's timestamps are recognisable. */
      export function createTestClock(startMs = 1_767_225_600_000): TestClock {
        let now = startMs
        let nextId = 0
        const timers = new Map<number, { at: number; fn: () => void }>()
        return {
          now: () => now,
          setTimeout(fn, ms) {
            const id = nextId++
            timers.set(id, { at: now + ms, fn })
            return () => { timers.delete(id) }
          },
          advance(ms) {
            const target = now + ms
            for (;;) {
              const due = [...timers.entries()]
                .filter(([, t]) => t.at <= target)
                .sort((a, b) => a[1].at - b[1].at)
              const first = due[0]
              if (first === undefined) break
              timers.delete(first[0])
              now = first[1].at        // time is at the deadline while the callback runs
              first[1].fn()
            }
            now = target
          },
          get pending() { return timers.size },
        }
      }
      ```

      Then **append** one line to `packages/protocol/src/index.ts`, keeping it sorted — the file
      becomes nine lines, `./clock` slotting in after `./agent`:

      ```ts
      export * from './clock'
      ```

- [ ] **Step 33: Run it, watch it pass, and commit.**

      ```sh
      npx vitest run packages/protocol/src/clock.test.ts
      npx tsc -p tsconfig.json && echo "typecheck OK"
      npm run test -w @cairn/protocol
      git add packages/protocol/src/clock.ts packages/protocol/src/clock.test.ts \
              packages/protocol/src/index.ts
      git commit -m "feat(protocol): the injected Clock and a deterministic TestClock

Every timeout in the repo goes through this seam, so no test needs a real timer:
advance() fires each timer whose deadline falls in the window, in deadline order,
with now sitting on the deadline while the callback runs."
      ```

      Expected: `Tests  7 passed (7)` for `clock.test.ts`, `typecheck OK`, then
      `Test Files  8 passed (8)`, `Tests  69 passed (69)` for the package, and one commit.

- [ ] **Step 34: Write the failing test for `newItemId` — `packages/protocol/src/id.test.ts`.**
      `@cairn/history` mints every `ItemId` with this function, and the store's chain verification
      depends on ids sorting by time. It takes `(nowMs, rnd)` rather than reading the clock or
      `randomBytes` itself, so every ingest test is reproducible — which is why the expected values
      below are literals, not regexes.

      ```ts
      import { describe, expect, it } from 'vitest'
      import { newItemId } from './id'

      const T = 1_767_225_600_000                          // 2026-01-01T00:00:00Z
      const SEQ = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      const ZERO = new Uint8Array(10)
      const MAX = new Uint8Array(10).fill(0xff)

      describe('newItemId', () => {
        it('is 26 Crockford base32 chars: 10 of timestamp then 16 of randomness', () => {
          const id = newItemId(T, SEQ)
          expect(id).toBe('01KDVDNA00000G40R40M30E209')
          expect(id).toHaveLength(26)
          expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)   // no I, L, O or U — Crockford's alphabet
        })

        it('splits exactly 10 + 16, which the two extreme random inputs prove', () => {
          expect(newItemId(T, ZERO)).toBe('01KDVDNA000000000000000000')
          expect(newItemId(T, MAX)).toBe('01KDVDNA00ZZZZZZZZZZZZZZZZ')
          expect(newItemId(T, ZERO).slice(0, 10)).toBe(newItemId(T, MAX).slice(0, 10))
        })

        it('is deterministic given the same (nowMs, rnd)', () => {
          expect(newItemId(T, SEQ)).toBe(newItemId(T, SEQ))
        })

        it('sorts lexicographically by time, even against a maximal random half', () => {
          expect(newItemId(T, MAX) < newItemId(T + 1, ZERO)).toBe(true)
          expect(newItemId(0, ZERO)).toBe('0'.repeat(26))
          const ids = [newItemId(T + 2, ZERO), newItemId(T, ZERO), newItemId(T + 1, ZERO)]
          expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]])
        })

        it('THROWS for anything but exactly 10 random bytes — a bad argument shape is a bug, not a state', () => {
          expect(() => newItemId(T, new Uint8Array(9))).toThrow(
            'newItemId needs exactly 10 random bytes, got 9',
          )
          expect(() => newItemId(T, new Uint8Array(11))).toThrow(
            'newItemId needs exactly 10 random bytes, got 11',
          )
        })
      })
      ```

- [ ] **Step 35: Run it and watch it fail.**

      ```sh
      npx vitest run packages/protocol/src/id.test.ts
      ```

      Expected: FAIL — `Failed Suites 1`, with
      `Error: Cannot find module './id' imported from .../packages/protocol/src/id.test.ts`.

- [ ] **Step 36: Write `packages/protocol/src/id.ts` and append its barrel line.**
      Contract §5.1, verbatim. It throws rather than returning a `Result` because a wrong-length
      random buffer is a programmer error the types should have prevented (contract §6), and a stack
      trace is the right output for that.

      ```ts
      import type { ItemId } from './types'

      const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

      /** Deterministic given (nowMs, rnd) so tests are reproducible. `rnd` must be exactly 10 bytes. */
      export function newItemId(nowMs: number, rnd: Uint8Array): ItemId {
        if (rnd.length !== 10) throw new Error(`newItemId needs exactly 10 random bytes, got ${rnd.length}`)
        let ts = ''
        let n = BigInt(nowMs)
        for (let i = 0; i < 10; i++) {
          ts = CROCKFORD[Number(n % 32n)]! + ts
          n /= 32n
        }
        let bits = 0
        let acc = 0
        let rand = ''
        for (const byte of rnd) {
          acc = (acc << 8) | byte
          bits += 8
          while (bits >= 5) {
            bits -= 5
            rand += CROCKFORD[(acc >> bits) & 31]!
          }
        }
        return (ts + rand.slice(0, 16)) as ItemId
      }
      ```

      Then **append** one line to `packages/protocol/src/index.ts`, keeping it sorted — ten lines now,
      `./id` after `./hash`:

      ```ts
      export * from './id'
      ```

- [ ] **Step 37: Run it, watch it pass, and commit.**

      ```sh
      npx vitest run packages/protocol/src/id.test.ts
      npx tsc -p tsconfig.json && echo "typecheck OK"
      git add packages/protocol/src/id.ts packages/protocol/src/id.test.ts \
              packages/protocol/src/index.ts
      git commit -m "feat(protocol): newItemId mints a time-sortable 26-char ItemId

Takes (nowMs, rnd) instead of reading the clock and randomBytes itself, so every
ingest test is reproducible, and throws for a wrong-length random buffer."
      ```

      Expected: `Tests  5 passed (5)`, `typecheck OK`, and one commit. The package now stands at
      `Test Files  9 passed (9)`, `Tests  74 passed (74)`.

- [ ] **Step 38: Write the failing test for the renderer IPC contract — `packages/protocol/src/ipc.test.ts`.**
      Spec §11 control 8: **both directions are validated**. Main validates `params` on receipt and
      `result` before replying; the renderer validates every event payload before it reaches component
      state. This file is where those schemas are proved to actually reject, and where the
      renderer-can-never-ask-for-a-body rule is asserted as a test rather than a comment: there is no
      `bytes`, no `reps` and no `repRefs` anywhere in `ItemSummary`, so the palette can only ever see
      the masked preview and a `data:` thumbnail.

      ```ts
      import { describe, expect, it } from 'vitest'
      import { newItemId } from './id'
      import {
        IPC_EVENT_CHANNELS,
        IPC_REQUEST_CHANNELS,
        IpcEventSchema,
        IpcRequestSchema,
        ItemIdSchema,
        ItemSummarySchema,
      } from './ipc'

      const summary = {
        id: '01KDVDNA00000G40R40M30E209',
        kind: 'text',
        preview: 'AKIA••••A7QD',
        previewTruncated: false,
        flags: ['secret'],
        maskedSpanCount: 1,
        sourceAppName: 'TextEdit',
        byteLength: 20,
        createdAt: 1_767_225_600_000,
        pinned: false,
        expiresAt: 1_767_225_900_000,
        thumbnailDataUrl: null,
      }

      describe('the channel lists are frozen and complete', () => {
        it('has eight request channels and four event channels, each with a schema', () => {
          expect(IPC_REQUEST_CHANNELS).toEqual([
            'cairn:history.list',
            'cairn:history.search',
            'cairn:history.preview',
            'cairn:history.pin',
            'cairn:history.remove',
            'cairn:recall.copy',
            'cairn:palette.close',
            'cairn:security.status',
          ])
          expect(IPC_EVENT_CHANNELS).toEqual([
            'cairn:history.changed',
            'cairn:hotkey.status',
            'cairn:toast',
            'cairn:palette.shown',
          ])
          for (const c of IPC_REQUEST_CHANNELS) {
            expect(IpcRequestSchema[c].params).toBeDefined()
            expect(IpcRequestSchema[c].result).toBeDefined()
          }
          for (const c of IPC_EVENT_CHANNELS) expect(IpcEventSchema[c]).toBeDefined()
          expect(Object.keys(IpcRequestSchema)).toHaveLength(8)
          expect(Object.keys(IpcEventSchema)).toHaveLength(4)
        })
      })

      describe('inbound params are validated (main side)', () => {
        it('applies the pinnedOnly default and refuses an out-of-range limit', () => {
          const params = IpcRequestSchema['cairn:history.list'].params
          expect(params.parse({ limit: 50, offset: 0 })).toEqual({ limit: 50, offset: 0, pinnedOnly: false })
          expect(params.safeParse({ limit: 0, offset: 0 }).success).toBe(false)
          expect(params.safeParse({ limit: 201, offset: 0 }).success).toBe(false)
          const bad = params.safeParse({ limit: 10, offset: 1.5 })
          expect(bad.success).toBe(false)
          expect(bad.error?.issues[0]?.message).toBe('Invalid input: expected int, received number')
        })

        it('refuses an id that is not a 26-char Crockford ItemId', () => {
          const params = IpcRequestSchema['cairn:history.preview'].params
          expect(params.safeParse({ id: '01KDVDNA00000G40R40M30E209' }).success).toBe(true)
          expect(params.safeParse({ id: 'nope' }).success).toBe(false)
          expect(params.safeParse({ id: '01KDVDNA00000G40R40M30E20I' }).success).toBe(false) // I is not Crockford
        })

        it('accepts an id minted by newItemId — the two modules agree on the format', () => {
          expect(ItemIdSchema.safeParse(newItemId(1_767_225_600_000, new Uint8Array(10))).success).toBe(true)
        })
      })

      describe('outbound results are validated (main side), and carry no bytes', () => {
        it('ItemSummary has exactly twelve keys, none of which can hold a body', () => {
          const keys = Object.keys(ItemSummarySchema.shape)
          expect(keys).toEqual([
            'id', 'kind', 'preview', 'previewTruncated', 'flags', 'maskedSpanCount', 'sourceAppName',
            'byteLength', 'createdAt', 'pinned', 'expiresAt', 'thumbnailDataUrl',
          ])
          for (const banned of ['bytes', 'reps', 'repRefs', 'blobId', 'raw', 'html', 'text']) {
            expect(keys).not.toContain(banned)
          }
          expect(ItemSummarySchema.safeParse(summary).success).toBe(true)
        })

        it('refuses a preview over 512 chars and a thumbnail that is not an inline JPEG data URL', () => {
          expect(ItemSummarySchema.safeParse({ ...summary, preview: 'x'.repeat(513) }).success).toBe(false)
          expect(
            ItemSummarySchema.safeParse({ ...summary, thumbnailDataUrl: 'https://evil.example/x.png' }).success,
          ).toBe(false)
          expect(
            ItemSummarySchema.safeParse({
              ...summary,
              thumbnailDataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
            }).success,
          ).toBe(true)
        })

        it('recall.copy can only ever report copied-manual in M1', () => {
          const result = IpcRequestSchema['cairn:recall.copy'].result
          expect(result.safeParse({ result: 'copied-manual', reason: 'user-preference' }).success).toBe(true)
          expect(result.safeParse({ result: 'copied-auto', reason: 'user-preference' }).success).toBe(false)
        })
      })

      describe('event payloads are validated too (renderer side)', () => {
        it('accepts the frozen toast and rejects an unknown tone', () => {
          expect(
            IpcEventSchema['cairn:toast'].safeParse({ text: 'Copied — press Cmd+V', tone: 'info' }).success,
          ).toBe(true)
          expect(IpcEventSchema['cairn:toast'].safeParse({ text: 'x', tone: 'shout' }).success).toBe(false)
          expect(
            IpcEventSchema['cairn:history.changed'].safeParse({ reason: 'ingest', total: 3 }).success,
          ).toBe(true)
          expect(
            IpcEventSchema['cairn:history.changed'].safeParse({ reason: 'wat', total: 3 }).success,
          ).toBe(false)
        })
      })
      ```

- [ ] **Step 39: Run it and watch it fail.**

      ```sh
      npx vitest run packages/protocol/src/ipc.test.ts
      ```

      Expected: FAIL — `Failed Suites 1`, with
      `Error: Cannot find module './ipc' imported from .../packages/protocol/src/ipc.test.ts`.

- [ ] **Step 40: Write `packages/protocol/src/ipc.ts` and append its barrel line.**
      Contract §5.9, verbatim. **One channel per method** — there is no generic `invoke(channel, …)`,
      because a channel parameter is how a compromised renderer reaches a handler nobody reviewed.
      `zod` is already a dependency of this package, so nothing changes in the manifest.

      ```ts
      import * as z from 'zod'

      export const IPC_REQUEST_CHANNELS = [
        'cairn:history.list',
        'cairn:history.search',
        'cairn:history.preview',
        'cairn:history.pin',
        'cairn:history.remove',
        'cairn:recall.copy',
        'cairn:palette.close',
        'cairn:security.status',
      ] as const
      export type IpcRequestChannel = (typeof IPC_REQUEST_CHANNELS)[number]

      export const IPC_EVENT_CHANNELS = [
        'cairn:history.changed',
        'cairn:hotkey.status',
        'cairn:toast',
        'cairn:palette.shown',
      ] as const
      export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]

      export const ItemIdSchema = z.string().length(26).regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

      /** What crosses to the renderer. Note there is no `repRefs` and no raw bytes: the renderer can
       *  never ask for a body, only for the masked preview and the thumbnail. */
      export const ItemSummarySchema = z.object({
        id: ItemIdSchema,
        kind: z.enum(['text', 'richtext', 'image', 'files']),
        preview: z.string().max(512),
        previewTruncated: z.boolean(),
        flags: z.array(z.enum(['secret', 'concealed', 'transient', 'auto-generated', 'excluded', 'no-sync', 'cut'])),
        maskedSpanCount: z.int().min(0),
        sourceAppName: z.string().nullable(),
        byteLength: z.int().min(0),
        createdAt: z.int(),
        pinned: z.boolean(),
        expiresAt: z.int().nullable(),
        thumbnailDataUrl: z.string().startsWith('data:image/jpeg;base64,').nullable(),
      })

      export const IpcRequestSchema = {
        'cairn:history.list': {
          params: z.object({
            limit: z.int().min(1).max(200),
            offset: z.int().min(0),
            kind: z.enum(['text', 'richtext', 'image', 'files']).optional(),
            pinnedOnly: z.boolean().default(false),
          }),
          result: z.object({ items: z.array(ItemSummarySchema), total: z.int().min(0) }),
        },
        'cairn:history.search': {
          params: z.object({ q: z.string().max(256), limit: z.int().min(1).max(200) }),
          result: z.object({
            results: z.array(z.object({ item: ItemSummarySchema, score: z.number(), ranges: z.array(z.int().min(0)) })),
          }),
        },
        'cairn:history.preview': {
          params: z.object({ id: ItemIdSchema }),
          // `text` is ALWAYS plain text. When the item is HTML, this is the HTML *source*, and the
          // renderer prints it as text. `isHtmlSource` exists only to label the pane.
          result: z.object({ text: z.string().max(8192), isHtmlSource: z.boolean(), truncated: z.boolean() }),
        },
        'cairn:history.pin': {
          params: z.object({ id: ItemIdSchema, pinned: z.boolean() }),
          result: z.object({ pinned: z.boolean() }),
        },
        'cairn:history.remove': {
          params: z.object({ id: ItemIdSchema }),
          result: z.object({ removed: z.boolean() }),
        },
        'cairn:recall.copy': {
          params: z.object({ id: ItemIdSchema }),
          // Deliberately the M2 `deliver()` shape. In M1 `result` is always 'copied-manual'.
          result: z.object({
            result: z.literal('copied-manual'),
            reason: z.enum(['user-preference', 'no-permission', 'secure-input', 'elevated-target']),
          }),
        },
        'cairn:palette.close': { params: z.object({}), result: z.object({ closed: z.literal(true) }) },
        'cairn:security.status': {
          params: z.object({}),
          result: z.object({
            keyringMode: z.enum(['os-keyring', 'passphrase', 'locked']),
            encryptedAtRest: z.boolean(),
            dataDirMode: z.string(),               // '700'
            notes: z.array(z.string()),
          }),
        },
      } as const

      export const IpcEventSchema = {
        'cairn:history.changed': z.object({ reason: z.enum(['ingest', 'update', 'delete', 'evict']), total: z.int() }),
        'cairn:hotkey.status': z.object({ status: z.enum(['active', 'unbound', 'failed']), accelerator: z.string() }),
        'cairn:toast': z.object({ text: z.string().max(200), tone: z.enum(['info', 'warn']) }),
        'cairn:palette.shown': z.object({ shownAt: z.int() }),
      } as const

      export type IpcRequest = {
        [C in IpcRequestChannel]: {
          channel: C
          params: z.output<(typeof IpcRequestSchema)[C]['params']>
          result: z.output<(typeof IpcRequestSchema)[C]['result']>
        }
      }[IpcRequestChannel]

      export type IpcEvent = {
        [C in IpcEventChannel]: { channel: C; payload: z.output<(typeof IpcEventSchema)[C]> }
      }[IpcEventChannel]

      export type ItemSummary = z.output<typeof ItemSummarySchema>
      ```

      Then **append** the last line to `packages/protocol/src/index.ts`, keeping it sorted — eleven
      lines now, `./ipc` after `./id`:

      ```ts
      export * from './ipc'
      ```

- [ ] **Step 41: Run it, watch it pass, and confirm the barrel is complete.**

      ```sh
      npx vitest run packages/protocol/src/ipc.test.ts
      npx tsc -p tsconfig.json && echo "typecheck OK"
      cat packages/protocol/src/index.ts
      npm run test -w @cairn/protocol
      git add packages/protocol/src/ipc.ts packages/protocol/src/ipc.test.ts \
              packages/protocol/src/index.ts
      git commit -m "feat(protocol): the frozen renderer IPC channels and zod schemas

One channel per method, no generic invoke, and both directions validated: main
checks params on receipt and result before replying, the renderer checks every
event payload. ItemSummary carries the masked preview and a data: thumbnail and
has no field that could hold a body."
      ```

      Expected: `Tests  8 passed (8)` for `ipc.test.ts`; `typecheck OK`; `index.ts` is exactly these
      eleven lines, in this order —

      ```ts
      export * from './agent'
      export * from './clock'
      export * from './constants'
      export * from './hash'
      export * from './id'
      export * from './ipc'
      export * from './log'
      export * from './parse-agent-line'
      export * from './result'
      export * from './testing'
      export * from './types'
      ```

      — then `Test Files  10 passed (10)`, `Tests  82 passed (82)` for the package, and one commit.
      Every module contract §5's barrel names now exists, so Tasks 3, 5, 6, 7, 8, 9 and 10 can import
      `Clock`, `createTestClock`, `newItemId`, `LOG_EVENTS`, `IpcRequestSchema` and `ItemSummary` from
      `@cairn/protocol` on their first step.

- [ ] **Step 42: Write the failing test for the Swift codegen — `tools/gen-agent-types.test.ts`.**
      Two behaviours are the whole point. **Golden identity:** the committed
      `AgentProtocol.generated.swift` must be byte-identical to what the generator emits, so any
      codegen change shows up as a reviewable diff rather than appearing on someone's machine.
      **Fail loudly:** a zod construct the generator cannot map must throw a named error, never emit
      a plausible-looking wrong type.

      ```ts
      import { readFileSync } from 'node:fs'
      import { describe, expect, it } from 'vitest'
      import * as z from 'zod'
      import * as protocol from '@cairn/protocol'
      import {
        GENERATED_PATH,
        GenError,
        agentGenInput,
        generateSwift,
        type GenInput,
        type ProtocolSchemas,
      } from './gen-agent-types'

      const input = agentGenInput(protocol as unknown as ProtocolSchemas)
      const committed = readFileSync(GENERATED_PATH, 'utf8')

      describe('the committed Swift file is exactly what the generator emits', () => {
        it('is byte-identical, so a codegen change always shows up as a reviewable diff', () => {
          // If this fails, run `npm run gen:agent-types` and commit the result. Never hand-edit.
          expect(generateSwift(input)).toBe(committed)
        })

        it('is deterministic: generating twice produces the same bytes', () => {
          expect(generateSwift(input)).toBe(generateSwift(input))
        })

        it('carries a DO-NOT-EDIT header and imports nothing but Foundation', () => {
          expect(committed.startsWith('// GENERATED FILE — DO NOT EDIT.')).toBe(true)
          expect(committed.match(/^import .*$/gm)).toEqual(['import Foundation'])
          expect(committed.endsWith('\n')).toBe(true)
        })

        it('pins protocolVersion to WIRE_MAJOR and emits no other top-level let', () => {
          expect(committed).toContain(`let protocolVersion = ${protocol.WIRE_MAJOR}`)
          expect(committed).toContain('let protocolVersion = 1')
          // A zod schema has nowhere to hang a bare number, so the generator emits no numeric limit.
          // Task 4's Wire.swift declares the six it needs, under its own drift guard; emitting them
          // here too would be `error: invalid redeclaration of 'MAX_REP_BYTES'` at `make agent`.
          expect(committed.match(/^let /gm)).toHaveLength(1)
          for (const name of ['MAX_LINE_BYTES', 'MAX_REP_BYTES', 'CHUNK_PAYLOAD_BYTES']) {
            expect(committed).not.toContain(`let ${name}`)
          }
        })
      })

      describe('the generated Swift matches the zod schemas field for field', () => {
        it('declares one AgentMethod case per request method, with the wire string as raw value', () => {
          for (const [method] of input.requests) expect(committed).toContain(`= "${method}"`)
          expect(committed).toContain('case watchStart = "watch.start"')
          expect(committed).toContain('case hotkeyUnregister = "hotkey.unregister"')
        })

        it('declares one AgentEventName case per event', () => {
          expect(committed).toContain('case clipboardChanged = "clipboard.changed"')
          expect(committed).toContain('case repChunk = "rep.chunk"')
        })

        it('maps zod base64 fields to Swift Data, which JSONCoder encodes as base64 for free', () => {
          // Task 4's Chunker.split therefore returns [Data] and no Swift file calls a base64 API for
          // a payload. Changing this to String breaks every construction in six Swift files.
          expect(committed).toContain('var b64: Data')
          expect(committed).toContain('var inline: Data?')
        })

        it('maps z.int() to Int and z.boolean() to Bool', () => {
          expect(committed).toContain('var byteLength: Int')
          expect(committed).toContain('var final: Bool')
        })

        it('maps a nullable-with-default field to a Swift Optional', () => {
          expect(committed).toContain('var uti: String?')
          expect(committed).toContain('var frontmostBundleId: String?')
        })

        it('aliases HelloResult rather than emitting a second AgentCapabilities struct', () => {
          expect(committed).toContain('typealias HelloResult = AgentCapabilities')
          expect(committed.match(/struct AgentCapabilities:/g)).toHaveLength(1)
          expect(committed).not.toContain('struct HelloResult')
        })

        it('emits shared named types once, referenced by every user', () => {
          expect(committed.match(/^struct Rep: /gm)).toHaveLength(1)
          expect(committed.match(/^enum Hint: /gm)).toHaveLength(1)
          expect(committed).toContain('var reps: [Rep]')
          expect(committed).toContain('var hints: [Hint]?')
          // `write`'s rep element is an INLINE object, so it is named after its owner. Task 4's
          // Writer.swift takes `[WriteParamsRepsItem]` and hand-declares no twin of it.
          expect(committed.match(/^struct WriteParamsRepsItem: /gm)).toHaveLength(1)
          expect(committed).toContain('var reps: [WriteParamsRepsItem]')
        })

        it('camelCases kebab-case enum members and keeps the wire string verbatim', () => {
          expect(committed).toContain('case autoGenerated = "auto-generated"')
          expect(committed).toContain('case changecountPoll = "changecount-poll"')
          expect(committed).toContain('case win32Hotkey = "win32-hotkey"')
        })

        it('sorts struct fields alphabetically, so reordering keys in agent.ts is not a diff', () => {
          const straight = z.object({ zulu: z.string(), alpha: z.int(), mike: z.boolean() })
          const shuffled = z.object({ mike: z.boolean(), zulu: z.string(), alpha: z.int() })
          const gen = (params: z.ZodType): string =>
            generateSwift({ wireMajor: 1, named: [], requests: [['probe', params]], results: [['probe', params]], events: [] })
          expect(gen(straight)).toBe(gen(shuffled))
          expect(gen(straight)).toContain(
            'struct ProbeParams: Codable, Equatable, Sendable {\n    var alpha: Int\n    var mike: Bool\n    var zulu: String\n}',
          )
        })
      })

      describe('renaming a field changes the output — this is the drift alarm', () => {
        const renamed: GenInput = {
          ...input,
          requests: input.requests.map(([method, params]) =>
            method === 'hello' ? ([method, z.object({ hostVer: z.string() })] as const) : ([method, params] as const),
          ),
        }

        it('produces different bytes from the committed file', () => {
          expect(generateSwift(renamed)).not.toBe(committed)
        })

        it('emits the new field name and drops the old one', () => {
          const out = generateSwift(renamed)
          expect(out).toContain('var hostVer: String')
          expect(out).not.toContain('var hostVersion: String')
          expect(committed).toContain('var hostVersion: String')
        })
      })

      describe('the generator fails loudly rather than emitting something wrong', () => {
        const genWith = (params: z.ZodType): string =>
          generateSwift({ wireMajor: 1, named: [], requests: [['probe', params]], results: [['probe', params]], events: [] })

        it('throws GenError, naming the zod type and the field path, for an unmappable type', () => {
          expect(() => genWith(z.object({ weird: z.bigint() }))).toThrow(GenError)
          expect(() => genWith(z.object({ weird: z.bigint() }))).toThrow(
            "cannot map zod type 'bigint' at ProbeParams.weird",
          )
        })

        it('throws for z.unknown(), z.any(), z.date(), z.map() and z.tuple() too', () => {
          for (const [label, schema] of [
            ['unknown', z.unknown()],
            ['any', z.any()],
            ['date', z.date()],
            ['map', z.map(z.string(), z.string())],
            ['tuple', z.tuple([z.string()])],
          ] as const) {
            expect(() => genWith(z.object({ weird: schema })), label).toThrow(GenError)
          }
        })

        it('throws for a record whose value type is not the log-metadata union', () => {
          expect(() => genWith(z.object({ bag: z.record(z.string(), z.string()) }))).toThrow(
            /only the log-metadata record/,
          )
        })

        it('accepts the log-metadata record and maps it to [String: AgentLogValue]', () => {
          const bag = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          expect(genWith(z.object({ fields: bag }))).toContain('var fields: [String: AgentLogValue]')
        })

        it('throws when two different shapes collide on one Swift type name', () => {
          expect(() =>
            generateSwift({
              wireMajor: 1,
              named: [],
              requests: [
                ['probe', z.object({ a: z.string() })],
                ['probe', z.object({ b: z.string() })],
              ],
              results: [],
              events: [],
            }),
          ).toThrow(/both want the Swift type name 'ProbeParams'/)
        })

        it('throws when AgentResultSchema is missing an entry for a request method', () => {
          expect(() =>
            agentGenInput({
              ...(protocol as unknown as ProtocolSchemas),
              AgentResultSchema: { hello: z.object({}) },
            }),
          ).toThrow("AgentResultSchema has no entry for method 'watch.start'")
        })

        it('throws when handed something that is not a discriminated union', () => {
          expect(() =>
            agentGenInput({
              ...(protocol as unknown as ProtocolSchemas),
              AgentEventSchema: z.object({ nope: z.string() }),
            }),
          ).toThrow(/is not a non-empty union/)
        })
      })
      ```

- [ ] **Step 43: Run it and watch it fail.**

      ```sh
      npx vitest run tools/gen-agent-types.test.ts
      ```

      Expected: FAIL — `Failed Suites 1`, with `Error: Cannot find module './gen-agent-types'
      imported from .../tools/gen-agent-types.test.ts`.

- [ ] **Step 44: Write `tools/gen-agent-types.ts`.**
      Read the three comment blocks before you skim the code — each explains a decision that looks
      arbitrary otherwise: why base64 becomes `Data`, why exactly one `record` shape is supported, and
      why there is a `module.registerHooks` call in a codegen script.

      ```ts
      /**
       * zod -> Swift codegen. Emits `agents/macos/Sources/AgentProtocol.generated.swift` from the zod
       * schemas in `packages/protocol/src/agent.ts`, so a field rename on the TypeScript side becomes
       * a Swift COMPILE error instead of a runtime "why is uti always nil".
       *
       * Run: `npm run gen:agent-types`. The emitted file is committed; `gen-agent-types.test.ts` fails
       * if it is stale, which is what makes a codegen change visible in review.
       */
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
      import { registerHooks } from 'node:module'
      import { dirname, join, resolve } from 'node:path'
      import { fileURLToPath, pathToFileURL } from 'node:url'
      import * as z from 'zod'

      // ------------------------------------------------------------------------------- errors

      /** Thrown when a schema uses a construct this generator refuses to guess at. */
      export class GenError extends Error {
        override readonly name = 'GenError'
      }

      // ------------------------------------------------------------------- zod introspection

      interface ZodDefLike {
        readonly type: string
        readonly format?: string
        readonly innerType?: z.ZodType
        readonly element?: z.ZodType
        readonly shape?: Readonly<Record<string, z.ZodType>>
        readonly entries?: Readonly<Record<string, string | number>>
        readonly values?: readonly unknown[]
        readonly keyType?: z.ZodType
        readonly valueType?: z.ZodType
        readonly options?: readonly z.ZodType[]
      }

      /** zod 4 exposes every schema's internals at `_zod.def`; `.type` is the discriminator we map on. */
      const defOf = (s: z.ZodType): ZodDefLike => s._zod.def as unknown as ZodDefLike

      // ------------------------------------------------------------------------- Swift naming

      const SWIFT_RESERVED = new Set([
        'associatedtype', 'as', 'any', 'async', 'await', 'break', 'case', 'catch', 'class', 'continue',
        'default', 'defer', 'deinit', 'do', 'else', 'enum', 'extension', 'false', 'fileprivate', 'for',
        'func', 'guard', 'if', 'import', 'in', 'indirect', 'init', 'inout', 'internal', 'is', 'lazy',
        'let', 'mutating', 'nil', 'nonmutating', 'open', 'operator', 'override', 'private', 'protocol',
        'public', 'repeat', 'required', 'rethrows', 'return', 'self', 'Self', 'some', 'static', 'struct',
        'subscript', 'super', 'switch', 'throw', 'throws', 'true', 'try', 'typealias', 'var', 'where',
        'while',
      ])

      /** `watch.start` -> `WatchStart`, `auto-generated` -> `AutoGenerated`. */
      function pascal(s: string): string {
        return s
          .split(/[.\-_ ]+/)
          .filter((part) => part.length > 0)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join('')
      }

      /** `watch.start` -> `watchStart`, `A` -> `a`. */
      function camel(s: string): string {
        const p = pascal(s)
        return p.charAt(0).toLowerCase() + p.slice(1)
      }

      /** Swift keywords are legal identifiers when backticked, so escape rather than mangle. */
      function ident(name: string): string {
        return SWIFT_RESERVED.has(name) ? `\`${name}\`` : name
      }

      // -------------------------------------------------------------------------- the emitter

      interface Emitter {
        /** Swift type name -> full declaration text. */
        readonly decls: Map<string, string>
        /** schema identity -> Swift type name, seeded from GenInput.named. */
        readonly named: Map<z.ZodType, string>
      }

      function declare(em: Emitter, name: string, body: string): string {
        const existing = em.decls.get(name)
        if (existing !== undefined && existing !== body) {
          throw new GenError(
            `two different shapes both want the Swift type name '${name}'. Give one of them an entry in ` +
              `GenInput.named so it gets a stable, distinct name.`,
          )
        }
        em.decls.set(name, body)
        return name
      }

      /** Resolves one schema to a Swift type, emitting any nested declarations it needs. */
      function swiftTypeFor(schema: z.ZodType, owner: string, field: string, em: Emitter): string {
        let inner = schema
        let optional = false
        for (;;) {
          const d = defOf(inner)
          if (d.type === 'optional' || d.type === 'nullable' || d.type === 'default') {
            if (d.innerType === undefined) throw new GenError(`wrapper '${d.type}' has no innerType at ${owner}.${field}`)
            optional = true
            inner = d.innerType
            continue
          }
          break
        }
        const registered = em.named.get(inner)
        const base = registered ?? baseSwiftTypeFor(inner, owner, field, em)
        return optional ? `${base}?` : base
      }

      function baseSwiftTypeFor(s: z.ZodType, owner: string, field: string, em: Emitter): string {
        const d = defOf(s)
        const nestedName = owner + pascal(field)
        switch (d.type) {
          case 'string':
            // Swift's JSONEncoder/JSONDecoder use base64 for `Data` by default, so a zod base64 string
            // maps to `Data` and the agent never hand-rolls a base64 call. Six Swift files in Task 4
            // are written against that, including `Chunker.split(_:payloadBytes:) -> [Data]`.
            return d.format === 'base64' ? 'Data' : 'String'
          case 'number':
            return d.format === 'safeint' || d.format === 'int32' || d.format === 'uint32' ? 'Int' : 'Double'
          case 'boolean':
            return 'Bool'
          case 'literal': {
            const values = d.values ?? []
            if (values.length !== 1) {
              throw new GenError(`literal with ${values.length} values at ${owner}.${field}; expected exactly 1`)
            }
            const v = values[0]
            if (typeof v === 'string') return 'String'
            if (typeof v === 'boolean') return 'Bool'
            if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Double'
            throw new GenError(`cannot map literal of JS type '${typeof v}' at ${owner}.${field}`)
          }
          case 'enum': {
            const values = Object.values(d.entries ?? {})
            if (values.length === 0) throw new GenError(`empty enum at ${owner}.${field}`)
            const cases = values.map((v) => {
              if (typeof v !== 'string') {
                throw new GenError(`cannot map non-string enum member '${String(v)}' at ${owner}.${field}`)
              }
              return `    case ${ident(camel(v))} = "${v}"`
            })
            return declare(
              em,
              nestedName,
              `enum ${nestedName}: String, Codable, Equatable, Sendable, CaseIterable {\n${cases.join('\n')}\n}`,
            )
          }
          case 'array': {
            if (d.element === undefined) throw new GenError(`array has no element schema at ${owner}.${field}`)
            return `[${swiftTypeFor(d.element, owner, `${field}Item`, em)}]`
          }
          case 'object':
            return emitStruct(nestedName, s, em)
          case 'record': {
            // The ONLY record we know how to map is the `log` event's metadata bag: string keys and a
            // string | number | boolean | null value. Anything else must be modelled explicitly.
            const keyType = d.keyType === undefined ? '?' : defOf(d.keyType).type
            const valueOptions = (d.valueType === undefined ? [] : defOf(d.valueType).options ?? [])
              .map((o) => defOf(o).type)
              .sort()
            if (keyType === 'string' && valueOptions.join(',') === 'boolean,null,number,string') {
              return '[String: AgentLogValue]'
            }
            throw new GenError(
              `cannot map record<${keyType}, ${valueOptions.join('|') || '?'}> at ${owner}.${field}; ` +
                `only the log-metadata record (string keys, string|number|boolean|null values) is supported`,
            )
          }
          default:
            throw new GenError(`cannot map zod type '${d.type}' at ${owner}.${field}`)
        }
      }

      function emitStruct(name: string, schema: z.ZodType, em: Emitter): string {
        const shape = defOf(schema).shape
        if (shape === undefined) throw new GenError(`object schema '${name}' has no shape`)
        // Alphabetical, so reordering keys in agent.ts does not churn the generated file.
        const keys = Object.keys(shape).sort()
        const fields = keys.map((key) => {
          const fieldSchema = shape[key]
          if (fieldSchema === undefined) throw new GenError(`field '${key}' of '${name}' is undefined`)
          return `    var ${ident(key)}: ${swiftTypeFor(fieldSchema, name, key, em)}`
        })
        const body =
          fields.length === 0
            ? `struct ${name}: Codable, Equatable, Sendable {}`
            : `struct ${name}: Codable, Equatable, Sendable {\n${fields.join('\n')}\n}`
        return declare(em, name, body)
      }

      // ---------------------------------------------------------------------------- the input

      export interface GenInput {
        readonly wireMajor: number
        /** Schemas that must get a stable shared Swift name instead of a nested generated one. */
        readonly named: readonly (readonly [z.ZodType, string])[]
        /** `[method, paramsSchema]`, one per request the agent accepts. */
        readonly requests: readonly (readonly [string, z.ZodType])[]
        /** `[method, resultSchema]`, one per request. */
        readonly results: readonly (readonly [string, z.ZodType])[]
        /** `[event, dataSchema]`, one per event the agent emits. */
        readonly events: readonly (readonly [string, z.ZodType])[]
      }

      /**
       * The subset of `@cairn/protocol` this generator reads. `WIRE_MAJOR` is the only number in it:
       * a zod schema has nowhere to hang a bare limit, so the generated Swift carries no
       * `MAX_REP_BYTES` and friends. Task 4's `Wire.swift` declares those six itself, guarded by a test
       * that reads `constants.ts`; emitting them here as well would be a Swift redeclaration error.
       */
      export interface ProtocolSchemas {
        readonly WIRE_MAJOR: number
        readonly HintSchema: z.ZodType
        readonly RepSchema: z.ZodType
        readonly AgentCapabilitiesSchema: z.ZodType
        readonly AgentErrorSchema: z.ZodType
        readonly AgentRequestSchema: z.ZodType
        readonly AgentEventSchema: z.ZodType
        readonly AgentResultSchema: Readonly<Record<string, z.ZodType>>
      }

      function unionOptions(u: z.ZodType, what: string): readonly z.ZodType[] {
        const options = defOf(u).options
        if (options === undefined || options.length === 0) {
          throw new GenError(`${what} is not a non-empty union`)
        }
        return options
      }

      function stringLiteral(s: z.ZodType | undefined, what: string): string {
        const v = s === undefined ? undefined : defOf(s).values?.[0]
        if (typeof v !== 'string') throw new GenError(`${what} is not a string literal`)
        return v
      }

      /** Derives the generator's input from the protocol module, so nothing is hand-listed twice. */
      export function agentGenInput(m: ProtocolSchemas): GenInput {
        const pairs = (union: z.ZodType, discriminator: 'method' | 'event', payload: 'params' | 'data') =>
          unionOptions(union, `Agent${pascal(discriminator)}Schema`).map((option) => {
            const shape = defOf(option).shape ?? {}
            const key = stringLiteral(shape[discriminator], `${discriminator} discriminator`)
            const body = shape[payload]
            if (body === undefined) throw new GenError(`'${key}' has no ${payload} schema`)
            return [key, body] as const
          })

        const requests = pairs(m.AgentRequestSchema, 'method', 'params')
        const events = pairs(m.AgentEventSchema, 'event', 'data')
        const results = requests.map(([method]) => {
          const result = m.AgentResultSchema[method]
          if (result === undefined) throw new GenError(`AgentResultSchema has no entry for method '${method}'`)
          return [method, result] as const
        })

        return {
          wireMajor: m.WIRE_MAJOR,
          named: [
            [m.HintSchema, 'Hint'],
            [m.RepSchema, 'Rep'],
            [m.AgentCapabilitiesSchema, 'AgentCapabilities'],
            [m.AgentErrorSchema, 'AgentError'],
          ],
          requests,
          results,
          events,
        }
      }

      // ----------------------------------------------------------------------------- the file

      const HEADER = `// GENERATED FILE — DO NOT EDIT.
      //
      // Emitted by tools/gen-agent-types.ts from the zod schemas in packages/protocol/src/agent.ts.
      // Regenerate with \`npm run gen:agent-types\`. tools/gen-agent-types.test.ts fails if this file is
      // stale, so a renamed field on the TypeScript side becomes a Swift compile error here rather than a
      // silent runtime mismatch across the stdio pipe.

      import Foundation`

      /**
       * Hand-written, not derived: the value side of the `log` event's metadata bag. It is deliberately
       * NOT a general JSON value — there is no `.object` or `.array` case, because the host drops the
       * agent's log fields anyway and a nested payload is where clipboard bytes would hide.
       */
      const LOG_VALUE = `/// A single \`log\` event field value. Metadata only — never clipboard bytes.
      enum AgentLogValue: Codable, Equatable, Sendable {
          case string(String)
          case number(Double)
          case bool(Bool)
          case null

          init(from decoder: Decoder) throws {
              let container = try decoder.singleValueContainer()
              if container.decodeNil() {
                  self = .null
              } else if let value = try? container.decode(Bool.self) {
                  self = .bool(value)
              } else if let value = try? container.decode(Double.self) {
                  self = .number(value)
              } else {
                  self = .string(try container.decode(String.self))
              }
          }

          func encode(to encoder: Encoder) throws {
              var container = encoder.singleValueContainer()
              switch self {
              case .string(let value): try container.encode(value)
              case .number(let value): try container.encode(value)
              case .bool(let value): try container.encode(value)
              case .null: try container.encodeNil()
              }
          }
      }`

      function stringEnum(name: string, doc: string, values: readonly string[]): string {
        const cases = values.map((v) => `    case ${ident(camel(v))} = "${v}"`).join('\n')
        return `/// ${doc}\nenum ${name}: String, Codable, Equatable, Sendable, CaseIterable {\n${cases}\n}`
      }

      export function generateSwift(input: GenInput): string {
        const em: Emitter = { decls: new Map(), named: new Map(input.named) }

        for (const [method, params] of input.requests) emitStruct(`${pascal(method)}Params`, params, em)
        for (const [event, data] of input.events) emitStruct(`${pascal(event)}Data`, data, em)
        for (const [method, result] of input.results) {
          const name = `${pascal(method)}Result`
          const registered = em.named.get(result)
          if (registered !== undefined) {
            // e.g. `hello`'s result IS AgentCapabilities; alias it rather than emitting a twin struct.
            declare(em, name, `typealias ${name} = ${registered}`)
          } else {
            emitStruct(name, result, em)
          }
        }
        // Named schemas are reachable only if some field referenced them; force them all so the Swift
        // side always has `Rep`, `Hint`, `AgentCapabilities` and `AgentError` even if a field is dropped.
        for (const [schema, name] of input.named) {
          if (em.decls.has(name)) continue
          if (defOf(schema).type === 'enum') {
            const values = Object.values(defOf(schema).entries ?? {}).map(String)
            declare(em, name, stringEnum(name, `Values of the ${name} wire enum.`, values))
          } else {
            const shape = defOf(schema).shape
            if (shape === undefined) throw new GenError(`named schema '${name}' is neither an object nor an enum`)
            emitStruct(name, schema, em)
          }
        }

        const sections = [
          HEADER,
          `/// The wire major this agent speaks. Any other value must fail to parse.\nlet protocolVersion = ${input.wireMajor}`,
          stringEnum('AgentMethod', 'Every request the host may send.', input.requests.map(([m]) => m)),
          stringEnum('AgentEventName', 'Every event the agent may emit.', input.events.map(([e]) => e)),
          LOG_VALUE,
          ...[...em.decls.keys()].sort().map((k) => em.decls.get(k) ?? ''),
        ]
        return sections.join('\n\n') + '\n'
      }

      // ------------------------------------------------------------------------- entry point

      export const GENERATED_PATH = join(
        dirname(dirname(fileURLToPath(import.meta.url))),
        'agents', 'macos', 'Sources', 'AgentProtocol.generated.swift',
      )

      /**
       * Node's ESM resolver has no extension search, but the contract's relative imports are
       * extensionless (`./result`) because `moduleResolution: bundler` resolves them for tsc, vite and
       * vitest. This hook adds `.ts` so `node tools/gen-agent-types.ts` can load the package source
       * directly, with no build step and no extra dependency. It is registered ONLY when this file is
       * the process entry point, so importing it from a test leaves Node's resolver untouched.
       */
      function registerExtensionlessTsResolution(): void {
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (
              specifier.startsWith('.') &&
              !/\.[cm]?[jt]s$/.test(specifier) &&
              context.parentURL !== undefined
            ) {
              const candidate = new URL(`${specifier}.ts`, context.parentURL)
              if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
            }
            return nextResolve(specifier, context)
          },
        })
      }

      const isEntryPoint =
        process.argv[1] !== undefined &&
        pathToFileURL(resolve(process.argv[1])).href === import.meta.url

      if (isEntryPoint) {
        registerExtensionlessTsResolution()
        const protocol = (await import('@cairn/protocol')) as unknown as ProtocolSchemas
        const next = generateSwift(agentGenInput(protocol))
        const previous = existsSync(GENERATED_PATH) ? readFileSync(GENERATED_PATH, 'utf8') : ''
        if (previous === next) {
          process.stdout.write(`gen:agent-types — up to date (${GENERATED_PATH})\n`)
        } else {
          mkdirSync(dirname(GENERATED_PATH), { recursive: true })
          writeFileSync(GENERATED_PATH, next, { encoding: 'utf8' })
          process.stdout.write(`gen:agent-types — wrote ${next.length} bytes to ${GENERATED_PATH}\n`)
        }
      }
      ```

      **Important about the two template literals `HEADER` and `LOG_VALUE`:** in the block above they
      are indented to match the surrounding plan text. In the real file they must start at **column
      0**, exactly as shown, because their contents are emitted verbatim into the Swift file. If you
      indent them, the Swift is still valid but the golden test in Step 47 will disagree with the
      committed file forever. Strip the leading indentation from every line inside those two
      backtick strings when you paste.

- [ ] **Step 45: Generate the Swift, twice, and confirm the second run is a no-op.**

      ```sh
      npm run gen:agent-types
      npm run gen:agent-types
      ```

      Expected: first run prints
      `gen:agent-types — wrote 6705 bytes to <repo>/agents/macos/Sources/AgentProtocol.generated.swift`;
      second run prints `gen:agent-types — up to date (…)`. Idempotence is not cosmetic — a generator
      that rewrites the file on every run makes `git status` permanently dirty and trains everyone to
      ignore it.

      If the first run fails with `ERR_MODULE_NOT_FOUND` for a path like `.../src/agent`, you are on
      Node 20: run `nvm use` and try again.

- [ ] **Step 46: Read the generated Swift and check it against the schemas by eye.**

      ```sh
      sed -n '1,60p' agents/macos/Sources/AgentProtocol.generated.swift
      grep -c '^struct \|^enum \|^typealias ' agents/macos/Sources/AgentProtocol.generated.swift
      grep -c '^let ' agents/macos/Sources/AgentProtocol.generated.swift
      wc -c agents/macos/Sources/AgentProtocol.generated.swift
      ```

      Expected: the header, `import Foundation`, `let protocolVersion = 1`, then `AgentMethod` with
      eight cases and `AgentEventName` with four. The first grep prints `35` (23 structs, 11 enums,
      1 typealias), the second prints `1` — `protocolVersion` is the only top-level `let`, because a zod
      schema has nowhere to hang a bare number — and `wc -c` prints `6709`, four more than the 6705
      characters the generator reported, because the two em dashes in the header are 3 bytes each.
      This is the **whole** file, complete, and it is what you are comparing against:

      ```swift
      // GENERATED FILE — DO NOT EDIT.
      //
      // Emitted by tools/gen-agent-types.ts from the zod schemas in packages/protocol/src/agent.ts.
      // Regenerate with `npm run gen:agent-types`. tools/gen-agent-types.test.ts fails if this file is
      // stale, so a renamed field on the TypeScript side becomes a Swift compile error here rather than a
      // silent runtime mismatch across the stdio pipe.

      import Foundation

      /// The wire major this agent speaks. Any other value must fail to parse.
      let protocolVersion = 1

      /// Every request the host may send.
      enum AgentMethod: String, Codable, Equatable, Sendable, CaseIterable {
          case hello = "hello"
          case watchStart = "watch.start"
          case watchStop = "watch.stop"
          case read = "read"
          case write = "write"
          case hotkeyRegister = "hotkey.register"
          case hotkeyUnregister = "hotkey.unregister"
          case shutdown = "shutdown"
      }

      /// Every event the agent may emit.
      enum AgentEventName: String, Codable, Equatable, Sendable, CaseIterable {
          case clipboardChanged = "clipboard.changed"
          case repChunk = "rep.chunk"
          case hotkeyFired = "hotkey.fired"
          case log = "log"
      }

      /// A single `log` event field value. Metadata only — never clipboard bytes.
      enum AgentLogValue: Codable, Equatable, Sendable {
          case string(String)
          case number(Double)
          case bool(Bool)
          case null

          init(from decoder: Decoder) throws {
              let container = try decoder.singleValueContainer()
              if container.decodeNil() {
                  self = .null
              } else if let value = try? container.decode(Bool.self) {
                  self = .bool(value)
              } else if let value = try? container.decode(Double.self) {
                  self = .number(value)
              } else {
                  self = .string(try container.decode(String.self))
              }
          }

          func encode(to encoder: Encoder) throws {
              var container = encoder.singleValueContainer()
              switch self {
              case .string(let value): try container.encode(value)
              case .number(let value): try container.encode(value)
              case .bool(let value): try container.encode(value)
              case .null: try container.encodeNil()
              }
          }
      }

      struct AgentCapabilities: Codable, Equatable, Sendable {
          var agent: AgentCapabilitiesAgent
          var agentVersion: String
          var chunkThresholdBytes: Int
          var clipboardWatch: AgentCapabilitiesClipboardWatch
          var concealedTypeHints: Bool
          var focusApp: Bool
          var hotkey: AgentCapabilitiesHotkey
          var maxRepBytes: Int
          var missingTools: [String]?
          var paste: AgentCapabilitiesPaste
          var platformVersion: String
          var tier: AgentCapabilitiesTier
          var wireMajor: Int
      }

      enum AgentCapabilitiesAgent: String, Codable, Equatable, Sendable, CaseIterable {
          case macos = "macos"
          case win32 = "win32"
          case linux = "linux"
      }

      enum AgentCapabilitiesClipboardWatch: String, Codable, Equatable, Sendable, CaseIterable {
          case changecountPoll = "changecount-poll"
          case sequencePoll = "sequence-poll"
          case xfixes = "xfixes"
          case wlPasteWatch = "wl-paste-watch"
          case focusOnly = "focus-only"
          case none = "none"
      }

      enum AgentCapabilitiesHotkey: String, Codable, Equatable, Sendable, CaseIterable {
          case carbon = "carbon"
          case win32Hotkey = "win32-hotkey"
          case portal = "portal"
          case electron = "electron"
          case none = "none"
      }

      enum AgentCapabilitiesPaste: String, Codable, Equatable, Sendable, CaseIterable {
          case cgevent = "cgevent"
          case sendinput = "sendinput"
          case ydotool = "ydotool"
          case none = "none"
      }

      enum AgentCapabilitiesTier: String, Codable, Equatable, Sendable, CaseIterable {
          case a = "A"
          case b = "B"
          case c = "C"
          case d = "D"
      }

      struct AgentError: Codable, Equatable, Sendable {
          var code: String
          var message: String
      }

      struct ClipboardChangedData: Codable, Equatable, Sendable {
          var attributionConfidence: ClipboardChangedDataAttributionConfidence
          var changeCount: Int
          var frontmostBundleId: String?
          var frontmostName: String?
          var hints: [Hint]?
          var reps: [Rep]
      }

      enum ClipboardChangedDataAttributionConfidence: String, Codable, Equatable, Sendable, CaseIterable {
          case heuristic = "heuristic"
          case unknown = "unknown"
      }

      struct HelloParams: Codable, Equatable, Sendable {
          var hostVersion: String
      }

      typealias HelloResult = AgentCapabilities

      /// Values of the Hint wire enum.
      enum Hint: String, Codable, Equatable, Sendable, CaseIterable {
          case concealed = "concealed"
          case transient = "transient"
          case autoGenerated = "auto-generated"
          case passwordManager = "password-manager"
      }

      struct HotkeyFiredData: Codable, Equatable, Sendable {
          var accelerator: String
          var firedAt: Int
          var focusToken: String
      }

      struct HotkeyRegisterParams: Codable, Equatable, Sendable {
          var accelerator: String
      }

      struct HotkeyRegisterResult: Codable, Equatable, Sendable {
          var accelerator: String
          var bound: Bool
      }

      struct HotkeyUnregisterParams: Codable, Equatable, Sendable {}

      struct HotkeyUnregisterResult: Codable, Equatable, Sendable {
          var bound: Bool
      }

      struct LogData: Codable, Equatable, Sendable {
          var event: String
          var fields: [String: AgentLogValue]?
          var level: LogDataLevel
      }

      enum LogDataLevel: String, Codable, Equatable, Sendable, CaseIterable {
          case debug = "debug"
          case info = "info"
          case warn = "warn"
          case error = "error"
      }

      struct ReadParams: Codable, Equatable, Sendable {
          var changeCount: Int
      }

      struct ReadResult: Codable, Equatable, Sendable {
          var changeCount: Int
          var hints: [Hint]?
          var reps: [Rep]
      }

      struct Rep: Codable, Equatable, Sendable {
          var byteLength: Int
          var inline: Data?
          var mime: String
          var repId: String?
          var sha256: String
          var uti: String?
      }

      struct RepChunkData: Codable, Equatable, Sendable {
          var b64: Data
          var final: Bool
          var repId: String
          var seq: Int
      }

      struct ShutdownParams: Codable, Equatable, Sendable {}

      struct ShutdownResult: Codable, Equatable, Sendable {
          var bye: Bool
      }

      struct WatchStartParams: Codable, Equatable, Sendable {
          var intervalMs: Int
      }

      struct WatchStartResult: Codable, Equatable, Sendable {
          var intervalMs: Int
          var watching: Bool
      }

      struct WatchStopParams: Codable, Equatable, Sendable {}

      struct WatchStopResult: Codable, Equatable, Sendable {
          var watching: Bool
      }

      struct WriteParams: Codable, Equatable, Sendable {
          var reps: [WriteParamsRepsItem]
          var transient: Bool
      }

      struct WriteParamsRepsItem: Codable, Equatable, Sendable {
          var b64: Data
          var mime: String
          var uti: String?
      }

      struct WriteResult: Codable, Equatable, Sendable {
          var changeToken: String
      }
      ```

- [ ] **Step 47: Run the codegen test and watch it pass.**

      ```sh
      npx vitest run tools/gen-agent-types.test.ts
      ```

      Expected: PASS — `Tests  22 passed (22)`.
      If the first test fails with a long string diff, the two template literals in Step 44 are
      indented. Fix the indentation, re-run `npm run gen:agent-types`, and re-run this.

- [ ] **Step 48: Prove the generated Swift actually compiles.**
      A codegen test that only compares strings can happily emit Swift that does not build. This step
      is the real check, and it is deliberately **not** a vitest test: every TypeScript test in this
      repo must run on a machine with no compiler (spec §7). The probe lives in `/tmp`, outside the
      repo, so it can never be committed.

      ```sh
      swiftc -parse agents/macos/Sources/AgentProtocol.generated.swift && echo "parse OK"
      swiftc -typecheck agents/macos/Sources/AgentProtocol.generated.swift && echo "typecheck OK"

      mkdir -p /tmp/cairn-swift-probe && cat > /tmp/cairn-swift-probe/main.swift <<'SWIFT'
      import Foundation

      // A real clipboard.changed payload, including an unknown key a future agent might add.
      let json = """
      {"changeCount":364,"hints":["concealed"],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic","futureField":42}
      """
      let decoded = try JSONDecoder().decode(ClipboardChangedData.self, from: Data(json.utf8))
      print("protocolVersion=\(protocolVersion)")
      print("hints=\(decoded.hints ?? [])")
      print("inline-as-utf8=\(String(data: decoded.reps[0].inline!, encoding: .utf8)!)")

      // Empty-params requests still decode from `{}`.
      _ = try JSONDecoder().decode(ShutdownParams.self, from: Data("{}".utf8))
      _ = try JSONDecoder().decode(WatchStopParams.self, from: Data("{}".utf8))

      // Data encodes as base64 with no manual call, and sortedKeys makes the line diffable.
      let enc = JSONEncoder()
      enc.outputFormatting = .sortedKeys
      let chunk = RepChunkData(b64: Data("hello world".utf8), final: true, repId: "r1", seq: 0)
      print(String(data: try enc.encode(chunk), encoding: .utf8)!)

      // The write path, with the generated nested name and alphabetical labels.
      let write = WriteParams(reps: [WriteParamsRepsItem(b64: Data("hello world".utf8),
                                                        mime: "text/plain", uti: "public.utf8-plain-text")],
                              transient: false)
      print(String(data: try enc.encode(write), encoding: .utf8)!)

      let log = LogData(event: "pasteboard.read",
                        fields: ["byteLength": .number(11), "ok": .bool(true), "nothing": .null],
                        level: .warn)
      print(String(data: try enc.encode(log), encoding: .utf8)!)

      let caps = HelloResult(agent: .macos, agentVersion: "0.1.0", chunkThresholdBytes: 65536,
                             clipboardWatch: .changecountPoll, concealedTypeHints: true, focusApp: true,
                             hotkey: .carbon, maxRepBytes: 20971520, missingTools: [],
                             paste: AgentCapabilitiesPaste.none, platformVersion: "26.5.1",
                             tier: .a, wireMajor: protocolVersion)
      print(String(data: try enc.encode(caps), encoding: .utf8)!)
      SWIFT

      swiftc -O -target "$(/usr/bin/uname -m)-apple-macos13.0" \
        -o /tmp/cairn-swift-probe/probe \
        agents/macos/Sources/AgentProtocol.generated.swift /tmp/cairn-swift-probe/main.swift \
        && /tmp/cairn-swift-probe/probe
      ```

      Expected, exactly — `[verified]` on Apple Swift 6.3.3, arm64:

      ```
      parse OK
      typecheck OK
      protocolVersion=1
      hints=[probe.Hint.concealed]
      inline-as-utf8=hello world
      {"b64":"aGVsbG8gd29ybGQ=","final":true,"repId":"r1","seq":0}
      {"reps":[{"b64":"aGVsbG8gd29ybGQ=","mime":"text\/plain","uti":"public.utf8-plain-text"}],"transient":false}
      {"event":"pasteboard.read","fields":{"byteLength":11,"nothing":null,"ok":true},"level":"warn"}
      {"agent":"macos","agentVersion":"0.1.0","chunkThresholdBytes":65536,"clipboardWatch":"changecount-poll","concealedTypeHints":true,"focusApp":true,"hotkey":"carbon","maxRepBytes":20971520,"missingTools":[],"paste":"none","platformVersion":"26.5.1","tier":"A","wireMajor":1}
      ```

      Four things this proves beyond "it compiles". Swift's `Codable` ignores `futureField` exactly the
      way zod's `z.object()` strips it, so both sides of the pipe agree on the tolerance rule. A `Data`
      field really does round-trip as base64 with no manual call, in both directions, which is why
      Task 4's `Chunker.split` returns `[Data]`. `WriteParamsRepsItem` is the real nested struct name,
      so `Writer.swift` compiles against `[WriteParamsRepsItem]`. And the last line is a valid
      `AgentCapabilitiesSchema` input, so `hello` will round-trip across the process boundary.

      One cosmetic surprise in the `WriteParams` line: Foundation's `JSONEncoder` escapes the forward
      slash, so `text/plain` is emitted as `text\/plain`. That is legal JSON, `JSON.parse` returns
      `text/plain`, and nothing needs to strip it. Then clean up:

      ```sh
      rm -rf /tmp/cairn-swift-probe
      ```

- [ ] **Step 49: Prove the drift alarm actually bites.**
      Rename one zod field and confirm the committed Swift is reported stale.

      ```sh
      sed -i '' 's/hostVersion: z.string().min(1)/hostVer: z.string().min(1)/' packages/protocol/src/agent.ts
      npx vitest run tools/gen-agent-types.test.ts
      ```

      Expected: FAIL — `Tests  1 failed | 21 passed (22)`, with
      `AssertionError: expected '// GENERATED FILE — DO NOT EDIT.\n//\…' to be '// GENERATED FILE — DO NOT EDIT.\n//\…' // Object.is equality`
      from the `is byte-identical` test. That is the alarm. Now revert it:

      ```sh
      sed -i '' 's/hostVer: z.string().min(1)/hostVersion: z.string().min(1)/' packages/protocol/src/agent.ts
      git diff --stat packages/protocol/src/agent.ts
      npx vitest run tools/gen-agent-types.test.ts
      ```

      Expected: the diff is empty (`agent.ts` is committed as of Step 23, so `git diff` on it prints
      nothing), and the test is back to `Tests  22 passed (22)`.

- [ ] **Step 50: Run the whole task's suite and the typechecker together.**

      ```sh
      npx tsc -p tsconfig.json && echo "typecheck OK"
      npx vitest run packages/protocol tools
      wc -l packages/protocol/src/index.ts
      npx vitest run
      ```

      Expected: `typecheck OK`; then `Test Files  11 passed (11)`, `Tests  104 passed (104)` for the
      scoped run — 92 of those are this task's nine test files, and 12 are the scaffolding task's
      `constants.test.ts` and `testing.test.ts`; then `11 packages/protocol/src/index.ts`, the complete
      barrel. The unscoped `npx vitest run` must also exit 0 with `0 failed`; its totals depend on which
      other task branches are already merged into `origin/main`, so assert **zero failures**, not a
      count.
      Also confirm nothing stray was created — this task writes exactly one file at runtime:

      ```sh
      git status --short
      ```

      Expected: only the codegen files you are about to commit — `?? tools/gen-agent-types.ts`,
      `?? tools/gen-agent-types.test.ts`, `?? agents/macos/Sources/AgentProtocol.generated.swift`.
      No `.tmp`, no spool file, no directory under `$TMPDIR`.

- [ ] **Step 51: Commit the codegen and the generated Swift together.**
      They must land in one commit: a generated file committed apart from its generator is a file
      nobody can reproduce.

      ```sh
      git add tools/gen-agent-types.ts tools/gen-agent-types.test.ts \
              agents/macos/Sources/AgentProtocol.generated.swift
      git commit -m "feat(tools): generate AgentProtocol.generated.swift from the zod schemas

The committed Swift must be byte-identical to the generator's output, so a zod
field rename becomes a reviewable diff and then a Swift compile error instead of
a silent runtime mismatch. The generator throws GenError on any zod construct it
cannot map rather than emitting a plausible wrong type."
      ```

- [ ] **Step 52: Push the branch for the user to merge.**
      Never merge to `main` yourself.

      ```sh
      git log --oneline origin/main..HEAD
      git push -u origin m1/02-protocol
      ```

      Expected: **eight** commits listed — one each from Steps 13, 18, 23, 29, 33, 37, 41 and 51 — and a
      push confirmation naming `m1/02-protocol`.

---

**Task 2 done when:**

- [ ] `git rev-parse --abbrev-ref HEAD` prints `m1/02-protocol`, and `git log origin/main..HEAD` shows
      only commits authored in this task — **no `Co-Authored-By` and no AI-attribution trailer in any
      of them** (`git log --format=%B origin/main..HEAD | grep -i -e co-authored -e 'generated with'`
      prints nothing).
- [ ] `npx tsc -p tsconfig.json` exits 0.
- [ ] `npx vitest run packages/protocol tools` reports `Test Files  11 passed (11)`,
      `Tests  104 passed (104)`, and `npx vitest run` exits 0 with `0 failed`.
- [ ] `npm run test -w @cairn/protocol` reports `Test Files  10 passed (10)`, `Tests  82 passed (82)`.
- [ ] `npx vitest run tools/gen-agent-types.test.ts` reports `Tests  22 passed (22)`.
- [ ] `npm run gen:agent-types` prints `gen:agent-types — up to date (…)` and leaves
      `git status --short` empty.
- [ ] `swiftc -typecheck agents/macos/Sources/AgentProtocol.generated.swift` exits 0.
- [ ] Adding `readonly [k: string]: unknown` to `LogFields` makes `npx tsc -p tsconfig.json` fail with
      `TS2578: Unused '@ts-expect-error' directive` (verified in Step 11) — the metadata-only log type
      is enforced, not documented.
- [ ] `grep -oE "'[a-z][a-z-]*\.[a-z][a-z-]*'" packages/protocol/src/log.ts | wc -l` prints **46** and
      `… | sort | uniq -d` prints nothing `[verified]` against this plan's own snippet; and
      `npx vitest run packages/protocol/src/log.test.ts` reports `Tests  5 passed (5)` with
      `LOG_EVENTS` at length **46** — the 39 subsystem ids plus the seven `renderer.*` /
      `preview-cache.*` / `config.*` ids the desktop-shell task needs. That task **verifies** these
      seven; it must not append them, because a second append gives 53 entries with 7 duplicates and
      fails the first test in `log.test.ts`.
- [ ] `grep -c 'createLogger' packages/protocol/src/log.ts` prints **0**. `log.ts` exports the `Logger`
      interface and no implementation; the only concrete logger in the repo is
      `apps/desktop/main/src/logger.ts`, so there is exactly one place a log line can reach a sink.
- [ ] Renaming any field in `packages/protocol/src/agent.ts` makes
      `npx vitest run tools/gen-agent-types.test.ts` fail on `is byte-identical` (verified in Step 49).
- [ ] `grep -rn 'crashReporter\|mkdtemp\|os.tmpdir\|tmpdir(\|net.createServer\|fetch(' packages/protocol/src tools/gen-agent-types.ts`
      prints nothing. This package does no I/O beyond writing the one generated Swift file, opens no
      socket, and never initialises crash reporting.
- [ ] `grep -rn 'sha256-' packages/protocol/src/hash.ts` shows the prefix is built from
      `digest('base64url')` — never `base64`, never over a JSON string.
- [ ] `packages/protocol/src/index.ts` contains exactly eleven `export * from` lines — `./agent`,
      `./clock`, `./constants`, `./hash`, `./id`, `./ipc`, `./log`, `./parse-agent-line`, `./result`,
      `./testing`, `./types` — so every module contract §5 names is reachable, and no file outside
      `packages/protocol/src/` imports a deep path such as `@cairn/protocol/src/types`
      (`grep -rn '@cairn/protocol/' --include='*.ts' . | grep -v node_modules` prints nothing).
- [ ] `grep -c '^export \* from' packages/protocol/src/index.ts` prints **11**, and every one of those
      eleven modules is exercised by a test in this run — so `Clock`, `createTestClock`, `newItemId`,
      `LOG_EVENTS`, `IpcRequestSchema`, `ItemSummary`, `contentHash`, `parseAgentLine` and
      `fixturePath` are all reachable as `import { … } from '@cairn/protocol'` for Tasks 3, 5, 6, 7, 8,
      9 and 10.
- [ ] `agents/macos/Sources/AgentProtocol.generated.swift` is committed, `wc -c` reports **6709**
      bytes (the generator reports 6705 *characters*; the two em dashes cost 2 extra bytes each),
      `grep -c '^struct \|^enum \|^typealias '` reports **35**, `grep -c '^let '` reports **1**, and its
      first line is `// GENERATED FILE — DO NOT EDIT.`
- [ ] `grep -c 'WriteParamsRepsItem' agents/macos/Sources/AgentProtocol.generated.swift` reports **2**
      (the declaration plus `WriteParams.reps`) and `grep -c ': Data' …` reports **3** (`Rep.inline`,
      `RepChunkData.b64`, `WriteParamsRepsItem.b64`) — the two facts Task 4's six Swift files are
      written against. Changing either one is a cross-task break, not a refactor.
