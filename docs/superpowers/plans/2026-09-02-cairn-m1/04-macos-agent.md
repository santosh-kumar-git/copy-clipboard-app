### Task 4: agents/macos — the Swift clipboard agent (watch, read, chunked write-out, hotkey)

This is the only code in the product that touches `NSPasteboard`, `NSWorkspace` or Carbon. It is a
standalone command-line binary speaking NDJSON on stdin/stdout. It has no storage, no policy and no
history: it reports what the OS says and it writes what it is told.

Nothing here needs a TCC permission. `NSPasteboard` reads, `NSWorkspace.frontmostApplication` and
Carbon hot keys are all permission-free — that is why M1 can ship a working palette before the
Accessibility work in M2.

**Everything in this section was compiled and run on macOS 26.5.1 arm64 with swiftc 6.3.3 (Command
Line Tools only) while the plan was written.** Where a fact is surprising it is marked `[verified]`
with the number that came back.

---

**Files:**

*Create:*
- `agents/macos/Sources/Wire.swift` — NDJSON envelopes, the serialised stdout writer, the stdin line splitter, the suspend ledger
- `agents/macos/Sources/Pasteboard.swift` — the one `NSPasteboard` queue, the hint probe, the UTI allowlist, TIFF→PNG, the read watchdog, the frontmost cache
- `agents/macos/Sources/Chunker.swift` — representations ≥ 64 KiB → `rep.chunk` events over stdout
- `agents/macos/Sources/Hotkey.swift` — the accelerator parser and Carbon `RegisterEventHotKey`
- `agents/macos/Sources/Writer.swift` — `write{reps,transient}` and the returned changeCount token
- `agents/macos/Sources/main.swift` — request dispatch, the `DispatchSourceTimer` poll, startup, shutdown
- `agents/macos/Tests/SelfTest.swift` — the pure-Swift assertion binary (**not in the contract's file tree; see Interfaces note 3**)
- `tools/record-transcript.ts` — `record` a real session to `*.raw.ndjson`, and `diff` a raw recording against a committed fixture. It has **no** promote-to-fixture mode: this task creates no fixture.
- `tools/agent-selftest.test.ts` — the vitest test that compiles and runs `SelfTest.swift`, plus the Swift/TypeScript constant drift guard (**tree addition**)
- `scripts/scan-transcripts.mjs` — the CI transcript scanner behind `npm run scan:transcripts`; contract §7's four checks, exporting `scanTranscript()` so the CLI and the security test share one code path
- `security/transcripts-synthetic.security.test.ts` — every committed transcript is synthetic and clean (contract §8)
- `security/agent-no-file-writes.security.test.ts` — the agent's sources contain no filesystem write path **and no network API**; it is listed in contract §1's file tree and contract §8's security table

*Consumes, does not create — `fixtures/agent-transcripts/`:* every fixture in that directory belongs
to another task, and this task only ever reads them.

| fixture | owner |
|---|---|
| `hello-watch-text.ndjson` | Task 3 (`@cairn/agent-host`) — its `transcript.test.ts` asserts these exact bytes |
| `image-tiff-chunked.ndjson` | Task 3 — asserts 12 frames, `wc -c` 268650 and `sha256-dIhVMuU3Wol_ozyx45p4bs59SBtVbYes7DAaCxSCsS4` |
| `concealed-1password.ndjson` | Task 7 (`@cairn/capture` + `@cairn/privacy`) |
| `finder-multifile.ndjson` | Task 7 |
| `chrome-source-url.ndjson` | Task 7 |
| `self-write-suppression.ndjson` | Task 7 |
| `duplicate-notify.ndjson` | Task 7 |

An earlier revision of this task recorded live sessions and `promote`d them over
`hello-watch-text.ndjson` and `image-tiff-chunked.ndjson`, which silently destroyed the byte counts
and hashes Task 3 asserts, and hand-authored five files Task 7 also authors with different
`changeCount`s and reps. **Do not reintroduce a promote step.** Step 34 records raw sessions and
*diffs* them against the committed fixtures instead, which is the check that actually has value:
it proves the real binary still emits what the fixtures claim.

*Modify:* nothing. The `Makefile`, `.gitignore`, `package.json`, `vitest.config.ts` and `.npmrc` are
already correct for this task — `.gitignore` already excludes `build/` and
`fixtures/agent-transcripts/*.raw.ndjson`, the root `package.json` already wires
`"scan:transcripts": "node scripts/scan-transcripts.mjs"` into `npm run verify` (Task 1's step that
writes the three root toolchain files records that it is expected to be broken until this task lands
the script), and the Makefile already globs `agents/macos/Sources/*.swift`.
`vitest.config.ts` is Task 1's three-project file (`unit`, `security`,
`renderer`) and needs no change here: `tools/agent-selftest.test.ts` is picked up by `unit`'s
`tools/**/*.test.ts` include, and both files this task adds under `security/` match `security`'s
`security/**/*.security.test.ts` include. `unit` also globs `security/**/*.test.ts` for the shared
source-scanner's own unit test, but excludes `**/*.security.test.ts`, so nothing here runs twice.

*Test:* `agents/macos/Tests/SelfTest.swift` (63 assertions, run by `tools/agent-selftest.test.ts`),
`security/transcripts-synthetic.security.test.ts`, `security/agent-no-file-writes.security.test.ts`,
and the by-hand pasteboard verifications in Steps 25–27 and 30, which are the tests for every
behaviour that needs a real pasteboard.

*Consume, do not edit:* `agents/macos/Sources/AgentProtocol.generated.swift` (Task 2),
`packages/protocol/src/constants.ts` (Task 1), `security/source-scan.ts` (Task 1 — the shared,
quote-aware source scanner every source ban runs through, used by Step 39),
`packages/privacy/src/index.ts` (Task 7 — the scanner imports its detectors, see Step 36).

---

**Interfaces:**

`Consumes:` — from `agents/macos/Sources/AgentProtocol.generated.swift`, emitted by
`npm run gen:agent-types` (Task 2). **The generator is authoritative; this is a transcription of what
it emits, not a wish list.** This task references exactly these symbols and nothing else. Types are
shown with the exact field names, field ORDER and Swift types the generator emits; `Codable,
Equatable, Sendable` is elided from every conformance list below for width, and the generated
`AgentLogValue` also carries a hand-written `init(from:)`/`encode(to:)` pair:

```swift
let protocolVersion = 1          // the ONLY constant in the generated file

enum AgentMethod: String, Codable { case hello, watchStart = "watch.start", watchStop = "watch.stop", read, write, hotkeyRegister = "hotkey.register", hotkeyUnregister = "hotkey.unregister", shutdown }
enum AgentEventName: String, Codable { case clipboardChanged = "clipboard.changed", repChunk = "rep.chunk", hotkeyFired = "hotkey.fired", log }
enum AgentLogValue: Codable { case string(String), number(Double), bool(Bool), null }
enum Hint: String, Codable { case concealed, transient, autoGenerated = "auto-generated", passwordManager = "password-manager" }
enum LogDataLevel: String, Codable { case debug, info, warn, error }
enum AgentCapabilitiesAgent: String, Codable { case macos, win32, linux }
enum AgentCapabilitiesClipboardWatch: String, Codable { case changecountPoll = "changecount-poll", sequencePoll = "sequence-poll", xfixes, wlPasteWatch = "wl-paste-watch", focusOnly = "focus-only", none }
enum AgentCapabilitiesHotkey: String, Codable { case carbon, win32Hotkey = "win32-hotkey", portal, electron, none }
enum AgentCapabilitiesPaste: String, Codable { case cgevent, sendinput, ydotool, none }
enum AgentCapabilitiesTier: String, Codable { case a = "A", b = "B", c = "C", d = "D" }
enum ClipboardChangedDataAttributionConfidence: String, Codable { case heuristic, unknown }

struct AgentError: Codable { var code: String; var message: String }
struct Rep: Codable { var byteLength: Int; var inline: Data?; var mime: String; var repId: String?; var sha256: String; var uti: String? }
struct AgentCapabilities: Codable { var agent: AgentCapabilitiesAgent; var agentVersion: String; var chunkThresholdBytes: Int; var clipboardWatch: AgentCapabilitiesClipboardWatch; var concealedTypeHints: Bool; var focusApp: Bool; var hotkey: AgentCapabilitiesHotkey; var maxRepBytes: Int; var missingTools: [String]?; var paste: AgentCapabilitiesPaste; var platformVersion: String; var tier: AgentCapabilitiesTier; var wireMajor: Int }
typealias HelloResult = AgentCapabilities
struct HelloParams: Codable { var hostVersion: String }
struct WatchStartParams: Codable { var intervalMs: Int }
struct ReadParams: Codable { var changeCount: Int }
struct WriteParamsRepsItem: Codable { var b64: Data; var mime: String; var uti: String? }
struct WriteParams: Codable { var reps: [WriteParamsRepsItem]; var transient: Bool }
struct HotkeyRegisterParams: Codable { var accelerator: String }
struct WatchStartResult: Codable { var intervalMs: Int; var watching: Bool }
struct WatchStopResult: Codable { var watching: Bool }
struct ReadResult: Codable { var changeCount: Int; var hints: [Hint]?; var reps: [Rep] }
struct WriteResult: Codable { var changeToken: String }
struct HotkeyRegisterResult: Codable { var accelerator: String; var bound: Bool }
struct HotkeyUnregisterResult: Codable { var bound: Bool }
struct ShutdownResult: Codable { var bye: Bool }
struct ClipboardChangedData: Codable { var attributionConfidence: ClipboardChangedDataAttributionConfidence; var changeCount: Int; var frontmostBundleId: String?; var frontmostName: String?; var hints: [Hint]?; var reps: [Rep] }
struct RepChunkData: Codable { var b64: Data; var final: Bool; var repId: String; var seq: Int }
struct HotkeyFiredData: Codable { var accelerator: String; var firedAt: Int; var focusToken: String }
struct LogData: Codable { var event: String; var fields: [String: AgentLogValue]?; var level: LogDataLevel }
```

`AgentMethod`, `AgentEventName` and `AgentError` are typechecked by Step 2's probe and are otherwise
touched only there: the dispatcher in `main.swift` routes on the raw `head.method` string so that an
unknown method is answered `E_UNKNOWN_METHOD` instead of failing to decode, and error responses are
built by `Out.fail(id:code:message:)`. The generator also emits three empty parameter structs
(`WatchStopParams`, `HotkeyUnregisterParams`, `ShutdownParams`); those three methods take no params,
so nothing in this task decodes them.

**Four consequences that will otherwise cost you an hour each.** All four were reproduced with
`swiftc -typecheck` against the real generated file while this plan was written:

1. **Field order is alphabetical, and Swift memberwise initialisers are positional.** Task 2's
   `emitStruct` does `Object.keys(shape).sort()`, so `RepChunkData(repId:seq:final:b64:)` fails with
   `error: incorrect argument labels in call (have 'repId:seq:final:b64:', expected
   'b64:final:repId:seq:')`. Every construction below therefore uses alphabetical labels.
2. **Every base64 field is `Data`, not `String`.** `Rep.inline`, `RepChunkData.b64` and
   `WriteParamsRepsItem.b64` are `Data`; `JSONEncoder`/`JSONDecoder` base64 them by default. The agent
   never calls a base64 API for a payload, and `Data(base64Encoded:)` never appears in `Writer.swift`.
3. **`missingTools` and `hints` are Optional** (`[String]?`, `[Hint]?`) because a zod `.default()` has
   no place to live in a memberwise init. Always pass `[]` rather than `nil` for `hints`, so
   `clipboard.changed` carries `"hints":[]` exactly as the committed fixtures do.
4. **`AgentCapabilitiesPaste`, `…ClipboardWatch` and `…Hotkey` each have a `none` case**, which is
   ambiguous with `Optional.none`. Write `AgentCapabilitiesPaste.none`, never bare `.none`.

The generated file contains **no numeric limits** — the zod schemas have nowhere to hang a bare
number, so the generator emits only `protocolVersion` plus the types. `Wire.swift` declares the **six**
it needs — `CHUNK_THRESHOLD_BYTES`, `CHUNK_PAYLOAD_BYTES`, `MAX_REP_BYTES`, `MAX_LINE_BYTES`,
`AGENT_REQUEST_TIMEOUT_MS`, `WATCH_INTERVAL_MS` — as top-level `let`s mirroring
`packages/protocol/src/constants.ts`. Emitting them from the generator as well is not an option: two
top-level `let`s of the same name in one module is `error: invalid redeclaration of 'MAX_REP_BYTES'` in
the whole-module `swiftc` build `make agent` runs. The drift guard is instead
`tools/agent-selftest.test.ts`, which imports the six frozen constants from `@cairn/protocol`
(`packages/protocol/src/constants.ts`), reads `Wire.swift` as text, and fails if any literal drifts —
see Step 11. The wire major itself is **not** duplicated: everything uses the generated
`protocolVersion`.

Also consumed: the frozen `Makefile` target `make agent` → `agents/macos/build/cairn-agent-macos`
(`AGENT_BIN_NAME` in `packages/protocol/src/constants.ts`), the constants above from
`@cairn/protocol`, `detectSpans` + `ALL_DETECTORS` from `@cairn/privacy` (Task 7, used only by
`scripts/scan-transcripts.mjs`), and the shared fixture directory `fixtures/agent-transcripts/`,
read-only.

`Produces:` — the wire behaviour every other task depends on.

1. **The binary:** `agents/macos/build/cairn-agent-macos`, built by `make agent`. Reads NDJSON
   requests on stdin, writes NDJSON responses and events on stdout, human text on stderr only.
2. **Requests answered** (and no others; anything else is `E_UNKNOWN_METHOD`):
   `hello`, `watch.start`, `watch.stop`, `read`, `write`, `hotkey.register`, `hotkey.unregister`,
   `shutdown`.
3. **Events emitted:** `clipboard.changed`, `rep.chunk`, `hotkey.fired`, `log`.
4. **Capabilities returned by `hello`** — exact values, so the fake-agent transcripts and
   `@cairn/agent-host` can assert them:
   `{wireMajor:1, agent:"macos", agentVersion:"0.1.0", platformVersion:"<major.minor.patch>",
   tier:"A", clipboardWatch:"changecount-poll", paste:"none", hotkey:"carbon", focusApp:true,
   concealedTypeHints:true, maxRepBytes:20971520, chunkThresholdBytes:65536, missingTools:[]}`.
   `paste:"none"` is correct for M1 and becomes `"cgevent"` in M2.
5. **MIME strings the agent will ever emit**, and the UTI each comes from:
   | mime | uti | note |
   |---|---|---|
   | `text/plain` | `public.utf8-plain-text` | never `public.utf16-external-plain-text`, never the `NSStringPboardType` alias |
   | `text/html` | `public.html` | raw source bytes; nothing renders them, ever |
   | `text/rtf` | `public.rtf` | |
   | `text/uri-list` | `public.file-url` | one URI per line, **LF-terminated including the last line**, collected across all pasteboard items into ONE rep |
   | `image/png` | `public.png` | |
   | `image/png` | `public.tiff` | converted to PNG in the agent; `uti` stays `public.tiff` so the provenance is visible |
   | `application/pdf` | `com.adobe.pdf` | only when neither png nor tiff is offered |
   | `text/x-source-url` | `org.chromium.source-url` | the page a Chrome copy came from |
   At most one rep per mime; the first pasteboard item that offers it wins.
6. **`changeToken`** is `String(changeCount)` — the value `write` returns is the number
   `@cairn/capture.suppressToken()` must ignore. `clipboard.changed.changeCount` is the same number
   as an `Int`.
7. **`focusToken`** on `hotkey.fired` is `"<frontmostBundleId or 'unknown'>|<firedAtMillis>"`. It is
   opaque in M1 (nothing restores focus until M2) and always non-empty.
8. **Exit codes:** `0` = `shutdown` or stdin EOF; `70` = stdout closed (the host died); `75` =
   the pasteboard is wedged, restart me.
9. **Log event ids** the agent emits (free-form strings on the wire; the host keeps only `level` and
   `event`): `watch.started`, `watch.suspended`, `watch.resumed`, `watch.rescheduled`,
   `watch.low-power`, `read.stale`, `pasteboard.concealed-skipped`, `pasteboard.rep-nil`,
   `pasteboard.rep-too-large`, `pasteboard.reps-skipped`, `pasteboard.tiff-convert-failed`,
   `pasteboard.read-wedged`, `pasteboard.read-wedged-fatal`, `write.set-data-refused`,
   `write.write-objects-failed`, `hotkey.unparseable`, `hotkey.register-failed`, `line.too-long`,
   `request.unparseable`, `request.not-a-req`.
   There is deliberately **no** `write.bad-base64`: `WriteParamsRepsItem.b64` is `Data`, so a malformed
   base64 string fails `JSONDecoder` and the whole `write` is answered `E_BAD_PARAMS` before
   `Writer.write` is ever called. A log id that can never fire is a lie, so it is not listed.
10. **`scripts/scan-transcripts.mjs`** — `npm run scan:transcripts`, exit `0` clean / `1` findings /
    `2` cannot scan, and a named `scanTranscript(path, detect)` export so
    `security/transcripts-synthetic.security.test.ts` runs the identical code path (contract §7).
11. **`node tools/record-transcript.ts record <name> <seconds> --i-understand-this-writes-real-clipboard-data-to-disk`**
    and **`node tools/record-transcript.ts diff <raw-name> <fixture-name>`**. There is no `promote`
    subcommand: this task creates no fixture, so nothing here can overwrite one.
12. **`agents/macos/build/cairn-agent-selftest --mark concealed|files|tiff|chrome`** — puts synthetic
    content with the awkward UTIs on the real pasteboard. This is how the concealed-type, multi-file,
    TIFF and Chrome paths are exercised without a password manager or Finder (Step 26), and it is what
    lets `record-transcript diff` compare the real binary against Task 7's hand-authored fixtures on a
    machine with no 1Password installed.

Notes the reviewer should see:

1. **The mime for `org.chromium.source-url` is frozen as `text/x-source-url`.** It is
   `MIME_SOURCE_URL` in `packages/protocol/src/constants.ts` (Task 1), asserted there by
   `constants.test.ts` as `expect(MIME_SOURCE_URL).toBe('text/x-source-url')`. This task is the only
   code that ever *emits* it, and it emits exactly that string; the UTI on the wire stays
   `org.chromium.source-url`. Task 7's `chrome-source-url.ndjson` and its `normalizeReps` assertions
   carry the same value, so a recorded session and the committed fixture agree — if a committed
   fixture is ever found declaring `"mime":"text/plain"` for that UTI, the fixture is the thing to fix
   (`git grep -n 'org.chromium.source-url' fixtures/` must show `text/x-source-url` beside every
   occurrence), because the real binary emits `MIME_SOURCE_URL` and `record-transcript diff` (Step 34)
   compares the binary's own output against whatever the fixture says. `Pasteboard.swift` spells the
   literal rather than importing the TypeScript constant for the same reason `Wire.swift` spells its six
   numeric limits: Swift cannot import from `@cairn/protocol`.
2. **The generated Swift symbol names above were transcribed from Task 2's actual emitted file**, not
   assumed: they were extracted by running Task 2's step that reads the generated Swift and checks it
   against the schemas by eye, then `swiftc -typecheck`ed against every construction in this task.
   Step 2 re-checks them before a line of Swift is written, and it does so with a real
   `swiftc -typecheck` probe rather than a name grep, because a grep cannot catch the
   alphabetical-argument-order trap. If they ever differ, the fix is a rename in these six files and a
   note back to Task 2 — not a second set of names.
3. **Two files are additions to the contract's frozen tree**
   (`agents/macos/Tests/SelfTest.swift` and `tools/agent-selftest.test.ts`): the contract's tree has no
   test target for the Swift agent at all. `security/agent-no-file-writes.security.test.ts` is **not** an
   addition — it has its own row in contract §1's file tree and in contract §8's security table,
   because it is the only assertion that the process holding clipboard bytes first can neither write a
   file nor open a socket. `security/no-plaintext-on-disk.security.test.ts` (Task 6) scans
   `packages/**` and `apps/desktop/**`, never `agents/**`, and Task 9's socket ban has the same roots,
   which is exactly the gap this file closes. Recorded in `concerns`.
4. **`scripts/scan-transcripts.mjs` imports `@cairn/privacy`, which Task 7 creates.** Contract §7 is
   explicit that the scan runs "the same code path as the product, so the scan cannot drift", so the
   scanner will not carry its own private copy of the detectors. Merge order is therefore Task 4 →
   Task 7: the script exists first (Task 7's step that creates the capture transcripts runs
   `npm run scan:transcripts` over them), and the scan becomes fully live once
   `packages/privacy/src/index.ts` exists. Until then the CLI exits **2** with
   the named line `scan-transcripts: FATAL @cairn/privacy is not available yet` rather than pretending
   to have scanned — see Step 36. Recorded in `concerns`.

**Branch:** `m1/04-macos-agent`

---

- [ ] **Step 1: Cut the branch.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git fetch origin && git checkout -b m1/04-macos-agent origin/main
```

Expected: `Switched to a new branch 'm1/04-macos-agent'`. Never commit to `main`.

- [ ] **Step 2: Confirm the generated protocol file exists and defines the symbols this task consumes.**

Task 2 owns the generator. This step fails loudly now rather than 300 lines of Swift later.

A name grep is not enough, and that is the whole point of this step. Swift memberwise initialisers are
positional, Task 2's `emitStruct` sorts fields alphabetically, and `Rep.inline` / `RepChunkData.b64` /
`WriteParamsRepsItem.b64` are `Data` and not `String` — none of which a grep can see. So the check is a
throwaway `swiftc -typecheck` probe that actually constructs every type this task uses. It lives in
`/tmp`, outside the repo, so it can never be committed.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npm run gen:agent-types
grep -c '^let protocolVersion = 1$' agents/macos/Sources/AgentProtocol.generated.swift
grep -cE '^(struct|enum|typealias) ' agents/macos/Sources/AgentProtocol.generated.swift
```

Expected: `1`, then `35` (23 structs, 11 enums, 1 typealias).

```sh
mkdir -p /tmp/cairn-agent-shapes && cat > /tmp/cairn-agent-shapes/main.swift <<'SWIFT'
import Foundation

// Every generated type this task constructs, with the labels in the order the generator emits them.
// If any line here fails to compile, fix the call sites in Wire/Pasteboard/Chunker/Writer/Hotkey/main
// to match the generator — never hand-declare a twin of a type the generator already emits.
let rep = Rep(byteLength: 11, inline: Data("hello world".utf8), mime: "text/plain",
              repId: nil, sha256: "sha256-x", uti: "public.utf8-plain-text")
let chunk = RepChunkData(b64: Data("hi".utf8), final: true, repId: "r1", seq: 0)
let caps = AgentCapabilities(agent: .macos, agentVersion: "0.1.0", chunkThresholdBytes: 65_536,
                             clipboardWatch: .changecountPoll, concealedTypeHints: true, focusApp: true,
                             hotkey: .carbon, maxRepBytes: 20_971_520, missingTools: [],
                             paste: AgentCapabilitiesPaste.none, platformVersion: "26.5.1",
                             tier: .a, wireMajor: protocolVersion)
let helloResult: HelloResult = caps
let changed = ClipboardChangedData(attributionConfidence: .heuristic, changeCount: 364,
                                   frontmostBundleId: "com.apple.TextEdit", frontmostName: "TextEdit",
                                   hints: [Hint.concealed], reps: [rep])
let log = LogData(event: "watch.started", fields: ["intervalMs": .number(500), "reason": .string("sleep")],
                  level: .info)
let fired = HotkeyFiredData(accelerator: "Cmd+Shift+V", firedAt: 1, focusToken: "x|1")
let watchStart = WatchStartResult(intervalMs: 500, watching: true)
let watchStop = WatchStopResult(watching: false)
let readResult = ReadResult(changeCount: 364, hints: [], reps: [rep])
let writeItem = WriteParamsRepsItem(b64: Data("hi".utf8), mime: "text/plain", uti: nil)
let writeParams = WriteParams(reps: [writeItem], transient: false)
let writeResult = WriteResult(changeToken: "364")
let hkReg = HotkeyRegisterResult(accelerator: "Cmd+Shift+V", bound: true)
let hkUnreg = HotkeyUnregisterResult(bound: false)
let bye = ShutdownResult(bye: true)
let helloParams = HelloParams(hostVersion: "0.1.0")
let watchStartParams = WatchStartParams(intervalMs: 500)
let readParams = ReadParams(changeCount: 364)
let hkParams = HotkeyRegisterParams(accelerator: "Cmd+Shift+V")
_ = (helloResult, changed, chunk, log, fired, watchStart, watchStop, readResult, writeParams,
     writeResult, hkReg, hkUnreg, bye, helloParams, watchStartParams, readParams, hkParams,
     AgentMethod.hello, AgentEventName.clipboardChanged, LogDataLevel.warn,
     AgentCapabilitiesClipboardWatch.changecountPoll, AgentCapabilitiesHotkey.carbon,
     AgentCapabilitiesTier.a, AgentCapabilitiesAgent.macos,
     ClipboardChangedDataAttributionConfidence.unknown, AgentError(code: "E", message: "m"))
print("shapes OK")
SWIFT

swiftc -typecheck agents/macos/Sources/AgentProtocol.generated.swift /tmp/cairn-agent-shapes/main.swift \
  && echo "generated protocol shapes OK"
rm -rf /tmp/cairn-agent-shapes
```

Expected: no compiler output, then `generated protocol shapes OK`.

If it fails, read the error and fix the *call sites* in this task, not the generated file. The two
failures you are most likely to see, both verified:

```
error: incorrect argument labels in call (have 'repId:seq:final:b64:', expected 'b64:final:repId:seq:')
error: cannot convert value of type 'String' to expected argument type 'Data'
```

**Do not** add a second set of type names beside the generated ones, and do not hand-declare a struct
the generator already emits — the generated file is the single source of truth for the wire.

- [ ] **Step 3: Write the failing self-test — the harness plus the accelerator-parser assertions.**

Swift has no test runner here. `swift build` and `swift test` **do not work with Command Line Tools
only**: `[verified]` on this machine, any `Package.swift` fails with
`error: 'x': Invalid manifest … Undefined symbols … PackageDescription.Package.__allocating_init`,
because the CLT ships a `libPackageDescription` older than the driver. XCTest ships with full Xcode,
which this machine does not have either. So the pure parts get a plain `swiftc` binary that prints
`ok`/`FAIL` lines and exits non-zero, and vitest runs it.

Create `agents/macos/Tests/SelfTest.swift`:

```swift
import AppKit
import Foundation

/// A plain `swiftc` harness, not `swift test`: SwiftPM cannot build a manifest with Command Line
/// Tools only on this machine, and XCTest ships with full Xcode. This binary compiles every agent
/// source except main.swift, asserts the pure parts, and exits non-zero on the first failure.
@main
struct SelfTest {
  static var failures = 0

  static func expect(_ condition: Bool, _ label: String) {
    if condition {
      print("ok   - \(label)")
    } else {
      print("FAIL - \(label)")
      failures += 1
    }
  }

  static func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
    if actual == expected {
      print("ok   - \(label)")
    } else {
      print("FAIL - \(label)\n       expected: \(expected)\n       actual:   \(actual)")
      failures += 1
    }
  }

  static func main() {
    runAssertions()
    print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
    exit(failures == 0 ? 0 : 1)
  }

  static func runAssertions() {
    // 1. accelerator parsing
    let cmdShiftV = HotkeyMap.parse("Cmd+Shift+V")
    expectEqual(cmdShiftV?.keyCode, UInt32(9), "Cmd+Shift+V resolves to the V key code (9)")
    expectEqual(cmdShiftV?.modifiers, UInt32(0x0100 | 0x0200), "Cmd+Shift+V sets cmdKey|shiftKey")
    expectEqual(HotkeyMap.parse("cmd+shift+v")?.modifiers, UInt32(0x0100 | 0x0200), "parsing is case-insensitive")
    expectEqual(HotkeyMap.parse("CommandOrControl+Shift+C")?.modifiers, UInt32(0x0100 | 0x0200), "CommandOrControl means cmdKey on macOS")
    expectEqual(HotkeyMap.parse("Ctrl+Alt+V")?.modifiers, UInt32(0x1000 | 0x0800), "Ctrl+Alt sets controlKey|optionKey")
    expect(HotkeyMap.parse("V") == nil, "a modifier-less accelerator is refused")
    expect(HotkeyMap.parse("Cmd+Shift+Nope") == nil, "an unknown key name is refused")
    expect(HotkeyMap.parse("Cmd+Shift+V+X") == nil, "two non-modifier keys is refused")
    expect(HotkeyMap.parse("") == nil, "an empty accelerator is refused")
  }
}
```

The magic numbers are Carbon's: `cmdKey == 0x0100`, `shiftKey == 0x0200`, `optionKey == 0x0800`,
`controlKey == 0x1000`. They are spelled as literals in the test on purpose, so a test that imports
the same constant as the implementation cannot pass vacuously.

- [ ] **Step 4: Write the vitest test that builds and runs it.**

Create `tools/agent-selftest.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES_DIR = join(REPO_ROOT, 'agents', 'macos', 'Sources')
const BUILD_DIR = join(REPO_ROOT, 'agents', 'macos', 'build')
const SELFTEST_SRC = join(REPO_ROOT, 'agents', 'macos', 'Tests', 'SelfTest.swift')
const SELFTEST_BIN = join(BUILD_DIR, 'cairn-agent-selftest')

/**
 * The Swift agent's pure logic is compiled and asserted here rather than by `swift test`, which
 * cannot run without full Xcode. Every source except main.swift is linked in, because main.swift is
 * the only file with top-level code and SelfTest.swift supplies the entry point instead.
 */
describe.runIf(process.platform === 'darwin')('macOS agent Swift self-test', () => {
  it('compiles the pure parts of the agent and every assertion passes', () => {
    expect(existsSync(SELFTEST_SRC)).toBe(true)
    mkdirSync(BUILD_DIR, { recursive: true })
    const arch = execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim()
    const sources = readdirSync(SOURCES_DIR)
      .filter((f) => f.endsWith('.swift') && f !== 'main.swift')
      .map((f) => join(SOURCES_DIR, f))
    expect(sources.length).toBeGreaterThan(0)

    execFileSync(
      'swiftc',
      [
        '-O',
        '-target', `${arch}-apple-macos13.0`,
        '-framework', 'AppKit',
        '-framework', 'Carbon',
        '-o', SELFTEST_BIN,
        ...sources,
        SELFTEST_SRC,
      ],
      { stdio: 'pipe' },
    )

    const output = execFileSync(SELFTEST_BIN, [], { encoding: 'utf8' })
    const failed = output.split('\n').filter((line) => line.startsWith('FAIL'))
    expect(failed, output).toEqual([])
    expect(output.trimEnd().endsWith('ALL PASS')).toBe(true)
  }, 60_000)
})
```

A second `it()` — the Swift/TypeScript constant drift guard — is appended to this file in Step 11, once
`Wire.swift` exists for it to read.

- [ ] **Step 5: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run tools/agent-selftest.test.ts
```

Expected: FAIL. The `swiftc` invocation exits non-zero and vitest prints the compiler's own message,
`error: cannot find 'HotkeyMap' in scope`. (`sources` is empty at this point, so the only Swift
files on the command line are the generated protocol file and `SelfTest.swift`.)

- [ ] **Step 6: Implement the accelerator parser.**

Create `agents/macos/Sources/Hotkey.swift` with the pure half only. Carbon registration is Step 29 —
it needs the stdout writer, which does not exist yet.

```swift
import AppKit
import Carbon
import Foundation

/// Carbon `RegisterEventHotKey`, not Electron's `globalShortcut`, for one reason that matters in
/// M2: a Carbon hot key keeps firing while secure input is active, which is what lets the palette
/// open over a focused password field at all. Nothing else in Cairn uses Carbon.
enum HotkeyMap {
  /// Physical ANSI virtual key codes. A hot key is registered by key CODE, not by character, so on
  /// a non-ANSI layout `Cmd+Shift+V` is the key in the V position. That is how every macOS app
  /// behaves and is not something we can fix here.
  static let keyCodes: [String: UInt32] = [
    "A": UInt32(kVK_ANSI_A), "B": UInt32(kVK_ANSI_B), "C": UInt32(kVK_ANSI_C), "D": UInt32(kVK_ANSI_D),
    "E": UInt32(kVK_ANSI_E), "F": UInt32(kVK_ANSI_F), "G": UInt32(kVK_ANSI_G), "H": UInt32(kVK_ANSI_H),
    "I": UInt32(kVK_ANSI_I), "J": UInt32(kVK_ANSI_J), "K": UInt32(kVK_ANSI_K), "L": UInt32(kVK_ANSI_L),
    "M": UInt32(kVK_ANSI_M), "N": UInt32(kVK_ANSI_N), "O": UInt32(kVK_ANSI_O), "P": UInt32(kVK_ANSI_P),
    "Q": UInt32(kVK_ANSI_Q), "R": UInt32(kVK_ANSI_R), "S": UInt32(kVK_ANSI_S), "T": UInt32(kVK_ANSI_T),
    "U": UInt32(kVK_ANSI_U), "V": UInt32(kVK_ANSI_V), "W": UInt32(kVK_ANSI_W), "X": UInt32(kVK_ANSI_X),
    "Y": UInt32(kVK_ANSI_Y), "Z": UInt32(kVK_ANSI_Z),
    "0": UInt32(kVK_ANSI_0), "1": UInt32(kVK_ANSI_1), "2": UInt32(kVK_ANSI_2), "3": UInt32(kVK_ANSI_3),
    "4": UInt32(kVK_ANSI_4), "5": UInt32(kVK_ANSI_5), "6": UInt32(kVK_ANSI_6), "7": UInt32(kVK_ANSI_7),
    "8": UInt32(kVK_ANSI_8), "9": UInt32(kVK_ANSI_9),
    "F1": UInt32(kVK_F1), "F2": UInt32(kVK_F2), "F3": UInt32(kVK_F3), "F4": UInt32(kVK_F4),
    "F5": UInt32(kVK_F5), "F6": UInt32(kVK_F6), "F7": UInt32(kVK_F7), "F8": UInt32(kVK_F8),
    "F9": UInt32(kVK_F9), "F10": UInt32(kVK_F10), "F11": UInt32(kVK_F11), "F12": UInt32(kVK_F12),
    "SPACE": UInt32(kVK_Space), "RETURN": UInt32(kVK_Return), "ENTER": UInt32(kVK_Return),
    "TAB": UInt32(kVK_Tab), "ESCAPE": UInt32(kVK_Escape), "ESC": UInt32(kVK_Escape),
    "BACKSPACE": UInt32(kVK_Delete), "DELETE": UInt32(kVK_ForwardDelete),
    "LEFT": UInt32(kVK_LeftArrow), "RIGHT": UInt32(kVK_RightArrow),
    "UP": UInt32(kVK_UpArrow), "DOWN": UInt32(kVK_DownArrow),
    ",": UInt32(kVK_ANSI_Comma), ".": UInt32(kVK_ANSI_Period), "/": UInt32(kVK_ANSI_Slash),
    ";": UInt32(kVK_ANSI_Semicolon), "'": UInt32(kVK_ANSI_Quote), "[": UInt32(kVK_ANSI_LeftBracket),
    "]": UInt32(kVK_ANSI_RightBracket), "\\": UInt32(kVK_ANSI_Backslash),
    "`": UInt32(kVK_ANSI_Grave), "-": UInt32(kVK_ANSI_Minus), "=": UInt32(kVK_ANSI_Equal),
  ]

  /// PURE. Electron-style accelerator -> (virtual key code, Carbon modifier mask).
  /// Returns nil for an unknown key, a missing key, or NO modifier — a modifier-less global hot key
  /// would swallow a bare letter system-wide, so we refuse to register one.
  static func parse(_ accelerator: String) -> (keyCode: UInt32, modifiers: UInt32)? {
    var modifiers: UInt32 = 0
    var key: String?
    for rawPart in accelerator.split(separator: "+", omittingEmptySubsequences: false) {
      let part = rawPart.trimmingCharacters(in: .whitespaces)
      if part.isEmpty { continue }
      switch part.uppercased() {
      case "CMD", "COMMAND", "META", "SUPER", "COMMANDORCONTROL", "CMDORCTRL":
        modifiers |= UInt32(cmdKey)
      case "SHIFT":
        modifiers |= UInt32(shiftKey)
      case "ALT", "OPTION":
        modifiers |= UInt32(optionKey)
      case "CTRL", "CONTROL":
        modifiers |= UInt32(controlKey)
      default:
        if key != nil { return nil }            // two non-modifier keys is not an accelerator
        key = part
      }
    }
    guard modifiers != 0, let key, let code = keyCodes[key.uppercased()] else { return nil }
    return (code, modifiers)
  }
}
```

- [ ] **Step 7: Run the self-test and see it pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run tools/agent-selftest.test.ts
```

Expected: `1 passed`. Run the binary directly to read the assertions:

```sh
./agents/macos/build/cairn-agent-selftest
```

Expected: 9 `ok   - …` lines then `ALL PASS`.

- [ ] **Step 8: Commit.**

```sh
git add agents/macos/Sources/Hotkey.swift agents/macos/Tests/SelfTest.swift tools/agent-selftest.test.ts
git commit -m "test(agent-macos): swiftc self-test harness and the accelerator parser"
```

- [ ] **Step 9: Write the failing assertions for the wire layer — encoder, line framing, suspend ledger.**

Append to `runAssertions()` in `agents/macos/Tests/SelfTest.swift`, immediately before the closing
brace:

```swift
    // 2. the encoder configuration, which is what makes recorded transcripts diffable.
    //    NOTE the argument order: the generator sorts struct fields alphabetically, so `Rep` is
    //    (byteLength:inline:mime:repId:sha256:uti:) and `RepChunkData` is (b64:final:repId:seq:).
    //    `inline` and `b64` are `Data`, and JSONEncoder base64s them — no base64 call by hand.
    let inlineRep = Rep(byteLength: 2, inline: Data("hi".utf8), mime: "text/plain",
                        repId: nil, sha256: "sha256-fake", uti: "public.utf8-plain-text")
    let json = String(decoding: Out.encode(inlineRep)!, as: UTF8.self)
    expect(!json.contains("repId"), "an inline rep omits repId entirely rather than sending null")
    // 0xFFFFFF base64-encodes to "////", so this payload is the only honest test of the slash rule.
    let slashy = String(decoding: Out.encode(RepChunkData(b64: Data([0xFF, 0xFF, 0xFF]), final: true, repId: "r1", seq: 0))!, as: UTF8.self)
    expectEqual(slashy, "{\"b64\":\"////\",\"final\":true,\"repId\":\"r1\",\"seq\":0}",
                "base64 slashes are not escaped into \\/, which would inflate every chunk line")
    expectEqual(
      String(decoding: Out.encode(RepChunkData(b64: Data("hi".utf8), final: true, repId: "r1", seq: 0))!, as: UTF8.self),
      "{\"b64\":\"aGk=\",\"final\":true,\"repId\":\"r1\",\"seq\":0}",
      "keys are sorted, so two recordings of the same session are byte-identical")

    // 3. the suspend/resume ledger
    var reasons = SuspendReasons()
    expect(reasons.add("sleep"), "the first reason suspends the timer")
    expect(!reasons.add("sleep"), "the same reason twice does not suspend twice")
    expect(!reasons.add("session-inactive"), "a second reason does not suspend an already-suspended timer")
    expect(!reasons.remove("session-inactive"), "dropping one of two reasons does not resume")
    expect(reasons.remove("sleep"), "dropping the last reason resumes")
    expect(!reasons.remove("sleep"), "an unmatched resume is refused, because over-resuming traps the process")
    expect(!reasons.isSuspended, "the ledger is empty again")
    expect(!reasons.drain(), "draining an empty ledger needs no resume")
    _ = reasons.add("sleep")
    expect(reasons.drain(), "draining a suspended ledger tells the caller to resume once before cancel")

    // 4. line framing
    var splitter = LineSplitter()
    expectEqual(splitter.push(Data("{\"a\":1}\n{\"b\"".utf8)).count, 1, "a chunk ending mid-line yields only the complete line")
    expectEqual(
      splitter.push(Data(":2}\n".utf8)).map { String(decoding: $0, as: UTF8.self) },
      ["{\"b\":2}"],
      "the rest of the line arrives on the next chunk")
    var utf8Splitter = LineSplitter()
    let emoji = Array("{\"s\":\"🪨\"}\n".utf8)
    expectEqual(utf8Splitter.push(Data(emoji[0..<8])).count, 0, "a chunk split inside a multi-byte character yields nothing yet")
    expectEqual(
      utf8Splitter.push(Data(emoji[8...])).map { String(decoding: $0, as: UTF8.self) },
      ["{\"s\":\"🪨\"}"],
      "the character is decoded only once both halves have arrived")
    var guardSplitter = LineSplitter()
    _ = guardSplitter.push(Data(repeating: 0x41, count: MAX_LINE_BYTES + 1))
    expectEqual(guardSplitter.droppedOverlongLines, 1, "an unterminated line over 1 MiB is dropped, not buffered")
    var emptySplitter = LineSplitter()
    expectEqual(emptySplitter.push(Data("\n\n".utf8)).count, 0, "empty lines are ignored")
```

- [ ] **Step 10: Run it and see the named failure.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run tools/agent-selftest.test.ts
```

Expected: FAIL with `error: cannot find 'Out' in scope`, `error: cannot find 'SuspendReasons' in
scope`, `error: cannot find 'LineSplitter' in scope` and `error: cannot find 'MAX_LINE_BYTES' in
scope` — the last one because `MAX_LINE_BYTES` is declared in `Wire.swift`, not in the generated
protocol file.

- [ ] **Step 11: Implement the wire layer.**

Create `agents/macos/Sources/Wire.swift`:

```swift
import Darwin
import Foundation

// MARK: - the frozen numeric limits

/// AgentProtocol.generated.swift emits `protocolVersion` and the wire TYPES and nothing else: a zod
/// schema has nowhere to hang a bare number, so the generator has none to emit. These six mirror
/// packages/protocol/src/constants.ts exactly, and the second `it()` in tools/agent-selftest.test.ts
/// reads both files and fails if a literal here drifts from the TypeScript one — so the duplication
/// cannot rot. The wire major is deliberately NOT duplicated: everything below uses the generated
/// `protocolVersion`.
let CHUNK_THRESHOLD_BYTES = 65_536
let CHUNK_PAYLOAD_BYTES = 32_768
let MAX_REP_BYTES = 20_971_520
let MAX_LINE_BYTES = 1_048_576
let AGENT_REQUEST_TIMEOUT_MS = 2_000
let WATCH_INTERVAL_MS = 500

// MARK: - envelopes (structural; every payload type comes from AgentProtocol.generated.swift)

/// Just enough of a request to route it. The typed params are decoded in a second pass, which is
/// how one Codable pass per method stays possible without a hand-written enum of param types.
struct RequestHead: Decodable {
  let v: Int
  let t: String
  let id: String
  let method: String
}

struct Request<P: Decodable>: Decodable {
  let id: String
  let params: P
}

struct ResponseOk<R: Encodable>: Encodable {
  let v = protocolVersion
  let t = "res"
  let id: String
  let ok = true
  let result: R
}

struct WireError: Encodable {
  let code: String
  let message: String
}

struct ResponseErr: Encodable {
  let v = protocolVersion
  let t = "res"
  let id: String
  let ok = false
  let error: WireError
}

struct Event<D: Encodable>: Encodable {
  let v = protocolVersion
  let t = "ev"
  let event: String
  let data: D
}

// MARK: - stdout, one line per object, serialised

enum Out {
  /// `.sortedKeys` is contract (§2): JSONEncoder is otherwise order-nondeterministic across runs,
  /// which would make recorded transcripts undiffable. `.withoutEscapingSlashes` keeps a base64
  /// chunk line at the length the contract measured instead of inflating every `/` into `\/`.
  private static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  /// One dedicated queue so two threads can never interleave halves of a line on the pipe.
  private static let queue = DispatchQueue(label: "app.cairn.agent.stdout")

  /// Exposed so the self-test can assert the encoder's configuration without capturing stdout.
  static func encode<T: Encodable>(_ value: T) -> Data? { try? encoder.encode(value) }

  static func line<T: Encodable>(_ value: T) {
    guard var data = encode(value) else {
      stderrLine("cairn-agent: encode failed for \(T.self)")
      return
    }
    data.append(0x0A)
    queue.sync { writeAll(data) }
  }

  static func ok<R: Encodable>(id: String, _ result: R) { line(ResponseOk(id: id, result: result)) }

  static func fail(id: String, code: String, message: String) {
    line(ResponseErr(id: id, error: WireError(code: code, message: message)))
  }

  static func event<D: Encodable>(_ name: String, _ data: D) { line(Event(event: name, data: data)) }

  /// The agent's own log channel. Metadata only — never a byte of clipboard content. The host keeps
  /// `level` and `event` and drops `fields`, because the agent is not trusted to police them.
  ///
  /// `level` is the generated `LogDataLevel` enum, not a String, so a typo'd level is a compile error.
  /// `fields` is `[String: AgentLogValue]`, and `AgentLogValue` is a CLOSED union of
  /// string/number/bool/null with no `.object` and no `.array` case — there is no shape in which a
  /// clipboard payload or a nested bag can be handed to this function (spec §11 control 2, the Swift
  /// half of it). Note the field order: the generator sorts, so it is `LogData(event:fields:level:)`.
  static func log(_ level: LogDataLevel, _ event: String, _ fields: [String: AgentLogValue] = [:]) {
    line(Event(event: "log", data: LogData(event: event, fields: fields, level: level)))
  }

  static func stderrLine(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
  }

  private static func writeAll(_ data: Data) {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      guard let base = raw.baseAddress else { return }
      var off = 0
      while off < raw.count {
        let n = Darwin.write(1, base.advanced(by: off), raw.count - off)
        if n > 0 {
          off += n
        } else if errno == EINTR {
          continue
        } else {
          // stdout is gone: the host died. There is nothing left to log to, so leave a breadcrumb
          // on stderr and exit.
          stderrLine("cairn-agent: stdout closed (errno \(errno)); exiting")
          exit(70)
        }
      }
    }
  }
}

// MARK: - poll suspension bookkeeping

/// PURE. Reason-keyed suspend bookkeeping for the poll timer. Over-resuming a DispatchSource traps
/// the process, and sleep and session-switch notifications overlap in practice, so the "should I
/// actually call suspend()/resume() now?" decision lives here where it can be asserted.
struct SuspendReasons {
  private var reasons = Set<String>()

  /// True only when the caller should now call `timer.suspend()`.
  mutating func add(_ reason: String) -> Bool {
    if reasons.contains(reason) { return false }
    let wasEmpty = reasons.isEmpty
    reasons.insert(reason)
    return wasEmpty
  }

  /// True only when the caller should now call `timer.resume()`.
  mutating func remove(_ reason: String) -> Bool {
    guard reasons.contains(reason) else { return false }
    reasons.remove(reason)
    return reasons.isEmpty
  }

  var isSuspended: Bool { !reasons.isEmpty }

  /// True when the caller must resume once before cancelling.
  mutating func drain() -> Bool {
    let wasSuspended = isSuspended
    reasons.removeAll()
    return wasSuspended
  }
}

// MARK: - stdin, whole lines only

/// PURE. Bytes in, whole lines out. Kept out of the read loop so it can be asserted with no pipe: a
/// multi-byte UTF-8 character split across two chunks must never be decoded half-way, and an
/// unterminated line longer than the guard is a memory attack rather than a message.
struct LineSplitter {
  private var buf = Data()
  /// Counts lines dropped for exceeding MAX_LINE_BYTES, so the caller can log the fact once.
  private(set) var droppedOverlongLines = 0

  mutating func push(_ chunk: Data) -> [Data] {
    buf.append(chunk)
    var lines: [Data] = []
    while let nl = buf.firstIndex(of: 0x0A) {
      let line = buf.subdata(in: buf.startIndex..<nl)
      buf.removeSubrange(buf.startIndex...nl)
      if line.count > MAX_LINE_BYTES {
        droppedOverlongLines += 1
        continue
      }
      if !line.isEmpty { lines.append(line) }
    }
    if buf.count > MAX_LINE_BYTES {
      droppedOverlongLines += 1
      buf.removeAll(keepingCapacity: false)
    }
    return lines
  }
}

enum In {
  /// Blocking read loop on fd 0. All the framing logic lives in LineSplitter.
  static func readLines(_ onLine: (Data) -> Void) {
    var splitter = LineSplitter()
    var reportedDrops = 0
    var chunk = [UInt8](repeating: 0, count: 65_536)
    while true {
      let n = chunk.withUnsafeMutableBytes { Darwin.read(0, $0.baseAddress, $0.count) }
      if n == 0 { return }                       // EOF: the host closed the pipe
      if n < 0 {
        if errno == EINTR { continue }
        Out.stderrLine("cairn-agent: stdin read error \(errno)")
        return
      }
      for line in splitter.push(Data(chunk[0..<n])) { onLine(line) }
      if splitter.droppedOverlongLines > reportedDrops {
        reportedDrops = splitter.droppedOverlongLines
        Out.log(.warn, "line.too-long", ["count": .number(Double(reportedDrops))])
      }
    }
  }
}
```

Now that `Wire.swift` exists, append the constant drift guard to `tools/agent-selftest.test.ts`. Add
`readFileSync` to the `node:fs` import and this import above the vitest one:

```ts
import {
  AGENT_REQUEST_TIMEOUT_MS,
  CHUNK_PAYLOAD_BYTES,
  CHUNK_THRESHOLD_BYTES,
  MAX_LINE_BYTES,
  MAX_REP_BYTES,
  WATCH_INTERVAL_MS,
} from '@cairn/protocol'
```

then append, after the closing `})` of the `describe`:

```ts
/**
 * AgentProtocol.generated.swift carries `protocolVersion` and the wire TYPES and nothing else — a zod
 * schema has nowhere to hang a bare number — so Wire.swift declares the six numeric limits it needs as
 * top-level `let`s. This is the guard that stops that duplication rotting: it reads the frozen
 * TypeScript constants and asserts the Swift literal for each one is present, spelled with Swift
 * underscore digit separators. It needs no compiler and no pasteboard, so it runs on every platform.
 */
it('the Swift agent declares the same numeric limits as @cairn/protocol', () => {
  const wire = readFileSync(join(SOURCES_DIR, 'Wire.swift'), 'utf8')
  const swiftLiteral = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_')
  const expected: ReadonlyArray<readonly [string, number]> = [
    ['CHUNK_THRESHOLD_BYTES', CHUNK_THRESHOLD_BYTES],
    ['CHUNK_PAYLOAD_BYTES', CHUNK_PAYLOAD_BYTES],
    ['MAX_REP_BYTES', MAX_REP_BYTES],
    ['MAX_LINE_BYTES', MAX_LINE_BYTES],
    ['AGENT_REQUEST_TIMEOUT_MS', AGENT_REQUEST_TIMEOUT_MS],
    ['WATCH_INTERVAL_MS', WATCH_INTERVAL_MS],
  ]
  const wrong = expected
    .filter(([name, value]) => !wire.includes(`let ${name} = ${swiftLiteral(value)}\n`))
    .map(([name, value]) => `${name} should be declared as ${swiftLiteral(value)}`)
  expect(wrong).toEqual([])
  // The wire major is NOT duplicated: it comes from the generated file as `protocolVersion`.
  expect(wire).not.toContain('WIRE_MAJOR')
})
```

`swiftLiteral(500)` is `500` and `swiftLiteral(20971520)` is `20_971_520` — exactly how both
`packages/protocol/src/constants.ts` and `Wire.swift` spell them.

- [ ] **Step 12: Run the self-test and see 27 assertions pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run tools/agent-selftest.test.ts
./agents/macos/build/cairn-agent-selftest | tail -3
```

Expected: `2 passed` (the swiftc self-test and the constant drift guard), and the binary's last line is
`ALL PASS`. Prove the drift guard can fail before moving on:

```sh
sed -i '' 's/^let MAX_LINE_BYTES = 1_048_576$/let MAX_LINE_BYTES = 2_097_152/' agents/macos/Sources/Wire.swift
npx vitest run tools/agent-selftest.test.ts
git checkout agents/macos/Sources/Wire.swift 2>/dev/null || sed -i '' 's/^let MAX_LINE_BYTES = 2_097_152$/let MAX_LINE_BYTES = 1_048_576/' agents/macos/Sources/Wire.swift
npx vitest run tools/agent-selftest.test.ts
```

Expected: FAIL with
`AssertionError: expected [ 'MAX_LINE_BYTES should be decla…' ] to deeply equal []`, then `2 passed`
again after the revert.

- [ ] **Step 13: Commit.**

```sh
git add agents/macos/Sources/Wire.swift agents/macos/Tests/SelfTest.swift tools/agent-selftest.test.ts
git commit -m "feat(agent-macos): NDJSON envelopes, sorted-key stdout writer, line splitter, suspend ledger"
```

- [ ] **Step 14: Write the failing assertions for the read core — hint UTIs, the UTI allowlist, TIFF→PNG, contentHash, the concealed rule, the wedged-read policy.**

Append to `runAssertions()`:

```swift
    // 5. the UTI -> mime allowlist
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.utf8-plain-text", "NSStringPboardType"]).map(\.mime),
      ["text/plain"],
      "a plain-text item yields exactly one text/plain plan and ignores the legacy alias")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.png", "public.tiff"]).map(\.mime),
      ["image/png"],
      "png wins over tiff, and only one image rep is planned")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.tiff", "com.adobe.pdf"]).first?.tiffToPng,
      true,
      "a tiff-only item is planned as a TIFF->PNG conversion")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.tiff", "com.adobe.pdf"]).map(\.mime),
      ["image/png"],
      "tiff wins over pdf")
    expectEqual(
      RepFilter.plan(forItemTypes: ["dyn.ah62d4rv4gu8zg55mrrxg23petzxg", "public.utf8-plain-text"]).map(\.uti),
      ["public.utf8-plain-text"],
      "a dyn.* UTI is never read")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.utf8-plain-text", "org.chromium.source-url"]).map(\.mime),
      ["text/plain", "text/x-source-url"],
      "Chrome's source-url rides alongside the text, in that order")
    expectEqual(
      RepFilter.plan(forItemTypes: [HintUTI.concealed, "public.utf8-plain-text"]).map(\.mime),
      ["text/plain"],
      "the hint UTIs are markers, never representations")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.utf8-plain-text", "public.html", "public.rtf", "public.file-url"]).map(\.mime),
      ["text/plain", "text/html", "text/rtf", "text/uri-list"],
      "the plan order is frozen so two machines hash the same copy identically")

    // 6. the concealed decision — the single most important branch in this file
    expect(!Pasteboard.mayReadBytes(hints: [.concealed]), "a concealed hint forbids reading any byte")
    expect(!Pasteboard.mayReadBytes(hints: [.transient, .concealed]), "concealed wins over other hints")
    expect(Pasteboard.mayReadBytes(hints: [.transient]), "a transient hint alone still allows reading")
    expect(Pasteboard.mayReadBytes(hints: []), "no hint allows reading")

    // 7. the wedged-read escalation policy
    expectEqual(ReadWatchdog.decide(elapsedMs: 1_999, strikes: 0), .ignore, "a read under 2 s is not wedged")
    expectEqual(ReadWatchdog.decide(elapsedMs: 2_001, strikes: 0), .warn, "the first strike over 2 s only warns")
    expectEqual(ReadWatchdog.decide(elapsedMs: 2_001, strikes: 1), .killProcess, "the second strike kills the process so the host restarts it")
    expectEqual(ReadWatchdog.decide(elapsedMs: 60_000, strikes: 0), .warn, "even a very long first strike only warns once")

    // 8. content hash, identical to @cairn/protocol's contentHash()
    expectEqual(
      contentHash(Data("hello".utf8)),
      "sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ",
      "contentHash matches the TypeScript vector for 'hello'")
    expectEqual(
      contentHash(Data("hello world".utf8)),
      "sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek",
      "contentHash matches the transcript fixture vector for 'hello world'")
    expectEqual(contentHash(Data()).count, 7 + 43, "a content hash is always sha256- plus 43 chars")

    // 9. TIFF -> PNG, which happens at capture so nothing downstream ever sees a TIFF
    let tiff = makeTiff(width: 8, height: 6)
    expectEqual(Array(tiff.prefix(2)), [77, 77], "the input really is a TIFF (MM big-endian magic)")
    guard let png = RepFilter.tiffToPng(tiff) else { return expect(false, "TIFF converts to PNG") }
    expectEqual(Array(png.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10], "the converted bytes carry the PNG magic number")
    expect(RepFilter.tiffToPng(Data("not an image".utf8)) == nil, "garbage does not convert")
```

And add this helper inside `struct SelfTest`, after `runAssertions()`. It builds a TIFF with no
window server and no `NSApplication`, using a deterministic LCG so the PNG cannot compress away to
nothing:

```swift
  static func makeTiff(width: Int, height: Int) -> Data {
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: width * 4, bitsPerPixel: 32)!
    var seed: UInt32 = 0x9E37_79B9
    let plane = rep.bitmapData!
    for i in 0..<(width * height * 4) {
      seed = seed &* 1_664_525 &+ 1_013_904_223
      plane[i] = UInt8((seed >> 16) & 0xFF)
    }
    return rep.tiffRepresentation!
  }
```

- [ ] **Step 15: Run it and see the named failure.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && npx vitest run tools/agent-selftest.test.ts
```

Expected: FAIL with `error: cannot find 'RepFilter' in scope`, `error: cannot find 'HintUTI' in
scope`, `error: cannot find 'Pasteboard' in scope`, `error: cannot find 'ReadWatchdog' in scope`,
`error: cannot find 'contentHash' in scope`.

- [ ] **Step 16: Implement the pasteboard file.**

Create `agents/macos/Sources/Pasteboard.swift`. It will not compile on its own — `Pasteboard.read()`
calls `Chunker.prepare`, which is Step 17 — so the green run comes after both files exist.

```swift
import AppKit
import CryptoKit
import Foundation

/// The three nspasteboard.org marker UTIs. Mirrors UTI_CONCEALED / UTI_TRANSIENT /
/// UTI_AUTO_GENERATED in packages/protocol/src/constants.ts — these are third-party well-known
/// strings rather than Cairn names, so both sides of the pipe spell them out.
enum HintUTI {
  static let concealed = "org.nspasteboard.ConcealedType"
  static let transient = "org.nspasteboard.TransientType"
  static let autoGenerated = "org.nspasteboard.AutoGeneratedType"
  static let all = [concealed, transient, autoGenerated]
}

/// UTI -> MIME allowlist. Anything not listed here is never read: an allowlist means a new OS UTI
/// cannot silently start flowing bytes into the history.
enum RepFilter {
  static let plainText = "public.utf8-plain-text"
  static let html = "public.html"
  static let rtf = "public.rtf"
  static let fileURL = "public.file-url"
  static let png = "public.png"
  static let tiff = "public.tiff"
  static let pdf = "com.adobe.pdf"
  static let chromeSourceURL = "org.chromium.source-url"

  struct Plan: Equatable {
    let uti: String
    /// The mime we publish. For `public.tiff` this is `image/png`, because we convert at capture.
    let mime: String
    /// True only for public.tiff: the bytes are transcoded before they leave the agent.
    let tiffToPng: Bool
  }

  /// PURE. Given ONE pasteboard item's UTIs in the order the OS offered them, returns what to read
  /// from that item, in the frozen order. Image preference is png > tiff > pdf, per spec §10: a
  /// promised `public.tiff` from Photoshop renders synchronously and can block, balloon, or come
  /// back nil.
  static func plan(forItemTypes types: [String]) -> [Plan] {
    let has = Set(types)
    var out: [Plan] = []
    if has.contains(plainText) { out.append(Plan(uti: plainText, mime: "text/plain", tiffToPng: false)) }
    if has.contains(html) { out.append(Plan(uti: html, mime: "text/html", tiffToPng: false)) }
    if has.contains(rtf) { out.append(Plan(uti: rtf, mime: "text/rtf", tiffToPng: false)) }
    if has.contains(fileURL) { out.append(Plan(uti: fileURL, mime: "text/uri-list", tiffToPng: false)) }
    if has.contains(png) {
      out.append(Plan(uti: png, mime: "image/png", tiffToPng: false))
    } else if has.contains(tiff) {
      out.append(Plan(uti: tiff, mime: "image/png", tiffToPng: true))
    } else if has.contains(pdf) {
      out.append(Plan(uti: pdf, mime: "application/pdf", tiffToPng: false))
    }
    if has.contains(chromeSourceURL) {
      out.append(Plan(uti: chromeSourceURL, mime: "text/x-source-url", tiffToPng: false))
    }
    return out
  }

  /// PURE. TIFF -> PNG. Runs with no window server and no NSApplication.
  static func tiffToPng(_ data: Data) -> Data? {
    guard let rep = NSBitmapImageRep(data: data) else { return nil }
    return rep.representation(using: .png, properties: [:])
  }
}

/// PURE. `sha256-<43 chars base64url>`, byte-identical to @cairn/protocol's contentHash().
func contentHash(_ bytes: Data) -> String {
  let digest = Data(SHA256.hash(data: bytes))
  let b64 = digest.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
  return "sha256-" + b64
}

/// A wedged promised read cannot be cancelled from inside the process, so the watchdog escalates to
/// the only lever that exists: exit, and let @cairn/agent-host restart us with backoff (spec §10).
enum ReadWatchdog {
  enum Action: Equatable { case ignore, warn, killProcess }

  private static let lock = NSLock()
  private static var startedAt: DispatchTime?
  private static var strikes = 0
  private static var timer: DispatchSourceTimer?

  /// PURE. The whole escalation policy, so it can be asserted without wedging a real pasteboard.
  static func decide(elapsedMs: Int, strikes: Int) -> Action {
    if elapsedMs <= AGENT_REQUEST_TIMEOUT_MS { return .ignore }
    return strikes + 1 >= 2 ? .killProcess : .warn
  }

  static func begin() { lock.lock(); startedAt = .now(); lock.unlock() }
  static func end() { lock.lock(); startedAt = nil; strikes = 0; lock.unlock() }

  static func start() {
    let q = DispatchQueue(label: "app.cairn.agent.watchdog")
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500), leeway: .milliseconds(100))
    t.setEventHandler { check() }
    t.activate()
    timer = t
  }

  private static func check() {
    lock.lock()
    let began = startedAt
    let seen = strikes
    lock.unlock()
    guard let began else { return }
    let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - began.uptimeNanoseconds) / 1_000_000)
    switch decide(elapsedMs: elapsedMs, strikes: seen) {
    case .ignore:
      return
    case .warn:
      lock.lock(); strikes += 1; lock.unlock()
      Out.log(.warn, "pasteboard.read-wedged", ["elapsedMs": .number(Double(elapsedMs))])
    case .killProcess:
      Out.log(.error, "pasteboard.read-wedged-fatal", ["elapsedMs": .number(Double(elapsedMs))])
      Out.stderrLine("cairn-agent: pasteboard read wedged for \(elapsedMs)ms; exiting 75 so the host restarts us")
      exit(75)
    }
  }
}

/// Frontmost app, cached. NSWorkspace notifications arrive on main and are marshalled onto the
/// pasteboard queue (spec §4 thread discipline), so a read never touches NSWorkspace itself.
enum Frontmost {
  private static let lock = NSLock()
  private static var bundleId: String?
  private static var name: String?

  static func snapshot() -> (bundleId: String?, name: String?) {
    lock.lock(); defer { lock.unlock() }
    return (bundleId, name)
  }

  private static func set(_ app: NSRunningApplication?) {
    lock.lock()
    bundleId = app?.bundleIdentifier
    name = app?.localizedName
    lock.unlock()
  }

  /// MUST be called on the main thread.
  static func startObserving() {
    set(NSWorkspace.shared.frontmostApplication)
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { note in
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      Pasteboard.queue.async { set(app) }
    }
  }
}

enum Pasteboard {
  /// THE one queue. Every NSPasteboard call in this process happens here and nowhere else:
  /// NSPasteboard's thread safety is undocumented by Apple and is a known crash and stale-read
  /// source.
  static let queue = DispatchQueue(label: "app.cairn.agent.pasteboard")

  private static let hintTypes = HintUTI.all.map { NSPasteboard.PasteboardType($0) }

  static func changeCount() -> Int { NSPasteboard.general.changeCount }

  /// Probes the marker UTIs BEFORE any byte is read. Reading first would defeat the entire point:
  /// the bytes of a concealed item must never enter this process at all.
  static func probeHints() -> [Hint] {
    let pb = NSPasteboard.general
    guard pb.availableType(from: hintTypes) != nil else { return [] }   // one cheap call, usually nil
    var hints: [Hint] = []
    if pb.availableType(from: [NSPasteboard.PasteboardType(HintUTI.concealed)]) != nil { hints.append(.concealed) }
    if pb.availableType(from: [NSPasteboard.PasteboardType(HintUTI.transient)]) != nil { hints.append(.transient) }
    if pb.availableType(from: [NSPasteboard.PasteboardType(HintUTI.autoGenerated)]) != nil { hints.append(.autoGenerated) }
    return hints
  }

  /// PURE. The one place that decides whether bytes may be read at all.
  static func mayReadBytes(hints: [Hint]) -> Bool { !hints.contains(.concealed) }

  struct ReadOutcome {
    let changeCount: Int
    let hints: [Hint]
    let reps: [Rep]
    let streams: [Chunker.Stream]
  }

  /// MUST run on `queue`. One explicit autorelease pool per read: NSPasteboard hands back
  /// autoreleased NSData, and a command-line process has no per-event-loop pool to drain them.
  static func read() -> ReadOutcome {
    autoreleasepool {
      let pb = NSPasteboard.general
      let cc = pb.changeCount
      let hints = probeHints()
      guard mayReadBytes(hints: hints) else {
        Out.log(.info, "pasteboard.concealed-skipped", ["changeCount": .number(Double(cc))])
        return ReadOutcome(changeCount: cc, hints: hints, reps: [], streams: [])
      }

      ReadWatchdog.begin()
      defer { ReadWatchdog.end() }

      var reps: [Rep] = []
      var streams: [Chunker.Stream] = []
      var seenMimes = Set<String>()
      var fileURLs: [String] = []
      var skipped = 0

      // pb.pasteboardItems, never pb.types: [verified] on this machine a single copied string
      // reports `["public.utf8-plain-text"]` per item but `["public.utf8-plain-text",
      // "NSStringPboardType"]` from pb.types, and persisting that alias would fabricate a
      // representation the source app never offered.
      for item in pb.pasteboardItems ?? [] {
        let offered = item.types.map(\.rawValue)
        for plan in RepFilter.plan(forItemTypes: offered) {
          if plan.uti == RepFilter.fileURL {
            if let s = item.string(forType: NSPasteboard.PasteboardType(RepFilter.fileURL)) {
              fileURLs.append(s)
            }
            continue
          }
          if seenMimes.contains(plan.mime) { continue }
          guard var bytes = item.data(forType: NSPasteboard.PasteboardType(plan.uti)) else {
            // A promised representation whose owner has quit renders as nil. Not an error.
            Out.log(.info, "pasteboard.rep-nil", ["uti": .string(plan.uti)])
            continue
          }
          if plan.tiffToPng {
            guard let png = RepFilter.tiffToPng(bytes) else {
              Out.log(.warn, "pasteboard.tiff-convert-failed", ["bytes": .number(Double(bytes.count))])
              continue
            }
            bytes = png
          }
          if bytes.count > MAX_REP_BYTES {
            Out.log(.warn, "pasteboard.rep-too-large", ["mime": .string(plan.mime), "bytes": .number(Double(bytes.count))])
            skipped += 1
            continue
          }
          seenMimes.insert(plan.mime)
          let prepared = Chunker.prepare(mime: plan.mime, uti: plan.uti, bytes: bytes)
          reps.append(prepared.rep)
          if let s = prepared.stream { streams.append(s) }
        }
      }

      if !fileURLs.isEmpty, !seenMimes.contains("text/uri-list") {
        // One URI per line, LF-terminated including the last. @cairn/capture canonicalises it.
        let bytes = Data((fileURLs.map { $0 + "\n" }.joined()).utf8)
        let prepared = Chunker.prepare(mime: "text/uri-list", uti: RepFilter.fileURL, bytes: bytes)
        reps.append(prepared.rep)
        if let s = prepared.stream { streams.append(s) }
      }

      if skipped > 0 { Out.log(.warn, "pasteboard.reps-skipped", ["count": .number(Double(skipped))]) }
      return ReadOutcome(changeCount: cc, hints: hints, reps: reps, streams: streams)
    }
  }
}
```

- [ ] **Step 17: Write the failing assertions for chunking, then implement the chunker.**

Append to `runAssertions()`:

```swift
    // 10. chunk splitting. `Chunker.split` returns RAW `[Data]`, because RepChunkData.b64 is `Data`
    //     and JSONEncoder base64s it on the way out — nothing here calls a base64 API for a payload.
    let big = Data(repeating: 0x5A, count: 200_000)
    let chunks = Chunker.split(big)
    expectEqual(chunks.count, 7, "200 000 bytes split into 7 chunks of at most 32 768")
    expectEqual(chunks[0].count, 32_768, "one full chunk carries exactly 32 768 raw bytes")
    expectEqual(chunks[6].count, 3_392, "the last chunk carries the 3 392-byte remainder")
    expectEqual(
      chunks[0].base64EncodedString().count,
      43_692,
      "32 768 raw bytes become exactly 43 692 base64 characters on the wire, under Node's 64 KiB pipe watermark")
    expectEqual(
      chunks.reduce(0) { $0 + $1.count },
      200_000,
      "the chunks account for exactly the input length")
    expect(Data(chunks.joined()) == big, "the chunks reassemble byte-for-byte")
    expectEqual(Chunker.split(Data()).count, 0, "an empty representation produces no chunks")

    // 11. the inline / stream threshold, which must match CHUNK_THRESHOLD_BYTES exactly
    let small = Chunker.prepare(mime: "text/plain", uti: "public.utf8-plain-text", bytes: Data(repeating: 0x41, count: 65_535))
    expect(small.rep.inline != nil && small.rep.repId == nil && small.stream == nil, "65 535 bytes travel inline")
    let large = Chunker.prepare(mime: "text/plain", uti: "public.utf8-plain-text", bytes: Data(repeating: 0x41, count: 65_536))
    expect(large.rep.inline == nil && large.rep.repId != nil && large.stream != nil, "65 536 bytes travel as a stream")
    expectEqual(large.stream?.payloads.count, 2, "65 536 bytes is exactly two chunks")
    expectEqual(large.rep.sha256, contentHash(Data(repeating: 0x41, count: 65_536)), "a streamed rep declares the hash of the whole representation")
```

Then create `agents/macos/Sources/Chunker.swift`:

```swift
import Foundation

/// Representations at or over 64 KiB are streamed over the SAME stdout pipe as `rep.chunk` events.
/// There is no other path. The agent never opens a file for clipboard bytes — no spool, no temp, no
/// cache (spec §11 control 1). The only sink in this file is stdout. If you are about to reach for
/// anything in the filesystem API here, stop: that is the vulnerability this design removed.
enum Chunker {
  struct Stream {
    let repId: String
    /// At most CHUNK_PAYLOAD_BYTES RAW bytes each, in order. `RepChunkData.b64` is `Data`, so
    /// JSONEncoder base64-encodes each payload on the way out and nothing here touches a base64 API.
    let payloads: [Data]
  }

  private static let lock = NSLock()
  private static var counter = 0

  static func nextRepId() -> String {
    lock.lock(); defer { lock.unlock() }
    counter += 1
    return "r\(counter)"
  }

  /// PURE. Splits raw bytes into slices of at most `payloadBytes` RAW bytes each. `Data(...)` is a
  /// real copy rather than a slice, so each payload's own indices start at 0 and the encoder cannot
  /// be confused by a non-zero `startIndex`.
  /// 32 768 raw bytes base64-encode to exactly 43 692 characters, so one chunk line stays under
  /// Node's 64 KiB default pipe highWaterMark and far under MAX_LINE_BYTES.
  static func split(_ bytes: Data, payloadBytes: Int = CHUNK_PAYLOAD_BYTES) -> [Data] {
    var out: [Data] = []
    var offset = bytes.startIndex
    while offset < bytes.endIndex {
      let end = min(bytes.index(offset, offsetBy: payloadBytes, limitedBy: bytes.endIndex) ?? bytes.endIndex, bytes.endIndex)
      out.append(Data(bytes[offset..<end]))
      offset = end
    }
    return out
  }

  /// Builds the wire Rep. Under the threshold the bytes ride inline on the declaring line; at or
  /// over it they become a Stream the caller MUST emit AFTER the declaring line.
  ///
  /// Note the argument order: the generator sorts fields alphabetically, so it is
  /// `Rep(byteLength:inline:mime:repId:sha256:uti:)`, and `inline` is `Data` — the raw bytes go
  /// straight in, and JSONEncoder base64s them.
  static func prepare(mime: String, uti: String?, bytes: Data) -> (rep: Rep, stream: Stream?) {
    let hash = contentHash(bytes)
    if bytes.count < CHUNK_THRESHOLD_BYTES {
      return (
        Rep(byteLength: bytes.count, inline: bytes, mime: mime, repId: nil, sha256: hash, uti: uti),
        nil
      )
    }
    let repId = nextRepId()
    return (
      Rep(byteLength: bytes.count, inline: nil, mime: mime, repId: repId, sha256: hash, uti: uti),
      Stream(repId: repId, payloads: split(bytes))
    )
  }

  /// Emits every chunk of every stream. ORDER IS LOAD-BEARING: the host's reassembler only creates
  /// a stream when it sees the declaring `Rep.repId`, so a chunk emitted before its declaring line
  /// is answered with E_REP_UNKNOWN_ID and the whole representation is discarded.
  static func emit(_ streams: [Stream]) {
    for stream in streams {
      let last = stream.payloads.count - 1
      for (seq, payload) in stream.payloads.enumerated() {
        // Alphabetical labels again: RepChunkData is (b64:final:repId:seq:).
        Out.event("rep.chunk", RepChunkData(b64: payload, final: seq == last, repId: stream.repId, seq: seq))
      }
    }
  }
}
```

- [ ] **Step 18: Run the self-test and see all 60 assertions pass.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run tools/agent-selftest.test.ts
./agents/macos/build/cairn-agent-selftest | grep -c '^ok'
```

Expected: `2 passed`, and the count is `60`.

- [ ] **Step 19: Commit.**

```sh
git add agents/macos/Sources/Pasteboard.swift agents/macos/Sources/Chunker.swift agents/macos/Tests/SelfTest.swift
git commit -m "feat(agent-macos): serialised pasteboard reads, hint probe, TIFF->PNG and rep chunking"
```

- [ ] **Step 20: Add the `--mark` synthetic-pasteboard subcommand to the self-test binary.**

This is how the concealed, multi-file, TIFF and Chrome paths get exercised — and it is why the
committed transcripts are synthetic *by construction* instead of being scrubbed after the fact. No
password manager, no Finder, no screenshot of your actual screen.

In `agents/macos/Tests/SelfTest.swift`, replace `static func main()` with:

```swift
  static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    if args.first == "--mark" {
      mark(args.count > 1 ? args[1] : "")
      return
    }
    runAssertions()
    print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
    exit(failures == 0 ? 0 : 1)
  }
```

and add, after `makeTiff`:

```swift
  /// Puts deliberately synthetic content with the awkward UTIs on the REAL pasteboard.
  static func mark(_ which: String) {
    let pb = NSPasteboard.general
    switch which {
    case "concealed":
      let item = NSPasteboardItem()
      item.setString("SYNTHETIC-NOT-A-REAL-SECRET", forType: .string)
      item.setData(Data(), forType: NSPasteboard.PasteboardType(HintUTI.concealed))
      pb.clearContents()
      _ = pb.writeObjects([item])
      print("marked: concealed + text, changeCount=\(pb.changeCount)")
    case "files":
      // Two paths that exist on every macOS install. Both facts below were measured: a file URL for
      // a path that does NOT exist is dropped from the pasteboard entirely, and a writer that exits
      // immediately after writeObjects can leave a foreign reader seeing only the first item.
      pb.clearContents()
      _ = pb.writeObjects([URL(fileURLWithPath: "/bin/ls") as NSURL, URL(fileURLWithPath: "/bin/cat") as NSURL])
      print("marked: two file urls, changeCount=\(pb.changeCount)")
    case "tiff":
      let item = NSPasteboardItem()
      item.setData(makeTiff(width: 200, height: 200), forType: NSPasteboard.PasteboardType(RepFilter.tiff))
      pb.clearContents()
      _ = pb.writeObjects([item])
      print("marked: tiff only, changeCount=\(pb.changeCount)")
    case "chrome":
      let item = NSPasteboardItem()
      item.setString("synthetic copied text", forType: .string)
      item.setString("https://example.com/page", forType: NSPasteboard.PasteboardType(RepFilter.chromeSourceURL))
      pb.clearContents()
      _ = pb.writeObjects([item])
      print("marked: text + chromium source-url, changeCount=\(pb.changeCount)")
    default:
      print("usage: cairn-agent-selftest --mark concealed|files|tiff|chrome")
      exit(2)
    }
    // Do not exit instantly: a pasteboard write is asynchronous to the pasteboard server.
    Thread.sleep(forTimeInterval: 0.5)
  }
```

Verify, then commit:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run tools/agent-selftest.test.ts
./agents/macos/build/cairn-agent-selftest --mark files
git add agents/macos/Tests/SelfTest.swift
git commit -m "test(agent-macos): --mark subcommand for synthetic concealed, file-url, TIFF and Chrome copies"
```

Expected: `2 passed` (the swiftc self-test and the constant drift guard from Step 11), then
`marked: two file urls, changeCount=<n>`. `pbpaste` afterwards prints nothing, because the pasteboard
now holds two file URLs and no text.

- [ ] **Step 21: Run `make agent` and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && make agent
```

Expected: FAIL. The compile succeeds and the **link** fails, because no file supplies an entry point:

```
Undefined symbols for architecture arm64:
  "_main", referenced from: <initial-undefines>
ld: symbol(s) not found for architecture arm64
```

Only a file literally named `main.swift` may hold top-level code, which is the next step.

- [ ] **Step 22: Implement the pasteboard writer.**

Create `agents/macos/Sources/Writer.swift`:

```swift
import AppKit
import Foundation

enum Writer {
  /// MIME -> UTI for the reps we can write back. The host may override per rep with `uti`.
  static let utiForMime: [String: String] = [
    "text/plain": "public.utf8-plain-text",
    "text/html": "public.html",
    "text/rtf": "public.rtf",
    "image/png": "public.png",
    "application/pdf": "com.adobe.pdf",
    "text/uri-list": "public.file-url",
  ]

  /// MUST run on Pasteboard.queue.
  ///
  /// Returns the changeCount the write caused. That number IS the self-write suppression token:
  /// @cairn/capture ignores exactly this changeCount, which is how pressing Enter in the palette
  /// does not re-record the item you just recalled.
  ///
  /// `transient: true` additionally marks org.nspasteboard.TransientType and AutoGeneratedType so
  /// every other clipboard manager on the machine skips it too. M1 never passes true — recall puts
  /// the item on the clipboard to keep. M2's paste path does.
  ///
  /// The parameter type is the generated `WriteParamsRepsItem` — there is no hand-written `WriteRep`.
  /// `WriteParamsRepsItem.b64` is `Data`, so JSONDecoder already base64-DECODED it and there is no
  /// `Data(base64Encoded:)` call here: a malformed base64 string failed the decode and the whole
  /// `write` was answered `E_BAD_PARAMS` in main.swift before this function was ever reached.
  static func write(reps: [WriteParamsRepsItem], transient: Bool) -> Int {
    autoreleasepool {
      var items: [NSPasteboardItem] = []
      var uriListURLs: [String] = []
      let primary = NSPasteboardItem()
      items.append(primary)

      for rep in reps {
        if rep.mime == "text/uri-list" {
          // A multi-file copy is N pasteboard items, one public.file-url each — that is the only
          // shape Finder accepts.
          let text = String(decoding: rep.b64, as: UTF8.self)
          uriListURLs = text.split(whereSeparator: \.isNewline).map(String.init)
          continue
        }
        let uti = rep.uti ?? utiForMime[rep.mime] ?? rep.mime
        if !primary.setData(rep.b64, forType: NSPasteboard.PasteboardType(uti)) {
          Out.log(.warn, "write.set-data-refused", ["mime": .string(rep.mime), "uti": .string(uti)])
        }
      }

      for (index, url) in uriListURLs.enumerated() {
        let target = index == 0 ? primary : NSPasteboardItem()
        target.setString(url, forType: NSPasteboard.PasteboardType(RepFilter.fileURL))
        if index > 0 { items.append(target) }
      }

      if transient {
        primary.setData(Data(), forType: NSPasteboard.PasteboardType(HintUTI.transient))
        primary.setData(Data(), forType: NSPasteboard.PasteboardType(HintUTI.autoGenerated))
      }

      let pb = NSPasteboard.general
      // clearContents() increments changeCount and returns the new value; writeObjects() does not
      // increment it again, so this return value IS the final changeCount.
      // [verified] clearContents() returned 364 and pb.changeCount was still 364 after writeObjects.
      let token = pb.clearContents()
      if !pb.writeObjects(items) {
        Out.log(.error, "write.write-objects-failed", ["repCount": .number(Double(reps.count))])
      }
      return token
    }
  }
}
```

- [ ] **Step 23: Implement the poll, the dispatcher and startup.**

Create `agents/macos/Sources/main.swift`:

```swift
import AppKit
import Carbon
import Foundation

let AGENT_VERSION = "0.1.0"

// Writing to a dead stdout must return EPIPE rather than killing us with a signal, so the exit path
// is ours and is logged.
signal(SIGPIPE, SIG_IGN)

// MARK: - the poll

enum Poller {
  private static var timer: DispatchSourceTimer?
  private static var requestedIntervalMs = WATCH_INTERVAL_MS
  private static var lastChangeCount = -1
  /// Reason-keyed so sleep and session-inactive cannot over-resume each other.
  private static var suspendReasons = SuspendReasons()

  /// MUST run on Pasteboard.queue.
  static func start(intervalMs: Int) {
    stop()
    requestedIntervalMs = intervalMs
    // Whatever is already on the clipboard when watching begins is the baseline and is NOT
    // captured. The host can ask for it explicitly with `read`.
    lastChangeCount = Pasteboard.changeCount()
    let t = DispatchSource.makeTimerSource(queue: Pasteboard.queue)
    // 200 ms leeway lets the kernel coalesce our wakeup with others: a changeCount read costs
    // ~0.77 µs, so the timer wakeup, not the read, is the only cost worth managing.
    t.schedule(deadline: .now() + .milliseconds(effectiveIntervalMs()),
               repeating: .milliseconds(effectiveIntervalMs()),
               leeway: .milliseconds(200))
    t.setEventHandler { tick() }
    t.activate()
    timer = t
    Out.log(.info, "watch.started", ["changeCount": .number(Double(lastChangeCount)),
                                     "intervalMs": .number(Double(effectiveIntervalMs()))])
  }

  /// MUST run on Pasteboard.queue.
  static func stop() {
    guard let t = timer else { return }
    // A suspended source cannot be cancelled cleanly, and we suspend at most once no matter how
    // many reasons are active, so exactly one resume balances it.
    if suspendReasons.drain() { t.resume() }
    t.cancel()
    timer = nil
  }

  /// Low Power Mode slows the poll to 1 s. Nothing else changes: we keep watching, because a
  /// clipboard manager that stops recording on battery is a clipboard manager that lost your data.
  static func effectiveIntervalMs() -> Int {
    ProcessInfo.processInfo.isLowPowerModeEnabled ? max(1_000, requestedIntervalMs) : requestedIntervalMs
  }

  /// MUST run on Pasteboard.queue.
  static func suspend(reason: String) {
    guard let t = timer else { return }
    if suspendReasons.add(reason) {
      t.suspend()
      Out.log(.info, "watch.suspended", ["reason": .string(reason)])
    }
  }

  /// MUST run on Pasteboard.queue.
  static func resume(reason: String) {
    guard let t = timer else { return }
    if suspendReasons.remove(reason) {
      t.resume()
      Out.log(.info, "watch.resumed", ["reason": .string(reason)])
      // A copy made while asleep or in another session bumped changeCount without a tick; the next
      // tick compares against lastChangeCount and reports it, so nothing is lost.
    }
  }

  /// MUST run on Pasteboard.queue.
  static func reschedule() {
    guard timer != nil else { return }
    Out.log(.info, "watch.rescheduled", ["intervalMs": .number(Double(effectiveIntervalMs()))])
    start(intervalMs: requestedIntervalMs)
  }

  private static func tick() {
    let cc = Pasteboard.changeCount()
    if cc == lastChangeCount { return }
    lastChangeCount = cc
    let outcome = Pasteboard.read()
    let front = Frontmost.snapshot()
    // attributionConfidence is ALWAYS 'heuristic', never authoritative: macOS exposes no
    // pasteboard-owner API, so this is only "whatever was frontmost when changeCount bumped" and it
    // races on background or scripted copies (spec §10).
    // Alphabetical labels: the generator sorts, so it is
    // (attributionConfidence:changeCount:frontmostBundleId:frontmostName:hints:reps:).
    // `hints` is `[Hint]?` but we always pass the array, never nil, so the line carries "hints":[].
    Out.event("clipboard.changed", ClipboardChangedData(
      attributionConfidence: front.bundleId == nil ? .unknown : .heuristic,
      changeCount: outcome.changeCount,
      frontmostBundleId: front.bundleId,
      frontmostName: front.name,
      hints: outcome.hints,
      reps: outcome.reps))
    // Chunks AFTER the declaring line, always.
    Chunker.emit(outcome.streams)
  }
}

// MARK: - request dispatch

/// A lock box, so the reader thread and the pasteboard queue never race on a result that a timeout
/// has abandoned.
final class Box<T> {
  private let lock = NSLock()
  private var value: T?
  func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
  func get() -> T? { lock.lock(); defer { lock.unlock() }; return value }
}

/// Alphabetical labels again, and every one of `agent`, `clipboardWatch`, `hotkey`, `paste` and
/// `tier` is a generated nested ENUM rather than a String, so a typo is a compile error instead of a
/// capability the host silently fails to recognise. `AgentCapabilitiesPaste.none` must be spelled in
/// full: a bare `.none` is ambiguous with `Optional.none`.
func capabilities() -> AgentCapabilities {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return AgentCapabilities(
    agent: .macos,
    agentVersion: AGENT_VERSION,
    chunkThresholdBytes: CHUNK_THRESHOLD_BYTES,
    clipboardWatch: .changecountPoll,
    concealedTypeHints: true,
    focusApp: true,
    hotkey: .carbon,
    maxRepBytes: MAX_REP_BYTES,
    missingTools: [],
    paste: AgentCapabilitiesPaste.none,   // M1 has no paste. M2 turns this into .cgevent.
    platformVersion: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
    tier: .a,
    wireMajor: protocolVersion)
}

func decodeParams<P: Decodable>(_ line: Data, _ type: P.Type) -> P? {
  (try? JSONDecoder().decode(Request<P>.self, from: line))?.params
}

func handle(line: Data) {
  guard let head = try? JSONDecoder().decode(RequestHead.self, from: line) else {
    Out.log(.warn, "request.unparseable", [:])
    return
  }
  guard head.v == protocolVersion else {
    Out.fail(id: head.id, code: "E_WIRE_MAJOR", message: "unsupported wire major \(head.v)")
    return
  }
  guard head.t == "req" else {
    Out.log(.warn, "request.not-a-req", ["t": .string(head.t)])
    return
  }
  let id = head.id

  switch head.method {
  case "hello":
    guard decodeParams(line, HelloParams.self) != nil else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "hello needs hostVersion")
    }
    Out.ok(id: id, capabilities())

  case "watch.start":
    guard let p = decodeParams(line, WatchStartParams.self) else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "watch.start needs intervalMs")
    }
    Pasteboard.queue.async {
      Poller.start(intervalMs: p.intervalMs)
      let effective = Poller.effectiveIntervalMs()
      if effective != p.intervalMs {
        Out.log(.info, "watch.low-power", ["intervalMs": .number(Double(effective))])
      }
      // The echoed intervalMs is the REQUESTED one, so a recorded transcript is identical on a
      // machine in Low Power Mode; the effective interval is reported in the log event above.
      Out.ok(id: id, WatchStartResult(intervalMs: p.intervalMs, watching: true))
    }

  case "watch.stop":
    Pasteboard.queue.async {
      Poller.stop()
      Out.ok(id: id, WatchStopResult(watching: false))
    }

  case "read":
    guard let p = decodeParams(line, ReadParams.self) else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "read needs changeCount")
    }
    let box = Box<Pasteboard.ReadOutcome>()
    let sem = DispatchSemaphore(value: 0)
    Pasteboard.queue.async {
      box.set(Pasteboard.read())
      sem.signal()
    }
    if sem.wait(timeout: .now() + .milliseconds(AGENT_REQUEST_TIMEOUT_MS)) == .timedOut {
      // The read is still wedged on the pasteboard queue — a promised public.tiff being rendered by
      // Photoshop, say. Answer honestly and let the watchdog decide whether to take the process
      // down; a second response is never sent for this id.
      Out.fail(id: id, code: "E_TIMEOUT", message: "promised pasteboard read exceeded \(AGENT_REQUEST_TIMEOUT_MS)ms")
      return
    }
    guard let outcome = box.get() else {
      return Out.fail(id: id, code: "E_INTERNAL", message: "read produced no outcome")
    }
    if outcome.changeCount != p.changeCount {
      Out.log(.info, "read.stale", ["changeCount": .number(Double(outcome.changeCount))])
    }
    Out.ok(id: id, ReadResult(changeCount: outcome.changeCount, hints: outcome.hints, reps: outcome.reps))
    Chunker.emit(outcome.streams)

  case "write":
    // `WriteParamsRepsItem.b64` is `Data`, so a b64 field that is not valid base64 fails the decode
    // here and is answered E_BAD_PARAMS. That is why the agent has no `write.bad-base64` log id.
    guard let p = decodeParams(line, WriteParams.self), !p.reps.isEmpty else {
      return Out.fail(id: id, code: "E_BAD_PARAMS",
                      message: "write needs at least one rep with a valid base64 b64")
    }
    Pasteboard.queue.async {
      let token = Writer.write(reps: p.reps, transient: p.transient)
      // The poll WILL see this changeCount and emit clipboard.changed for it. That is deliberate:
      // suppression is the host's job, keyed on the token we return here, and a transcript proves it.
      Out.ok(id: id, WriteResult(changeToken: String(token)))
    }

  case "hotkey.register":
    guard let p = decodeParams(line, HotkeyRegisterParams.self) else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "hotkey.register needs accelerator")
    }
    DispatchQueue.main.async {
      let bound = Hotkey.register(p.accelerator)
      // Never an error response: a hot key that failed to bind is a first-class product state, and
      // a rejected promise would let @cairn/hotkey swallow it (contract §3).
      Out.ok(id: id, HotkeyRegisterResult(accelerator: p.accelerator, bound: bound))
    }

  case "hotkey.unregister":
    DispatchQueue.main.async {
      Hotkey.unregister()
      Out.ok(id: id, HotkeyUnregisterResult(bound: false))
    }

  case "shutdown":
    Out.ok(id: id, ShutdownResult(bye: true))
    exit(0)

  default:
    Out.fail(id: id, code: "E_UNKNOWN_METHOD", message: "unknown method \(head.method)")
  }
}

// MARK: - startup

// NSApplication.shared initialises AppKit and connects this process to the window server, which is
// what makes NSWorkspace notifications and Carbon hot keys deliver. `.prohibited` keeps the agent
// out of the Dock and the app switcher.
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

Frontmost.startObserving()
ReadWatchdog.start()

// Sleep and fast-user-switch both mean "nobody is copying anything right now". Observed on main and
// marshalled onto the pasteboard queue, per spec §4's thread discipline.
let wsCenter = NSWorkspace.shared.notificationCenter
for (name, reason, isSuspend) in [
  (NSWorkspace.willSleepNotification, "sleep", true),
  (NSWorkspace.didWakeNotification, "sleep", false),
  (NSWorkspace.sessionDidResignActiveNotification, "session-inactive", true),
  (NSWorkspace.sessionDidBecomeActiveNotification, "session-inactive", false),
] {
  wsCenter.addObserver(forName: name, object: nil, queue: .main) { _ in
    Pasteboard.queue.async { isSuspend ? Poller.suspend(reason: reason) : Poller.resume(reason: reason) }
  }
}
NotificationCenter.default.addObserver(
  forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: .main
) { _ in
  Pasteboard.queue.async { Poller.reschedule() }
}

// stdin blocks, so it gets its own thread; the main thread belongs to the run loop that delivers
// Carbon hot keys and NSWorkspace notifications.
Thread.detachNewThread {
  In.readLines { line in handle(line: line) }
  Out.stderrLine("cairn-agent: stdin closed; exiting")
  exit(0)
}

RunLoop.main.run()
```

- [ ] **Step 24: Build the agent and see it link.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app && make agent && file agents/macos/build/cairn-agent-macos
```

Expected: the `swiftc` line runs with no output, then
`agents/macos/build/cairn-agent-macos: Mach-O 64-bit executable arm64`. `[verified]` this recipe
compiles the whole agent in about 1.7 s with Command Line Tools only.

- [ ] **Step 25: Verify the happy path by hand: hello, watch, one text copy.**

Two things to know about this command. `{ …; sleep N; } | binary` is the whole harness: the `sleep`
holds the write end of the pipe open, which is what keeps the agent alive after the last request —
the agent exits on stdin EOF by design. And `cut` only trims the display; nothing truncates the wire.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
{ printf '%s\n' \
  '{"v":1,"t":"req","id":"1","method":"hello","params":{"hostVersion":"0.1.0"}}' \
  '{"v":1,"t":"req","id":"2","method":"watch.start","params":{"intervalMs":500}}'
  sleep 6
} | agents/macos/build/cairn-agent-macos | cut -c1-160 &
sleep 2 && printf 'hello world' | pbcopy
wait
```

Expected, in this order:

```
{"id":"1","ok":true,"result":{"agent":"macos","agentVersion":"0.1.0","chunkThresholdBytes":65536,"clipboardWatch":"changecount-poll","concealedTypeHints
{"data":{"event":"watch.started","fields":{"changeCount":<n>,"intervalMs":500},"level":"info"},"event":"log","t":"ev","v":1}
{"id":"2","ok":true,"result":{"intervalMs":500,"watching":true},"t":"res","v":1}
{"data":{"attributionConfidence":"heuristic","changeCount":<n+1>,"frontmostBundleId":"com.apple.Terminal","frontmostName":"Terminal","hints":[],"reps":[
cairn-agent: stdin closed; exiting
```

Note that the log `fields` values are JSON **numbers**, not quoted strings: `AgentLogValue` has a
`.number(Double)` case and the agent uses it for counts and intervals. `[verified]` this exact run on
macOS 26.5.1 printed `"fields":{"changeCount":410,"intervalMs":500}`.

The full `clipboard.changed` rep must be
`{"byteLength":11,"inline":"aGVsbG8gd29ybGQ=","mime":"text/plain","sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","uti":"public.utf8-plain-text"}`
— drop the `cut` to see it. `[verified]` that sha256 is exactly what `printf 'hello world' | shasum
-a 256` base64url-encodes to, so the Swift and TypeScript hashes agree byte for byte. Note the key
order: `Rep` fields are alphabetical because the generator sorts them and the encoder uses
`.sortedKeys`, so `byteLength` comes first and `uti` last.

- [ ] **Step 26: Verify the four awkward pasteboard shapes by hand.**

The decision logic for all four is already asserted in the self-test; this is the integration proof
that the real `NSPasteboard` behaves as the allowlist assumes. Run each block and compare.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
for CASE in concealed files tiff chrome; do
  echo "=== $CASE"
  { printf '%s\n' \
    '{"v":1,"t":"req","id":"1","method":"hello","params":{"hostVersion":"0.1.0"}}' \
    '{"v":1,"t":"req","id":"2","method":"watch.start","params":{"intervalMs":500}}'
    sleep 4
  } | agents/macos/build/cairn-agent-macos 2>/dev/null | grep -E 'clipboard.changed|rep.chunk|concealed-skipped' | cut -c1-200 &
  sleep 1.5 && ./agents/macos/build/cairn-agent-selftest --mark "$CASE" > /dev/null
  wait
done
```

Expected — the four lines that matter, one per case:

- `concealed`: a log line `{"data":{"event":"pasteboard.concealed-skipped",…}}` **and**
  `…"hints":["concealed"],"reps":[]…`. **Zero reps and zero bytes read.** If you ever see a rep on
  this line, the hint probe has moved after the read and the app is recording passwords.
- `files`: exactly one rep,
  `{"byteLength":31,"inline":"ZmlsZTovLy9iaW4vbHMKZmlsZTovLy9iaW4vY2F0Cg==","mime":"text/uri-list",…}`
  — that base64 is `file:///bin/ls\nfile:///bin/cat\n`. Two pasteboard items collapse into one rep.
- `tiff`: one rep with `"mime":"image/png"`, `"byteLength":131601`, `"repId":"r1"` and **no
  `inline`**, followed by exactly 5 `rep.chunk` lines with `seq` 0…4, `final` true only on `seq:4`,
  and the first four `b64` fields exactly 43 692 characters long. The chunks come **after** the
  `clipboard.changed` line; if they ever come first the host answers `E_REP_UNKNOWN_ID` and throws
  the representation away.
- `chrome`: two reps, `text/plain` then `text/x-source-url`, both inline.

- [ ] **Step 27: Verify `write`, the changeToken, and the transient markers by hand.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
B64=$(printf 'written by cairn' | base64)
{ printf '{"v":1,"t":"req","id":"1","method":"write","params":{"reps":[{"mime":"text/plain","uti":null,"b64":"%s"}],"transient":true}}\n' "$B64"
  sleep 2
} | agents/macos/build/cairn-agent-macos
pbpaste
```

Expected: `{"id":"1","ok":true,"result":{"changeToken":"<n>"},"t":"res","v":1}` then
`written by cairn`. `[verified]` the pasteboard then holds exactly one item whose types are
`["public.utf8-plain-text", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"]`,
the two markers carrying zero bytes, and `<n>` equals the pasteboard's `changeCount` afterwards —
which is what makes it a usable suppression token.

Then prove the malformed-base64 path, because `WriteParamsRepsItem.b64` being `Data` moves that
failure from `Writer.write` up into the decoder:

```sh
{ printf '%s\n' '{"v":1,"t":"req","id":"9","method":"write","params":{"reps":[{"mime":"text/plain","uti":null,"b64":"!!!not base64!!!"}],"transient":false}}'
  sleep 1
} | agents/macos/build/cairn-agent-macos
pbpaste
```

Expected, `[verified]` byte for byte:

```
{"error":{"code":"E_BAD_PARAMS","message":"write needs at least one rep with a valid base64 b64"},"id":"9","ok":false,"t":"res","v":1}
cairn-agent: stdin closed; exiting
```

and `pbpaste` still prints `written by cairn` — the pasteboard was never touched, because
`JSONDecoder` rejected the request before `Writer.write` ran. That is why there is no
`write.bad-base64` log id.

- [ ] **Step 28: Commit the writer, the poll and the dispatcher.**

```sh
git add agents/macos/Sources/Writer.swift agents/macos/Sources/main.swift
git commit -m "feat(agent-macos): 500ms poll with sleep/low-power suspension, request dispatch and pasteboard write"
```

- [ ] **Step 29: Write the failing assertion for the hot key's own state, then implement Carbon registration.**

Append to `runAssertions()`:

```swift
    // 12. hot key state is observable without a key press
    expect(Hotkey.current() == nil, "no accelerator is current before anything is registered")
    expect(!Hotkey.register("Bogus+Nope"), "an unparseable accelerator reports bound:false rather than throwing")
    expect(Hotkey.current() == nil, "a failed registration leaves no accelerator behind")
```

Run `npx vitest run tools/agent-selftest.test.ts` — expected: FAIL with
`error: type 'Hotkey' has no member 'register'`. Then append to
`agents/macos/Sources/Hotkey.swift`:

```swift
enum Hotkey {
  private static var ref: EventHotKeyRef?
  private static var handler: EventHandlerRef?
  private static var accelerator: String?
  private static let signature: OSType = 0x4341_524E     // 'CARN'

  /// MUST be called on the main thread: Carbon hot key events are delivered to the main run loop's
  /// event dispatcher target.
  static func register(_ accel: String) -> Bool {
    unregister()
    guard let parsed = HotkeyMap.parse(accel) else {
      Out.log(.warn, "hotkey.unparseable", ["accelerator": .string(accel)])
      return false
    }
    installHandlerIfNeeded()
    var newRef: EventHotKeyRef?
    let hotKeyID = EventHotKeyID(signature: signature, id: 1)
    let status = RegisterEventHotKey(
      parsed.keyCode, parsed.modifiers, hotKeyID, GetEventDispatcherTarget(), 0, &newRef)
    guard status == noErr, let newRef else {
      // -9878 is eventHotKeyExistsErr. [verified] it fires only for a duplicate registration WITHIN
      // this process: two separate processes can both register Cmd+Shift+V and both get noErr. So
      // `bound: true` means "the API accepted it", never "nobody else has it" — which is exactly why
      // spec §4 makes a dead hot key a first-class UI state with a rebind row instead of trusting a
      // return code.
      Out.log(.warn, "hotkey.register-failed", ["accelerator": .string(accel), "status": .number(Double(status))])
      return false
    }
    ref = newRef
    accelerator = accel
    return true
  }

  static func unregister() {
    if let r = ref { UnregisterEventHotKey(r) }
    ref = nil
    accelerator = nil
  }

  static func current() -> String? { accelerator }

  private static func installHandlerIfNeeded() {
    guard handler == nil else { return }
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let callback: EventHandlerUPP = { _, event, _ in
      var fired = EventHotKeyID()
      let got = GetEventParameter(
        event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
        nil, MemoryLayout<EventHotKeyID>.size, nil, &fired)
      guard got == noErr, fired.signature == Hotkey.signature else { return noErr }
      Hotkey.fire()
      return noErr
    }
    InstallEventHandler(GetEventDispatcherTarget(), callback, 1, &spec, nil, &handler)
  }

  /// The focus token is opaque in M1 — nothing restores focus until M2 — but it is emitted from day
  /// one so the wire never changes. It records who was frontmost the instant the key fired, which is
  /// exactly what M2's focus.restore needs and what reading "previous app" at paste time cannot
  /// give: while our accessory app is active, NSWorkspace.frontmostApplication returns *us*.
  private static func fire() {
    guard let accel = accelerator else { return }
    let firedAt = Int(Date().timeIntervalSince1970 * 1000)
    let snapshot = Frontmost.snapshot()
    let token = "\(snapshot.bundleId ?? "unknown")|\(firedAt)"
    // Alphabetical labels: HotkeyFiredData is (accelerator:firedAt:focusToken:).
    Out.event("hotkey.fired", HotkeyFiredData(accelerator: accel, firedAt: firedAt, focusToken: token))
  }
}
```

- [ ] **Step 30: Run the self-test, then verify the hot key really fires by pressing it.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run tools/agent-selftest.test.ts && make agent
./agents/macos/build/cairn-agent-selftest | grep -c '^ok'
```

Expected: `2 passed`, a clean build, and the count is `63`.

One thing not to be alarmed by: the self-test's output now starts with a stray protocol line,
`{"data":{"event":"hotkey.unparseable",…},"event":"log","t":"ev","v":1}`. `Out.log` writes straight to
fd 1 while Swift's `print` is block-buffered when stdout is a pipe, so the raw line lands first and the
whole block of `ok` lines flushes at exit. `ALL PASS` is still the last line, which is what
`tools/agent-selftest.test.ts` asserts.

Now the only test that actually proves a global hot key works — a human pressing it:

```sh
{ printf '%s\n' \
  '{"v":1,"t":"req","id":"1","method":"hotkey.register","params":{"accelerator":"Cmd+Shift+V"}}'
  sleep 15
} | agents/macos/build/cairn-agent-macos
```

Expected: `{"id":"1","ok":true,"result":{"accelerator":"Cmd+Shift+V","bound":true},"t":"res","v":1}`
immediately, then — after you click into **any other app** and press `Cmd+Shift+V` — one line per
press:

```
{"data":{"accelerator":"Cmd+Shift+V","firedAt":1772...,"focusToken":"com.google.Chrome|1772..."},"event":"hotkey.fired","t":"ev","v":1}
```

Press it inside a password field too (System Settings → your Apple Account password box, or
Terminal with Secure Keyboard Entry on): it must still fire. That is the whole reason this is Carbon
and not Electron's `globalShortcut`, and it is what lets the palette open over a password prompt in
M2. If nothing fires, the run loop is not pumping — check that `RunLoop.main.run()` is the last line
of `main.swift` and that `NSApplication.shared` is touched before registration.

- [ ] **Step 31: Commit.**

```sh
git add agents/macos/Sources/Hotkey.swift agents/macos/Tests/SelfTest.swift
git commit -m "feat(agent-macos): Carbon global hot key with an honest bound flag and a focus token"
```

- [ ] **Step 32: Write the transcript recorder.**

Create `tools/record-transcript.ts`. It is run directly by Node 24's built-in type stripping
(`node tools/record-transcript.ts …`) — there is no build step and no `tsx`.

**Read this comment before the code.** A raw recording is real clipboard data in plaintext on disk.
That is the one place in this repo where that is allowed to happen, it is gated behind an explicit
acknowledgement flag, it can only ever write `fixtures/agent-transcripts/*.raw.ndjson` (which
`.gitignore` excludes), and you delete it when you are done. The product never does this.

```ts
/**
 * Captures a real macOS pasteboard session into a replayable transcript, and diffs a recording
 * against a committed fixture so you can see whether the real binary still emits what the fixture
 * claims.
 *
 * `record` writes REAL clipboard data, in the clear, to fixtures/agent-transcripts/<name>.raw.ndjson.
 * That file is gitignored, is never committed, and should be deleted as soon as you have looked at
 * it. Nothing in the shipping app ever writes clipboard bytes to disk (spec §11 control 1); this is a
 * developer tool and it is deliberately loud about the difference.
 *
 * There is deliberately NO `promote` subcommand and no code path in this file that writes a
 * `*.ndjson` fixture. Every fixture under fixtures/agent-transcripts/ is owned by another task —
 * hello-watch-text and image-tiff-chunked by Task 3, the five capture fixtures by Task 7 — and each of
 * those tasks asserts its fixtures' exact frame counts, byte lengths and hashes. An earlier revision
 * of this tool promoted recordings over them and silently broke those assertions. `diff` is the
 * replacement: it reads, compares and reports, and it never writes anything but the .raw.ndjson.
 *
 *   node tools/record-transcript.ts record my-session 20 --i-understand-this-writes-real-clipboard-data-to-disk
 *   node tools/record-transcript.ts diff my-session hello-watch-text
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AGENT_BIN = join(REPO_ROOT, 'agents', 'macos', 'build', 'cairn-agent-macos')
const TRANSCRIPT_DIR = join(REPO_ROOT, 'fixtures', 'agent-transcripts')
const ACK = '--i-understand-this-writes-real-clipboard-data-to-disk'

interface Frame {
  dir: 'in' | 'out'
  delayMs?: number
  line: Record<string, unknown>
}

function die(message: string): never {
  console.error('record-transcript: ' + message)
  process.exit(2)
}

async function record(name: string, seconds: number, argv: string[]): Promise<void> {
  if (!argv.includes(ACK)) {
    die(
      `refusing to record without ${ACK}\n` +
        '  A raw recording is REAL clipboard data in plaintext on disk. It is gitignored, it is\n' +
        '  never committed, and you delete it as soon as you have looked at it.',
    )
  }
  if (!existsSync(AGENT_BIN)) die(`no agent binary at ${AGENT_BIN} — run \`make agent\` first`)
  const out = join(TRANSCRIPT_DIR, `${name}.raw.ndjson`)
  if (!out.endsWith('.raw.ndjson')) die('refusing to write anywhere but *.raw.ndjson')

  writeFileSync(
    out,
    JSON.stringify({
      v: 1,
      t: 'meta',
      transcript: name,
      recordedOn: `macos ${release()} ${arch()}`,
      synthetic: false,
      note: 'UNSCRUBBED RAW CAPTURE - real clipboard data, never commit this file',
    }) + '\n',
    { mode: 0o600 },
  )
  console.error(
    `record-transcript: writing ${out}\n  This file contains REAL clipboard data. Delete it when you are done.`,
  )

  const startedAt = Date.now()
  const child = spawn(AGENT_BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  const frame = (f: Frame): void => appendFileSync(out, JSON.stringify(f) + '\n')

  let idCounter = 0
  let pendingResponse: (() => void) | null = null

  /**
   * A transcript replays strictly in file order, so the `in` frame for request N+1 must never be
   * written before the `out` frame carrying the response to request N. Hence the await.
   */
  const send = (method: string, params: Record<string, unknown>): Promise<void> => {
    const line = { v: 1, t: 'req', id: '*', method, params }
    frame({ dir: 'in', line })
    child.stdin.write(JSON.stringify({ ...line, id: String(++idCounter) }) + '\n')
    return new Promise((resolve) => {
      pendingResponse = resolve
    })
  }

  let buf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl < 0) break
      const raw = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (raw.length === 0) continue
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.t === 'res') parsed.id = '*'      // the host allocates ids; a fixture must not pin them
      frame({ dir: 'out', line: parsed })
      const label = parsed.t === 'ev' ? String(parsed.event) : 'res'
      console.error(`  <- ${label} ${raw.length} bytes @${Date.now() - startedAt}ms`)
      if (parsed.t === 'res' && pendingResponse !== null) {
        const resolve = pendingResponse
        pendingResponse = null
        resolve()
      }
    }
  })

  await send('hello', { hostVersion: '0.1.0' })
  await send('watch.start', { intervalMs: 500 })
  console.error(`record-transcript: recording for ${seconds}s — copy something now`)
  await new Promise((r) => setTimeout(r, seconds * 1000))
  await send('shutdown', {})
  child.kill()
  console.error(
    `record-transcript: done. Next:\n` +
      `  node tools/record-transcript.ts diff ${name} <fixture-name>\n` +
      `  rm fixtures/agent-transcripts/${name}.raw.ndjson`,
  )
}

/**
 * A comparable summary of one transcript frame: direction, method or event name, and for each rep the
 * tuple that has to be stable for the host to behave the same way. Everything that legitimately
 * differs between a live recording and a committed fixture — `id`, `changeCount`, `delayMs`, the
 * frontmost app, the platform version, `repId`, and the inline bytes themselves — is left out, because
 * the point of `diff` is "does the real binary still produce this SHAPE?", not "are the files equal".
 */
function summarise(frame: Record<string, any>): string {
  const line = frame.line as Record<string, any>
  const dir = String(frame.dir)
  if (line.t === 'req') return `${dir} req ${String(line.method)}`
  if (line.t === 'ev') {
    const event = String(line.event)
    if (event === 'rep.chunk') return `${dir} ev rep.chunk final=${String(line.data.final)}`
    const reps = (line.data?.reps ?? []) as Record<string, any>[]
    const hints = (line.data?.hints ?? []) as string[]
    return `${dir} ev ${event} hints=[${hints.join(',')}] reps=[${reps.map(summariseRep).join(' ')}]`
  }
  if (line.t === 'res') {
    if (line.ok === false) return `${dir} res error ${String(line.error?.code)}`
    const result = (line.result ?? {}) as Record<string, any>
    const reps = (result.reps ?? []) as Record<string, any>[]
    const keys = Object.keys(result).sort().join(',')
    return reps.length === 0
      ? `${dir} res ok {${keys}}`
      : `${dir} res ok {${keys}} reps=[${reps.map(summariseRep).join(' ')}]`
  }
  return `${dir} ${String(line.t)}`
}

function summariseRep(rep: Record<string, any>): string {
  const carriage = rep.inline === undefined ? 'streamed' : 'inline'
  return `${String(rep.mime)}|${String(rep.uti)}|${String(rep.byteLength)}|${carriage}`
}

/**
 * Compares a raw recording against a COMMITTED fixture and reports. Writes nothing: every fixture
 * belongs to another task.
 *
 * The fixture is the contract, so the check is PREFIX containment, not equality: every frame the
 * fixture scripts must appear, in order, with the same shape, at the same position in the recording.
 * A live session legitimately runs longer than a fixture models — the recorder always sends `shutdown`
 * and the fixtures do not script it — so trailing recorded frames are reported as information rather
 * than as findings. A fixture that is LONGER than the recording is a finding, because then the agent
 * failed to emit something the fixture claims.
 *
 * Exit 0 = every scripted frame matched. Exit 1 = at least one did not.
 */
function diff(rawName: string, fixtureName: string): void {
  const src = join(TRANSCRIPT_DIR, `${rawName}.raw.ndjson`)
  const fixture = join(TRANSCRIPT_DIR, `${fixtureName}.ndjson`)
  if (!existsSync(src)) die(`no such raw recording: ${src}`)
  if (!existsSync(fixture)) die(`no such committed fixture: ${fixture}`)

  const frames = (path: string): string[] =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, any>)
      .filter((o) => o.t !== 'meta')
      // log frames are recording noise and are not present in any committed fixture
      .filter((o) => !(o.line?.t === 'ev' && o.line?.event === 'log'))
      .map(summarise)

  const recorded = frames(src)
  const committed = frames(fixture)
  let findings = 0
  for (const [i, expected] of committed.entries()) {
    if (recorded[i] === expected) continue
    findings += 1
    console.error(
      `record-transcript: frame ${i + 1} differs\n` +
        `  recorded:  ${recorded[i] ?? '<recording ended early>'}\n` +
        `  committed: ${expected}`,
    )
  }
  const extra = recorded.length - committed.length
  if (findings === 0) {
    console.error(
      `record-transcript: all ${committed.length} scripted frames of ${fixtureName}.ndjson match — ` +
        'the real binary still emits the shape that fixture claims',
    )
    if (extra > 0) {
      console.error(
        `  (${extra} further recorded frame(s) the fixture does not script, which is normal: the\n` +
          '   recorder always sends shutdown and no fixture models it)',
      )
      for (const line of recorded.slice(committed.length)) console.error(`   + ${line}`)
    }
    return
  }
  console.error(
    `record-transcript: ${findings} differing frame(s). The fixture belongs to another task: do NOT\n` +
      '  overwrite it. Either the agent changed and that task must be told, or the recording captured\n' +
      '  something the fixture never modelled.',
  )
  process.exit(1)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'record') {
  await record(rest[0] ?? die('record needs a name'), Number(rest[1] ?? 20), rest)
} else if (cmd === 'diff') {
  diff(rest[0] ?? die('diff needs a raw name'), rest[1] ?? die('diff needs a fixture name'))
} else {
  die(
    'usage:\n' +
      `  record <name> <seconds> ${ACK}\n` +
      '  diff <raw-name> <fixture-name>\n' +
      '\n' +
      '  There is no promote subcommand. Every fixture under fixtures/agent-transcripts/ is owned by\n' +
      '  Task 3 or Task 7, and this tool never writes one.',
  )
}
```

- [ ] **Step 33: Prove the recorder refuses to run without the acknowledgement.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
node tools/record-transcript.ts record scratch 5; echo "exit=$?"
```

Expected: `refusing to record without --i-understand-this-writes-real-clipboard-data-to-disk` and
`exit=2`, and **no file created**:

```sh
ls fixtures/agent-transcripts/
```

Expected: no `scratch.raw.ndjson`.

- [ ] **Step 34: Record one raw session and diff it against the committed fixture.**

This task creates **no** fixture. `hello-watch-text.ndjson` and `image-tiff-chunked.ndjson` belong to
Task 3, which asserts their exact frame counts, byte lengths and hashes; the five capture fixtures
belong to Task 7, which asserts their reps and `changeCount`s. Overwriting any of them from here breaks
another task's tests silently, which is exactly what an earlier revision of this plan did. So the
recorder records, and `diff` compares.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
ACK=--i-understand-this-writes-real-clipboard-data-to-disk
node tools/record-transcript.ts record raw-text 8 $ACK & sleep 3; printf 'hello world' | pbcopy; wait
wc -l fixtures/agent-transcripts/raw-text.raw.ndjson
```

Expected, `[verified]` on macOS 26.5.1 with this exact binary:

```
record-transcript: writing <repo>/fixtures/agent-transcripts/raw-text.raw.ndjson
  This file contains REAL clipboard data. Delete it when you are done.
  <- res 318 bytes @662ms
  <- log 124 bytes @662ms
  <- res 80 bytes @663ms
record-transcript: recording for 8s — copy something now
  <- clipboard.changed 358 bytes @3278ms
  <- res 58 bytes @8674ms
record-transcript: done. Next:
  node tools/record-transcript.ts diff raw-text <fixture-name>
  rm fixtures/agent-transcripts/raw-text.raw.ndjson
```

and `wc -l` prints `9`: the meta line, three request/response pairs (`hello`, `watch.start`,
`shutdown`), the one `clipboard.changed`, and the one `watch.started` log event. Treat `9` as a floor —
if you are in Low Power Mode the agent also emits `watch.low-power` and you get `10`.

Now compare it against Task 3's committed fixture. The `if` is there because your branch is cut from
`origin/main` and Task 3 may not have merged yet; both branches of it print a named line, so there is
no silent outcome:

```sh
if [ -f fixtures/agent-transcripts/hello-watch-text.ndjson ]; then
  node tools/record-transcript.ts diff raw-text hello-watch-text; echo "diff exit=$?"
else
  echo "SKIPPED: fixtures/agent-transcripts/hello-watch-text.ndjson is not on this branch yet (Task 3 owns it)"
fi
```

Expected, when Task 3 has merged — `[verified]` against Task 3's exact fixture bytes:

```
record-transcript: all 5 scripted frames of hello-watch-text.ndjson match — the real binary still emits the shape that fixture claims
  (2 further recorded frame(s) the fixture does not script, which is normal: the
   recorder always sends shutdown and no fixture models it)
   + in req shutdown
   + out res ok {bye}
diff exit=0
```

The check is prefix containment, not equality: the fixture is the contract, so every frame it scripts
must appear in order with the same shape, and a live session running longer than the fixture models is
normal. `diff` compares shapes only — direction, method or event name, hints, and per rep
`mime|uti|byteLength|inline-or-streamed`. The `id`, `changeCount`, `delayMs`, frontmost app, `repId` and
the inline bytes are deliberately excluded, because they legitimately differ between a live recording
and a fixture. (In the verified run above the recording's `frontmostBundleId` was
`com.apple.Terminal` and the fixture's is `com.apple.TextEdit`, and that is *not* a difference.)

If it prints differing frames instead, read them carefully and then **do not touch the fixture**. A
difference means the agent's output genuinely no longer matches what Task 3 modelled: fix the agent, or
open the mismatch with Task 3.

Then delete the raw recording, because it is real clipboard data on disk:

```sh
rm -f fixtures/agent-transcripts/*.raw.ndjson
git status --short fixtures/
```

Expected: `git status --short fixtures/` prints **nothing at all**. Not one file under `fixtures/` was
created, modified or deleted by this task. If it prints anything, you have written a fixture that
belongs to another task — revert it.

- [ ] **Step 35: Write the failing security test for the transcript scanner.**

`scripts/scan-transcripts.mjs` is wired into the root `scan:transcripts` script and into `npm run
verify` by Task 1, and `security/transcripts-synthetic.security.test.ts` is required by contract §1 and
§8 — and neither file exists in any task yet, so `npm run verify` has been dying with `Cannot find
module '.../scripts/scan-transcripts.mjs'` since the first commit. This task fixes that. Test first.

Create `security/transcripts-synthetic.security.test.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_BUNDLE_ID,
  MAX_TRANSCRIPT_BYTES,
  listTranscripts,
  loadDetector,
  scanTranscript,
} from '../scripts/scan-transcripts.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCANNER = join(REPO_ROOT, 'scripts', 'scan-transcripts.mjs')
const PRIVACY_INDEX = join(REPO_ROOT, 'packages', 'privacy', 'src', 'index.ts')

/**
 * Contract §8, "Transcripts are synthetic": run the four checks of §7 over every committed transcript.
 * This file imports `scanTranscript` from the CLI's own module rather than reimplementing it, so the
 * thing CI runs and the thing this test asserts are one function.
 *
 * `mkdtempSync` and `tmpdir(` appear below, and `security/no-plaintext-on-disk.security.test.ts`
 * (Task 6) bans both identifiers under `packages/**` and `apps/desktop/**` — this file is under
 * `security/`, which that scan does not cover, and every path ending `.test.ts` is exempt there in any
 * case. The bytes written here are the literal string `AKIA2E0PQIN4XA7QD`, never clipboard content.
 */

/** A minimal, valid, clean transcript. Written to a temp dir; never to fixtures/. */
const CLEAN_TRANSCRIPT = [
  '{"v":1,"t":"meta","transcript":"probe","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"written by transcripts-synthetic.security.test.ts"}',
  '{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}',
  '{"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":364,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic"}}}',
].join('\n') + '\n'

/**
 * A stand-in for the product's detectors, used only to prove the SCANNER's wiring. The real detectors
 * are asserted in the last test in this file and are the only thing `npm run scan:transcripts` ever
 * uses — this stub can never reach CI's verdict.
 */
const stubDetect = (text: string): readonly string[] =>
  /AKIA[0-9A-Z]{12,}/.test(text) ? ['awsAccessKeyId'] : []

const write = (dir: string, name: string, body: string): string => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

describe('scripts/scan-transcripts.mjs enforces contract §7', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-scan-'))

  it('reports nothing for a clean synthetic transcript', () => {
    expect(scanTranscript(write(dir, 'clean.ndjson', CLEAN_TRANSCRIPT), stubDetect)).toEqual([])
  })

  it('check 1a: fails a transcript whose first line is not a meta frame', () => {
    const body = CLEAN_TRANSCRIPT.split('\n').slice(1).join('\n')
    expect(scanTranscript(write(dir, 'no-meta.ndjson', body), stubDetect)).toEqual([
      'no-meta.ndjson:1: E_NO_META line 1 is not a meta frame',
    ])
  })

  it('check 1b: fails a transcript whose meta.synthetic is not true', () => {
    const body = CLEAN_TRANSCRIPT.replace('"synthetic":true', '"synthetic":false')
    expect(scanTranscript(write(dir, 'not-synthetic.ndjson', body), stubDetect)).toEqual([
      'not-synthetic.ndjson:1: E_NOT_SYNTHETIC meta.synthetic is false, must be true',
    ])
  })

  it('check 2a: fails a Rep.inline whose decoded bytes trip a detector', () => {
    const planted = Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')
    const body = CLEAN_TRANSCRIPT.replace('aGVsbG8gd29ybGQ=', planted)
    expect(scanTranscript(write(dir, 'planted-inline.ndjson', body), stubDetect)).toEqual([
      'planted-inline.ndjson:3: E_SECRET rep text/plain inline trips awsAccessKeyId',
    ])
  })

  it('check 2b: fails a rep.chunk.b64 whose decoded bytes trip a detector', () => {
    const planted = Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')
    const chunk = JSON.stringify({
      dir: 'out',
      line: { v: 1, t: 'ev', event: 'rep.chunk', data: { b64: planted, final: true, repId: 'r1', seq: 0 } },
    })
    const body = CLEAN_TRANSCRIPT + chunk + '\n'
    expect(scanTranscript(write(dir, 'planted-chunk.ndjson', body), stubDetect)).toEqual([
      'planted-chunk.ndjson:4: E_SECRET rep.chunk seq 0 b64 trips awsAccessKeyId',
    ])
  })

  it('check 2c: fails a write request whose b64 trips a detector', () => {
    const planted = Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')
    const request = JSON.stringify({
      dir: 'in',
      line: {
        v: 1,
        t: 'req',
        id: '*',
        method: 'write',
        params: { reps: [{ mime: 'text/plain', uti: null, b64: planted }], transient: false },
      },
    })
    const body = CLEAN_TRANSCRIPT + request + '\n'
    expect(scanTranscript(write(dir, 'planted-write.ndjson', body), stubDetect)).toEqual([
      'planted-write.ndjson:4: E_SECRET write rep text/plain b64 trips awsAccessKeyId',
    ])
  })

  it('check 3: fails a frontmostBundleId outside the allowlist', () => {
    const body = CLEAN_TRANSCRIPT.replace('com.apple.TextEdit', 'com.evil.Keylogger')
    expect(scanTranscript(write(dir, 'bad-bundle.ndjson', body), stubDetect)).toEqual([
      'bad-bundle.ndjson:3: E_BUNDLE_ID com.evil.Keylogger is not an allowlisted bundle id',
    ])
    for (const allowed of [
      'com.apple.TextEdit',
      'com.apple.finder',
      'com.apple.screencaptureui',
      'com.google.Chrome',
      'com.1password.1password',
      'app.cairn.desktop',
    ]) {
      expect(ALLOWED_BUNDLE_ID.test(allowed), allowed).toBe(true)
    }
    expect(ALLOWED_BUNDLE_ID.test('com.evil.Keylogger')).toBe(false)
    expect(ALLOWED_BUNDLE_ID.test('org.mozilla.firefox')).toBe(false)
  })

  it('check 4: fails a transcript over 512 KiB', () => {
    const chunk = JSON.stringify({
      dir: 'out',
      line: {
        v: 1,
        t: 'ev',
        event: 'rep.chunk',
        data: { b64: 'A'.repeat(600 * 1024), final: true, repId: 'r1', seq: 0 },
      },
    })
    const path = write(dir, 'too-big.ndjson', CLEAN_TRANSCRIPT + chunk + '\n')
    expect(statSync(path).size).toBeGreaterThan(MAX_TRANSCRIPT_BYTES)
    expect(scanTranscript(path, stubDetect)[0]).toMatch(
      /^too-big\.ndjson:0: E_TOO_BIG \d+ bytes is over the 512 KiB limit/,
    )
  })
})

describe('every committed transcript is synthetic and secret-free', () => {
  it("runs the product's own detectors over fixtures/agent-transcripts, or fails closed", async () => {
    let detect: ((text: string) => readonly string[]) | null = null
    try {
      detect = await loadDetector()
    } catch {
      detect = null
    }
    const files = listTranscripts()

    if (detect === null) {
      // @cairn/privacy is Task 7's. Until it exists the scanner must REFUSE to scan rather than
      // report a clean run it never performed, so that is what is asserted here — this branch can
      // never become a silent pass.
      expect(existsSync(PRIVACY_INDEX)).toBe(false)
      if (files.length > 0) {
        const cli = spawnSync(process.execPath, [SCANNER], { encoding: 'utf8' })
        expect(cli.status).toBe(2)
        expect(cli.stderr).toContain('FATAL @cairn/privacy is not available yet')
      }
      return
    }

    expect(files.length).toBeGreaterThan(0)
    const findings = files.flatMap((file) => scanTranscript(file, detect))
    expect(findings).toEqual([])

    // Mutation proof against the real detectors: a planted AWS key in a temp COPY must be caught.
    const dir = mkdtempSync(join(tmpdir(), 'cairn-scan-real-'))
    const source = files[0] as string
    const planted = readFileSync(source, 'utf8').replace(
      '"inline":"aGVsbG8gd29ybGQ="',
      `"inline":"${Buffer.from('AKIA2E0PQIN4XA7QD').toString('base64')}"`,
    )
    const path = join(dir, 'planted.ndjson')
    writeFileSync(path, planted)
    const caught = scanTranscript(path, detect)
    expect(caught.length, `no detector fired on a planted AWS key in ${source}`).toBeGreaterThan(0)
    expect(caught[0]).toContain('E_SECRET')
  })
})
```

Run it and watch it fail for the right reason:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security security/transcripts-synthetic.security.test.ts
```

Expected: FAIL before a single test runs, with
`Error: Failed to load url ../scripts/scan-transcripts.mjs`. That is the whole point of this step:
before today, `npm run scan:transcripts` and `npm run verify` failed the same way and nothing in the
plan created the file.

- [ ] **Step 36: Implement `scripts/scan-transcripts.mjs`.**

Contract §7's four checks, and nothing else. `scanTranscript` takes the detector as an argument so the
CLI and the security test are the same function; `loadDetector` imports `@cairn/privacy` and the
detectors are never reimplemented here, because a second copy of a secret detector is a second copy
that can drift.

Create `scripts/scan-transcripts.mjs`:

```js
/**
 * Contract §7: every committed transcript under fixtures/agent-transcripts/ is SYNTHETIC and
 * secret-free. This is the CI enforcement of that sentence, wired to `npm run scan:transcripts` and
 * chained into `npm run verify`.
 *
 * The four checks, verbatim from the contract. A transcript fails if it:
 *   1. has no meta line, or `meta.synthetic !== true`;
 *   2. contains a `Rep.inline` or a `rep.chunk.b64` whose decoded bytes, interpreted as UTF-8, trip
 *      any detector in `@cairn/privacy` — the SAME code path as the product, so the scan cannot drift;
 *   3. contains a `frontmostBundleId` outside a small allowlist of well-known bundle ids;
 *   4. is over 512 KiB, which is a sign someone committed a real screenshot.
 *
 * `scanTranscript` takes the detector as an argument so
 * security/transcripts-synthetic.security.test.ts runs this exact function rather than a copy of it.
 * The detectors themselves are never reimplemented here: `loadDetector()` imports @cairn/privacy, and
 * if that package is not built yet the CLI exits 2 rather than reporting a clean scan it did not
 * perform.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = cannot scan.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TRANSCRIPT_DIR = join(REPO_ROOT, 'fixtures', 'agent-transcripts')
export const MAX_TRANSCRIPT_BYTES = 512 * 1024
export const ALLOWED_BUNDLE_ID =
  /^(com\.apple\.[A-Za-z0-9._-]+|com\.google\.Chrome|com\.1password\.1password|app\.cairn\.desktop)$/

/** Every committed transcript, sorted. `*.raw.ndjson` recordings are gitignored and never scanned. */
export function listTranscripts() {
  if (!existsSync(TRANSCRIPT_DIR)) return []
  return readdirSync(TRANSCRIPT_DIR)
    .filter((f) => f.endsWith('.ndjson') && !f.endsWith('.raw.ndjson'))
    .sort()
    .map((f) => join(TRANSCRIPT_DIR, f))
}

/** Every base64 payload one frame can carry, labelled for the failure line. */
function payloadsOf(wire) {
  const out = []
  const reps = wire?.data?.reps ?? wire?.result?.reps ?? []
  for (const rep of reps) {
    if (typeof rep?.inline === 'string') out.push([`rep ${String(rep.mime)} inline`, rep.inline])
  }
  if (wire?.event === 'rep.chunk' && typeof wire?.data?.b64 === 'string') {
    out.push([`rep.chunk seq ${String(wire.data.seq)} b64`, wire.data.b64])
  }
  // An `in` write frame carries the bytes the host asked the agent to put on the pasteboard. The
  // contract names Rep.inline and rep.chunk.b64; scanning this third one too costs nothing and a
  // committed self-write fixture is exactly where a real recalled secret would hide.
  for (const rep of wire?.params?.reps ?? []) {
    if (typeof rep?.b64 === 'string') out.push([`write rep ${String(rep.mime)} b64`, rep.b64])
  }
  return out
}

/**
 * @param {string} path absolute path to a committed *.ndjson transcript
 * @param {(text: string) => readonly string[]} detect names of the detectors that fired, if any
 * @returns {string[]} one named finding per violation; empty means clean
 */
export function scanTranscript(path, detect) {
  const name = basename(path)
  const findings = []
  const add = (line, message) => findings.push(`${name}:${line}: ${message}`)

  const bytes = statSync(path).size
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    add(0, `E_TOO_BIG ${bytes} bytes is over the 512 KiB limit — did someone commit a real screenshot?`)
  }

  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  let meta = null
  try {
    meta = JSON.parse(lines[0] ?? 'null')
  } catch {
    meta = null
  }
  if (meta === null || meta.t !== 'meta') {
    add(1, 'E_NO_META line 1 is not a meta frame')
  } else if (meta.synthetic !== true) {
    add(1, `E_NOT_SYNTHETIC meta.synthetic is ${JSON.stringify(meta.synthetic)}, must be true`)
  }

  for (const [index, text] of lines.entries()) {
    if (index === 0) continue
    const lineNo = index + 1
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      add(lineNo, 'E_BAD_JSON frame does not parse as JSON')
      continue
    }
    const wire = frame?.line ?? {}
    const bundleId = wire?.data?.frontmostBundleId
    if (typeof bundleId === 'string' && !ALLOWED_BUNDLE_ID.test(bundleId)) {
      add(lineNo, `E_BUNDLE_ID ${bundleId} is not an allowlisted bundle id`)
    }
    for (const [label, b64] of payloadsOf(wire)) {
      const fired = detect(Buffer.from(b64, 'base64').toString('utf8'))
      if (fired.length > 0) add(lineNo, `E_SECRET ${label} trips ${[...fired].join(', ')}`)
    }
  }
  return findings
}

/**
 * The product's own detectors, never a copy of them. Throws if @cairn/privacy has not been built yet
 * (Task 7 owns it) — the caller must fail closed rather than scan with something weaker.
 */
export async function loadDetector() {
  const { ALL_DETECTORS, detectSpans } = await import('@cairn/privacy')
  if (typeof detectSpans !== 'function' || !Array.isArray(ALL_DETECTORS)) {
    throw new Error('@cairn/privacy does not export detectSpans and ALL_DETECTORS')
  }
  return (text) => [...new Set(detectSpans(text, ALL_DETECTORS).map((span) => span.detector))]
}

export async function main() {
  const files = listTranscripts()
  if (files.length === 0) {
    console.error('scan-transcripts: 0 transcripts under fixtures/agent-transcripts/ — nothing to scan')
    return 0
  }
  let detect
  try {
    detect = await loadDetector()
  } catch (error) {
    console.error(
      `scan-transcripts: FATAL @cairn/privacy is not available yet: ${String(error?.message ?? error)}`,
    )
    console.error(
      `  Refusing to scan ${files.length} transcript(s) with anything other than the product's own\n` +
        '  detectors (contract §7). Build packages/privacy (Task 7) and re-run.',
    )
    return 2
  }
  const findings = files.flatMap((file) => scanTranscript(file, detect))
  for (const finding of findings) console.error(`scan-transcripts: ${finding}`)
  console.error(`scan-transcripts: ${files.length} transcript(s) scanned, ${findings.length} finding(s)`)
  return findings.length === 0 ? 0 : 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main())
```

The root `tsconfig.json` does not set `allowJs`, so a `.ts` test importing a `.mjs` would fail
`npm run typecheck` with `TS2307: Cannot find module '../scripts/scan-transcripts.mjs' or its
corresponding type declarations.` The fix is a hand-written sidecar declaration, which
`moduleResolution: "bundler"` resolves for a `.mjs` specifier. `[verified]` with `tsc 5.9.3` under this
repo's exact `compilerOptions`: with the sidecar, `tsc --noEmit` exits 0; without it, TS2307.

Create `scripts/scan-transcripts.d.mts`:

```ts
export declare const TRANSCRIPT_DIR: string
export declare const MAX_TRANSCRIPT_BYTES: number
export declare const ALLOWED_BUNDLE_ID: RegExp
export declare function listTranscripts(): string[]
export declare function scanTranscript(
  path: string,
  detect: (text: string) => readonly string[],
): string[]
export declare function loadDetector(): Promise<(text: string) => readonly string[]>
export declare function main(): Promise<number>
```

- [ ] **Step 37: Run the scanner and its security test, and prove the fail-closed path.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security security/transcripts-synthetic.security.test.ts
npm run typecheck
```

Expected: `Tests  9 passed (9)`, and `typecheck` clean — the sidecar declaration is what makes the
second command pass.

Now the CLI, which is what CI actually runs:

```sh
npm run scan:transcripts; echo "exit=$?"
```

Expected, and both are correct answers depending on what has merged into `main`:

- Task 3 and Task 7 have merged, so the seven transcripts and `@cairn/privacy` are present:
  `scan-transcripts: 7 transcript(s) scanned, 0 finding(s)` and `exit=0`.
- Nothing else has merged yet, so `fixtures/agent-transcripts/` is empty:
  `scan-transcripts: 0 transcripts under fixtures/agent-transcripts/ — nothing to scan` and `exit=0`.
- Task 3 merged but Task 7 has not, so there are transcripts and no detectors:
  `scan-transcripts: FATAL @cairn/privacy is not available yet: Cannot find package '@cairn/privacy'`
  and `exit=2`. **This is the correct outcome, not a bug** — the alternative is a scan that reports
  clean without having looked, and the security test above asserts exactly this exit code.

Finally, prove the scan can actually fail, using a temp copy so no committed fixture is touched:

```sh
if [ -f fixtures/agent-transcripts/hello-watch-text.ndjson ] && [ -f packages/privacy/src/index.ts ]; then
  sed 's/"inline":"aGVsbG8gd29ybGQ="/"inline":"QUtJQTJFMFBRSU40WEE3UUQ="/' \
    fixtures/agent-transcripts/hello-watch-text.ndjson \
    > fixtures/agent-transcripts/planted.ndjson
  npm run scan:transcripts; echo "exit=$?"
  rm -f fixtures/agent-transcripts/planted.ndjson
  git status --short fixtures/
else
  echo "SKIPPED: needs Task 3's fixture and Task 7's packages/privacy on this branch"
fi
```

Expected, when both are present: a line ending
`planted.ndjson:6: E_SECRET rep text/plain inline trips awsAccessKeyId`, then `exit=1`, then
`git status --short fixtures/` prints **nothing**. That base64 is `AKIA2E0PQIN4XA7QD` — a documentation
example, not anybody's key. `planted.ndjson` has to live in `fixtures/agent-transcripts/` for one
command because that is the only directory the CLI scans; the `rm` and the `git status` on the two lines
after it are what keep it from ever reaching a commit. `.gitignore` covers `*.raw.ndjson`, not this
name, so do not skip them.

- [ ] **Step 38: Commit the recorder, the scanner and the transcript security test.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git status --short fixtures/
git add tools/record-transcript.ts scripts/scan-transcripts.mjs scripts/scan-transcripts.d.mts \
        security/transcripts-synthetic.security.test.ts
git commit -m "test(agent-macos): raw transcript recorder, the contract §7 transcript scanner and its security test"
```

Expected: `git status --short fixtures/` prints nothing, and the commit touches exactly four files.
No fixture is added, modified or deleted by this task.

- [ ] **Step 39: Write the security test that bans a filesystem write path and a network API in the agent.**

Create `security/agent-no-file-writes.security.test.ts` — one file, three `it()`s: an anti-vacuity
check, the filesystem ban and the egress ban. Both bans live here for the same reason, which is that
`agents/**` is outside the roots every other source scan walks, and this is the process that holds
clipboard bytes first.

It reuses Task 1's `security/source-scan.ts` rather than rolling a private walker. That is not
tidiness: `source-scan.ts`'s `stripComments` is quote-aware and `sourceFiles` already knows `.swift`,
so `let doc = "https://example.com/x" ; let _ = URLSession.shared` is still a hit. A naive
`source.replace(/\/\/.*$/gm, '')` would treat the `//` inside that URL string as the start of a
comment and silently drop the rest of the line — a ban with a hole in it. `[verified]` against the
real `source-scan.ts`: that line reports
`agents/macos/Sources/Wire.swift:<line>: let doc = "https://example.com/x" ; let _ = URLSession.shared`,
and the finished file typechecks under `tsconfig.base.json`'s `strict` + `moduleResolution: bundler`
settings, which is why `./source-scan` needs no file extension.

```ts
import { basename } from 'node:path'
import { expect, it } from 'vitest'
import { findInSources, formatHits, sourceFiles } from './source-scan'

/**
 * Spec §11 control 1: clipboard bytes never touch the disk unencrypted, at any point, and nothing
 * egresses. The agent is the process that holds them first, so it must have no filesystem write path
 * and no network API at all — its only sinks are stdout (protocol) and stderr (human text). An earlier
 * revision of this design spooled oversized representations to $TMPDIR; this file is what stops that
 * coming back.
 *
 * `security/no-plaintext-on-disk.security.test.ts` (Task 6) scans packages/** and apps/desktop/**, and
 * Task 9's `security/no-socket-at-startup.security.test.ts` scans packages/**, apps/desktop/** and
 * tools/**. The Swift agent is outside both sets of roots, which is why this file exists.
 *
 * `agents/macos/Tests/` is deliberately NOT a root: `--mark files` legitimately builds
 * `URL(fileURLWithPath:)` for /bin/ls, and SelfTest.swift is a test binary that never ships.
 */
const AGENT_SOURCES = ['agents/macos/Sources']

/** Every way a byte could reach the disk from Swift, including the two read forms. */
const BANNED_FS = [
  'FileManager',
  'createFile',
  'write(toFile',
  'writeToFile',
  'NSTemporaryDirectory',
  'mkstemp',
  'mkdtemp',
  'fopen(',
  'fwrite(',
  'FileHandle(forWritingAtPath',
  'FileHandle(forUpdatingAtPath',
  'URL(fileURLWithPath',
  'Data(contentsOf',
  'String(contentsOf',
  'UserDefaults',
  'CFPreferences',
]

/**
 * Spec §11 control 1's other half: no telemetry, no egress, in any form. Every entry is a way bytes
 * could leave this process other than stdout/stderr — a URL load, a raw socket, an XPC peer, or a
 * child process (a `Process` running `/usr/bin/curl` is egress with extra steps, and spec §11
 * control 3 wants no shell in the capture path on macOS at all). Bare `Network` catches
 * `import Network` before `NWConnection` is ever spelled.
 */
const BANNED_EGRESS = [
  'URLSession',
  'URLRequest',
  'NSURLConnection',
  'NWConnection',
  'NWListener',
  'NWBrowser',
  'Network',
  'NetService',
  'CFSocket',
  'CFStream',
  'socket(',
  'getaddrinfo',
  'NSXPCConnection',
  'Process(',
  'posix_spawn',
  'popen(',
  'system(',
]

it('scans a non-empty set of agent sources, so a zero-hit result means something', () => {
  const files = sourceFiles(AGENT_SOURCES).map((f) => basename(f))
  expect(files).toContain('main.swift')
  expect(files).toContain('Wire.swift')
  expect(files).not.toContain('SelfTest.swift')
})

it('the macOS agent has no filesystem write path for clipboard bytes', () => {
  for (const banned of BANNED_FS) {
    expect(formatHits(findInSources(banned, AGENT_SOURCES)), `banned: ${banned}`).toBe('')
  }
})

it('the macOS agent has no network egress path and spawns no child process', () => {
  for (const banned of BANNED_EGRESS) {
    expect(formatHits(findInSources(banned, AGENT_SOURCES)), `banned: ${banned}`).toBe('')
  }
})
```

The first `it()` is the anti-vacuity check: if `agents/macos/Sources` were ever renamed,
`sourceFiles` would return `[]` and both bans would pass over nothing, so the file list is asserted
before either ban runs. `[verified]` — run against a directory holding every Swift block in this task,
`Tests/SelfTest.swift` included, the only hit in either list is
`URL(fileURLWithPath` on SelfTest's `--mark files` line, which is why `Tests/` is not a root.

- [ ] **Step 40: Prove both bans fail when the control is removed, then restore them.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
printf '\n// deliberate violation\nlet _ = FileManager.default.temporaryDirectory\n' >> agents/macos/Sources/Chunker.swift
npx vitest run --project security security/agent-no-file-writes.security.test.ts
```

Expected: `Tests  1 failed | 2 passed (3)`, and the failure is the filesystem ban:
`AssertionError: banned: FileManager: expected 'agents/macos/Sources/Chunker.swift:<line>…' to be ''`,
with the raw offending line printed under it. Now undo, and plant the egress violation instead:

```sh
git checkout agents/macos/Sources/Chunker.swift
printf '\nlet doc = "https://example.com/x" ; let _ = URLSession.shared\n' >> agents/macos/Sources/Wire.swift
npx vitest run --project security security/agent-no-file-writes.security.test.ts
```

Expected: `Tests  1 failed | 2 passed (3)`, and this time it is the egress ban:
`AssertionError: banned: URLSession: expected 'agents/macos/Sources/Wire.swift:<line>…' to be ''`. The
`https://` in that line is the point — it proves the shared quote-aware `stripComments` did not read
the URL's `//` as a comment and swallow the `URLSession` after it. Restore and re-run:

```sh
git checkout agents/macos/Sources/Wire.swift
npx vitest run --project security security/agent-no-file-writes.security.test.ts
```

Expected: `Tests  3 passed (3)`. The two `git checkout`s put `Chunker.swift` and `Wire.swift` back
exactly as committed — `git status --short agents/` must print nothing before you move on.

- [ ] **Step 41: Commit.**

```sh
git status --short agents/
git add security/agent-no-file-writes.security.test.ts
git commit -m "test(security): the macOS agent has no filesystem write path and no network egress"
```

Expected: `git status --short agents/` prints nothing, and the commit touches exactly one file.

- [ ] **Step 42: Full verify.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
make clean && make agent
npx vitest run tools/agent-selftest.test.ts
./agents/macos/build/cairn-agent-selftest | grep -c '^ok'
npx vitest run --project security security/agent-no-file-writes.security.test.ts security/transcripts-synthetic.security.test.ts
git status --short fixtures/
npm run verify
```

Expected: a clean rebuild; `2 passed` from `agent-selftest.test.ts`; the count is `63`; `12 passed`
across the two security files (9 transcript checks, plus the agent file's anti-vacuity check, its
no-file-writes ban and its no-egress ban); `git status --short fixtures/` prints **nothing**; and
`npm run verify` green —
`guard:no-rebuild`, `typecheck`, `vitest run` over all three projects (`unit`, `security`, `renderer`),
and `scan:transcripts`.

`npm run typecheck` covers `tools/record-transcript.ts` because the root `tsconfig.json` includes
`tools/**/*.ts`, and it covers the `.mjs` scanner's public surface through
`scripts/scan-transcripts.d.mts`, resolved from the import in
`security/transcripts-synthetic.security.test.ts`.

One conditional outcome, and it is the honest one: if Task 3's transcripts are on `main` but Task 7's
`packages/privacy/src/index.ts` is not, `scan:transcripts` exits **2** with
`scan-transcripts: FATAL @cairn/privacy is not available yet`, so `npm run verify` is red at that step.
That is correct — contract §7 requires the product's own detectors and the alternative is a scan that
reports clean without looking. Merge Task 7 (or check out a tree that has it) and re-run; do not
weaken the scanner to make this line green.

- [ ] **Step 43: Push the branch.**

```sh
git push -u origin m1/04-macos-agent
```

Expected: the branch is on the remote and the user can open a PR. Nothing was committed to `main`.

---

**Task 4 done when:**

- [ ] `make agent` produces `agents/macos/build/cairn-agent-macos`, a `Mach-O 64-bit executable`, from a clean tree with Command Line Tools only, in under 5 s.
- [ ] `npx vitest run tools/agent-selftest.test.ts` reports `2 passed`; running the built `cairn-agent-selftest` prints 63 `ok   - …` lines, zero `FAIL`, and `ALL PASS`.
- [ ] Changing any numeric literal in `Wire.swift`'s frozen-limits block makes `tools/agent-selftest.test.ts`'s drift-guard test fail, and `grep -c WIRE_MAJOR agents/macos/Sources/Wire.swift` prints `0` — the wire major comes only from the generated `protocolVersion`.
- [ ] `swiftc -typecheck` of Step 2's shape probe against `AgentProtocol.generated.swift` exits 0, and no file under `agents/macos/Sources/` declares a struct the generator already emits (`grep -c 'struct WriteRep' agents/macos/Sources/*.swift` prints `0` for every file).
- [ ] `npx vitest run --project security security/agent-no-file-writes.security.test.ts` reports `3 passed`; appending `let _ = FileManager.default` to any file in `agents/macos/Sources/` fails the filesystem ban with `banned: FileManager`, and appending `let doc = "https://example.com/x" ; let _ = URLSession.shared` fails the egress ban with `banned: URLSession` — the URL string proves the comment stripper is quote-aware.
- [ ] `grep -rn "FileManager\|createFile\|mkstemp\|NSTemporaryDirectory\|fopen(" agents/macos/Sources/` returns nothing outside a comment.
- [ ] `grep -rn "URLSession\|NWConnection\|import Network\|CFSocket\|socket(\|NSXPCConnection\|Process(" agents/macos/Sources/` returns nothing at all: the process that holds clipboard bytes first has no egress path and spawns no child.
- [ ] Piping `hello` + `watch.start` into the agent and running `printf 'hello world' | pbcopy` emits one `clipboard.changed` whose single rep is `{"byteLength":11,"inline":"aGVsbG8gd29ybGQ=","mime":"text/plain","sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","uti":"public.utf8-plain-text"}`.
- [ ] `cairn-agent-selftest --mark concealed` makes the agent emit `"hints":["concealed"],"reps":[]` and a `pasteboard.concealed-skipped` log event — zero reps, zero bytes read.
- [ ] `cairn-agent-selftest --mark tiff` makes the agent emit one `image/png` rep of 131 601 bytes carrying `repId` and no `inline`, followed by exactly 5 `rep.chunk` events, `final: true` only on `seq: 4`, the first four `b64` fields exactly 43 692 characters, all of them **after** the declaring `clipboard.changed` line.
- [ ] `cairn-agent-selftest --mark files` makes the agent emit exactly one `text/uri-list` rep decoding to `file:///bin/ls\nfile:///bin/cat\n`.
- [ ] `cairn-agent-selftest --mark chrome` makes the agent emit `text/plain` followed by `text/x-source-url`.
- [ ] A `write` request returns `{"changeToken":"<n>"}` where `<n>` equals the pasteboard's `changeCount` afterwards, `pbpaste` shows the written text, and with `transient:true` the pasteboard item also carries `org.nspasteboard.TransientType` and `org.nspasteboard.AutoGeneratedType`.
- [ ] A `write` whose `b64` is not valid base64 answers `{"code":"E_BAD_PARAMS",...}`, leaves the pasteboard untouched, and emits no log event — `grep -c 'write.bad-base64' agents/macos/Sources/*.swift` prints `0` for every file.
- [ ] `hotkey.register{"accelerator":"Cmd+Shift+V"}` answers `{"bound":true,...}`, and pressing `Cmd+Shift+V` in another app — **including while a password field is focused** — emits a `hotkey.fired` event with a non-empty `focusToken`. `hotkey.register{"accelerator":"Bogus+Nope"}` answers `{"bound":false,...}` and never an error response.
- [ ] `shutdown` answers `{"bye":true}` and the process exits 0; closing stdin also exits 0.
- [ ] `node tools/record-transcript.ts record x 5` without the acknowledgement flag exits 2 and creates no file.
- [ ] `git status --short fixtures/` prints **nothing**, and `git diff --name-only origin/main..HEAD -- fixtures/` prints nothing: this task creates, modifies and deletes no fixture. Every file under `fixtures/agent-transcripts/` belongs to Task 3 or Task 7.
- [ ] No `*.raw.ndjson` remains in the working tree, and `node tools/record-transcript.ts` with no arguments prints a usage block that has no `promote` subcommand.
- [ ] `npx vitest run --project security security/transcripts-synthetic.security.test.ts` reports `9 passed`, and each of the four contract §7 checks has its own test that fails when the violation is planted in a temp copy.
- [ ] `npm run scan:transcripts` exits 0 on a clean tree, exits 1 with a `E_SECRET … trips …` line when an `AKIA2E0PQIN4XA7QD` payload is planted in a temp copy, and exits 2 with `FATAL @cairn/privacy is not available yet` rather than 0 when `packages/privacy/src/index.ts` is absent.
- [ ] `npm run typecheck` is clean, which requires `scripts/scan-transcripts.d.mts` to exist — the root `tsconfig.json` sets no `allowJs`.
- [ ] `npm run verify` is green on a tree where Tasks 1, 2, 3 and 7 have merged.
- [ ] `git log --oneline origin/main..m1/04-macos-agent` shows 8 conventional commits, none with a `Co-Authored-By` or any AI-attribution trailer, and `git branch --contains HEAD` does not list `main`.
