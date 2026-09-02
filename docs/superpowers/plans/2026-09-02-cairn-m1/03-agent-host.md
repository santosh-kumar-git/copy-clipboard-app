### Task 3: @cairn/agent-host — lifecycle, NDJSON framing, in-memory chunk reassembly, and the fake agent

This package is the only thing in Cairn that talks to an agent process. Everything above it depends on
the `ClipboardAgent` interface, never on a child process, which is why every later task can be tested
with no compiler, no clipboard and no OS permission.

It is also where the single most dangerous mistake in this codebase would live. An earlier revision of
the design spooled oversized clipboard representations to plaintext files in `$TMPDIR`. That is gone.
Representations at or over 64 KiB arrive as `rep.chunk` events on the **same stdout pipe** and are
reassembled **in memory**. If you find yourself typing `mkdtemp`, `writeFileSync`, `createWriteStream`
or the word "spool" anywhere in `packages/agent-host/src/*.ts`, stop: Step 47's in-package scan fails,
and for anything outside a `.test.ts` file the repo-wide
`security/no-plaintext-on-disk.security.test.ts` fails too.

You are writing this **before the Swift agent exists**. Every test runs against a tiny Node stand-in
agent whose full source is in Step 31, spawned as `process.execPath -e <source>` — a real child
process, a real pipe, real partial chunks.

**Files:**

Create:
```
packages/agent-host/package.json            @cairn/agent-host manifest
packages/agent-host/src/framing.ts          createLineSplitter(): Buffer chunks -> whole lines
packages/agent-host/src/framing.test.ts     split mid-line, split mid-UTF8, MAX_LINE_BYTES guard
packages/agent-host/src/correlator.ts       id -> pending promise, per-request timeouts
packages/agent-host/src/correlator.test.ts  timeout, late response, response for unknown id
packages/agent-host/src/reassembler.ts      the rep.chunk state machine (contract §4)
packages/agent-host/src/reassembler.test.ts happy path + every failure code
packages/agent-host/src/spawn-agent.ts      createAgentCore + child_process.spawn, restart, dispose
packages/agent-host/src/spawn-agent.test.ts uses a `node -e` stub agent, not the Swift binary
packages/agent-host/src/transcript.ts       transcript file parser + zod schema (contract §7)
packages/agent-host/src/transcript.test.ts  rejects a transcript without a meta line
packages/agent-host/src/fake-agent.ts       createFakeAgent(transcriptPath) (contract §7)
packages/agent-host/src/fake-agent.test.ts  asserts the outbound script and fails loudly on drift
packages/agent-host/src/index.ts            public entry: spawnAgent, createFakeAgent, types
fixtures/agent-transcripts/hello-watch-text.ndjson    hello -> watch.start -> one text copy
fixtures/agent-transcripts/image-tiff-chunked.ndjson  a 200 000-byte image over rep.chunk
```

Modify: nothing. The root `package.json` already declares `"workspaces": ["packages/*", "apps/desktop"]`,
so this package joins by existing.

Test: every file above ending `.test.ts`. All of them run in the **`unit`** vitest project. This
package ships **no** `*.security.test.ts` file — the contract's file tree does not list one — so the
no-bytes-on-disk guard lives inside `spawn-agent.test.ts` (Steps 47–50).

There is a **second, repo-wide** layer of the same guard: `security/no-plaintext-on-disk.security.test.ts`
(contract §1, contract §8 CI table). It is created by **Task 6's step that writes contract §8's
repo-wide no-plaintext-on-disk test**, and its source scan goes through `findInSources()` from
`security/source-scan.ts` — there is exactly one comment stripper in the repo, not a second weaker
copy. Note that the repo-wide scan **exempts every path ending `.test.ts`**, which is precisely why the
local guard in this task's own `spawn-agent.test.ts` still has to exist and why its needles are
fragment-assembled. It reads every `.ts` file under `packages/**` and `apps/desktop/**`, strips
comments first (the ban is on *code*, so a comment may name an identifier), and bans `mkdtemp`,
`tmpdir(`, `os.tmpdir`, `spool`, `writeFileSync(`, `appendFileSync(` and `createWriteStream(`. Its
exemptions are: **every path ending `.test.ts`**, `packages/store/` for the three write identifiers,
and the single file `packages/store/src/testing.ts` for the temp-dir ones. `apps/desktop/main/src/config.ts`
is deliberately **not** exempt.

Because `*.test.ts` is exempt there, the local scan in Step 47 below is the **stricter** of the two: it
covers this package's test files as well as its product code. That is the safe direction, so keep it —
including its fragment-assembled needles, which let the scan survive reading its own source. Do not add
more layers, and do not relax Step 47 to match the repo-wide exemption.

The other five transcripts in the contract's fixture list (`finder-multifile`,
`concealed-1password`, `self-write-suppression`, `duplicate-notify`, `chrome-source-url`) belong to
the `@cairn/capture` task, not this one. Do not create them here.

**Interfaces:**

`Consumes:` — all from `@cairn/protocol`, imported as `from '@cairn/protocol'` and never by a deep path.

```ts
// values
export function parseAgentLine(line: string): Result<AgentLine>
export function contentHash(bytes: Uint8Array): ContentHash
export const ok: <T>(value: T) => Ok<T>
export const err: (code: ErrorCode, message: string, detail?: LogFields) => Err
export const ERROR_CODES: readonly ErrorCode[]
export const AgentResultSchema: {
  hello: ZodType; 'watch.start': ZodType; 'watch.stop': ZodType; read: ZodType
  write: ZodType; 'hotkey.register': ZodType; 'hotkey.unregister': ZodType; shutdown: ZodType
}
export const WIRE_MAJOR: 1
export const CHUNK_THRESHOLD_BYTES: 65_536
export const CHUNK_PAYLOAD_BYTES: 32_768
export const MAX_REP_BYTES: 20_971_520
export const MAX_LINE_BYTES: 1_048_576
export const REP_STREAM_TIMEOUT_MS: 5_000
export const MAX_CONCURRENT_REP_STREAMS: 8
export const AGENT_REQUEST_TIMEOUT_MS: 2_000
export function createTestClock(startMs?: number): TestClock   // test-only

// types
interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Cancel }
interface TestClock extends Clock { advance(ms: number): void; readonly pending: number }
type Cancel = () => void
interface Logger { debug/info/warn/error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void }
type Rep = { mime: string; uti: string | null; byteLength: number; sha256: string; inline?: string; repId?: string }
interface ResolvedRep { mime: string; uti: string | null; bytes: Uint8Array; byteLength: number; sha256: ContentHash }
interface ClipboardChangedPayload {
  changeCount: number; changeToken: string; hints: readonly PasteboardHint[]
  reps: readonly ResolvedRep[]; sourceApp: SourceApp | null
  droppedReps: readonly { mime: string; code: ErrorCode }[]
}
interface RepChunkPayload { repId: string; seq: number; final: boolean }
interface AgentEventMap {
  'clipboard.changed': ClipboardChangedPayload; 'rep.chunk': RepChunkPayload
  'hotkey.fired': HotkeyFiredPayload; log: AgentLogPayload
}
interface ClipboardAgent {
  start(): Promise<AgentCapabilities>
  request<M extends AgentMethod>(method: M, params: AgentParams<M>, timeoutMs?: number): Promise<Result<AgentResult<M>>>
  on<E extends keyof AgentEventMap>(event: E, cb: (payload: AgentEventMap[E]) => void): Unsub
  dispose(): Promise<void>
}
type AgentCapabilities, AgentMethod, AgentParams<M>, AgentResult<M>, AgentResponse, AgentPlatform
type Result<T>, Ok<T>, Err, ErrorCode, ContentHash, PasteboardHint, SourceApp, Unsub, LogEvent, LogFields
```

`Produces:` — the exact exports of `packages/agent-host/src/index.ts`. Later tasks (`@cairn/hotkey`,
`@cairn/capture`, `apps/desktop`) see only this list.

```ts
// ---- framing.ts
export interface LineSplitter {
  push(chunk: Uint8Array): void
  reset(): void
  readonly bufferedBytes: number
}
export interface LineSplitterOptions {
  onLine: (line: string) => void
  onOverflow: (droppedBytes: number) => void
  maxLineBytes?: number
}
export function createLineSplitter(opts: LineSplitterOptions): LineSplitter

// ---- reassembler.ts
export interface RepAbort { readonly repId: string; readonly mime: string; readonly code: ErrorCode }
export interface RepChunkIn { readonly repId: string; readonly seq: number; readonly final: boolean; readonly b64: string }
export interface Reassembler {
  declare(rep: Rep & { repId: string }): void
  chunk(c: RepChunkIn): void
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly bufferedBytes: number
}
export function createReassembler(opts: {
  clock: Clock
  logger: Logger
  onComplete: (repId: string, rep: ResolvedRep) => void
  onAbort: (abort: RepAbort) => void
}): Reassembler
export interface ChangedWire {
  readonly changeCount: number
  readonly hints: readonly PasteboardHint[]
  readonly reps: readonly Rep[]
  readonly frontmostBundleId: string | null
  readonly frontmostName: string | null
  readonly attributionConfidence: 'heuristic' | 'unknown'
}
export interface ChangeAssembler {
  handleChanged(w: ChangedWire): void
  handleChunk(c: RepChunkIn): void
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly pendingChanges: number
}
export function createChangeAssembler(opts: {
  clock: Clock
  logger: Logger
  emit: (payload: ClipboardChangedPayload) => void
}): ChangeAssembler

// ---- correlator.ts
export interface Correlator {
  nextId(): string
  register<T>(id: string, method: AgentMethod, timeoutMs: number): Promise<Result<T>>
  settle(res: AgentResponse): void
  fail(id: string, code: ErrorCode, message: string): void
  failAll(code: ErrorCode, message: string): void
  readonly pending: number
}
export function createCorrelator(opts: { clock: Clock; logger: Logger }): Correlator

// ---- spawn-agent.ts
export const HOST_VERSION = '0.1.0'
export const RESTART_BACKOFF_MS: readonly [250, 500, 1_000, 2_000, 4_000]
export const DEFAULT_MAX_RESTARTS = 5
export const MAX_CONSECUTIVE_PARSE_FAILURES = 10
export interface AgentCore {
  handleBytes(chunk: Uint8Array): void
  handleLine(line: string): void
  request<M extends AgentMethod>(method: M, params: AgentParams<M>, timeoutMs?: number): Promise<Result<AgentResult<M>>>
  on<E extends keyof AgentEventMap>(event: E, cb: (payload: AgentEventMap[E]) => void): Unsub
  hello(timeoutMs?: number): Promise<Result<AgentCapabilities>>
  failAllPending(code: ErrorCode, message: string): void
  abortStreams(code: ErrorCode): void
  resetFraming(): void
  readonly lastWatchIntervalMs: number | null
  readonly lastAccelerator: string | null
  readonly pendingRequests: number
  readonly openRepStreams: number
}
export function createAgentCore(opts: {
  clock: Clock
  logger: Logger
  send: (line: string) => Result<void>
  onFatal: (code: ErrorCode) => void
}): AgentCore
export interface SpawnAgentOptions {
  platform: AgentPlatform
  binPath: string
  clock: Clock
  logger: Logger
  maxRestarts?: number
  args?: readonly string[]
}
export function spawnAgent(opts: SpawnAgentOptions): ClipboardAgent

// ---- transcript.ts
export const TranscriptMetaSchema: ZodObject   // { v, t:'meta', transcript, recordedOn, synthetic:true, note }
export const TranscriptFrameSchema: ZodDiscriminatedUnion   // { dir:'in'|'out', delayMs?, line }
export type TranscriptMeta = z.output<typeof TranscriptMetaSchema>
export interface TranscriptFrame {
  readonly dir: 'in' | 'out'
  readonly fileLine: number
  readonly delayMs: number
  readonly line: Record<string, unknown>
}
export interface Transcript {
  readonly path: string
  readonly meta: TranscriptMeta
  readonly frames: readonly TranscriptFrame[]
}
export function parseTranscript(text: string, path: string): Transcript   // THROWS on a bad fixture
export function loadTranscript(path: string): Transcript                 // THROWS on a bad fixture

// ---- fake-agent.ts
export interface FakeAgent extends ClipboardAgent {
  assertDrained(): void
  readonly framesPlayed: number
}
export function matchesPattern(pattern: unknown, actual: unknown): boolean
export function createFakeAgent(opts: {
  transcriptPath: string
  clock: Clock
  logger: Logger
}): FakeAgent
```

Two notes for whoever consumes this:

- `spawnAgent(...).start()` **rejects** on failure (contract §5.4) — it is called once, at composition,
  and a failure there is fatal. Every other call returns `Result<T>`.
- No consumer ever sees `repId`, `inline` or a chunk. By the time a `clipboard.changed` payload
  reaches you, every representation is a `ResolvedRep` with verified bytes, and anything that failed
  is listed in `droppedReps` with its `ErrorCode`.

**Branch:** `m1/03-agent-host`

---

- [ ] **Step 1: Cut the branch.**

```sh
git fetch origin && git checkout -b m1/03-agent-host origin/main
```

Expected: `Switched to a new branch 'm1/03-agent-host'`. Never commit to `main`.

- [ ] **Step 2: Create the package manifest.**

Every dependency except `@cairn/*` lives at the repo root (contract §2), so this manifest is tiny.
The `test` script's `--root ../..` is what lets `npm run test -w @cairn/agent-host` find the root
`vitest.config.ts` with its three projects (`unit`, `security`, `renderer`). Every test in this task
runs under `--project unit`; the `renderer` project only matches
`apps/desktop/renderer/src/**/*.test.ts`, so nothing here lands in it.

```sh
mkdir -p packages/agent-host/src
cat > packages/agent-host/package.json <<'EOF'
{
  "name": "@cairn/agent-host",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Agent lifecycle, NDJSON framing, in-memory chunk reassembly and the fakes",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run --root ../.. --project unit packages/agent-host",
    "test:security": "vitest run --root ../.. --project security packages/agent-host"
  },
  "dependencies": { "@cairn/protocol": "0.1.0" }
}
EOF
```

- [ ] **Step 3: Link the workspace, and check the three `@cairn/protocol` pieces this task needs.**

Task 2 ships `packages/protocol/src/clock.ts` and re-exports it from the barrel, so `Clock`, `Cancel`,
`TestClock`, `systemClock` and `createTestClock` are already importable from `@cairn/protocol`. These
greps just confirm the merge you branched from really has them, because every timeout in this package
runs on that injected `Clock` (contract §5.8) and every test drives it with `createTestClock()`. They
are greps rather than an `import()` on purpose: relative imports in this repo are extensionless by
contract §2, which vite, vitest and tsc resolve and Node's own ESM resolver does not.

```sh
npm install
node -e "console.log(require('node:fs').realpathSync('node_modules/@cairn/agent-host'))"
grep -c "export \* from './clock'" packages/protocol/src/index.ts
grep -c "^export " packages/protocol/src/clock.ts
grep -hn "export function parseAgentLine" packages/protocol/src/parse-agent-line.ts
grep -hn "export function contentHash" packages/protocol/src/hash.ts
```

Expected: `npm install` reports `added`/`up to date` with no `EUNSUPPORTEDPROTOCOL` and no peer
warning; the `node -e` line prints the absolute path of `packages/agent-host`; the first `grep -c`
prints `1`; the second prints `5` (`Cancel`, `Clock`, `TestClock`, `systemClock`, `createTestClock` —
contract §5.8); and the last two greps each print one matching line.

Never write a second `Clock`, `systemClock` or `createTestClock` in this package. Two definitions of
`Clock` in the repo is exactly the drift the frozen contract exists to prevent — every module below
does `import type { Clock } from '@cairn/protocol'` and every test does
`import { createTestClock } from '@cairn/protocol'`, never a deep path into `packages/protocol/src`.

- [ ] **Step 4: Commit the scaffold.**

```sh
git add packages/agent-host/package.json package-lock.json
git commit -m "chore(agent-host): add the @cairn/agent-host workspace manifest"
```

---

#### Framing: bytes off a pipe become whole NDJSON lines

- [ ] **Step 5: Write the failing framing test, and an empty module for it to import.**

The empty module is deliberate: it makes the red phase a named `TypeError` instead of a module
resolution error, which is a more useful failure to look at.

```sh
: > packages/agent-host/src/framing.ts
```

`packages/agent-host/src/framing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createLineSplitter } from './framing'

function collect(maxLineBytes?: number) {
  const lines: string[] = []
  const overflows: number[] = []
  const splitter = createLineSplitter(
    maxLineBytes === undefined
      ? { onLine: (l) => lines.push(l), onOverflow: (n) => overflows.push(n) }
      : { onLine: (l) => lines.push(l), onOverflow: (n) => overflows.push(n), maxLineBytes },
  )
  return { lines, overflows, splitter }
}

describe('createLineSplitter', () => {
  it('emits two lines from one chunk that contains two objects', () => {
    const { lines, splitter } = collect()
    splitter.push(Buffer.from('{"a":1}\n{"b":2}\n', 'utf8'))
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.bufferedBytes).toBe(0)
  })

  it('reassembles one object split across three chunks', () => {
    const { lines, splitter } = collect()
    splitter.push(Buffer.from('{"v":1,', 'utf8'))
    expect(lines).toEqual([])
    splitter.push(Buffer.from('"t":"ev"', 'utf8'))
    expect(lines).toEqual([])
    splitter.push(Buffer.from('}\n', 'utf8'))
    expect(lines).toEqual(['{"v":1,"t":"ev"}'])
  })

  it('does not split a multi-byte UTF-8 character', () => {
    const { lines, splitter } = collect()
    const bytes = Buffer.from('{"emoji":"🪨"}\n', 'utf8')
    // The rock emoji is 4 bytes; cut two bytes into it.
    const cut = bytes.indexOf(0xf0) + 2
    splitter.push(bytes.subarray(0, cut))
    expect(lines).toEqual([])
    splitter.push(bytes.subarray(cut))
    expect(lines).toEqual(['{"emoji":"🪨"}'])
  })

  it('drops a line over the cap instead of buffering it forever, and resumes on the next line', () => {
    const { lines, overflows, splitter } = collect(64)
    splitter.push(Buffer.from('x'.repeat(200), 'utf8'))
    expect(overflows).toEqual([200])
    expect(splitter.bufferedBytes).toBe(0)
    splitter.push(Buffer.from('yyy', 'utf8'))
    expect(splitter.bufferedBytes).toBe(0)
    splitter.push(Buffer.from('\n{"ok":true}\n', 'utf8'))
    expect(overflows).toEqual([200])
    expect(lines).toEqual(['{"ok":true}'])
  })

  it('reports an oversized line exactly once when its newline is in the same chunk', () => {
    const { lines, overflows, splitter } = collect(64)
    splitter.push(Buffer.from('z'.repeat(100) + '\n{"ok":true}\n', 'utf8'))
    expect(overflows).toEqual([100])
    expect(lines).toEqual(['{"ok":true}'])
  })

  it('ignores empty lines and defaults the cap to MAX_LINE_BYTES', () => {
    const { lines, overflows, splitter } = collect()
    splitter.push(Buffer.from('\n\n{"a":1}\n', 'utf8'))
    expect(lines).toEqual(['{"a":1}'])
    splitter.push(Buffer.from('q'.repeat(700_000), 'utf8'))
    expect(overflows).toEqual([])
    expect(splitter.bufferedBytes).toBe(700_000)
    splitter.reset()
    expect(splitter.bufferedBytes).toBe(0)
  })
})
```

- [ ] **Step 6: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/framing.test.ts
```

Expected: FAIL, 6 tests failed, each with `TypeError: createLineSplitter is not a function`.

- [ ] **Step 7: Implement the splitter.**

`packages/agent-host/src/framing.ts`:

```ts
import { MAX_LINE_BYTES } from '@cairn/protocol'

export interface LineSplitter {
  /** Feed one raw pipe chunk. Emits every complete line it now holds. */
  push(chunk: Uint8Array): void
  /** Drop everything buffered — used when the child is replaced. */
  reset(): void
  /** Bytes held for an incomplete line. Tests assert this returns to 0. */
  readonly bufferedBytes: number
}

export interface LineSplitterOptions {
  onLine: (line: string) => void
  /** Called ONCE per oversized line, with the byte count that was thrown away. */
  onOverflow: (droppedBytes: number) => void
  maxLineBytes?: number
}

const EMPTY = Buffer.alloc(0)
const LF = 0x0a

/**
 * Byte-level NDJSON splitter. It buffers BYTES and decodes only whole lines, which is what makes a
 * multi-byte UTF-8 character split across two pipe chunks safe.
 */
export function createLineSplitter(opts: LineSplitterOptions): LineSplitter {
  const max = opts.maxLineBytes ?? MAX_LINE_BYTES
  let buf: Buffer = EMPTY
  // True while we are throwing away the tail of a line that already exceeded `max`.
  let discarding = false

  return {
    push(chunk: Uint8Array): void {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, Buffer.from(chunk)])
      for (;;) {
        const nl = buf.indexOf(LF)
        if (nl === -1) break
        const line = buf.subarray(0, nl)
        buf = buf.subarray(nl + 1)
        if (discarding) {
          discarding = false
          continue
        }
        if (line.length > max) {
          opts.onOverflow(line.length)
          continue
        }
        if (line.length > 0) opts.onLine(line.toString('utf8'))
      }
      if (discarding) {
        buf = EMPTY
        return
      }
      if (buf.length > max) {
        // The terminating newline has not arrived and we are already over the cap: report now and
        // discard until it does, so a newline-free stream cannot grow the buffer without limit.
        opts.onOverflow(buf.length)
        buf = EMPTY
        discarding = true
      }
    },
    reset(): void {
      buf = EMPTY
      discarding = false
    },
    get bufferedBytes(): number {
      return buf.length
    },
  }
}
```

- [ ] **Step 8: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/framing.test.ts
git add packages/agent-host/src/framing.ts packages/agent-host/src/framing.test.ts
git commit -m "feat(agent-host): byte-level NDJSON line splitter with a hard line cap"
```

Expected: `Tests 6 passed (6)`.

---

#### Correlation: a response finds its caller, or the caller gets a definite failure

- [ ] **Step 9: Write the failing correlator test, and an empty module for it to import.**

```sh
: > packages/agent-host/src/correlator.ts
```

`packages/agent-host/src/correlator.test.ts`:

```ts
import {
  AGENT_REQUEST_TIMEOUT_MS,
  createTestClock,
  type AgentCapabilities,
  type AgentResponse,
  type LogEvent,
  type LogFields,
  type Logger,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { createCorrelator } from './correlator'

interface RecordedLog { level: string; event: LogEvent; fields: LogFields }

/** A Logger that keeps what it was given, so a test can assert on metadata-only log output. */
function recordingLogger(): { logger: Logger; lines: RecordedLog[] } {
  const lines: RecordedLog[] = []
  const at = (level: string) => (event: LogEvent, fields?: LogFields) => {
    lines.push({ level, event, fields: fields ?? {} })
  }
  const logger = {
    log: (level: string, event: LogEvent, fields?: LogFields) => at(level)(event, fields),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger
  return { logger, lines }
}

const CAPS = {
  wireMajor: 1,
  agent: 'macos',
  agentVersion: '0.1.0',
  platformVersion: '26.5.1',
  tier: 'A',
  clipboardWatch: 'changecount-poll',
  paste: 'none',
  hotkey: 'carbon',
  focusApp: true,
  concealedTypeHints: true,
  maxRepBytes: 20_971_520,
  chunkThresholdBytes: 65_536,
  missingTools: [],
} as const

const res = (id: string, result: Record<string, unknown>): AgentResponse =>
  ({ v: 1, t: 'res', id, ok: true, result }) as AgentResponse

describe('createCorrelator', () => {
  it('allocates decimal ids starting at "1"', () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    expect([c.nextId(), c.nextId(), c.nextId()]).toEqual(['1', '2', '3'])
  })

  it('resolves two in-flight requests to the right callers out of order', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const a = c.register<{ watching: true; intervalMs: number }>('1', 'watch.start', 2_000)
    const b = c.register<{ changeToken: string }>('2', 'write', 2_000)
    expect(c.pending).toBe(2)
    c.settle(res('2', { changeToken: '365' }))
    c.settle(res('1', { watching: true, intervalMs: 500 }))
    await expect(a).resolves.toEqual({ ok: true, value: { watching: true, intervalMs: 500 } })
    await expect(b).resolves.toEqual({ ok: true, value: { changeToken: '365' } })
    expect(c.pending).toBe(0)
  })

  it('validates the result against the per-method schema', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register<AgentCapabilities>('1', 'hello', 2_000)
    c.settle(res('1', { ...CAPS, tier: 'Z' }))
    const r = await p
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('E_PARSE')
    expect(r.message).toContain('result for hello failed validation')
  })

  it('accepts a valid hello result', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register<AgentCapabilities>('1', 'hello', 2_000)
    c.settle(res('1', { ...CAPS }))
    const r = await p
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.value.agent).toBe('macos')
    expect(r.value.chunkThresholdBytes).toBe(65_536)
  })

  it('maps an unknown agent error code to E_INTERNAL and keeps a known one', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const known = c.register('1', 'read', 2_000)
    const unknown = c.register('2', 'read', 2_000)
    c.settle({ v: 1, t: 'res', id: '1', ok: false, error: { code: 'E_TIMEOUT', message: 'promised read timed out' } })
    c.settle({ v: 1, t: 'res', id: '2', ok: false, error: { code: 'E_SOMETHING_NEW', message: 'from the future' } })
    await expect(known).resolves.toEqual({ ok: false, code: 'E_TIMEOUT', message: 'promised read timed out' })
    await expect(unknown).resolves.toEqual({ ok: false, code: 'E_INTERNAL', message: 'from the future' })
  })

  it('fails a request after timeoutMs and leaks no pending entry', async () => {
    const clock = createTestClock()
    const { logger, lines } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register('1', 'read', AGENT_REQUEST_TIMEOUT_MS)
    clock.advance(AGENT_REQUEST_TIMEOUT_MS - 1)
    expect(c.pending).toBe(1)
    clock.advance(1)
    await expect(p).resolves.toEqual({
      ok: false,
      code: 'E_TIMEOUT',
      message: 'agent request read timed out after 2000ms',
    })
    expect(c.pending).toBe(0)
    expect(clock.pending).toBe(0)
    expect(lines).toEqual([
      { level: 'warn', event: 'agent.request-timeout', fields: { method: 'read', durationMs: 2_000 } },
    ])
  })

  it('ignores a response that arrives after its request timed out', async () => {
    const clock = createTestClock()
    const { logger, lines } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register('1', 'read', 2_000)
    clock.advance(2_000)
    await expect(p).resolves.toMatchObject({ ok: false, code: 'E_TIMEOUT' })
    c.settle(res('1', { changeCount: 1, hints: [], reps: [] }))
    expect(c.pending).toBe(0)
    expect(lines.map((l) => l.event)).toEqual(['agent.request-timeout', 'agent.line-unparseable'])
  })

  it('drops a response for an id it never issued', () => {
    const clock = createTestClock()
    const { logger, lines } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    c.settle(res('99', { bye: true }))
    expect(c.pending).toBe(0)
    expect(lines.map((l) => l.event)).toEqual(['agent.line-unparseable'])
  })

  it('failAll settles every pending caller and cancels their timers', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const a = c.register('1', 'read', 2_000)
    const b = c.register('2', 'write', 2_000)
    c.failAll('E_AGENT_EXIT', 'agent exited with code 3')
    await expect(a).resolves.toEqual({ ok: false, code: 'E_AGENT_EXIT', message: 'agent exited with code 3' })
    await expect(b).resolves.toEqual({ ok: false, code: 'E_AGENT_EXIT', message: 'agent exited with code 3' })
    expect(c.pending).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('fail settles exactly one id', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const a = c.register('1', 'hello', 2_000)
    const b = c.register('2', 'read', 2_000)
    c.fail('1', 'E_WIRE_MAJOR', 'agent speaks wire major 2, host speaks 1')
    await expect(a).resolves.toEqual({
      ok: false,
      code: 'E_WIRE_MAJOR',
      message: 'agent speaks wire major 2, host speaks 1',
    })
    expect(c.pending).toBe(1)
    c.failAll('E_AGENT_DISPOSED', 'disposed')
    await expect(b).resolves.toMatchObject({ ok: false, code: 'E_AGENT_DISPOSED' })
  })
})
```

- [ ] **Step 10: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/correlator.test.ts
```

Expected: FAIL, 10 tests failed, each with `TypeError: createCorrelator is not a function`.

- [ ] **Step 11: Implement the correlator.**

Note the two things that are easy to get wrong and are what the tests above pin down: the pending
entry is deleted **before** the timeout resolves (otherwise a late response settles a caller that
already gave up, and the map leaks an entry per timeout), and the agent's `error.code` is a free-form
string on the wire, so an unrecognised one becomes `E_INTERNAL` rather than being cast blindly into
`ErrorCode`.

`packages/agent-host/src/correlator.ts`:

```ts
import {
  AgentResultSchema,
  err,
  ERROR_CODES,
  ok,
  type AgentMethod,
  type AgentResponse,
  type Cancel,
  type Clock,
  type ErrorCode,
  type Logger,
  type Result,
} from '@cairn/protocol'
import * as z from 'zod'

interface Pending {
  readonly id: string
  readonly method: AgentMethod
  readonly startedAt: number
  readonly settle: (r: Result<unknown>) => void
  cancelTimeout: Cancel
}

export interface Correlator {
  /** Host-allocated decimal ids starting at "1" (contract §3). */
  nextId(): string
  /** Registers a pending request and returns the promise the caller awaits. */
  register<T>(id: string, method: AgentMethod, timeoutMs: number): Promise<Result<T>>
  /** Matches a parsed `res` line to its request and settles the caller. */
  settle(res: AgentResponse): void
  /** Settles one id with a failure — used for the wire-major refusal. */
  fail(id: string, code: ErrorCode, message: string): void
  /** Settles EVERY pending caller with a failure. No caller is ever left hanging. */
  failAll(code: ErrorCode, message: string): void
  readonly pending: number
}

export function createCorrelator(opts: { clock: Clock; logger: Logger }): Correlator {
  const { clock, logger } = opts
  const pending = new Map<string, Pending>()
  let counter = 0

  const take = (id: string): Pending | undefined => {
    const p = pending.get(id)
    if (p === undefined) return undefined
    p.cancelTimeout()
    pending.delete(id)
    return p
  }

  return {
    nextId(): string {
      counter += 1
      return String(counter)
    },

    register<T>(id: string, method: AgentMethod, timeoutMs: number): Promise<Result<T>> {
      return new Promise<Result<T>>((resolve) => {
        const entry: Pending = {
          id,
          method,
          startedAt: clock.now(),
          settle: (r) => resolve(r as Result<T>),
          cancelTimeout: () => {},
        }
        entry.cancelTimeout = clock.setTimeout(() => {
          // Delete FIRST so a late response cannot settle an already-timed-out caller, and so the
          // map cannot leak an entry per timed-out request.
          pending.delete(id)
          logger.warn('agent.request-timeout', { method, durationMs: timeoutMs })
          resolve(err('E_TIMEOUT', `agent request ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, entry)
      })
    },

    settle(res): void {
      const p = take(res.id)
      if (p === undefined) {
        // A response for an id we are not waiting on: already timed out, or an agent bug.
        logger.warn('agent.line-unparseable', { code: 'E_INTERNAL' })
        return
      }
      if (!res.ok) {
        const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(res.error.code)
          ? (res.error.code as ErrorCode)
          : 'E_INTERNAL'
        p.settle(err(code, res.error.message))
        return
      }
      // The wire schema types `result` as an open record; only the method knows its real shape.
      const parsed = AgentResultSchema[p.method].safeParse(res.result)
      if (!parsed.success) {
        p.settle(err('E_PARSE', `result for ${p.method} failed validation: ${z.prettifyError(parsed.error)}`))
        return
      }
      p.settle(ok(parsed.data))
    },

    fail(id, code, message): void {
      const p = take(id)
      if (p === undefined) return
      p.settle(err(code, message))
    },

    failAll(code, message): void {
      for (const id of [...pending.keys()]) {
        const p = take(id)
        p?.settle(err(code, message))
      }
    },

    get pending(): number {
      return pending.size
    },
  }
}
```

- [ ] **Step 12: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/correlator.test.ts
git add packages/agent-host/src/correlator.ts packages/agent-host/src/correlator.test.ts
git commit -m "feat(agent-host): request/response correlation with per-request timeouts"
```

Expected: `Tests 10 passed (10)`.

---

#### Chunk reassembly, part 1: the happy path, and two streams that must not contaminate each other

Everything from here to Step 30 is the security-critical half of this package. Read contract §4 once
before starting. The rule you are implementing: **a representation is handed to nobody until its
declared sha256 has been verified over the assembled bytes, and there are no files involved at any
point.**

- [ ] **Step 13: Write the failing happy-path and interleaving tests, and an empty module.**

```sh
: > packages/agent-host/src/reassembler.ts
```

`packages/agent-host/src/reassembler.test.ts`:

```ts
import {
  CHUNK_PAYLOAD_BYTES,
  contentHash,
  createTestClock,
  type LogEvent,
  type LogFields,
  type Logger,
  type Rep,
  type ResolvedRep,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { createReassembler, type RepAbort } from './reassembler'

interface RecordedLog { level: string; event: LogEvent; fields: LogFields }

function recordingLogger(): { logger: Logger; lines: RecordedLog[] } {
  const lines: RecordedLog[] = []
  const at = (level: string) => (event: LogEvent, fields?: LogFields) => {
    lines.push({ level, event, fields: fields ?? {} })
  }
  const logger = {
    log: (level: string, event: LogEvent, fields?: LogFields) => at(level)(event, fields),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger
  return { logger, lines }
}

/**
 * The one payload rule, shared with the committed transcript fixture: deterministic filler with a
 * little-endian TIFF magic prefix. Deterministic so a test can compare byte-for-byte; filler rather
 * than a real screenshot so nothing real is ever committed or logged.
 */
function fillerBytes(n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251
  b.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0)
  return b
}

function chunksOf(bytes: Buffer, size = CHUNK_PAYLOAD_BYTES): string[] {
  const out: string[] = []
  for (let o = 0; o < bytes.length; o += size) out.push(bytes.subarray(o, o + size).toString('base64'))
  return out
}

function wireRep(bytes: Buffer, repId: string, mime = 'image/tiff'): Rep & { repId: string } {
  return {
    mime,
    uti: 'public.tiff',
    byteLength: bytes.length,
    sha256: contentHash(bytes),
    repId,
  } as Rep & { repId: string }
}

function harness() {
  const clock = createTestClock()
  const { logger, lines } = recordingLogger()
  const completed: { repId: string; rep: ResolvedRep }[] = []
  const aborted: RepAbort[] = []
  const r = createReassembler({
    clock,
    logger,
    onComplete: (repId, rep) => completed.push({ repId, rep }),
    onAbort: (a) => aborted.push(a),
  })
  return { clock, lines, completed, aborted, r }
}

describe('createReassembler', () => {
  it('reassembles a 200 000-byte payload from 7 chunks byte-for-byte', () => {
    const { completed, r, clock } = harness()
    const payload = fillerBytes(200_000)
    const parts = chunksOf(payload)
    expect(parts).toHaveLength(7)
    r.declare(wireRep(payload, 'r1'))
    parts.forEach((b64, seq) => r.chunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }))
    expect(completed).toHaveLength(1)
    expect(Buffer.from(completed[0]!.rep.bytes).equals(payload)).toBe(true)
    expect(completed[0]!.rep.sha256).toBe(contentHash(payload))
    expect(completed[0]!.rep.byteLength).toBe(200_000)
    expect(completed[0]!.rep.mime).toBe('image/tiff')
    expect(completed[0]!.rep.uti).toBe('public.tiff')
    expect(r.openStreams).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('reassembles two interleaved repIds independently', () => {
    const { completed, aborted, r } = harness()
    const a = fillerBytes(70_000)
    const b = Buffer.from(fillerBytes(70_000).reverse())
    expect(contentHash(a)).not.toBe(contentHash(b))
    r.declare(wireRep(a, 'rA', 'image/png'))
    r.declare(wireRep(b, 'rB', 'image/tiff'))
    const pa = chunksOf(a)
    const pb = chunksOf(b)
    // Interleave: A0 B0 B1 A1 A2 B2
    r.chunk({ repId: 'rA', seq: 0, final: false, b64: pa[0]! })
    r.chunk({ repId: 'rB', seq: 0, final: false, b64: pb[0]! })
    r.chunk({ repId: 'rB', seq: 1, final: false, b64: pb[1]! })
    r.chunk({ repId: 'rA', seq: 1, final: false, b64: pa[1]! })
    r.chunk({ repId: 'rA', seq: 2, final: true, b64: pa[2]! })
    r.chunk({ repId: 'rB', seq: 2, final: true, b64: pb[2]! })
    expect(aborted).toEqual([])
    expect(completed.map((c) => c.repId)).toEqual(['rA', 'rB'])
    expect(Buffer.from(completed[0]!.rep.bytes).equals(a)).toBe(true)
    expect(Buffer.from(completed[1]!.rep.bytes).equals(b)).toBe(true)
    expect(completed[0]!.rep.mime).toBe('image/png')
    expect(completed[1]!.rep.mime).toBe('image/tiff')
  })
})
```

- [ ] **Step 14: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
```

Expected: FAIL, 2 tests failed, both with `TypeError: createReassembler is not a function`.

- [ ] **Step 15: Implement the minimal reassembler — one stream at a time.**

This is deliberately the smallest thing that can pass the first test. It holds a single active
stream, which is why the interleaving test will still fail.

`packages/agent-host/src/reassembler.ts`:

```ts
import {
  contentHash,
  type Cancel,
  type Clock,
  type ContentHash,
  type ErrorCode,
  type Logger,
  type Rep,
  type ResolvedRep,
} from '@cairn/protocol'

export interface RepAbort {
  readonly repId: string
  readonly mime: string
  readonly code: ErrorCode
}

export interface RepChunkIn {
  readonly repId: string
  readonly seq: number
  readonly final: boolean
  readonly b64: string
}

export interface Reassembler {
  /** Open a stream for a wire Rep that carries `repId`. */
  declare(rep: Rep & { repId: string }): void
  /** Feed one `rep.chunk` event payload. */
  chunk(c: RepChunkIn): void
  /** Abort every open stream — the child died, or we are disposing. */
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly bufferedBytes: number
}

interface RepStream {
  readonly repId: string
  readonly mime: string
  readonly uti: string | null
  readonly declaredBytes: number
  readonly declaredHash: ContentHash
  readonly parts: Uint8Array[]
  receivedBytes: number
  expectedSeq: number
  sawFinal: boolean
  cancelTimeout: Cancel
}

export function createReassembler(opts: {
  clock: Clock
  logger: Logger
  onComplete: (repId: string, rep: ResolvedRep) => void
  onAbort: (abort: RepAbort) => void
}): Reassembler {
  const { logger, onComplete, onAbort } = opts
  let active: RepStream | null = null

  return {
    declare(rep): void {
      active = {
        repId: rep.repId,
        mime: rep.mime,
        uti: rep.uti,
        declaredBytes: rep.byteLength,
        declaredHash: rep.sha256 as ContentHash,
        parts: [],
        receivedBytes: 0,
        expectedSeq: 0,
        sawFinal: false,
        cancelTimeout: () => {},
      }
      logger.debug('rep.stream-begin', { mime: rep.mime, byteLength: rep.byteLength })
    },

    chunk(c): void {
      const s = active
      if (s === null || s.repId !== c.repId) {
        logger.warn('rep.stream-aborted', { code: 'E_REP_UNKNOWN_ID', repCount: 0 })
        return
      }
      const bytes = Buffer.from(c.b64, 'base64')
      s.parts.push(bytes)
      s.receivedBytes += bytes.length
      s.expectedSeq += 1
      if (!c.final) return
      s.sawFinal = true
      const assembled = Buffer.concat(s.parts)
      const hash = contentHash(assembled)
      active = null
      logger.debug('rep.stream-complete', {
        mime: s.mime,
        byteLength: s.receivedBytes,
        hashPrefix: hash.slice(0, 12),
      })
      onComplete(s.repId, {
        mime: s.mime,
        uti: s.uti,
        bytes: assembled,
        byteLength: assembled.length,
        sha256: hash,
      })
    },

    abortAll(code): void {
      const s = active
      if (s === null) return
      active = null
      logger.warn('rep.stream-aborted', { code, repCount: 0 })
      onAbort({ repId: s.repId, mime: s.mime, code })
    },

    get openStreams(): number {
      return active === null ? 0 : 1
    },
    get bufferedBytes(): number {
      return active === null ? 0 : active.receivedBytes
    },
  }
}
```

- [ ] **Step 16: Run it: the happy path passes, interleaving still fails.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
```

Expected: `Tests 1 failed | 1 passed (2)`. The failure is
`AssertionError: expected [ 'rB' ] to deeply equal [ 'rA', 'rB' ]` in
`reassembles two interleaved repIds independently` — the second `declare` threw the first stream
away, so `rA` never completed. That is exactly the cross-contamination the test exists to prevent.

- [ ] **Step 17: Replace the single active stream with a Map keyed by `repId`.**

In `packages/agent-host/src/reassembler.ts`, replace `let active: RepStream | null = null` with:

```ts
  const streams = new Map<string, RepStream>()
```

replace the whole body of `declare` after the `logger.debug` line ordering so it reads:

```ts
    declare(rep): void {
      const s: RepStream = {
        repId: rep.repId,
        mime: rep.mime,
        uti: rep.uti,
        declaredBytes: rep.byteLength,
        declaredHash: rep.sha256 as ContentHash,
        parts: [],
        receivedBytes: 0,
        expectedSeq: 0,
        sawFinal: false,
        cancelTimeout: () => {},
      }
      streams.set(s.repId, s)
      logger.debug('rep.stream-begin', { mime: s.mime, byteLength: s.declaredBytes })
    },
```

replace the first three lines of `chunk` with:

```ts
    chunk(c): void {
      const s = streams.get(c.repId)
      if (s === undefined) {
        logger.warn('rep.stream-aborted', { code: 'E_REP_UNKNOWN_ID', repCount: streams.size })
        return
      }
```

replace `active = null` in `chunk` with `streams.delete(s.repId)`, and replace `abortAll` and the two
getters with:

```ts
    abortAll(code): void {
      for (const s of [...streams.values()]) {
        streams.delete(s.repId)
        logger.warn('rep.stream-aborted', { code, repCount: streams.size })
        onAbort({ repId: s.repId, mime: s.mime, code })
      }
    },

    get openStreams(): number {
      return streams.size
    },
    get bufferedBytes(): number {
      let n = 0
      for (const s of streams.values()) n += s.receivedBytes
      return n
    },
```

- [ ] **Step 18: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
git add packages/agent-host/src/reassembler.ts packages/agent-host/src/reassembler.test.ts
git commit -m "feat(agent-host): in-memory rep.chunk reassembly, one stream per repId"
```

Expected: `Tests 2 passed (2)`.

---

#### Chunk reassembly, part 2: every way a stream can be wrong, and the whole rep is discarded

Contract §4 lists ten error codes "and no others". On any of them the **whole representation** is
discarded — never truncated, never partially delivered — and its buffers are zero-filled before being
dropped.

- [ ] **Step 19: Append the failing discard-code tests to `reassembler.test.ts`.**

Add these inside the existing `describe('createReassembler', ...)` block, after the interleaving test:

```ts
  it('discards the whole representation on a sha256 mismatch', () => {
    const { completed, aborted, r } = harness()
    const payload = fillerBytes(70_000)
    const lying = { ...wireRep(payload, 'r1'), sha256: contentHash(Buffer.from('something else')) }
    r.declare(lying as Rep & { repId: string })
    chunksOf(payload).forEach((b64, seq, all) =>
      r.chunk({ repId: 'r1', seq, final: seq === all.length - 1, b64 }),
    )
    expect(completed).toEqual([])
    expect(aborted).toEqual([{ repId: 'r1', mime: 'image/tiff', code: 'E_REP_HASH_MISMATCH' }])
    expect(r.openStreams).toBe(0)
    expect(r.bufferedBytes).toBe(0)
  })

  it('discards the representation on a gap in seq', () => {
    const { completed, aborted, r } = harness()
    const payload = fillerBytes(70_000)
    const parts = chunksOf(payload)
    r.declare(wireRep(payload, 'r1'))
    r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
    r.chunk({ repId: 'r1', seq: 2, final: true, b64: parts[2]! })
    expect(aborted.map((a) => a.code)).toEqual(['E_REP_SEQ_GAP'])
    expect(completed).toEqual([])
  })

  it('discards the representation on a duplicated seq', () => {
    const { completed, aborted, r } = harness()
    const payload = fillerBytes(70_000)
    const parts = chunksOf(payload)
    r.declare(wireRep(payload, 'r1'))
    r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
    r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
    expect(aborted.map((a) => a.code)).toEqual(['E_REP_SEQ_DUPLICATE'])
    expect(completed).toEqual([])
  })

  it('aborts with E_REP_SHORT when final arrives with fewer bytes than declared', () => {
    const { aborted, r } = harness()
    const payload = fillerBytes(70_000)
    const parts = chunksOf(payload)
    r.declare({ ...wireRep(payload, 'r1'), byteLength: 70_000 + 3 } as Rep & { repId: string })
    parts.forEach((b64, seq) => r.chunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }))
    expect(aborted.map((a) => a.code)).toEqual(['E_REP_SHORT'])
  })

  it('aborts on undecodable base64', () => {
    const { aborted, r } = harness()
    const payload = fillerBytes(70_000)
    r.declare(wireRep(payload, 'r1'))
    r.chunk({ repId: 'r1', seq: 0, final: false, b64: 'not!valid!base64' })
    expect(aborted.map((a) => a.code)).toEqual(['E_REP_BAD_BASE64'])
  })

  it('aborts when the accumulated bytes exceed the declared byteLength', () => {
    const { aborted, r } = harness()
    const payload = fillerBytes(70_000)
    // Declare it 100 bytes shorter than it is: chunk 2 then overflows.
    const short = { ...wireRep(payload, 'r1'), byteLength: 70_000 - 100 }
    r.declare(short as Rep & { repId: string })
    const parts = chunksOf(payload)
    r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
    r.chunk({ repId: 'r1', seq: 1, final: false, b64: parts[1]! })
    r.chunk({ repId: 'r1', seq: 2, final: true, b64: parts[2]! })
    expect(aborted.map((a) => a.code)).toEqual(['E_REP_OVERFLOW'])
  })

  it('logs E_REP_UNKNOWN_ID and drops a chunk for an undeclared repId', () => {
    const { aborted, r, lines } = harness()
    r.chunk({ repId: 'nope', seq: 0, final: true, b64: 'aGk=' })
    expect(aborted).toEqual([])
    expect(lines).toEqual([
      { level: 'warn', event: 'rep.stream-aborted', fields: { code: 'E_REP_UNKNOWN_ID', repCount: 0 } },
    ])
  })

  it('aborts every open stream on abortAll', () => {
    const { aborted, r, clock } = harness()
    const payload = fillerBytes(200_000)
    r.declare(wireRep(payload, 'r1'))
    r.chunk({ repId: 'r1', seq: 0, final: false, b64: chunksOf(payload)[0]! })
    r.abortAll('E_REP_TIMEOUT')
    expect(aborted.map((a) => a.code)).toEqual(['E_REP_TIMEOUT'])
    expect(r.openStreams).toBe(0)
    expect(r.bufferedBytes).toBe(0)
    expect(clock.pending).toBe(0)
  })
```

- [ ] **Step 20: Run it and watch each new test fail for its own reason.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
```

Expected: `Tests 6 failed | 4 passed (10)`, with these failures:

- `sha256 mismatch` → `AssertionError: expected [ { repId: 'r1', … } ] to deeply equal []` — it
  completed instead of aborting.
- `gap in seq` → `expected [] to deeply equal [ 'E_REP_SEQ_GAP' ]`.
- `duplicated seq` → `expected [] to deeply equal [ 'E_REP_SEQ_DUPLICATE' ]`.
- `E_REP_SHORT` → `expected [] to deeply equal [ 'E_REP_SHORT' ]`.
- `undecodable base64` → `expected [] to deeply equal [ 'E_REP_BAD_BASE64' ]`.
- `exceed the declared byteLength` → `expected [] to deeply equal [ 'E_REP_OVERFLOW' ]`.

(`E_REP_UNKNOWN_ID` and `abortAll` already pass — they were implemented in Step 17.)

- [ ] **Step 21: Add the guards. This replaces the whole of `reassembler.ts`.**

Two things worth a sentence each. `decodeBase64` is strict because `Buffer.from(s, 'base64')`
*silently skips* junk characters, so a corrupted chunk would decode short and look like a legitimate
partial payload. And `abort()` zero-fills the parts it drops: this process holds the user's clipboard,
and half a private key should not sit in a reachable heap object waiting for GC.

```ts
import {
  contentHash,
  type Cancel,
  type Clock,
  type ContentHash,
  type ErrorCode,
  type Logger,
  type Rep,
  type ResolvedRep,
} from '@cairn/protocol'

export interface RepAbort {
  readonly repId: string
  readonly mime: string
  readonly code: ErrorCode
}

export interface RepChunkIn {
  readonly repId: string
  readonly seq: number
  readonly final: boolean
  readonly b64: string
}

export interface Reassembler {
  /** Open a stream for a wire Rep that carries `repId`. */
  declare(rep: Rep & { repId: string }): void
  /** Feed one `rep.chunk` event payload. */
  chunk(c: RepChunkIn): void
  /** Abort every open stream — the child died, or we are disposing. */
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly bufferedBytes: number
}

interface RepStream {
  readonly repId: string
  readonly mime: string
  readonly uti: string | null
  readonly declaredBytes: number
  readonly declaredHash: ContentHash
  readonly parts: Uint8Array[]
  receivedBytes: number
  expectedSeq: number
  sawFinal: boolean
  cancelTimeout: Cancel
}

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Strict base64 decode. `Buffer.from(s, 'base64')` silently skips junk characters, so without this
 * a corrupted chunk decodes to fewer bytes and looks like a legitimately short payload.
 */
function decodeBase64(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0 || !STRICT_BASE64.test(b64)) return null
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.toString('base64') !== b64) return null
  return bytes
}

export function createReassembler(opts: {
  clock: Clock
  logger: Logger
  onComplete: (repId: string, rep: ResolvedRep) => void
  onAbort: (abort: RepAbort) => void
}): Reassembler {
  const { logger, onComplete, onAbort } = opts
  const streams = new Map<string, RepStream>()

  const abort = (s: RepStream, code: ErrorCode): void => {
    s.cancelTimeout()
    // Zero what we drop: this process holds the user's clipboard, and half a private key should not
    // sit in a reachable heap object waiting for GC.
    for (const p of s.parts) p.fill(0)
    s.parts.length = 0
    streams.delete(s.repId)
    logger.warn('rep.stream-aborted', { code, repCount: streams.size })
    onAbort({ repId: s.repId, mime: s.mime, code })
  }

  return {
    declare(rep): void {
      const s: RepStream = {
        repId: rep.repId,
        mime: rep.mime,
        uti: rep.uti,
        declaredBytes: rep.byteLength,
        declaredHash: rep.sha256 as ContentHash,
        parts: [],
        receivedBytes: 0,
        expectedSeq: 0,
        sawFinal: false,
        cancelTimeout: () => {},
      }
      streams.set(s.repId, s)
      logger.debug('rep.stream-begin', { mime: s.mime, byteLength: s.declaredBytes })
    },

    chunk(c): void {
      const s = streams.get(c.repId)
      if (s === undefined) {
        // Nothing to abort: there is no stream to drop, so this is log-and-forget.
        logger.warn('rep.stream-aborted', { code: 'E_REP_UNKNOWN_ID', repCount: streams.size })
        return
      }
      if (c.seq < s.expectedSeq) return abort(s, 'E_REP_SEQ_DUPLICATE')
      if (c.seq > s.expectedSeq) return abort(s, 'E_REP_SEQ_GAP')
      const bytes = decodeBase64(c.b64)
      if (bytes === null) return abort(s, 'E_REP_BAD_BASE64')
      if (s.receivedBytes + bytes.length > s.declaredBytes) return abort(s, 'E_REP_OVERFLOW')
      s.parts.push(bytes)
      s.receivedBytes += bytes.length
      s.expectedSeq += 1
      if (!c.final) return
      s.sawFinal = true
      if (s.receivedBytes !== s.declaredBytes) return abort(s, 'E_REP_SHORT')
      const assembled = Buffer.concat(s.parts)
      const hash = contentHash(assembled)
      // The host verifies the hash BEFORE handing the bytes to anyone.
      if (hash !== s.declaredHash) return abort(s, 'E_REP_HASH_MISMATCH')
      streams.delete(s.repId)
      logger.debug('rep.stream-complete', {
        mime: s.mime,
        byteLength: s.receivedBytes,
        hashPrefix: hash.slice(0, 12),
      })
      onComplete(s.repId, {
        mime: s.mime,
        uti: s.uti,
        bytes: assembled,
        byteLength: assembled.length,
        sha256: hash,
      })
    },

    abortAll(code): void {
      for (const s of [...streams.values()]) abort(s, code)
    },

    get openStreams(): number {
      return streams.size
    },
    get bufferedBytes(): number {
      let n = 0
      for (const s of streams.values()) n += s.receivedBytes
      return n
    },
  }
}
```

- [ ] **Step 22: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
git commit -am "feat(agent-host): discard a representation on hash, seq, base64 or length failure"
```

Expected: `Tests 10 passed (10)`.

---

#### Chunk reassembly, part 3: a wedged agent must not grow memory, and the ceilings

- [ ] **Step 23: Append the failing timeout, ceiling, concurrency and after-final tests.**

Add to the top import block of `reassembler.test.ts`:

```ts
import {
  CHUNK_PAYLOAD_BYTES,
  contentHash,
  createTestClock,
  MAX_REP_BYTES,
  REP_STREAM_TIMEOUT_MS,
  type LogEvent,
  type LogFields,
  type Logger,
  type Rep,
  type ResolvedRep,
} from '@cairn/protocol'
```

and add these four tests inside `describe('createReassembler', ...)`:

```ts
  it('evicts a stream that never sends final, and leaks no buffer', () => {
    const { completed, aborted, r, clock, lines } = harness()
    const payload = fillerBytes(200_000)
    r.declare(wireRep(payload, 'r1'))
    r.chunk({ repId: 'r1', seq: 0, final: false, b64: chunksOf(payload)[0]! })
    expect(r.bufferedBytes).toBe(CHUNK_PAYLOAD_BYTES)
    clock.advance(REP_STREAM_TIMEOUT_MS - 1)
    expect(r.openStreams).toBe(1)
    clock.advance(1)
    expect(aborted.map((a) => a.code)).toEqual(['E_REP_TIMEOUT'])
    expect(completed).toEqual([])
    expect(r.openStreams).toBe(0)
    expect(r.bufferedBytes).toBe(0)
    expect(clock.pending).toBe(0)
    expect(lines.filter((l) => l.event === 'rep.stream-aborted')).toHaveLength(1)
  })

  it('aborts a representation that declares more than MAX_REP_BYTES without allocating', () => {
    const { aborted, r, clock } = harness()
    const huge = {
      mime: 'image/tiff',
      uti: null,
      byteLength: MAX_REP_BYTES + 1,
      sha256: contentHash(Buffer.alloc(0)),
      repId: 'r1',
    } as Rep & { repId: string }
    r.declare(huge)
    expect(aborted).toEqual([{ repId: 'r1', mime: 'image/tiff', code: 'E_REP_OVERFLOW' }])
    expect(r.openStreams).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('refuses a ninth concurrent stream with E_REP_TOO_MANY', () => {
    const { aborted, r } = harness()
    const payload = fillerBytes(70_000)
    for (let i = 0; i < 8; i++) r.declare(wireRep(payload, `r${i}`))
    expect(r.openStreams).toBe(8)
    r.declare(wireRep(payload, 'r8'))
    expect(aborted).toEqual([{ repId: 'r8', mime: 'image/tiff', code: 'E_REP_TOO_MANY' }])
    expect(r.openStreams).toBe(8)
  })

  it('reports E_REP_AFTER_FINAL for a chunk that arrives after the final one', () => {
    const { aborted, r, lines } = harness()
    const payload = fillerBytes(70_000)
    const parts = chunksOf(payload)
    r.declare(wireRep(payload, 'r1'))
    parts.forEach((b64, seq) => r.chunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }))
    r.chunk({ repId: 'r1', seq: 3, final: true, b64: 'aGk=' })
    expect(aborted).toEqual([])
    expect(lines.filter((l) => l.event === 'rep.stream-aborted').map((l) => l.fields.code)).toEqual([
      'E_REP_AFTER_FINAL',
    ])
  })
```

- [ ] **Step 24: Run it and watch the four new tests fail.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
```

Expected: `Tests 4 failed | 10 passed (14)`:

- `never sends final` → `expected [] to deeply equal [ 'E_REP_TIMEOUT' ]` — no timer is armed yet, so
  the buffer would sit there for the life of the process.
- `more than MAX_REP_BYTES` → `expected [] to deeply equal [ { repId: 'r1', … 'E_REP_OVERFLOW' } ]`.
- `ninth concurrent stream` → `expected 9 to be 8` on `r.openStreams`.
- `E_REP_AFTER_FINAL` → `expected [ 'E_REP_UNKNOWN_ID' ] to deeply equal [ 'E_REP_AFTER_FINAL' ]`.

- [ ] **Step 25: Add the timeout, the ceilings and the bounded `ended` set. This replaces the whole of `reassembler.ts`.**

Two design notes. The timeout uses the **injected `Clock`**, so no test needs a real timer and a
wedged agent is provable in microseconds. And the `ended` list exists because contract §4 step 3
*deletes* the completed stream — without it, "one chunk too many" and "a chunk for an id we never
declared" are indistinguishable, and the ten-code set would have a member that can never fire.

```ts
import {
  contentHash,
  MAX_CONCURRENT_REP_STREAMS,
  MAX_REP_BYTES,
  REP_STREAM_TIMEOUT_MS,
  type Cancel,
  type Clock,
  type ContentHash,
  type ErrorCode,
  type Logger,
  type Rep,
  type ResolvedRep,
} from '@cairn/protocol'

export interface RepAbort {
  readonly repId: string
  readonly mime: string
  readonly code: ErrorCode
}

export interface RepChunkIn {
  readonly repId: string
  readonly seq: number
  readonly final: boolean
  readonly b64: string
}

export interface Reassembler {
  /** Open a stream for a wire Rep that carries `repId`. */
  declare(rep: Rep & { repId: string }): void
  /** Feed one `rep.chunk` event payload. */
  chunk(c: RepChunkIn): void
  /** Abort every open stream — the child died, or we are disposing. */
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly bufferedBytes: number
}

interface RepStream {
  readonly repId: string
  readonly mime: string
  readonly uti: string | null
  readonly declaredBytes: number
  readonly declaredHash: ContentHash
  readonly parts: Uint8Array[]
  receivedBytes: number
  expectedSeq: number
  sawFinal: boolean
  cancelTimeout: Cancel
}

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Strict base64 decode. `Buffer.from(s, 'base64')` silently skips junk characters, so without this
 * a corrupted chunk decodes to fewer bytes and looks like a legitimately short payload.
 */
function decodeBase64(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0 || !STRICT_BASE64.test(b64)) return null
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.toString('base64') !== b64) return null
  return bytes
}

export function createReassembler(opts: {
  clock: Clock
  logger: Logger
  onComplete: (repId: string, rep: ResolvedRep) => void
  onAbort: (abort: RepAbort) => void
}): Reassembler {
  const { clock, logger, onComplete, onAbort } = opts
  const streams = new Map<string, RepStream>()
  /**
   * repIds whose `final: true` chunk has already been processed. Bounded FIFO, so it cannot grow.
   * It exists to tell "the agent sent one chunk too many" (E_REP_AFTER_FINAL) apart from "the agent
   * sent a chunk for an id it never declared" (E_REP_UNKNOWN_ID) — step 3 deletes the stream, so
   * both look identical without it.
   */
  const ended: string[] = []
  const markEnded = (repId: string): void => {
    ended.push(repId)
    if (ended.length > MAX_CONCURRENT_REP_STREAMS * 4) ended.shift()
  }

  const abort = (s: RepStream, code: ErrorCode): void => {
    s.cancelTimeout()
    // Zero what we drop: this process holds the user's clipboard, and half a private key should not
    // sit in a reachable heap object waiting for GC.
    for (const p of s.parts) p.fill(0)
    s.parts.length = 0
    streams.delete(s.repId)
    logger.warn('rep.stream-aborted', { code, repCount: streams.size })
    onAbort({ repId: s.repId, mime: s.mime, code })
  }

  const arm = (s: RepStream): void => {
    s.cancelTimeout = clock.setTimeout(() => abort(s, 'E_REP_TIMEOUT'), REP_STREAM_TIMEOUT_MS)
  }

  const refuse = (rep: Rep & { repId: string }, code: ErrorCode): void => {
    logger.warn('rep.stream-aborted', { code, repCount: streams.size })
    onAbort({ repId: rep.repId, mime: rep.mime, code })
  }

  return {
    declare(rep): void {
      if (streams.has(rep.repId) || streams.size >= MAX_CONCURRENT_REP_STREAMS) {
        return refuse(rep, 'E_REP_TOO_MANY')
      }
      // Refuse an oversized declaration before allocating anything at all.
      if (rep.byteLength > MAX_REP_BYTES) return refuse(rep, 'E_REP_OVERFLOW')
      const s: RepStream = {
        repId: rep.repId,
        mime: rep.mime,
        uti: rep.uti,
        declaredBytes: rep.byteLength,
        declaredHash: rep.sha256 as ContentHash,
        parts: [],
        receivedBytes: 0,
        expectedSeq: 0,
        sawFinal: false,
        cancelTimeout: () => {},
      }
      streams.set(s.repId, s)
      arm(s)
      logger.debug('rep.stream-begin', { mime: s.mime, byteLength: s.declaredBytes })
    },

    chunk(c): void {
      const s = streams.get(c.repId)
      if (s === undefined) {
        // Nothing to abort: there is no stream to drop, so this is log-and-forget.
        const code = ended.includes(c.repId) ? 'E_REP_AFTER_FINAL' : 'E_REP_UNKNOWN_ID'
        logger.warn('rep.stream-aborted', { code, repCount: streams.size })
        return
      }
      if (c.seq < s.expectedSeq) return abort(s, 'E_REP_SEQ_DUPLICATE')
      if (c.seq > s.expectedSeq) return abort(s, 'E_REP_SEQ_GAP')
      const bytes = decodeBase64(c.b64)
      if (bytes === null) return abort(s, 'E_REP_BAD_BASE64')
      if (
        s.receivedBytes + bytes.length > s.declaredBytes ||
        s.receivedBytes + bytes.length > MAX_REP_BYTES
      ) {
        return abort(s, 'E_REP_OVERFLOW')
      }
      s.cancelTimeout()
      s.parts.push(bytes)
      s.receivedBytes += bytes.length
      s.expectedSeq += 1
      if (!c.final) {
        arm(s)
        return
      }
      s.sawFinal = true
      markEnded(s.repId)
      if (s.receivedBytes !== s.declaredBytes) return abort(s, 'E_REP_SHORT')
      const assembled = Buffer.concat(s.parts)
      const hash = contentHash(assembled)
      // The host verifies the hash BEFORE handing the bytes to anyone.
      if (hash !== s.declaredHash) return abort(s, 'E_REP_HASH_MISMATCH')
      streams.delete(s.repId)
      logger.debug('rep.stream-complete', {
        mime: s.mime,
        byteLength: s.receivedBytes,
        hashPrefix: hash.slice(0, 12),
      })
      onComplete(s.repId, {
        mime: s.mime,
        uti: s.uti,
        bytes: assembled,
        byteLength: assembled.length,
        sha256: hash,
      })
    },

    abortAll(code): void {
      for (const s of [...streams.values()]) abort(s, code)
    },

    get openStreams(): number {
      return streams.size
    },
    get bufferedBytes(): number {
      let n = 0
      for (const s of streams.values()) n += s.receivedBytes
      return n
    },
  }
}
```

- [ ] **Step 26: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
git commit -am "feat(agent-host): evict wedged rep streams on a clock timeout and cap concurrency"
```

Expected: `Tests 14 passed (14)`.

---

#### One clipboard tick becomes one payload, with the failures listed rather than hidden

`ClipboardChangedPayload` is the post-reassembly form: no consumer of `ClipboardAgent` ever sees
`repId`, `inline` or a chunk. So something has to hold a `clipboard.changed` event back until every
chunked representation it declared has finished, and decode the inline ones on the spot. That is the
change assembler, and it lives in `reassembler.ts` because the contract's file tree has no other home
for it.

- [ ] **Step 27: Append the failing change-assembler tests.**

Extend the `reassembler.test.ts` imports:

```ts
import { createChangeAssembler, createReassembler, type RepAbort } from './reassembler'
```

and add `type ClipboardChangedPayload` to the `@cairn/protocol` type imports. Then append a second
`describe` block at the end of the file:

```ts
function changedWire(reps: Rep[], changeCount = 364) {
  return {
    changeCount,
    hints: [] as const,
    reps,
    frontmostBundleId: 'com.apple.TextEdit',
    frontmostName: 'TextEdit',
    attributionConfidence: 'heuristic' as const,
  }
}

function inlineRep(text: string, mime = 'text/plain'): Rep {
  const bytes = Buffer.from(text, 'utf8')
  return {
    mime,
    uti: 'public.utf8-plain-text',
    byteLength: bytes.length,
    sha256: contentHash(bytes),
    inline: bytes.toString('base64'),
  } as Rep
}

describe('createChangeAssembler', () => {
  it('emits immediately when every rep is inline', () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const emitted: ClipboardChangedPayload[] = []
    const a = createChangeAssembler({ clock, logger, emit: (p) => emitted.push(p) })
    a.handleChanged(changedWire([inlineRep('hello world')]))
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.changeToken).toBe('364')
    expect(Buffer.from(emitted[0]!.reps[0]!.bytes).toString('utf8')).toBe('hello world')
    expect(emitted[0]!.droppedReps).toEqual([])
    expect(emitted[0]!.sourceApp).toEqual({
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      confidence: 'heuristic',
    })
  })

  it('holds the payload until a chunked rep completes, then emits both reps in wire order', () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const emitted: ClipboardChangedPayload[] = []
    const a = createChangeAssembler({ clock, logger, emit: (p) => emitted.push(p) })
    const image = fillerBytes(200_000)
    a.handleChanged(changedWire([inlineRep('hello world'), wireRep(image, 'r1')]))
    expect(emitted).toHaveLength(0)
    expect(a.pendingChanges).toBe(1)
    const parts = chunksOf(image)
    parts.forEach((b64, seq) =>
      a.handleChunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }),
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.reps.map((r) => r.mime)).toEqual(['text/plain', 'image/tiff'])
    expect(Buffer.from(emitted[0]!.reps[1]!.bytes).equals(image)).toBe(true)
    expect(a.pendingChanges).toBe(0)
    expect(a.openStreams).toBe(0)
  })

  it('emits the surviving reps with droppedReps when a chunked rep fails its hash', () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const emitted: ClipboardChangedPayload[] = []
    const a = createChangeAssembler({ clock, logger, emit: (p) => emitted.push(p) })
    const image = fillerBytes(200_000)
    const lying = { ...wireRep(image, 'r1'), sha256: contentHash(Buffer.from('nope')) } as Rep
    a.handleChanged(changedWire([inlineRep('hello world'), lying]))
    const parts = chunksOf(image)
    parts.forEach((b64, seq) =>
      a.handleChunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }),
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.reps.map((r) => r.mime)).toEqual(['text/plain'])
    expect(emitted[0]!.droppedReps).toEqual([{ mime: 'image/tiff', code: 'E_REP_HASH_MISMATCH' }])
  })

  it('keeps two interleaved chunked streams in separate clipboard ticks apart', () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const emitted: ClipboardChangedPayload[] = []
    const a = createChangeAssembler({ clock, logger, emit: (p) => emitted.push(p) })
    const one = fillerBytes(70_000)
    const two = Buffer.from(fillerBytes(70_000).reverse())
    a.handleChanged(changedWire([wireRep(one, 'rA', 'image/png')], 401))
    a.handleChanged(changedWire([wireRep(two, 'rB', 'image/tiff')], 402))
    const pa = chunksOf(one)
    const pb = chunksOf(two)
    a.handleChunk({ repId: 'rB', seq: 0, final: false, b64: pb[0]! })
    a.handleChunk({ repId: 'rA', seq: 0, final: false, b64: pa[0]! })
    a.handleChunk({ repId: 'rA', seq: 1, final: false, b64: pa[1]! })
    a.handleChunk({ repId: 'rB', seq: 1, final: false, b64: pb[1]! })
    a.handleChunk({ repId: 'rB', seq: 2, final: true, b64: pb[2]! })
    a.handleChunk({ repId: 'rA', seq: 2, final: true, b64: pa[2]! })
    // rB finished first, so it is emitted first: each tick is independent.
    expect(emitted.map((e) => e.changeCount)).toEqual([402, 401])
    expect(Buffer.from(emitted[0]!.reps[0]!.bytes).equals(two)).toBe(true)
    expect(Buffer.from(emitted[1]!.reps[0]!.bytes).equals(one)).toBe(true)
  })

  it('drops an inline rep whose declared hash does not match its bytes', () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const emitted: ClipboardChangedPayload[] = []
    const a = createChangeAssembler({ clock, logger, emit: (p) => emitted.push(p) })
    const bad = { ...inlineRep('hello world'), sha256: contentHash(Buffer.from('other')) } as Rep
    a.handleChanged(changedWire([bad]))
    expect(emitted[0]!.reps).toEqual([])
    expect(emitted[0]!.droppedReps).toEqual([{ mime: 'text/plain', code: 'E_REP_HASH_MISMATCH' }])
  })
})
```

- [ ] **Step 28: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
```

Expected: FAIL, `Tests 5 failed | 14 passed (19)`, every new one with
`TypeError: createChangeAssembler is not a function`.

- [ ] **Step 29: Append the change assembler to `reassembler.ts`.**

Add `type ClipboardChangedPayload` and `type PasteboardHint` to the `@cairn/protocol` import at the top
of the file, then append this to the end. Note that inline representations are hash-checked too — the
agent is not trusted about its own bytes in either transport.

```ts
// ---------------------------------------------------------------------------------------------
// The change assembler: turns ONE `clipboard.changed` wire event into ONE ClipboardChangedPayload,
// holding it until every chunked representation it declared has completed or been discarded.
// ---------------------------------------------------------------------------------------------

export interface ChangedWire {
  readonly changeCount: number
  readonly hints: readonly PasteboardHint[]
  readonly reps: readonly Rep[]
  readonly frontmostBundleId: string | null
  readonly frontmostName: string | null
  readonly attributionConfidence: 'heuristic' | 'unknown'
}

export interface ChangeAssembler {
  handleChanged(w: ChangedWire): void
  handleChunk(c: RepChunkIn): void
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly pendingChanges: number
}

interface Slot {
  readonly mime: string
  resolved: ResolvedRep | null
  dropped: ErrorCode | null
}

interface PendingChange {
  readonly slots: Slot[]
  readonly wire: ChangedWire
  outstanding: number
}

export function createChangeAssembler(opts: {
  clock: Clock
  logger: Logger
  emit: (payload: ClipboardChangedPayload) => void
}): ChangeAssembler {
  const { logger, emit } = opts
  /** repId -> which pending change and which slot it fills. */
  const owner = new Map<string, { change: PendingChange; slot: number }>()
  let pending: PendingChange[] = []

  const finish = (p: PendingChange): void => {
    pending = pending.filter((q) => q !== p)
    const reps: ResolvedRep[] = []
    const droppedReps: { mime: string; code: ErrorCode }[] = []
    for (const s of p.slots) {
      if (s.resolved !== null) reps.push(s.resolved)
      else if (s.dropped !== null) droppedReps.push({ mime: s.mime, code: s.dropped })
    }
    const w = p.wire
    emit({
      changeCount: w.changeCount,
      changeToken: String(w.changeCount),
      hints: w.hints,
      reps,
      sourceApp:
        w.frontmostBundleId === null && w.frontmostName === null
          ? null
          : { bundleId: w.frontmostBundleId, name: w.frontmostName, confidence: w.attributionConfidence },
      droppedReps,
    })
  }

  const reassembler = createReassembler({
    clock: opts.clock,
    logger,
    onComplete: (repId, rep) => {
      const at = owner.get(repId)
      if (at === undefined) return
      owner.delete(repId)
      at.change.slots[at.slot]!.resolved = rep
      at.change.outstanding -= 1
      if (at.change.outstanding === 0) finish(at.change)
    },
    onAbort: ({ repId, code }) => {
      const at = owner.get(repId)
      if (at === undefined) return
      owner.delete(repId)
      at.change.slots[at.slot]!.dropped = code
      at.change.outstanding -= 1
      if (at.change.outstanding === 0) finish(at.change)
    },
  })

  return {
    handleChanged(w): void {
      const slots: Slot[] = w.reps.map((r) => ({ mime: r.mime, resolved: null, dropped: null }))
      const p: PendingChange = { slots, wire: w, outstanding: 0 }
      const chunked: { rep: Rep & { repId: string }; slot: number }[] = []
      w.reps.forEach((r, i) => {
        if (r.inline !== undefined) {
          const bytes = Buffer.from(r.inline, 'base64')
          const hash = contentHash(bytes)
          if (bytes.length !== r.byteLength) {
            slots[i]!.dropped = 'E_REP_SHORT'
            logger.warn('rep.stream-aborted', { code: 'E_REP_SHORT', mime: r.mime })
          } else if (hash !== r.sha256) {
            slots[i]!.dropped = 'E_REP_HASH_MISMATCH'
            logger.warn('rep.stream-aborted', { code: 'E_REP_HASH_MISMATCH', mime: r.mime })
          } else {
            slots[i]!.resolved = { mime: r.mime, uti: r.uti, bytes, byteLength: bytes.length, sha256: hash }
            logger.debug('rep.inline-received', { mime: r.mime, byteLength: bytes.length })
          }
        } else if (r.repId !== undefined) {
          chunked.push({ rep: r as Rep & { repId: string }, slot: i })
          p.outstanding += 1
        }
      })
      if (p.outstanding === 0) {
        finish(p)
        return
      }
      pending.push(p)
      for (const c of chunked) {
        owner.set(c.rep.repId, { change: p, slot: c.slot })
        reassembler.declare(c.rep)
      }
    },

    handleChunk(c): void {
      reassembler.chunk(c)
    },

    abortAll(code): void {
      // Aborting every stream settles every pending change through onAbort, so a consumer that was
      // waiting on a chunked rep gets a payload with `droppedReps` rather than nothing at all.
      reassembler.abortAll(code)
      pending = []
      owner.clear()
    },

    get openStreams(): number {
      return reassembler.openStreams
    },
    get pendingChanges(): number {
      return pending.length
    },
  }
}
```

- [ ] **Step 30: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/reassembler.test.ts
git commit -am "feat(agent-host): assemble one ClipboardChangedPayload per clipboard tick"
```

Expected: `Tests 19 passed (19)`.

---

#### Spawning a real child process, with a Node stand-in agent

The Swift agent does not exist yet, so every test in this file spawns a small Node script as the
agent. It is passed with `node -e`, **not written to a file**: writing an executable stub to a temp
path is precisely the thing this package must never do, and Step 47 scans for it. This is why
`SpawnAgentOptions` carries an `args` array — the real binary needs none, and the tests need
`['-e', SRC, mode]`.

- [ ] **Step 31: Write the failing spawn test with the stand-in agent, and an empty module.**

```sh
: > packages/agent-host/src/spawn-agent.ts
```

`packages/agent-host/src/spawn-agent.test.ts`:

```ts
import {
  AGENT_REQUEST_TIMEOUT_MS,
  createTestClock,
  type LogEvent,
  type LogFields,
  type Logger,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { spawnAgent } from './spawn-agent'

// ---------------------------------------------------------------------------------------------
// The stand-in agent. A Node script handed to `node -e`, NOT a file on disk.
// `process.argv[1]` is the mode, because with `node -e SRC mode` argv is [execPath, 'mode'].
// ---------------------------------------------------------------------------------------------
const STUB_AGENT_SRC = `
const { createHash } = require('node:crypto')
const MODE = process.argv[1] || 'normal'
const CAPS = { wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1',
  tier: 'A', clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon', focusApp: true,
  concealedTypeHints: true, maxRepBytes: 20971520, chunkThresholdBytes: 65536, missingTools: [] }
function out(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
function log(name) { out({ v: 1, t: 'ev', event: 'log', data: { level: 'info', event: name, fields: {} } }) }
function filler(n) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251
  b.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0)
  return b
}
function hash(b) { return 'sha256-' + createHash('sha256').update(b).digest('base64url') }
function emitChunkedImage() {
  const text = Buffer.from('hello world', 'utf8')
  const img = filler(200000)
  out({ v: 1, t: 'ev', event: 'clipboard.changed', data: { changeCount: 364, hints: [], reps: [
    { mime: 'text/plain', uti: 'public.utf8-plain-text', byteLength: text.length, sha256: hash(text), inline: text.toString('base64') },
    { mime: 'image/tiff', uti: 'public.tiff', byteLength: img.length, sha256: hash(img), repId: 'rep-1' },
  ], frontmostBundleId: 'com.apple.Preview', frontmostName: 'Preview', attributionConfidence: 'heuristic' } })
  const CH = 32768
  const total = Math.ceil(img.length / CH)
  for (let s = 0; s < total; s++) {
    out({ v: 1, t: 'ev', event: 'rep.chunk', data: { repId: 'rep-1', seq: s, final: s === total - 1,
      b64: img.subarray(s * CH, (s + 1) * CH).toString('base64') } })
  }
}
function handle(req) {
  const id = req.id
  const m = req.method
  if (m === 'hello') {
    const caps = MODE === 'wrong-wire' ? Object.assign({}, CAPS, { wireMajor: 2 }) : CAPS
    return out({ v: 1, t: 'res', id: id, ok: true, result: caps })
  }
  if (m === 'watch.start') {
    out({ v: 1, t: 'res', id: id, ok: true, result: { watching: true, intervalMs: req.params.intervalMs } })
    log('stub.watch-start')
    if (MODE === 'chunked-image') emitChunkedImage()
    if (MODE === 'two-in-one-write') process.stdout.write(
      JSON.stringify({ v: 1, t: 'ev', event: 'log', data: { level: 'info', event: 'first', fields: {} } }) + '\\n' +
      JSON.stringify({ v: 1, t: 'ev', event: 'log', data: { level: 'info', event: 'second', fields: {} } }) + '\\n')
    if (MODE === 'garbage') { for (let i = 0; i < 12; i++) process.stdout.write('this is not json ' + i + '\\n') }
    if (MODE === 'huge-line') process.stdout.write('{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"' + 'x'.repeat(1100000) + '","fields":{}}}\\n')
    return
  }
  if (m === 'read') {
    if (MODE === 'silent-read') return
    if (MODE === 'crash-on-read') return process.exit(3)
    return out({ v: 1, t: 'res', id: id, ok: true, result: { changeCount: req.params.changeCount, hints: [], reps: [] } })
  }
  if (m === 'write') return out({ v: 1, t: 'res', id: id, ok: true, result: { changeToken: '365' } })
  if (m === 'hotkey.register') return out({ v: 1, t: 'res', id: id, ok: true, result: { bound: true, accelerator: req.params.accelerator } })
  if (m === 'shutdown') { out({ v: 1, t: 'res', id: id, ok: true, result: { bye: true } }); return process.exit(0) }
  out({ v: 1, t: 'res', id: id, ok: false, error: { code: 'E_UNKNOWN_METHOD', message: m } })
}
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString('utf8')
  for (;;) {
    const i = buf.indexOf('\\n')
    if (i === -1) break
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line.length > 0) handle(JSON.parse(line))
  }
})
log('stub.started')
`

interface RecordedLog { level: string; event: LogEvent; fields: LogFields }

function recordingLogger(): { logger: Logger; lines: RecordedLog[] } {
  const lines: RecordedLog[] = []
  const at = (level: string) => (event: LogEvent, fields?: LogFields) => {
    lines.push({ level, event, fields: fields ?? {} })
  }
  const logger = {
    log: (level: string, event: LogEvent, fields?: LogFields) => at(level)(event, fields),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger
  return { logger, lines }
}

function stub(mode: string, maxRestarts?: number) {
  const clock = createTestClock()
  const { logger, lines } = recordingLogger()
  const stubEvents: string[] = []
  const agent = spawnAgent({
    platform: 'macos',
    binPath: process.execPath,
    args: ['-e', STUB_AGENT_SRC, mode],
    clock,
    logger,
    ...(maxRestarts === undefined ? {} : { maxRestarts }),
  })
  agent.on('log', (p) => stubEvents.push(p.event))
  return { agent, clock, lines, stubEvents }
}

describe('spawnAgent', () => {
  it('starts the child, sends hello and returns its capabilities', async () => {
    const { agent, lines } = stub('normal')
    try {
      const caps = await agent.start()
      expect(caps.agent).toBe('macos')
      expect(caps.tier).toBe('A')
      expect(caps.chunkThresholdBytes).toBe(65_536)
      expect(lines.map((l) => l.event)).toEqual(['agent.spawning', 'agent.started'])
    } finally {
      await agent.dispose()
    }
  })

  it('correlates two in-flight requests to the right callers', async () => {
    const { agent } = stub('normal')
    try {
      await agent.start()
      const a = agent.request('read', { changeCount: 363 })
      const b = agent.request('write', { reps: [{ mime: 'text/plain', uti: null, b64: 'aGk=' }], transient: false })
      const [ra, rb] = await Promise.all([a, b])
      expect(ra).toEqual({ ok: true, value: { changeCount: 363, hints: [], reps: [] } })
      expect(rb).toEqual({ ok: true, value: { changeToken: '365' } })
    } finally {
      await agent.dispose()
    }
  })

  it('rejects start with E_AGENT_SPAWN when the binary does not exist', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = spawnAgent({
      platform: 'macos',
      binPath: '/definitely/not/a/binary/cairn-agent-macos',
      clock,
      logger,
    })
    await expect(agent.start()).rejects.toThrow(/hello failed \(E_AGENT_SPAWN\)/)
    await agent.dispose()
  })

  it('fails a request the agent never answers after timeoutMs, leaking no pending entry', async () => {
    const { agent, clock, lines } = stub('silent-read')
    try {
      await agent.start()
      const p = agent.request('read', { changeCount: 1 }, AGENT_REQUEST_TIMEOUT_MS)
      clock.advance(AGENT_REQUEST_TIMEOUT_MS)
      await expect(p).resolves.toEqual({
        ok: false,
        code: 'E_TIMEOUT',
        message: 'agent request read timed out after 2000ms',
      })
      expect(clock.pending).toBe(0)
      expect(lines.some((l) => l.event === 'agent.request-timeout')).toBe(true)
    } finally {
      await agent.dispose()
    }
  })

  it('stops the child on dispose and fails every later request with E_AGENT_DISPOSED', async () => {
    const { agent } = stub('normal')
    await agent.start()
    await agent.dispose()
    await expect(agent.request('read', { changeCount: 1 })).resolves.toEqual({
      ok: false,
      code: 'E_AGENT_DISPOSED',
      message: 'agent has been disposed',
    })
    // dispose() is idempotent.
    await agent.dispose()
  })
})
```

- [ ] **Step 32: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
```

Expected: FAIL, 5 tests failed, each with `TypeError: spawnAgent is not a function`.

- [ ] **Step 33: Implement `createAgentCore` and `spawnAgent` — hello, requests and dispose only.**

`createAgentCore` is the transport-independent half: framing, correlation and (from Step 37) event
fan-out. `fake-agent.ts` will hand it a transcript instead of a pipe, so the fake exercises exactly the
same code as the real spawn path. It lives in `spawn-agent.ts` because the contract's file tree has no
`core.ts`.

`packages/agent-host/src/spawn-agent.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import {
  AGENT_REQUEST_TIMEOUT_MS,
  err,
  ok,
  parseAgentLine,
  WIRE_MAJOR,
  type AgentCapabilities,
  type AgentEventMap,
  type AgentMethod,
  type AgentParams,
  type AgentPlatform,
  type AgentResult,
  type ClipboardAgent,
  type Clock,
  type ErrorCode,
  type Logger,
  type Result,
  type Unsub,
} from '@cairn/protocol'
import { createCorrelator, type Correlator } from './correlator'
import { createLineSplitter } from './framing'

/** Sent as `hello.params.hostVersion`. */
export const HOST_VERSION = '0.1.0'
/** Restart delays in ms. After the last one the host gives up (contract §5.4). */
export const RESTART_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000] as const
export const DEFAULT_MAX_RESTARTS = 5
/** Unparseable stdout lines in a row before the child is considered wedged (contract §3 rule 7). */
export const MAX_CONSECUTIVE_PARSE_FAILURES = 10

export interface AgentCore {
  /** Feed raw stdout bytes. */
  handleBytes(chunk: Uint8Array): void
  /** Feed one already-split NDJSON line. */
  handleLine(line: string): void
  request<M extends AgentMethod>(
    method: M,
    params: AgentParams<M>,
    timeoutMs?: number,
  ): Promise<Result<AgentResult<M>>>
  on<E extends keyof AgentEventMap>(event: E, cb: (payload: AgentEventMap[E]) => void): Unsub
  hello(timeoutMs?: number): Promise<Result<AgentCapabilities>>
  failAllPending(code: ErrorCode, message: string): void
  abortStreams(code: ErrorCode): void
  resetFraming(): void
  /** What to re-send after a restart, so a crash does not silently stop the watch. */
  readonly lastWatchIntervalMs: number | null
  readonly lastAccelerator: string | null
  readonly pendingRequests: number
  readonly openRepStreams: number
}

export function createAgentCore(opts: {
  clock: Clock
  logger: Logger
  /** Writes one `\n`-terminated line, or returns why it could not. */
  send: (line: string) => Result<void>
  /** The wire is unusable: the transport must replace or fail the child. */
  onFatal: (code: ErrorCode) => void
}): AgentCore {
  const { clock, logger, send } = opts
  const correlator: Correlator = createCorrelator({ clock, logger })
  const listeners: { [E in keyof AgentEventMap]: Set<(p: AgentEventMap[E]) => void> } = {
    'clipboard.changed': new Set(),
    'rep.chunk': new Set(),
    'hotkey.fired': new Set(),
    log: new Set(),
  }

  let consecutiveParseFailures = 0
  let lastWatchIntervalMs: number | null = null
  let lastAccelerator: string | null = null

  const splitter = createLineSplitter({
    onLine: (line) => core.handleLine(line),
    onOverflow: (droppedBytes) => {
      logger.error('agent.line-unparseable', { code: 'E_LINE_TOO_LONG', byteLength: droppedBytes })
    },
  })

  const core: AgentCore = {
    handleBytes(chunk): void {
      splitter.push(chunk)
    },

    handleLine(line): void {
      const parsed = parseAgentLine(line)
      if (!parsed.ok) {
        consecutiveParseFailures += 1
        logger.warn('agent.line-unparseable', { code: parsed.code, count: consecutiveParseFailures })
        return
      }
      consecutiveParseFailures = 0
      const l = parsed.value
      if (l.t === 'req') {
        // The agent never asks the host for anything in M1.
        logger.warn('agent.line-unparseable', { code: 'E_UNKNOWN_METHOD', method: l.method })
        return
      }
      if (l.t === 'res') correlator.settle(l)
    },

    async request<M extends AgentMethod>(
      method: M,
      params: AgentParams<M>,
      timeoutMs = AGENT_REQUEST_TIMEOUT_MS,
    ): Promise<Result<AgentResult<M>>> {
      const id = correlator.nextId()
      const line = JSON.stringify({ v: WIRE_MAJOR, t: 'req', id, method, params }) + '\n'
      const promise = correlator.register<AgentResult<M>>(id, method, timeoutMs)
      const written = send(line)
      if (!written.ok) {
        correlator.fail(id, written.code, written.message)
        return promise
      }
      if (method === 'watch.start') {
        lastWatchIntervalMs = (params as AgentParams<'watch.start'>).intervalMs
      } else if (method === 'watch.stop') {
        lastWatchIntervalMs = null
      } else if (method === 'hotkey.register') {
        lastAccelerator = (params as AgentParams<'hotkey.register'>).accelerator
      } else if (method === 'hotkey.unregister') {
        lastAccelerator = null
      }
      return promise
    },

    on(event, cb): Unsub {
      const set = listeners[event] as Set<(p: AgentEventMap[typeof event]) => void>
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },

    hello(timeoutMs = AGENT_REQUEST_TIMEOUT_MS): Promise<Result<AgentCapabilities>> {
      return core.request('hello', { hostVersion: HOST_VERSION }, timeoutMs)
    },

    failAllPending(code, message): void {
      correlator.failAll(code, message)
    },

    abortStreams(): void {
      // Wired to the change assembler in Step 37.
    },

    resetFraming(): void {
      splitter.reset()
      consecutiveParseFailures = 0
    },

    get lastWatchIntervalMs(): number | null {
      return lastWatchIntervalMs
    },
    get lastAccelerator(): string | null {
      return lastAccelerator
    },
    get pendingRequests(): number {
      return correlator.pending
    },
    get openRepStreams(): number {
      return 0
    },
  }

  return core
}

export interface SpawnAgentOptions {
  platform: AgentPlatform
  binPath: string
  clock: Clock
  logger: Logger
  maxRestarts?: number
  /**
   * argv for the child. Empty for the real Swift binary; the tests use it to run a Node stand-in
   * agent as `process.execPath -e <source>`, which is how the spawn path is exercised without
   * writing an executable to disk.
   */
  args?: readonly string[]
}

export function spawnAgent(opts: SpawnAgentOptions): ClipboardAgent {
  const { platform, binPath, clock, logger } = opts
  const args = [...(opts.args ?? [])]

  let child: ChildProcess | null = null
  let disposed = false
  let failed = false

  const send = (line: string): Result<void> => {
    if (disposed) return err('E_AGENT_DISPOSED', 'agent has been disposed')
    if (failed) return err('E_AGENT_EXIT', 'agent is not running')
    const stdin = child?.stdin
    if (child === null || stdin === null || stdin === undefined || !stdin.writable) {
      return err('E_AGENT_EXIT', 'agent is not running')
    }
    stdin.write(line)
    return ok(undefined)
  }

  const core = createAgentCore({
    clock,
    logger,
    send,
    onFatal: () => {
      // Given a fatal wire error the child is replaced; wired in Steps 41 and 45.
    },
  })

  const killChild = (): void => {
    const c = child
    if (c === null) return
    child = null
    c.kill('SIGTERM')
  }

  const spawnChild = (): void => {
    logger.info('agent.spawning', { agent: platform })
    // `spawn` with an argv ARRAY and no shell option: spec §11 control 3 wants no shell anywhere in
    // the capture or recall path. `binPath` and `args` are never interpolated into a command string,
    // so a pasteboard-derived path can never become shell syntax.
    const c = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    c.stdout?.on('data', (b: Buffer) => core.handleBytes(b))
    // Drained and discarded on purpose: we cannot prove the agent kept clipboard content out of its
    // human-readable stderr, so it is never copied into our log. Draining stops the pipe filling.
    c.stderr?.resume()
    c.on('error', (e: Error) => {
      child = null
      failed = true
      logger.error('agent.exited', { code: 'E_AGENT_SPAWN' })
      core.failAllPending('E_AGENT_SPAWN', `could not spawn ${binPath}: ${e.message}`)
    })
    c.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      child = null
      logger.warn('agent.exited', { code: 'E_AGENT_EXIT', ok: code === 0 })
      // Everything in flight is definitively over: no caller waits on a dead process.
      core.abortStreams('E_REP_TIMEOUT')
      core.failAllPending('E_AGENT_EXIT', `agent exited (code ${String(code)}, signal ${String(signal)})`)
      core.resetFraming()
    })
    child = c
  }

  return {
    async start(): Promise<AgentCapabilities> {
      if (disposed) throw new Error('cairn: agent has been disposed')
      spawnChild()
      const r = await core.hello()
      if (!r.ok) {
        failed = true
        killChild()
        throw new Error(
          `cairn: refusing to start the ${platform} agent — hello failed (${r.code}): ${r.message}`,
        )
      }
      logger.info('agent.started', { agent: platform })
      return r.value
    },

    request(method, params, timeoutMs) {
      return core.request(method, params, timeoutMs)
    },

    on(event, cb) {
      return core.on(event, cb)
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      core.abortStreams('E_REP_TIMEOUT')
      const c = child
      if (c !== null) {
        const closed = new Promise<void>((resolve) => c.once('close', () => resolve()))
        // Courtesy first so a real agent can unregister its Carbon hotkey, then SIGTERM so dispose
        // can never hang: the agent holds no unflushed state, so there is nothing to lose.
        if (c.stdin?.writable === true) {
          c.stdin.write(JSON.stringify({ v: WIRE_MAJOR, t: 'req', id: '0', method: 'shutdown', params: {} }) + '\n')
        }
        child = null
        c.kill('SIGTERM')
        await closed
      }
      core.failAllPending('E_AGENT_DISPOSED', 'agent disposed')
      logger.info('app.quitting', { agent: platform })
    },
  }
}
```

- [ ] **Step 34: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
git add packages/agent-host/src/spawn-agent.ts packages/agent-host/src/spawn-agent.test.ts
git commit -m "feat(agent-host): spawn an agent child process, hello handshake and dispose"
```

Expected: `Tests 5 passed (5)`. The five children are all reaped — if vitest hangs at the end, a
`dispose()` is missing from a `finally`.

---

#### Events off the pipe, and a >64 KiB representation reassembled in memory

- [ ] **Step 35: Append the failing event tests, plus the `waitFor` helper they need.**

Add to the `@cairn/protocol` import in `spawn-agent.test.ts`: `CHUNK_PAYLOAD_BYTES`, `contentHash`
and `type ClipboardChangedPayload`. Add this helper above `describe('spawnAgent', ...)`:

```ts
/** Polls with REAL timers — allowed in a test; product code only ever uses the injected Clock. */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** The one payload rule, shared with the committed transcript: filler plus a TIFF magic prefix. */
function fillerBytes(n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251
  b.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0)
  return b
}
```

and these two tests inside `describe('spawnAgent', ...)`:

```ts
  it('parses two events that arrive in one stdout write as two events', async () => {
    const { agent, stubEvents } = stub('two-in-one-write')
    try {
      await agent.start()
      await agent.request('watch.start', { intervalMs: 500 })
      await waitFor(() => stubEvents.includes('second'), 'both events')
      expect(stubEvents).toEqual(['stub.started', 'stub.watch-start', 'first', 'second'])
    } finally {
      await agent.dispose()
    }
  })

  it('reassembles a >64 KiB representation off the real pipe and emits chunk progress with no bytes', async () => {
    const { agent, stubEvents } = stub('chunked-image')
    const changes: ClipboardChangedPayload[] = []
    const chunks: { repId: string; seq: number; final: boolean }[] = []
    agent.on('clipboard.changed', (p) => changes.push(p))
    agent.on('rep.chunk', (p) => chunks.push(p))
    try {
      await agent.start()
      await agent.request('watch.start', { intervalMs: 500 })
      await waitFor(() => changes.length === 1, 'the reassembled clipboard.changed')
      expect(stubEvents).toContain('stub.watch-start')

      const payload = fillerBytes(200_000)
      const change = changes[0]!
      expect(change.changeCount).toBe(364)
      expect(change.changeToken).toBe('364')
      expect(change.droppedReps).toEqual([])
      expect(change.reps.map((r) => r.mime)).toEqual(['text/plain', 'image/tiff'])
      expect(Buffer.from(change.reps[0]!.bytes).toString('utf8')).toBe('hello world')
      expect(Buffer.from(change.reps[1]!.bytes).equals(payload)).toBe(true)
      expect(change.reps[1]!.sha256).toBe(contentHash(payload))
      expect(change.sourceApp).toEqual({
        bundleId: 'com.apple.Preview',
        name: 'Preview',
        confidence: 'heuristic',
      })

      expect(chunks).toHaveLength(Math.ceil(200_000 / CHUNK_PAYLOAD_BYTES))
      expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
      expect(chunks[6]).toEqual({ repId: 'rep-1', seq: 6, final: true })
      // The progress payload carries NO bytes. If a `b64` or `bytes` key ever appears here, the
      // renderer could be handed raw clipboard content through a progress indicator.
      expect(Object.keys(chunks[0]!)).toEqual(['repId', 'seq', 'final'])
    } finally {
      await agent.dispose()
    }
  })
```

- [ ] **Step 36: Run it and watch both new tests fail.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
```

Expected: `Tests 2 failed | 5 passed (7)`:

- `two events in one stdout write` → `AssertionError: expected [] to deeply equal [ 'stub.started', 'stub.watch-start', 'first', 'second' ]` — the core parses the lines and then throws the events away.
- `reassembles a >64 KiB representation` → `Error: timed out waiting for the reassembled clipboard.changed` after about 5 s.

- [ ] **Step 37: Fan events out, and wire the change assembler into the core.**

In `packages/agent-host/src/spawn-agent.ts`, add `createChangeAssembler` to the imports:

```ts
import { createChangeAssembler } from './reassembler'
```

Immediately after the `listeners` object inside `createAgentCore`, add:

```ts
  const emit = <E extends keyof AgentEventMap>(event: E, payload: AgentEventMap[E]): void => {
    for (const cb of [...listeners[event]]) cb(payload)
  }

  const changes = createChangeAssembler({
    clock,
    logger,
    emit: (payload) => emit('clipboard.changed', payload),
  })
```

Replace the last line of `handleLine` (`if (l.t === 'res') correlator.settle(l)`) with:

```ts
      if (l.t === 'res') {
        correlator.settle(l)
        return
      }
      switch (l.event) {
        case 'clipboard.changed':
          changes.handleChanged(l.data)
          return
        case 'rep.chunk':
          // The payload we hand listeners carries NO bytes — just enough to draw a progress row.
          emit('rep.chunk', { repId: l.data.repId, seq: l.data.seq, final: l.data.final })
          changes.handleChunk(l.data)
          return
        case 'hotkey.fired':
          logger.info('hotkey.fired', { accelerator: l.data.accelerator })
          emit('hotkey.fired', l.data)
          return
        case 'log':
          // `fields` is dropped on purpose: the agent is not trusted to keep clipboard content out.
          emit('log', { level: l.data.level, event: l.data.event })
          return
      }
```

and replace the placeholder `abortStreams` and `openRepStreams` members with the real ones:

```ts
    abortStreams(code): void {
      changes.abortAll(code)
    },
```

```ts
    get openRepStreams(): number {
      return changes.openStreams
    },
```

- [ ] **Step 38: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
git commit -am "feat(agent-host): fan agent events out and reassemble chunked reps off the pipe"
```

Expected: `Tests 7 passed (7)`.

---

#### A `hello` with the wrong `protocolVersion` means the host refuses to start the agent

Contract §4: a different wire major means every later field is a guess. The host does not degrade, does
not restart, and does not run — it refuses.

- [ ] **Step 39: Append the failing wire-major test.**

```ts
  it('refuses to start an agent whose hello reports a different wire major', async () => {
    const { agent, lines } = stub('wrong-wire')
    await expect(agent.start()).rejects.toThrow(
      /refusing to start the macos agent — hello failed \(E_WIRE_MAJOR\): agent reports wire major 2, host speaks 1/,
    )
    expect(lines.map((l) => l.event)).toContain('agent.wire-major-mismatch')
    // A refused agent is never restarted: it will be just as wrong next time.
    await expect(agent.request('read', { changeCount: 1 })).resolves.toMatchObject({
      ok: false,
      code: 'E_AGENT_EXIT',
    })
    await agent.dispose()
  })
```

- [ ] **Step 40: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts -t 'different wire major'
```

Expected: FAIL with
`AssertionError: expected error to match /refusing to start the macos agent — hello failed \(E_WIRE_MAJOR\)…/`
and an actual message of
`cairn: refusing to start the macos agent — hello failed (E_PARSE): result for hello failed validation: ✖ Invalid input: expected 1 → at wireMajor`.
The zod literal already rejects the capability set, but `E_PARSE` is the wrong diagnosis and nothing
logged `agent.wire-major-mismatch`, so a real mismatch would be indistinguishable from a typo in the
agent's JSON.

- [ ] **Step 41: Detect the mismatch explicitly, name it, and refuse.**

In `createAgentCore`, add a `helloId` variable beside `consecutiveParseFailures`:

```ts
  let helloId: string | null = null
```

set it in `request` immediately after the id is allocated:

```ts
      const id = correlator.nextId()
      if (method === 'hello') helloId = id
```

and replace the `if (l.t === 'res') { correlator.settle(l); return }` block in `handleLine` with:

```ts
      if (l.t === 'res') {
        if (l.id === helloId && l.ok === true && l.result['wireMajor'] !== WIRE_MAJOR) {
          // Refuse the agent outright: a different wire major means every later field is a guess.
          logger.error('agent.wire-major-mismatch', { code: 'E_WIRE_MAJOR' })
          correlator.fail(
            l.id,
            'E_WIRE_MAJOR',
            `agent reports wire major ${String(l.result['wireMajor'])}, host speaks ${WIRE_MAJOR}`,
          )
          onFatal('E_WIRE_MAJOR')
          return
        }
        correlator.settle(l)
        return
      }
```

`onFatal` is now used, so change the destructuring at the top of `createAgentCore` from
`const { clock, logger, send } = opts` to:

```ts
  const { clock, logger, send, onFatal } = opts
```

Then in `spawnAgent`, replace the placeholder `onFatal` callback with:

```ts
    onFatal: (code) => {
      logger.error('agent.exited', { code })
      if (code === 'E_WIRE_MAJOR') failed = true
      killChild()
    },
```

`killChild` is declared with `const` **below** `createAgentCore(...)` in the current file, and this
callback only runs later, so no reordering is needed.

- [ ] **Step 42: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
git commit -am "feat(agent-host): refuse to start an agent that reports a different wire major"
```

Expected: `Tests 8 passed (8)`.

---

#### Crash-restart with backoff, and the two ways a wedged agent gets replaced

- [ ] **Step 43: Append the failing restart tests.**

Add `RESTART_BACKOFF_MS` to the `./spawn-agent` import:

```ts
import { RESTART_BACKOFF_MS, spawnAgent } from './spawn-agent'
```

and these four tests:

```ts
  it('restarts a crashed child with growing backoff, fails the in-flight caller, and re-arms the watch', async () => {
    const { agent, clock, lines, stubEvents } = stub('crash-on-read')
    try {
      await agent.start()
      await agent.request('watch.start', { intervalMs: 500 })
      await waitFor(() => stubEvents.includes('stub.watch-start'), 'first watch.start')

      const inFlight = agent.request('read', { changeCount: 1 })
      // A caller mid-request gets a definite failure rather than hanging forever.
      await expect(inFlight).resolves.toMatchObject({ ok: false, code: 'E_AGENT_EXIT' })

      const scheduled = () => lines.filter((l) => l.event === 'agent.restart-scheduled')
      expect(scheduled()).toHaveLength(1)
      expect(scheduled()[0]!.fields).toEqual({ attempt: 1, durationMs: RESTART_BACKOFF_MS[0] })

      clock.advance(RESTART_BACKOFF_MS[0])
      await waitFor(() => stubEvents.filter((e) => e === 'stub.started').length === 2, 'second spawn')
      // The restart re-sends watch.start, so a crash cannot silently stop the clipboard watch.
      await waitFor(() => stubEvents.filter((e) => e === 'stub.watch-start').length === 2, 'watch re-armed')

      await expect(agent.request('read', { changeCount: 2 })).resolves.toMatchObject({
        ok: false,
        code: 'E_AGENT_EXIT',
      })
      expect(scheduled()).toHaveLength(2)
      expect(scheduled()[1]!.fields).toEqual({ attempt: 2, durationMs: RESTART_BACKOFF_MS[1] })
    } finally {
      await agent.dispose()
    }
  })

  it('gives up after maxRestarts and answers every later request with E_AGENT_EXIT', async () => {
    const { agent, clock, stubEvents } = stub('crash-on-read', 1)
    try {
      await agent.start()
      await expect(agent.request('read', { changeCount: 1 })).resolves.toMatchObject({ ok: false, code: 'E_AGENT_EXIT' })
      clock.advance(RESTART_BACKOFF_MS[0])
      await waitFor(() => stubEvents.filter((e) => e === 'stub.started').length === 2, 'second spawn')
      await expect(agent.request('read', { changeCount: 2 })).resolves.toMatchObject({ ok: false, code: 'E_AGENT_EXIT' })
      // No third spawn: the host has given up, and says so instead of pretending.
      clock.advance(60_000)
      await expect(agent.request('read', { changeCount: 3 })).resolves.toEqual({
        ok: false,
        code: 'E_AGENT_EXIT',
        message: 'agent gave up after 1 restarts',
      })
      expect(stubEvents.filter((e) => e === 'stub.started')).toHaveLength(2)
    } finally {
      await agent.dispose()
    }
  })

  it('drops a line over MAX_LINE_BYTES and replaces the child instead of buffering it', async () => {
    const { agent, lines } = stub('huge-line')
    try {
      await agent.start()
      await agent.request('watch.start', { intervalMs: 500 })
      await waitFor(
        () => lines.some((l) => l.fields.code === 'E_LINE_TOO_LONG'),
        'the oversized line to be rejected',
      )
      const tooLong = lines.find((l) => l.fields.code === 'E_LINE_TOO_LONG')!
      expect(tooLong.event).toBe('agent.line-unparseable')
      expect(tooLong.fields.byteLength).toBeGreaterThan(1_048_576)
      await waitFor(() => lines.some((l) => l.event === 'agent.restart-scheduled'), 'a restart')
    } finally {
      await agent.dispose()
    }
  })

  it('replaces the child after 10 unparseable lines in a row', async () => {
    const { agent, lines } = stub('garbage')
    try {
      await agent.start()
      await agent.request('watch.start', { intervalMs: 500 })
      await waitFor(
        () => lines.filter((l) => l.event === 'agent.line-unparseable').length >= 10,
        'ten unparseable lines',
      )
      await waitFor(() => lines.some((l) => l.event === 'agent.restart-scheduled'), 'a restart')
      const first = lines.find((l) => l.event === 'agent.line-unparseable')!
      expect(first.fields.code).toBe('E_PARSE')
      expect(first.fields.count).toBe(1)
    } finally {
      await agent.dispose()
    }
  })
```

- [ ] **Step 44: Run it and watch all four fail.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
```

Expected: `Tests 4 failed | 8 passed (12)`:

- `restarts a crashed child` → `AssertionError: expected [] to have a length of 1 but got +0` on
  `scheduled()` — the caller is failed correctly, but nothing schedules a restart.
- `gives up after maxRestarts` → `Error: timed out waiting for second spawn`.
- `drops a line over MAX_LINE_BYTES` → `Error: timed out waiting for a restart` (the line *is*
  dropped and logged — the splitter did that in Step 7 — but the child is not replaced).
- `10 unparseable lines` → `Error: timed out waiting for a restart`.

- [ ] **Step 45: Implement restart-with-backoff and the two wedge detectors.**

Three decisions worth stating. `restartsUsed` never resets: an agent that crashes every two seconds
would otherwise restart forever at 250 ms. The backoff timer is on the **injected clock**, so the whole
sequence is deterministic in tests. And after a successful restart the host re-sends the last
`watch.start` and `hotkey.register`, because the frozen `ClipboardAgent` interface has no
"restarted" event for the app to react to — without the replay a crash would silently stop clipboard
capture and leave the palette empty forever.

In `createAgentCore`, replace the splitter's `onOverflow` body with:

```ts
    onOverflow: (droppedBytes) => {
      // An unbounded line is a memory attack, so the child is replaced rather than trusted again.
      logger.error('agent.line-unparseable', { code: 'E_LINE_TOO_LONG', byteLength: droppedBytes })
      onFatal('E_LINE_TOO_LONG')
    },
```

and in `handleLine`, replace the parse-failure branch with:

```ts
      if (!parsed.ok) {
        consecutiveParseFailures += 1
        logger.warn('agent.line-unparseable', { code: parsed.code, count: consecutiveParseFailures })
        if (parsed.code === 'E_WIRE_MAJOR') {
          logger.error('agent.wire-major-mismatch', { code: 'E_WIRE_MAJOR' })
          onFatal('E_WIRE_MAJOR')
          return
        }
        if (consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
          onFatal('E_PARSE')
        }
        return
      }
```

In `spawnAgent`, add `type Cancel` to the `@cairn/protocol` type imports, then replace the state
declarations with:

```ts
  let child: ChildProcess | null = null
  let disposed = false
  let failed = false
  let restartsUsed = 0
  let cancelRestart: Cancel = () => {}
```

replace the `failed` line inside `send` with:

```ts
    if (failed) return err('E_AGENT_EXIT', `agent gave up after ${restartsUsed} restarts`)
```

replace the inline `c.on('exit', …)` handler in `spawnChild` with a named handler declared above
`spawnChild`:

```ts
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    child = null
    logger.warn('agent.exited', { code: 'E_AGENT_EXIT', ok: code === 0, attempt: restartsUsed })
    // Everything in flight is definitively over: no caller is left waiting on a dead process.
    core.abortStreams('E_REP_TIMEOUT')
    core.failAllPending('E_AGENT_EXIT', `agent exited (code ${String(code)}, signal ${String(signal)})`)
    core.resetFraming()
    if (disposed || failed) return
    if (restartsUsed >= maxRestarts) {
      failed = true
      logger.error('agent.exited', { code: 'E_AGENT_EXIT', attempt: restartsUsed })
      return
    }
    const delay = RESTART_BACKOFF_MS[Math.min(restartsUsed, RESTART_BACKOFF_MS.length - 1)]!
    restartsUsed += 1
    logger.info('agent.restart-scheduled', { attempt: restartsUsed, durationMs: delay })
    cancelRestart = clock.setTimeout(() => {
      void restart()
    }, delay)
  }
```

so that `spawnChild` ends with `c.on('exit', onExit)`, and add the restart routine after
`spawnChild`:

```ts
  const restart = async (): Promise<void> => {
    if (disposed || failed) return
    spawnChild()
    const r = await core.hello()
    if (!r.ok) {
      logger.error('agent.exited', { code: r.code })
      return
    }
    logger.info('agent.started', { agent: platform })
    // Re-arm what the app had asked for, or a crash would silently stop the clipboard watch.
    const intervalMs = core.lastWatchIntervalMs
    if (intervalMs !== null) await core.request('watch.start', { intervalMs })
    const accelerator = core.lastAccelerator
    if (accelerator !== null) await core.request('hotkey.register', { accelerator })
  }
```

Read `maxRestarts` from the options next to `args`:

```ts
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS
```

and cancel a pending restart in `dispose`, as its first statement after `disposed = true`:

```ts
      cancelRestart()
```

- [ ] **Step 46: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
git commit -am "feat(agent-host): restart a crashed agent with backoff and re-arm the watch"
```

Expected: `Tests 12 passed (12)`.

---

#### The regression guard for the vulnerability that was removed

This is the test that stops a future contributor from "fixing" a memory concern by spooling a big
representation to `$TMPDIR`. It runs a whole capture cycle through a real child process and then proves
that the 200 000 payload bytes exist in exactly one place: this process's heap.

- [ ] **Step 47: Append the no-bytes-on-disk test and the source scan.**

Add to the top of `spawn-agent.test.ts`:

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
```

add these two tests inside `describe('spawnAgent', ...)`:

```ts
  it('writes the reassembled payload to NO file anywhere under the temp directory', async () => {
    // The `node:os` temp-path helper is deliberately NOT imported here: its name is one of the
    // substrings the local scan below bans across every .ts file in this package, test files
    // included. Listing the tree needs only the env var, so use it.
    const tempRoot = process.env['TMPDIR'] ?? '/tmp'
    const { agent } = stub('chunked-image')
    const changes: ClipboardChangedPayload[] = []
    agent.on('clipboard.changed', (p) => changes.push(p))
    try {
      await agent.start()
      await agent.request('watch.start', { intervalMs: 500 })
      await waitFor(() => changes.length === 1, 'the reassembled clipboard.changed')
    } finally {
      await agent.dispose()
    }
    const payload = fillerBytes(200_000)
    const head = payload.subarray(0, 48)
    const middle = payload.subarray(100_000, 100_048)
    // EVERY file, not just files created during this test: a leaked payload file written by an
    // earlier test in this same file would otherwise hide inside a "before" snapshot. Other vitest
    // workers churn this directory concurrently, which is fine — the assertion is about payload
    // bytes, not about the file list being unchanged.
    for (const f of listFiles(tempRoot)) {
      let bytes: Buffer
      try {
        if (statSync(f).size > 8 * 1024 * 1024) continue
        bytes = readFileSync(f)
      } catch {
        continue
      }
      expect(bytes.includes(head), `${f} contains the payload head`).toBe(false)
      expect(bytes.includes(middle), `${f} contains payload bytes`).toBe(false)
    }
  })

  it('has no temp-file or file-write identifier anywhere in the package source', () => {
    // Every needle is assembled from two fragments so this file does not contain the identifiers it
    // bans. That is not decoration: this scan covers every .ts file in the package *including*
    // .test.ts files, so it must survive reading its own source. The repo-wide guard
    // security/no-plaintext-on-disk.security.test.ts exempts *.test.ts paths, which makes this local
    // scan the stricter of the two on purpose — the bytes land in this package first.
    const banned = [
      'mkd' + 'temp',
      'tmp' + 'dir',
      'write' + 'File',
      'append' + 'File',
      'create' + 'WriteStream',
      'sp' + 'ool',
    ]
    const srcDir = new URL('.', import.meta.url).pathname
    const offenders: string[] = []
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ts')) continue
      const text = readFileSync(join(srcDir, name), 'utf8')
      for (const b of banned) if (text.includes(b)) offenders.push(`${name}: ${b}`)
    }
    expect(offenders, 'banned identifiers in packages/agent-host/src').toEqual([])
  })
```

Note the two things that deliberately survive that list: `process.env['TMPDIR']` (uppercase, so
`'tmp' + 'dir'` does not match it, and the repo-wide needles `tmpdir(` and `os.tmpdir` do not either)
and `readFileSync` / `readdirSync` / `statSync`, which only ever **read**. Nothing in this package
opens a file for writing.

and this helper at the very bottom of the file, after the closing `})` of the describe block:

```ts
/** Every file under `root`, two directory levels deep, skipping anything unreadable. */
function listFiles(root: string, depth = 2): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number): void => {
    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (d > 0) walk(p, d - 1)
      } else {
        out.push(p)
      }
    }
  }
  walk(root, depth)
  return out.sort()
}
```

- [ ] **Step 48: Run them and watch them pass.**

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
```

Expected: `Tests 14 passed (14)`. These two are regression guards, so green on the first run is the
correct outcome — which is exactly why the next step proves they can fail.

- [ ] **Step 49: Prove the guard fails when the control is removed.**

Temporarily reintroduce the vulnerability. This package is `"type": "module"` and vitest loads it as
ESM, so `require` is not defined inside it — use real imports or the run fails with
`ReferenceError: require is not defined` instead of the assertion you are trying to see. Add these two
lines at the very top of `packages/agent-host/src/reassembler.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
```

and inside `chunk()`, immediately after `const assembled = Buffer.concat(s.parts)`, insert:

```ts
      writeFileSync(join(process.env['TMPDIR'] ?? '/tmp', `cairn-spool-${s.repId}`), assembled)
```

then run:

```sh
npx vitest run packages/agent-host/src/spawn-agent.test.ts
```

Expected: FAIL, `Tests 2 failed | 12 passed (14)` — **both** guards fire:

```
AssertionError: /var/folders/…/T/cairn-spool-rep-1 contains the payload head: expected true to be false
AssertionError: banned identifiers in packages/agent-host/src: expected [ 'reassembler.ts: writeFile', 'reassembler.ts: spool' ] to deeply equal []
```

Two offenders, one per needle, from the one inserted write: that is the source scan and the byte scan
independently catching the same regression, which is the point of having both.

Now delete all three inserted lines (the two imports and the write), delete the file they created, and
confirm the suite is green:

```sh
rm -f "${TMPDIR:-/tmp}/cairn-spool-rep-1"
git diff --stat packages/agent-host/src/reassembler.ts   # Expected: no output — byte-identical again
npx vitest run packages/agent-host/src/spawn-agent.test.ts
```

Expected: `Tests 14 passed (14)`.

- [ ] **Step 50: Commit the guard.**

```sh
git commit -am "test(agent-host): assert no clipboard byte reaches any file during reassembly"
```

---

#### The NDJSON transcript format, and the two committed fixtures

A transcript is an NDJSON file. **Line 1 is the meta line**; every later line is a directed frame.

```
{"v":1,"t":"meta","transcript":"<name>","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"<free text>"}
{"dir":"in","line":{ …an NDJSON request the HOST is expected to send… }}
{"dir":"out","line":{ …an NDJSON line the AGENT emits… }}
{"dir":"out","delayMs":500,"line":{ …emitted only once the clock has advanced 500 ms… }}
```

Rules, frozen by contract §7:

- `dir: "in"` is a request the host is **expected to send**. `createFakeAgent` compares the host's next
  outbound request against it and **fails the test** if it differs.
- `dir: "out"` is a line the agent emits, replayed into the host.
- The literal string `"*"` in an `in` line means "any value" for that field. `id` is always `"*"`,
  because the host allocates ids. In an `out` response, `id: "*"` means "echo the id of the most
  recently matched `in` request".
- `delayMs` (optional, `out` only) schedules the line on the **injected clock**. There are no real
  timers in a replay: the test moves time with `clock.advance(ms)`.
- Replay is strictly in file order. An `out` line is emitted as soon as the `in` line before it has
  been matched.
- Committed transcripts contain **synthetic content only**, and `meta.synthetic` must be `true`.

- [ ] **Step 51: Create the two fixtures.**

The first is hand-written in full. `sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek` is
`contentHash(Buffer.from('hello world'))` and `aGVsbG8gd29ybGQ=` is its base64 — both are real values,
not placeholders, and the reassembler checks them.

```sh
mkdir -p fixtures/agent-transcripts
cat > fixtures/agent-transcripts/hello-watch-text.ndjson <<'EOF'
{"v":1,"t":"meta","transcript":"hello-watch-text","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"hand-written 2026-09-02"}
{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}
{"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"wireMajor":1,"agent":"macos","agentVersion":"0.1.0","platformVersion":"26.5.1","tier":"A","clipboardWatch":"changecount-poll","paste":"none","hotkey":"carbon","focusApp":true,"concealedTypeHints":true,"maxRepBytes":20971520,"chunkThresholdBytes":65536,"missingTools":[]}}}
{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"watch.start","params":{"intervalMs":500}}}
{"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"watching":true,"intervalMs":500}}}
{"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":364,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic"}}}
EOF
```

The second one carries a 200 000-byte payload over seven `rep.chunk` frames, which is ~262 KB of
base64 — too much to type, so generate it with this exact one-off command. It is a one-off: the output
is committed, and the command is not part of the build.

The payload is the same deterministic filler the tests use (`b[i] = (i * 7 + 13) % 251` with a
little-endian TIFF magic prefix). It is **not** a decodable TIFF, and does not need to be: the
TIFF→PNG conversion path is tested by `@cairn/capture` against `fixtures/formats/screenshot.tiff`.
This fixture exercises the byte transport only, and using filler rather than a real screenshot is what
keeps `scripts/scan-transcripts.mjs` honest.

```sh
node -e '
const { createHash } = require("node:crypto")
const CH = 32768
const img = Buffer.alloc(200000)
for (let i = 0; i < img.length; i++) img[i] = (i * 7 + 13) % 251
img.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0)
const sha = "sha256-" + createHash("sha256").update(img).digest("base64url")
const CAPS = { wireMajor: 1, agent: "macos", agentVersion: "0.1.0", platformVersion: "26.5.1", tier: "A", clipboardWatch: "changecount-poll", paste: "none", hotkey: "carbon", focusApp: true, concealedTypeHints: true, maxRepBytes: 20971520, chunkThresholdBytes: 65536, missingTools: [] }
const L = []
L.push({ v: 1, t: "meta", transcript: "image-tiff-chunked", recordedOn: "macos 26.5.1 arm64", synthetic: true, note: "generated payload: b[i]=(i*7+13)%251 with a TIFF magic prefix" })
L.push({ dir: "in", line: { v: 1, t: "req", id: "*", method: "hello", params: { hostVersion: "*" } } })
L.push({ dir: "out", line: { v: 1, t: "res", id: "*", ok: true, result: CAPS } })
L.push({ dir: "in", line: { v: 1, t: "req", id: "*", method: "watch.start", params: { intervalMs: 500 } } })
L.push({ dir: "out", line: { v: 1, t: "res", id: "*", ok: true, result: { watching: true, intervalMs: 500 } } })
L.push({ dir: "out", delayMs: 500, line: { v: 1, t: "ev", event: "clipboard.changed", data: { changeCount: 371, hints: [], reps: [{ mime: "image/tiff", uti: "public.tiff", byteLength: img.length, sha256: sha, repId: "rep-1" }], frontmostBundleId: "com.apple.Preview", frontmostName: "Preview", attributionConfidence: "heuristic" } } })
const total = Math.ceil(img.length / CH)
for (let s = 0; s < total; s++) L.push({ dir: "out", line: { v: 1, t: "ev", event: "rep.chunk", data: { repId: "rep-1", seq: s, final: s === total - 1, b64: img.subarray(s * CH, (s + 1) * CH).toString("base64") } } })
require("fs").writeFileSync("fixtures/agent-transcripts/image-tiff-chunked.ndjson", L.map((o) => JSON.stringify(o)).join("\n") + "\n")
console.log("frames:", L.length - 1, "chunks:", total, "sha:", sha)
'
```

Expected output, exactly:

```
frames: 12 chunks: 7 sha: sha256-dIhVMuU3Wol_ozyx45p4bs59SBtVbYes7DAaCxSCsS4
```

Then check the two properties `scripts/scan-transcripts.mjs` will later enforce — under 512 KiB, and no
line near `MAX_LINE_BYTES`:

```sh
wc -c fixtures/agent-transcripts/image-tiff-chunked.ndjson
awk '{ if (length($0) > m) m = length($0) } END { print "max line", m }' fixtures/agent-transcripts/image-tiff-chunked.ndjson
```

Expected: `268650` bytes (well under 524 288) and `max line 43805` (well under 1 048 576).

- [ ] **Step 52: Commit the fixtures.**

```sh
git add fixtures/agent-transcripts/hello-watch-text.ndjson fixtures/agent-transcripts/image-tiff-chunked.ndjson
git commit -m "test(agent-host): add the hello-watch-text and image-tiff-chunked transcripts"
```

---

#### Parsing a transcript

- [ ] **Step 53: Write the failing transcript test, and an empty module.**

```sh
: > packages/agent-host/src/transcript.ts
```

`packages/agent-host/src/transcript.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { loadTranscript, parseTranscript } from './transcript'

const META =
  '{"v":1,"t":"meta","transcript":"t","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"x"}'
const IN_HELLO = '{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}'

/** Resolved from this file, so a test's cwd never matters. */
function fixture(name: string): string {
  return new URL(`../../../fixtures/agent-transcripts/${name}`, import.meta.url).pathname
}

describe('parseTranscript', () => {
  it('reads the meta line and numbers the frames by file line', () => {
    const t = parseTranscript([META, IN_HELLO].join('\n') + '\n', 'x.ndjson')
    expect(t.meta.transcript).toBe('t')
    expect(t.meta.synthetic).toBe(true)
    expect(t.meta.note).toBe('x')
    expect(t.frames).toHaveLength(1)
    expect(t.frames[0]!.fileLine).toBe(2)
    expect(t.frames[0]!.dir).toBe('in')
    expect(t.frames[0]!.delayMs).toBe(0)
  })

  it('defaults delayMs to 0 and keeps it when given', () => {
    const t = parseTranscript(
      [META, '{"dir":"out","delayMs":500,"line":{"v":1,"t":"ev"}}', '{"dir":"out","line":{"v":1}}'].join('\n'),
      'x.ndjson',
    )
    expect(t.frames.map((f) => f.delayMs)).toEqual([500, 0])
  })

  it('rejects a transcript whose first line is not a meta line', () => {
    expect(() => parseTranscript([IN_HELLO, META].join('\n'), 'x.ndjson')).toThrow(
      /line 1 must be the meta line/,
    )
  })

  it('rejects a transcript with no lines at all', () => {
    expect(() => parseTranscript('\n\n', 'x.ndjson')).toThrow(
      /x.ndjson is empty: line 1 must be the meta line/,
    )
  })

  it('rejects synthetic:false, because committed transcripts are never real clipboard data', () => {
    const real = META.replace('"synthetic":true', '"synthetic":false')
    expect(() => parseTranscript(real, 'x.ndjson')).toThrow(/must be the meta line/)
  })

  it('rejects a frame with an unknown dir', () => {
    expect(() => parseTranscript([META, '{"dir":"sideways","line":{}}'].join('\n'), 'x.ndjson')).toThrow(
      /line 2 is not a frame/,
    )
  })

  it('rejects a line that is not JSON, naming the line number', () => {
    expect(() => parseTranscript([META, 'not json'].join('\n'), 'x.ndjson')).toThrow(
      /line 2 is not valid JSON/,
    )
  })

  it('loads the committed hello-watch-text fixture', () => {
    const t = loadTranscript(fixture('hello-watch-text.ndjson'))
    expect(t.meta.transcript).toBe('hello-watch-text')
    expect(t.frames.map((f) => f.dir)).toEqual(['in', 'out', 'in', 'out', 'out'])
    expect(t.frames[4]!.delayMs).toBe(500)
  })

  it('loads the committed image-tiff-chunked fixture with 7 chunk frames', () => {
    const t = loadTranscript(fixture('image-tiff-chunked.ndjson'))
    const chunks = t.frames.filter((f) => f.line['event'] === 'rep.chunk')
    expect(chunks).toHaveLength(7)
    expect(t.frames).toHaveLength(12)
  })
})
```

- [ ] **Step 54: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/transcript.test.ts
```

Expected: FAIL, 9 tests failed, each with `TypeError: parseTranscript is not a function`.

- [ ] **Step 55: Implement the transcript parser.**

It **throws** rather than returning a `Result`: a malformed committed fixture is a broken invariant, not
a runtime state a caller could handle (contract §6). `synthetic: z.literal(true)` is the schema saying
out loud that a recorded-but-unscrubbed transcript may not be replayed.

`packages/agent-host/src/transcript.ts`:

```ts
import { readFileSync } from 'node:fs'
import { WIRE_MAJOR } from '@cairn/protocol'
import * as z from 'zod'

export const TranscriptMetaSchema = z.object({
  v: z.literal(WIRE_MAJOR),
  t: z.literal('meta'),
  transcript: z.string().min(1),
  recordedOn: z.string().min(1),
  /** Committed transcripts are synthetic. `false` is not a legal value in this repo. */
  synthetic: z.literal(true),
  note: z.string().default(''),
})

const LineSchema = z.record(z.string(), z.unknown())

export const TranscriptFrameSchema = z.discriminatedUnion('dir', [
  z.object({ dir: z.literal('in'), line: LineSchema }),
  z.object({ dir: z.literal('out'), delayMs: z.int().min(0).default(0), line: LineSchema }),
])

export type TranscriptMeta = z.output<typeof TranscriptMetaSchema>

export interface TranscriptFrame {
  readonly dir: 'in' | 'out'
  /** 1-based line number in the file, so a mismatch message can point at it. */
  readonly fileLine: number
  /** `out` only; the line is scheduled on the injected clock this far ahead. */
  readonly delayMs: number
  readonly line: Record<string, unknown>
}

export interface Transcript {
  readonly path: string
  readonly meta: TranscriptMeta
  readonly frames: readonly TranscriptFrame[]
}

/**
 * Parses a transcript. Throws: a malformed committed fixture is a broken invariant, not a runtime
 * state a caller could sensibly handle.
 */
export function parseTranscript(text: string, path: string): Transcript {
  const rawLines = text.split('\n')
  let meta: TranscriptMeta | null = null
  const frames: TranscriptFrame[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.trim()
    if (raw.length === 0) continue
    const fileLine = i + 1
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error(`Transcript ${path} line ${fileLine} is not valid JSON`)
    }
    if (meta === null) {
      const parsed = TranscriptMetaSchema.safeParse(json)
      if (!parsed.success) {
        throw new Error(
          `Transcript ${path} line ${fileLine} must be the meta line: ${z.prettifyError(parsed.error)}`,
        )
      }
      meta = parsed.data
      continue
    }
    const parsed = TranscriptFrameSchema.safeParse(json)
    if (!parsed.success) {
      throw new Error(
        `Transcript ${path} line ${fileLine} is not a frame: ${z.prettifyError(parsed.error)}`,
      )
    }
    frames.push({
      dir: parsed.data.dir,
      fileLine,
      delayMs: parsed.data.dir === 'out' ? parsed.data.delayMs : 0,
      line: parsed.data.line,
    })
  }
  if (meta === null) throw new Error(`Transcript ${path} is empty: line 1 must be the meta line`)
  return { path, meta, frames }
}

export function loadTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, 'utf8'), path)
}
```

- [ ] **Step 56: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/transcript.test.ts
git add packages/agent-host/src/transcript.ts packages/agent-host/src/transcript.test.ts
git commit -m "feat(agent-host): parse and validate NDJSON agent transcripts"
```

Expected: `Tests 9 passed (9)`.

---

#### The fake agent: replay a transcript through the real host code

`createFakeAgent` builds the same `createAgentCore` as `spawnAgent`, but hands it a transcript instead of
a pipe. That is the point: every later task's tests exercise the real framing, correlation and chunk
reassembly, with no compiler, no clipboard and no OS permission.

- [ ] **Step 57: Write the failing replay test, and an empty module.**

```sh
: > packages/agent-host/src/fake-agent.ts
```

`packages/agent-host/src/fake-agent.test.ts`:

```ts
import {
  createTestClock,
  type ClipboardChangedPayload,
  type LogEvent,
  type LogFields,
  type Logger,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { createFakeAgent, matchesPattern } from './fake-agent'

function fixture(name: string): string {
  return new URL(`../../../fixtures/agent-transcripts/${name}`, import.meta.url).pathname
}

interface RecordedLog { level: string; event: LogEvent; fields: LogFields }

function recordingLogger(): { logger: Logger; lines: RecordedLog[] } {
  const lines: RecordedLog[] = []
  const at = (level: string) => (event: LogEvent, fields?: LogFields) => {
    lines.push({ level, event, fields: fields ?? {} })
  }
  const logger = {
    log: (level: string, event: LogEvent, fields?: LogFields) => at(level)(event, fields),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger
  return { logger, lines }
}

describe('matchesPattern', () => {
  it('treats "*" as any value and requires an exact key set otherwise', () => {
    expect(matchesPattern({ id: '*', method: 'hello' }, { id: '7', method: 'hello' })).toBe(true)
    expect(matchesPattern({ id: '*', method: 'hello' }, { id: '7', method: 'read' })).toBe(false)
    // An extra or missing key is a mismatch: a host that quietly adds a param must fail the script.
    expect(matchesPattern({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(matchesPattern({ a: 1, b: 2 }, { a: 1 })).toBe(false)
    expect(matchesPattern([1, '*'], [1, 9])).toBe(true)
    expect(matchesPattern([1], [1, 9])).toBe(false)
    expect(matchesPattern({ p: { q: '*' } }, { p: { q: [1, 2] } })).toBe(true)
  })
})

describe('createFakeAgent', () => {
  it('replays hello, watch.start and a delayed text copy', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('hello-watch-text.ndjson'), clock, logger })
    const changes: ClipboardChangedPayload[] = []
    agent.on('clipboard.changed', (p) => changes.push(p))

    const caps = await agent.start()
    expect(caps.agent).toBe('macos')
    expect(caps.hotkey).toBe('carbon')

    await expect(agent.request('watch.start', { intervalMs: 500 })).resolves.toEqual({
      ok: true,
      value: { watching: true, intervalMs: 500 },
    })

    // The event is scheduled on the injected clock, so nothing has arrived yet.
    expect(changes).toEqual([])
    clock.advance(499)
    expect(changes).toEqual([])
    clock.advance(1)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.changeCount).toBe(364)
    expect(changes[0]!.changeToken).toBe('364')
    expect(Buffer.from(changes[0]!.reps[0]!.bytes).toString('utf8')).toBe('hello world')
    expect(changes[0]!.sourceApp).toEqual({
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      confidence: 'heuristic',
    })
    expect(agent.framesPlayed).toBe(5)
    await agent.dispose()
  })

  it('answers requests with E_AGENT_DISPOSED after dispose', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('hello-watch-text.ndjson'), clock, logger })
    await agent.start()
    await agent.dispose()
    await expect(agent.request('watch.start', { intervalMs: 500 })).resolves.toEqual({
      ok: false,
      code: 'E_AGENT_DISPOSED',
      message: 'fake agent has been disposed',
    })
  })
})
```

- [ ] **Step 58: Run it and watch it fail.**

```sh
npx vitest run packages/agent-host/src/fake-agent.test.ts
```

Expected: FAIL, 3 tests failed: two with `TypeError: createFakeAgent is not a function` and one with
`TypeError: matchesPattern is not a function`.

- [ ] **Step 59: Implement the fake agent.**

Note what `delayMs` does: contract §7 says it "advances the injected clock", but the `Clock` interface
has no `advance` — only `TestClock` does, and the fake must work with either. So the fake **schedules**
the frame on the injected clock and the test advances time. Same observable behaviour, no cast, and a
demo running on `systemClock` gets a realistic delay for free.

`packages/agent-host/src/fake-agent.ts`:

```ts
import { basename } from 'node:path'
import {
  err,
  ok,
  type AgentCapabilities,
  type ClipboardAgent,
  type Clock,
  type Logger,
  type Result,
} from '@cairn/protocol'
import { createAgentCore } from './spawn-agent'
import { loadTranscript, type TranscriptFrame } from './transcript'

export interface FakeAgent extends ClipboardAgent {
  /** Throws if the transcript was not played to the end, or if a mismatch was recorded. */
  assertDrained(): void
  readonly framesPlayed: number
}

/** `"*"` in an `in` frame means "any value here". Key sets must otherwise match exactly. */
export function matchesPattern(pattern: unknown, actual: unknown): boolean {
  if (pattern === '*') return true
  if (Array.isArray(pattern)) {
    return (
      Array.isArray(actual) &&
      pattern.length === actual.length &&
      pattern.every((p, i) => matchesPattern(p, actual[i]))
    )
  }
  if (pattern !== null && typeof pattern === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
    const p = pattern as Record<string, unknown>
    const a = actual as Record<string, unknown>
    const pk = Object.keys(p).sort()
    const ak = Object.keys(a).sort()
    if (pk.length !== ak.length) return false
    if (pk.some((k, i) => k !== ak[i])) return false
    return pk.every((k) => matchesPattern(p[k], a[k]))
  }
  return pattern === actual
}

export function createFakeAgent(opts: {
  transcriptPath: string
  clock: Clock
  logger: Logger
}): FakeAgent {
  const { clock, logger } = opts
  const transcript = loadTranscript(opts.transcriptPath)
  const where = basename(transcript.path)
  let cursor = 0
  let outboundCount = 0
  let lastMatchedId: string | null = null
  let failure: Error | null = null
  let disposed = false

  const record = (message: string): Error => {
    const e = new Error(message)
    if (failure === null) failure = e
    return e
  }

  const deliver = (frame: TranscriptFrame): void => {
    let line = frame.line
    if (line['t'] === 'res' && line['id'] === '*') {
      if (lastMatchedId === null) throw record('FakeAgent: id "*" before any matched request')
      line = { ...line, id: lastMatchedId }
    }
    core.handleLine(JSON.stringify(line))
  }

  /** Plays every `out` frame up to the next `in` frame. */
  const pump = (): void => {
    for (;;) {
      const frame = transcript.frames[cursor]
      if (frame === undefined || frame.dir !== 'out') return
      cursor += 1
      if (frame.delayMs > 0) {
        // Scheduled on the injected clock, never on a real timer: the test decides when time moves.
        clock.setTimeout(() => {
          deliver(frame)
          pump()
        }, frame.delayMs)
        return
      }
      deliver(frame)
    }
  }

  const send = (line: string): Result<void> => {
    if (disposed) return err('E_AGENT_DISPOSED', 'fake agent has been disposed')
    const actual = JSON.parse(line) as Record<string, unknown>
    outboundCount += 1
    const frame = transcript.frames[cursor]
    if (frame === undefined || frame.dir !== 'in') throw record('FakeAgent: off-script request')
    if (!matchesPattern(frame.line, actual)) throw record('FakeAgent: script mismatch')
    lastMatchedId = String(actual['id'])
    cursor += 1
    pump()
    return ok(undefined)
  }

  const core = createAgentCore({ clock, logger, send, onFatal: () => {} })

  return {
    async start(): Promise<AgentCapabilities> {
      // Leading `out` frames (an event before the host says anything) are played here, so listeners
      // must be attached before start() — exactly as with a real agent.
      pump()
      const r = await core.hello()
      if (!r.ok) throw record(`FakeAgent: ${where} hello failed (${r.code}): ${r.message}`)
      return r.value
    },

    request(method, params, timeoutMs) {
      return core.request(method, params, timeoutMs)
    },

    on(event, cb) {
      return core.on(event, cb)
    },

    async dispose(): Promise<void> {
      disposed = true
      core.abortStreams('E_REP_TIMEOUT')
      core.failAllPending('E_AGENT_DISPOSED', 'fake agent disposed')
      await Promise.resolve()
    },

    assertDrained(): void {
      if (failure !== null) throw failure
      const remaining = transcript.frames.length - cursor
      if (remaining > 0) throw new Error(`FakeAgent: ${remaining} frames unplayed`)
    },

    get framesPlayed(): number {
      return cursor
    },
  }
}
```

- [ ] **Step 60: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/fake-agent.test.ts
git add packages/agent-host/src/fake-agent.ts packages/agent-host/src/fake-agent.test.ts
git commit -m "feat(agent-host): replay a transcript through the real host core"
```

Expected: `Tests 3 passed (3)`.

---

#### The fake agent asserts the host's outbound script, and says exactly what drifted

A fake that silently accepts any request is worthless: the whole value of a transcript is that it fails
when the code under test starts asking for something different. Contract §7 freezes these three
messages, because a broken test has to be diagnosable at a glance.

- [ ] **Step 61: Append the failing drift tests.**

```ts
  it('fails when the host sends a request the transcript did not script', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('hello-watch-text.ndjson'), clock, logger })
    await agent.start()
    let message = ''
    try {
      await agent.request('watch.start', { intervalMs: 250 })
    } catch (e) {
      message = (e as Error).message
    }
    // The message names both sides and the exact fixture line, so drift is diagnosable at a glance.
    expect(message).toBe(
      'FakeAgent: outbound request #2 did not match the transcript script.\n' +
        '  transcript: {"method":"watch.start","params":{"intervalMs":500}}\n' +
        '  actual:     {"method":"watch.start","params":{"intervalMs":250}}\n' +
        '  transcript: hello-watch-text.ndjson line 4',
    )
    // The rejected request must not leave a timer armed.
    expect(clock.pending).toBe(0)
    expect(() => agent.assertDrained()).toThrow(/did not match the transcript script/)
  })

  it('fails when the host sends a request after the transcript is exhausted', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('hello-watch-text.ndjson'), clock, logger })
    await agent.start()
    await agent.request('watch.start', { intervalMs: 500 })
    clock.advance(500)
    await expect(agent.request('read', { changeCount: 364 })).rejects.toThrow(
      'FakeAgent: unexpected outbound request `read` — the transcript scripts no further requests.',
    )
  })

  it('assertDrained names what is left unplayed', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('hello-watch-text.ndjson'), clock, logger })
    await agent.start()
    expect(() => agent.assertDrained()).toThrow(
      'FakeAgent: transcript not fully consumed — 3 of 5 frames unplayed (next: in watch.start).',
    )
  })
```

- [ ] **Step 62: Run it and watch all three fail.**

```sh
npx vitest run packages/agent-host/src/fake-agent.test.ts
```

Expected: `Tests 3 failed | 3 passed (6)`:

- `did not script` → `AssertionError: expected 'FakeAgent: script mismatch' to be 'FakeAgent: outbound request #2 did not match…'`.
- `after the transcript is exhausted` → `AssertionError: expected error to include 'FakeAgent: unexpected outbound request `read`…'`, actual `FakeAgent: off-script request`.
- `assertDrained names what is left` → `AssertionError: expected error to include 'FakeAgent: transcript not fully consumed — 3 of 5…'`, actual `FakeAgent: 3 frames unplayed`.

- [ ] **Step 63: Make the three messages exact, and stop a rejected request leaking its timer.**

In `packages/agent-host/src/fake-agent.ts`, replace the two `throw record(...)` lines in `send` with:

```ts
    if (frame === undefined || frame.dir !== 'in') {
      throw record(
        `FakeAgent: unexpected outbound request \`${String(actual['method'])}\` — ` +
          `the transcript scripts no further requests.`,
      )
    }
    if (!matchesPattern(frame.line, actual)) {
      throw record(
        `FakeAgent: outbound request #${outboundCount} did not match the transcript script.\n` +
          `  transcript: ${JSON.stringify({ method: frame.line['method'], params: frame.line['params'] })}\n` +
          `  actual:     ${JSON.stringify({ method: actual['method'], params: actual['params'] })}\n` +
          `  transcript: ${where} line ${frame.fileLine}`,
      )
    }
```

and replace the body of `assertDrained` with:

```ts
    assertDrained(): void {
      if (failure !== null) throw failure
      const remaining = transcript.frames.length - cursor
      if (remaining > 0) {
        const next = transcript.frames[cursor]!
        const label = String(next.line['method'] ?? next.line['event'] ?? 'unknown')
        throw new Error(
          `FakeAgent: transcript not fully consumed — ${remaining} of ${transcript.frames.length} ` +
            `frames unplayed (next: ${next.dir} ${label}).`,
        )
      }
    },
```

Then, in `packages/agent-host/src/spawn-agent.ts`, make `createAgentCore.request` tolerate a throwing
transport — replace `const written = send(line)` with:

```ts
      let written: Result<void>
      try {
        written = send(line)
      } catch (e) {
        // The fake agent throws when the host goes off-script. Settle the pending entry so no timer
        // is left armed, then rethrow so the test fails loudly instead of quietly returning an Err.
        correlator.fail(id, 'E_INTERNAL', e instanceof Error ? e.message : String(e))
        throw e
      }
```

- [ ] **Step 64: Run it green and commit.**

```sh
npx vitest run packages/agent-host/src/fake-agent.test.ts packages/agent-host/src/spawn-agent.test.ts
git commit -am "feat(agent-host): fail loudly when the host drifts from the transcript script"
```

Expected: `Tests 20 passed (20)` across the two files — 6 fake-agent and 14 spawn-agent.

---

#### The fake agent reassembles a chunked image too — the same code as the real pipe

- [ ] **Step 65: Append the chunked-transcript replay test.**

This one is expected to pass on its first run. That is the point: the fake shares
`createAgentCore`, so a transcript exercises the very same reassembler that Step 35's real child
process did. If it fails, the fake has grown a second code path and that is the bug.

```ts
  it('reassembles a chunked image from a transcript, in memory, with no dropped reps', async () => {
    const clock = createTestClock()
    const { logger, lines } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('image-tiff-chunked.ndjson'), clock, logger })
    const changes: ClipboardChangedPayload[] = []
    const chunks: { repId: string; seq: number; final: boolean }[] = []
    agent.on('clipboard.changed', (p) => changes.push(p))
    agent.on('rep.chunk', (p) => chunks.push(p))

    await agent.start()
    await agent.request('watch.start', { intervalMs: 500 })
    expect(changes).toEqual([])
    clock.advance(500)

    expect(changes).toHaveLength(1)
    const change = changes[0]!
    expect(change.changeCount).toBe(371)
    expect(change.droppedReps).toEqual([])
    expect(change.reps).toHaveLength(1)
    const image = change.reps[0]!
    expect(image.mime).toBe('image/tiff')
    expect(image.uti).toBe('public.tiff')
    expect(image.byteLength).toBeGreaterThanOrEqual(CHUNK_THRESHOLD_BYTES)
    expect(image.byteLength).toBe(200_000)
    // The TIFF magic survived, so chunk 0 landed at offset 0 and the order was preserved.
    expect([...image.bytes.subarray(0, 8)]).toEqual([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])
    expect(image.sha256).toBe('sha256-dIhVMuU3Wol_ozyx45p4bs59SBtVbYes7DAaCxSCsS4')
    expect(chunks).toHaveLength(Math.ceil(200_000 / CHUNK_PAYLOAD_BYTES))
    expect(chunks.at(-1)).toEqual({ repId: 'rep-1', seq: 6, final: true })
    expect(lines.some((l) => l.event === 'rep.stream-complete')).toBe(true)
    expect(lines.some((l) => l.event === 'rep.stream-aborted')).toBe(false)
    agent.assertDrained()
    await agent.dispose()
  })
```

Add `CHUNK_PAYLOAD_BYTES` and `CHUNK_THRESHOLD_BYTES` to the `@cairn/protocol` import at the top of
`fake-agent.test.ts`.

- [ ] **Step 66: Run it and confirm it passes.**

```sh
npx vitest run packages/agent-host/src/fake-agent.test.ts
```

Expected: `Tests 7 passed (7)`. If instead you see
`AssertionError: expected [] to have a length of 1` on `changes`, the delayed frame was not scheduled on
the injected clock; if you see `droppedReps` non-empty, the transcript's `sha256` and its chunk bytes
disagree and the fixture needs regenerating with the Step 51 command.

- [ ] **Step 67: Commit.**

```sh
git commit -am "test(agent-host): replay a chunked image transcript through the fake agent"
```

---

#### The public entry, the typecheck, and the branch

- [ ] **Step 68: Write the barrel.**

Only these names are visible to `@cairn/hotkey`, `@cairn/capture` and `apps/desktop`. Nothing reaches
into a deep path.

`packages/agent-host/src/index.ts`:

```ts
export { createLineSplitter, type LineSplitter, type LineSplitterOptions } from './framing'
export {
  createChangeAssembler,
  createReassembler,
  type ChangeAssembler,
  type ChangedWire,
  type Reassembler,
  type RepAbort,
  type RepChunkIn,
} from './reassembler'
export { createCorrelator, type Correlator } from './correlator'
export {
  createAgentCore,
  spawnAgent,
  DEFAULT_MAX_RESTARTS,
  HOST_VERSION,
  MAX_CONSECUTIVE_PARSE_FAILURES,
  RESTART_BACKOFF_MS,
  type AgentCore,
  type SpawnAgentOptions,
} from './spawn-agent'
export { createFakeAgent, matchesPattern, type FakeAgent } from './fake-agent'
export {
  loadTranscript,
  parseTranscript,
  TranscriptFrameSchema,
  TranscriptMetaSchema,
  type Transcript,
  type TranscriptFrame,
  type TranscriptMeta,
} from './transcript'
```

- [ ] **Step 69: Typecheck the whole node side and run the package suite.**

```sh
npx tsc -p tsconfig.json
npm run test -w @cairn/agent-host
```

Expected: `tsc` exits 0 with no output, and vitest reports `Test Files 6 passed (6)` /
`Tests 65 passed (65)`. A `TS6133 … is declared but its value is never read` here means a helper was
added in the wrong step — delete it or use it, do not disable the rule.

- [ ] **Step 70: Confirm every module is re-exported, then commit and push.**

```sh
for m in framing reassembler correlator spawn-agent fake-agent transcript; do
  grep -q "from './$m'" packages/agent-host/src/index.ts && echo "$m ok" || echo "$m MISSING"
done
```

Expected: six lines, all `ok`. (A plain `node -e "import('@cairn/agent-host')"` will **not** work and
is not a useful check: relative imports in this repo are extensionless by contract §2, which vite,
vitest and tsc resolve and Node's ESM resolver does not.)

```sh
git add packages/agent-host/src/index.ts
git commit -m "feat(agent-host): export the public surface"
git push -u origin m1/03-agent-host
```

Then stop: the user merges the branch.

---

**Task 3 done when:**

- [ ] `npm run test -w @cairn/agent-host` prints `Test Files 6 passed (6)` and `Tests 65 passed (65)`.
- [ ] `npx tsc -p tsconfig.json` exits 0.
- [ ] `packages/agent-host/src/` contains exactly seven non-test modules — `framing.ts`,
      `correlator.ts`, `reassembler.ts`, `spawn-agent.ts`, `fake-agent.ts`, `transcript.ts`,
      `index.ts` — and no others.
- [ ] `grep -rniE 'mkdtemp|tmpdir|writeFile|appendFile|createWriteStream|spool' packages/agent-host/src --include='*.ts' | grep -v '\.test\.ts'` prints nothing.
- [ ] The exact needles the repo-wide guard uses are absent from **every** `.ts` file here, test
      files included — `grep -rnE 'mkdtemp|tmpdir\(|os\.tmpdir|spool|writeFileSync\(|appendFileSync\(|createWriteStream\(' packages/agent-host/src --include='*.ts'`
      prints nothing (case-sensitive on purpose: `process.env['TMPDIR']` is allowed and must survive).
      Task 6's step that writes contract §8's repo-wide no-plaintext-on-disk test scans this directory
      with those needles and `@cairn/agent-host` is on none of its allowance lists, so a hit in product
      code here breaks CI in a task nobody working on this one will be looking at. That guard exempts
      every path ending `.test.ts` and strips comments before scanning; this grep does neither, and
      Step 47's in-package scan covers the test files, so the strictness lives here where the bytes are.
- [ ] `grep -rn 'crashReporter\|fetch(\|net.createServer\|http.createServer' packages/agent-host/src` prints nothing.
- [ ] No shell anywhere in the capture path (spec §11 control 3):
      `grep -rnE 'execSync|execFile|(^|[^a-zA-Z.])exec\(|shell: *true' packages/agent-host/src --include='*.ts'`
      prints nothing. The one child process this package starts is `spawn(binPath, args, …)` with an
      argv **array**. Task 9's step that adds the shell-execution ban to its `security/` suite bans the
      same identifiers repo-wide across `packages/**` and `apps/desktop/**`, so a regression here fails
      there too.
- [ ] `grep -rnE 'Date\.now\(\)|(^|[^.])\bsetTimeout\(|setInterval\(' packages/agent-host/src --include='*.ts' | grep -v '\.test\.ts'` prints nothing: every timer in product code is `clock.setTimeout`, never a bare one.
- [ ] Re-inserting a `writeFileSync` of the assembled payload into `reassembler.ts` makes **two**
      tests fail (`writes the reassembled payload to NO file…` and
      `has no temp-file or file-write identifier…`); removing it again makes them pass.
- [ ] Deleting the `if (hash !== s.declaredHash) return abort(s, 'E_REP_HASH_MISMATCH')` line makes
      `discards the whole representation on a sha256 mismatch` fail.
- [ ] Deleting the `arm(s)` call in `declare` makes `evicts a stream that never sends final` fail.
- [ ] `npx vitest run packages/agent-host --reporter=verbose` lists a named test for each of:
      `E_REP_HASH_MISMATCH`, `E_REP_SEQ_GAP`, `E_REP_SEQ_DUPLICATE`, `E_REP_AFTER_FINAL`,
      `E_REP_BAD_BASE64`, `E_REP_OVERFLOW`, `E_REP_SHORT`, `E_REP_TIMEOUT`, `E_REP_TOO_MANY`,
      `E_REP_UNKNOWN_ID`.
- [ ] `wc -c fixtures/agent-transcripts/image-tiff-chunked.ndjson` prints `268650`, and
      `node -e "for (const l of require('fs').readFileSync('fixtures/agent-transcripts/image-tiff-chunked.ndjson','utf8').trim().split('\n')) JSON.parse(l); console.log('ok')"` prints `ok`.
- [ ] `git log --oneline origin/main..m1/03-agent-host` shows conventional-commit subjects only, and no
      `Co-Authored-By` line appears in `git log --format=%B origin/main..m1/03-agent-host`.
- [ ] `git branch --contains HEAD` does not include `main`, and the branch is pushed
      (`git status -sb` shows no `ahead` count).
