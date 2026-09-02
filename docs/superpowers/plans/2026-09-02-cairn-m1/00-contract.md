# Cairn M1 — FROZEN CONTRACT

**Status:** frozen. Every task section in this plan must match this file exactly.
**Scope:** Milestone 1 only (spec §8, row 1), macOS only.
**Source of truth for behaviour:** `docs/superpowers/specs/2026-09-02-cairn-clipboard-manager-design.md`.

If a task needs a name, a type, a version, a constant, an error code or a file path, it is in here.
If you think this file is wrong, say so in the plan review — **do not** invent a second name.

Everything below marked `[verified]` was executed on this machine (macOS 26.5.1, arm64, Node
24.20.0, npm 11.19.0, swiftc 6.3.3) while writing this contract. Everything marked
`[decided here]` is a choice this contract makes because the spec is silent.

---

## 0. What M1 is, and what it is not

**M1 demo (spec §8):** copy text, an image and a couple of files in Finder. Press the hotkey
anywhere, type a few out-of-order letters, arrow to the item, press Enter — the item is on the
clipboard and a toast says `Copied — press Cmd+V`. Copy a password out of 1Password and nothing is
recorded. Copy an AWS key by hand and the palette shows `AKIA••••A7QD` and expires it in 5 minutes.
Quit and relaunch: history intact, and `grep` for the copied string finds nothing in any file on disk.

**In M1, deliberately:**

- The full privacy layer: OS concealed-type hints **and** the secret detectors **and** masking at
  ingest. Spec §11 control 5 says detection ships in M1, "the whole point is that there is no window
  in which the app records passwords in the clear."
- Encrypted append-only store with the hash chain, encrypted blobs, `0700`/`0600`.
- Carbon global hotkey through the Swift agent, with the "my hotkey is dead" state.
- The `security` vitest project (§8 of this contract), green.

**NOT in M1 — do not add, do not stub, do not reference from a task section:**

| Thing | Milestone | Why not now |
|---|---|---|
| Auto-paste / `CGEventPost` / `@cairn/paste` | M2 | Enter puts the item on the real clipboard and toasts. |
| `focus.capture` / `focus.restore` / `permission.*` / `secureInput.check` agent methods | M2 | Only needed to synthesize a keystroke. |
| Per-app exclusion list UI and rules | M2 | The `excluded` flag exists in the type union so `assertSyncable` covers it; nothing sets it in M1. |
| `tools/doctor.ts`, `npm run doctor` | M2 | |
| `npm run dev:signed`, code signing, DMG, electron-builder, login item, tray, Settings, updater | M3 | M1 needs **zero** TCC grants: NSPasteboard reads, NSWorkspace attribution and Carbon hotkeys are all permission-free (spec §6). |
| `agents/win32`, `agents/linux`, tier detection | M4 | The `AgentCapabilities` shape carries the fields already so M4 is additive. |
| `@cairn/sync-protocol`, `@cairn/sync-server`, mDNS, `noise-handshake`, `cbor-x`, `ws`, `qrcode`, `bonjour-service` | M5–M6 | Not a dependency, not a package directory, not an import. |
| `crashReporter`, telemetry, analytics, any socket, any custom URI scheme | never | Spec §11 controls 1 and 10. |
| `tsup`, `@electron/rebuild`, `node-gyp`, `better-sqlite3*` | never in M1 | See §2 and §9. |

Two day-0 spikes from spec §8, timeboxed to one afternoon, belong to the M1 plan but produce
**notes, not product code**: (a) does `BrowserWindow{type:'panel'}` still yield an `NSPanel` in
Electron 44 — creation succeeds `[verified]`, the remaining question is whether the native window is
really an `NSPanel`; (b) TCC attribution of an Accessibility request to the Swift helper vs the
parent — record the answer for M2, M1 asks for no permission.

---

## 1. The M1 file tree

Every file M1 creates. One line each. This tree is the **completeness check**: if a task creates a
file, it has a row here. Nothing is "obvious enough to omit", and a later task must never delete a
file it cannot find here.

`*.test.ts` files run in the `unit` vitest project, **except** those under
`apps/desktop/renderer/src/`, which run in the `renderer` project (a jsdom + Svelte program; §2).
`*.security.test.ts` files run in the `security` project (§8) wherever they live.

```
.nvmrc                                     24.20.0 — required, not advisory: jsdom needs require(esm)
.npmrc                                     ignore-scripts=true + exact saves (§2)
Makefile                                   the swiftc invocation for the macOS agent (§2)
package.json                               npm workspaces root, all devDependencies, all scripts
package-lock.json                          committed; npm ci in CI
tsconfig.base.json                         shared strictness, no lib/types (§2)
tsconfig.json                              node side: packages, main, preload, tools, security
vitest.config.ts                           THREE projects: unit + renderer + security (§2)
electron.vite.config.ts                    main (cjs) / preload (cjs) / renderer (esm) (§2)
PLATFORM-NOTES.md                          the macOS capability row + the measured facts M1 relies on
.github/workflows/ci.yml                   guard, typecheck, all three vitest projects, transcript scan

scripts/guard-no-electron-rebuild.mjs      fails the build if @electron/rebuild or node-gyp appear anywhere
scripts/scan-transcripts.mjs               CI: committed transcripts must be synthetic and secret-free
scripts/scan-transcripts.d.mts             the sidecar .d.mts so a .ts test may import that .mjs (no allowJs)

packages/protocol/package.json             @cairn/protocol manifest
packages/protocol/src/index.ts             the only public entry: ELEVEN re-export lines (§5)
packages/protocol/src/constants.ts         THE one naming/limits file (§10)
packages/protocol/src/constants.test.ts    9 assertions over the frozen names, limits and maskToken
packages/protocol/src/log.ts               the six log names, all 46 LOG_EVENTS ids, NO createLogger (§5.3)
packages/protocol/src/log.test.ts          LOG_EVENTS holds 46 ids, no duplicates, no free-form message
packages/protocol/src/result.ts            Result<T>, ok(), err(), ERROR_CODES, ErrorCode (§6)
packages/protocol/src/types.ts             every shared domain type (§5)
packages/protocol/src/types.test.ts        compile-time assertions via @ts-expect-error on LogFields
packages/protocol/src/clock.ts             Clock, systemClock, createTestClock
packages/protocol/src/clock.test.ts        test clock advances and fires timers deterministically
packages/protocol/src/hash.ts              contentHash(bytes) -> 'sha256-<b64url>'
packages/protocol/src/hash.test.ts         known-answer vectors for contentHash
packages/protocol/src/id.ts                newItemId(nowMs, rnd) -> 26-char Crockford base32
packages/protocol/src/id.test.ts           monotonic, lexicographically sortable, 26 chars
packages/protocol/src/agent.ts             the frozen agent NDJSON zod schemas (§3)
packages/protocol/src/agent.test.ts        envelope, framing, unknown-keys-ignored, Rep rules
packages/protocol/src/parse-agent-line.ts  parseAgentLine(s): Result<AgentLine>
packages/protocol/src/parse-agent-line.test.ts  torn lines, huge lines, wrong wire major
packages/protocol/src/ipc.ts               the frozen renderer IPC zod schemas (§5.9)
packages/protocol/src/ipc.test.ts          both directions validated; malformed rejected
packages/protocol/src/testing.ts           REPO_ROOT + fixturePath(...p) — the one fixture-path helper (§7)
packages/protocol/src/testing.test.ts      fixturePath resolves from the file, so a test's cwd never matters

packages/agent-host/package.json           @cairn/agent-host manifest
packages/agent-host/src/index.ts           public entry: spawnAgent, createFakeAgent, types
packages/agent-host/src/framing.ts         createLineSplitter(): Buffer chunks -> whole lines
packages/agent-host/src/framing.test.ts    split mid-line, split mid-UTF8, MAX_LINE_BYTES guard
packages/agent-host/src/reassembler.ts     the rep.chunk state machine (§4)
packages/agent-host/src/reassembler.test.ts  happy path + all 10 failure codes
packages/agent-host/src/correlator.ts      id -> pending promise, per-request timeouts
packages/agent-host/src/correlator.test.ts  timeout, late response, response for unknown id
packages/agent-host/src/spawn-agent.ts     child_process.spawn, restart with backoff, dispose
packages/agent-host/src/spawn-agent.test.ts  uses a node -e stub agent, not the Swift binary
packages/agent-host/src/fake-agent.ts      createFakeAgent(transcriptPath) (§7)
packages/agent-host/src/fake-agent.test.ts  asserts the outbound script and fails loudly on drift
packages/agent-host/src/transcript.ts      transcript file parser + zod schema (§7)
packages/agent-host/src/transcript.test.ts  rejects a transcript without a meta line

packages/capture/package.json              @cairn/capture manifest
packages/capture/src/index.ts              createCapture({agent, privacy, config, clock, logger})
packages/capture/src/normalize-reps.ts     normalizeReps(raw): TIFF->PNG, alias dedupe, uri-list
packages/capture/src/normalize-reps.test.ts  byte fixtures per format
packages/capture/src/classify-kind.ts      classifyKind(reps): ItemKind
packages/capture/src/classify-kind.test.ts  one case per kind + an unknown-mime fallback
packages/capture/src/thumbnail.ts          thumbnail(png): sharp -> JPEG 256px q70 <=24 KiB
packages/capture/src/thumbnail.test.ts     dimensions, format and the size ceiling
packages/capture/src/capture.ts            debounce, self-write suppression, candidate assembly
packages/capture/src/capture.test.ts       transcript-driven: debounce, duplicate notify, self-write
packages/capture/src/capture.security.test.ts  no file is created anywhere during a capture
packages/capture/src/stub-agent.ts         createStubAgent(): a hand-driven ClipboardAgent for tests
packages/capture/src/testing.ts            rep(), changed(), createSpyLogger() — capture's test builders

packages/privacy/package.json              @cairn/privacy manifest
packages/privacy/src/index.ts              classify, mask, assertSyncable, DEFAULT_RULES
packages/privacy/src/entropy.ts            shannonBits + highEntropyRuns (the frozen rule, §5.7)
packages/privacy/src/entropy.test.ts       the 4.0 arithmetic and the run-selection rules
packages/privacy/src/detectors.ts          the 10 named detectors
packages/privacy/src/detectors.test.ts     one positive and one near-miss per detector
packages/privacy/src/corpus.test.ts        fixtures/secrets/*: corpus trips, false-positive corpus does not
packages/privacy/src/mask.ts               mask(text): {preview, spans}
packages/privacy/src/mask.test.ts          AKIA... -> AKIA••••A7QD, span offsets exact
packages/privacy/src/classify.ts           classify(snapshot, rules): three layers, fail closed
packages/privacy/src/classify.test.ts      hint layer wins before any byte is read
packages/privacy/src/retention-policy.ts   secretExpiresAt + isPinnable — the ONE place SECRET_TTL_MS is applied
packages/privacy/src/retention-policy.test.ts  the 5-minute TTL arithmetic and the never-pinnable rule
packages/privacy/src/assert-syncable.ts    assertSyncable(item): void — THROWS by design
packages/privacy/src/assert-syncable.security.test.ts  throws for every flag in NON_SYNCABLE_FLAGS

packages/store/package.json                @cairn/store manifest
packages/store/src/index.ts                openStore({dir, key, clock, logger}) -> Store
packages/store/src/paths.ts                dataDirLayout(dir) + ensureDir0700 + writeFile0600
packages/store/src/paths.security.test.ts  0700 dir, 0600 files, asserted after every write
packages/store/src/record.ts               seal/open one AES-256-GCM line with the frozen AAD
packages/store/src/record.test.ts          roundtrip; reorder and kind-swap both fail to authenticate
packages/store/src/chain.ts                prevRecordHash chain build + verify
packages/store/src/chain.test.ts           swap, reorder, duplicate, truncate, delete all detected
packages/store/src/log-store.ts            appendEvent, readAll, compact, stat, CHECKPOINT
packages/store/src/log-store.test.ts       torn trailing line discarded; seq monotonic
packages/store/src/blobs.ts                putBlob, getBlob, deleteBlob with HKDF subkeys
packages/store/src/blobs.test.ts           content addressing, fsync-before-append, orphan GC
packages/store/src/testing.ts              tempStoreDir() and randomTestKey() for every test
packages/store/src/store.security.test.ts  a canary string never appears in bytes on disk

packages/keyring/package.json              @cairn/keyring manifest
packages/keyring/src/index.ts              createKeyring({safeStorage, platform, dir, logger})
packages/keyring/src/backend.ts            probeBackend(): the basic_text refusal policy
packages/keyring/src/backend.test.ts       refuses basic_text on linux; tolerates a missing API
packages/keyring/src/passphrase.ts         scrypt N=2^17 r=8 p=1 with the mandatory maxmem
packages/keyring/src/passphrase.test.ts     same passphrase+salt -> same key; wrong passphrase fails
packages/keyring/src/keyring.ts            getMode, getOrCreateMasterKey, unlockWithPassphrase, lock
packages/keyring/src/keyring.test.ts        key.bin wrap/unwrap; decrypt failure returns a re-key path
packages/keyring/src/testing.ts            createFakeSafeStorage() + createCapturingLogger() — no Electron
packages/keyring/src/keyring.security.test.ts  the master key Buffer is zero-filled on lock and quit

packages/history/package.json              @cairn/history manifest
packages/history/src/index.ts              createHistory({store, privacy, search, clock, logger})
packages/history/src/dedupe.ts             contentHash-based dedupe -> bump updatedAt, no new row
packages/history/src/dedupe.test.ts        copying the same thing twice yields one item
packages/history/src/retention.ts          500 items / 30 days / 512 MiB / secret TTL 300 s
packages/history/src/retention.test.ts     injected clock; pinned exempt; secrets expire at 300 s
packages/history/src/history.ts            ingest, list, search, resolveReps, pin, remove, evictNow
packages/history/src/history.test.ts       ingest masks at ingest; pin refused for secret-flagged

packages/search/package.json               @cairn/search manifest
packages/search/src/index.ts               createSearchIndex({limit}) -> {add, remove, query, size}
packages/search/src/index.test.ts          out-of-order letters match; empty query = pinned then recency
packages/search/src/index.security.test.ts  the index holds the masked preview, never the raw secret

packages/hotkey/package.json               @cairn/hotkey manifest
packages/hotkey/src/index.ts               createHotkey({agent, logger}) -> bind/current/status/onTrigger
packages/hotkey/src/index.test.ts          a false `bound` from the agent becomes status 'failed'

agents/macos/Sources/AgentProtocol.generated.swift  generated by npm run gen:agent-types — never hand-edited
agents/macos/Sources/Wire.swift            NDJSON read loop, one-line-per-object writer, sortedKeys
agents/macos/Sources/Pasteboard.swift      the serialised NSPasteboard queue, hint probe, reads
agents/macos/Sources/Chunker.swift         >=64 KiB reps -> rep.chunk events over stdout
agents/macos/Sources/Hotkey.swift          Carbon RegisterEventHotKey + the accelerator parser
agents/macos/Sources/Writer.swift          write{reps,transient} + the returned changeToken
agents/macos/Sources/main.swift            request dispatch, the DispatchSourceTimer poll, shutdown
agents/macos/Tests/SelfTest.swift          a pure-Swift assertion binary; never linked into the agent

apps/desktop/package.json                  @cairn/desktop manifest; NO "type" field (CJS output)
apps/desktop/main/src/constants.ts         window options, CSP strings, toast strings (§8)
apps/desktop/main/src/logger.ts            the concrete Logger: NDJSON to stderr, metadata only
apps/desktop/main/src/logger.security.test.ts  canary copied during the test never appears in output
apps/desktop/main/src/windows.ts           createPaletteWindow(): the hardened BrowserWindow
apps/desktop/main/src/windows.test.ts      the window flags, the CSP header and the navigation guards
apps/desktop/main/src/windows.security.test.ts  webPreferences match the frozen set exactly
apps/desktop/main/src/menu.ts              the explicit Edit-menu template + assertEditMenuIntact()
apps/desktop/main/src/menu.test.ts         Cmd+C/Cmd+V/Cmd+X survive; the assertion throws when one is cut
apps/desktop/main/src/config.ts            CairnConfig load/save; 0600 via openSync/writeSync/fchmodSync
apps/desktop/main/src/config.test.ts       round-trip, defaults on a missing file, a corrupt file falls back
apps/desktop/main/src/config.security.test.ts  the config file is 0600 and holds no clipboard content
apps/desktop/main/src/ipc-handlers.ts      one handler per enumerated channel, zod-validated
apps/desktop/main/src/ipc-handlers.test.ts  a malformed renderer message is rejected, not trusted
apps/desktop/main/src/wiring.ts            composeApp(deps): the pure composition root
apps/desktop/main/src/wiring.test.ts       full copy->ingest->search->recall against a fake agent
apps/desktop/main/src/index.ts             the Electron entry: app.setName, whenReady, composeApp

apps/desktop/preload/src/index.ts          contextBridge with a FIXED enumerated method set
apps/desktop/preload/src/index.security.test.ts  no invoke passthrough; the method list is exact

apps/desktop/renderer/index.html           the only HTML; carries the CSP meta tag
apps/desktop/renderer/svelte.config.mjs    vitePreprocess(); .mjs on purpose (§2)
apps/desktop/renderer/tsconfig.json        web side: DOM lib, ["vite/client","node"] types, no packages glob
apps/desktop/renderer/src/app.css          palette styling; no remote fonts, no @import url()
apps/desktop/renderer/src/api.ts           the typed wrapper over window.cairn
apps/desktop/renderer/src/api.test.ts      (renderer project) a malformed payload is rejected, not rendered
apps/desktop/renderer/src/testing.ts       the fake window.cairn every renderer test mounts against
apps/desktop/renderer/src/palette-state.svelte.ts  $state store: query, results, selection index
apps/desktop/renderer/src/palette-state.test.ts    (renderer project) arrow keys wrap; Enter picks the id
apps/desktop/renderer/src/main.ts          mount(Palette, {target})
apps/desktop/renderer/src/Palette.svelte   search field + list + toast host
apps/desktop/renderer/src/Palette.test.ts  (renderer project) the nine palette behaviours, end to end
apps/desktop/renderer/src/Palette.security.test.ts  the mounted palette holds at most 32 rows, all masked
apps/desktop/renderer/src/ItemRow.svelte   one row: kind glyph, masked preview, thumbnail, highlights
apps/desktop/renderer/src/Preview.svelte   text/plain or ESCAPED HTML source — never the raw-HTML directive
apps/desktop/renderer/src/Preview.security.test.ts  <img onerror> renders as text, not an element
apps/desktop/renderer/src/Toast.svelte     the "Copied — press Cmd+V" toast

spikes/electron-panel/package.json         spec §8 spike 1: does an accessory NSPanel keep focus?
spikes/electron-panel/main.cjs             the four PANEL/POLICY permutations, run by hand once
spikes/electron-panel/index.html           the spike's only markup
spikes/electron-panel/frontmost.swift      a permission-free frontmost-app observer for that spike
spikes/tcc-attribution/package.json        spec §8 spike 2: which process owns the TCC prompt?
spikes/tcc-attribution/parent.cjs          spawns the probe as a child and records the attribution
spikes/tcc-attribution/ax-probe.swift      the AXIsProcessTrusted probe the parent spawns

tools/gen-agent-types.ts                   zod -> AgentProtocol.generated.swift
tools/gen-agent-types.test.ts              regenerating is a no-op; a field rename changes output
tools/agent-selftest.test.ts               compiles + runs SelfTest.swift; Swift<->constants.ts drift guard
tools/record-transcript.ts                 capture a real pasteboard session to *.raw.ndjson

security/source-scan.ts                          the ONE shared source walker + quote-aware comment stripper
security/source-scan.test.ts                     (unit project) 13 tests over that stripper
security/no-plaintext-on-disk.security.test.ts   canary never appears under the data dir or a redirected TMPDIR
security/no-socket-at-startup.security.test.ts   no TCP/UDP handles, no control socket, no shell execution
security/no-crash-reporter.security.test.ts      the identifier crashReporter appears in no source file
security/no-uri-scheme.security.test.ts          no setAsDefaultProtocolClient, no CFBundleURLTypes
security/renderer-hardening.security.test.ts     CSP has no unsafe-inline; navigation handlers deny
security/no-html-sink.security.test.ts           no .svelte file contains the raw-HTML directive token
security/supply-chain.security.test.ts           lockfile committed, versions exact, guard passes
security/transcripts-synthetic.security.test.ts  every committed transcript is synthetic and clean
security/agent-no-file-writes.security.test.ts   the macOS agent has no filesystem and no network sink

fixtures/agent-transcripts/hello-watch-text.ndjson       hello -> watch.start -> one text copy
fixtures/agent-transcripts/image-tiff-chunked.ndjson     a 200 KB TIFF screenshot over rep.chunk
fixtures/agent-transcripts/finder-multifile.ndjson       a two-file Finder copy as text/uri-list
fixtures/agent-transcripts/concealed-1password.ndjson    a concealed-hint change with zero reps
fixtures/agent-transcripts/self-write-suppression.ndjson  our own write() must not be recaptured
fixtures/agent-transcripts/duplicate-notify.ndjson       two ticks, one changeCount, one candidate
fixtures/agent-transcripts/chrome-source-url.ndjson      mime text/x-source-url + uti org.chromium.source-url
fixtures/formats/plain-utf8.txt                          bare UTF-8 with an emoji and a CRLF
fixtures/formats/cf-html-wrapper.txt                     a CF_HTML blob with the Windows header
fixtures/formats/screenshot.tiff                         a small TIFF, for the TIFF->PNG path
fixtures/formats/screenshot.png                          the expected PNG conversion result
fixtures/formats/uri-list-two-files.txt                  two file:// URIs, LF terminated
fixtures/formats/rtf-minimal.rtf                         a minimal RTF document
fixtures/secrets/detector-corpus.json                    must trip; one entry per detector
fixtures/secrets/false-positive-corpus.json              must NOT trip; the 13 frozen cases (§5.7)
fixtures/guard/banned-lockfile/package.json              a clean manifest beside a poisoned lockfile
fixtures/guard/banned-lockfile/package-lock.json         a transitive @electron/rebuild entry
fixtures/guard/banned-manifest/package.json              a workspace root for the manifest case
fixtures/guard/banned-manifest/package-lock.json         a clean lockfile beside a poisoned manifest
fixtures/guard/banned-manifest/packages/thumbs/package.json  declares @electron/rebuild directly
```

`fixtures/guard/**` is five committed dependency-tree fixtures that make
`security/supply-chain.security.test.ts` able to *fail*: the guard is spawned against each tree and
must exit 1, so the control is proven without ever editing the real lockfile.

Additional `.gitignore` lines M1 needs (append; **do not** recreate the file, and **do not** touch
`LICENSE`):

```
# --- M1 additions ---
apps/desktop/out/
agents/macos/build/
spikes/*/build/
*.generated.swift.tmp
.vitest-reports/
```

`spikes/*/build/` matters: the two day-0 spikes compile `frontmost.swift` and `ax-probe.swift` into
`spikes/<name>/build/`, and the spike step ends in a bare `git add spikes`. Without this line that
command commits two ~60 KB Swift binaries. The seven spike **source** files in §1 are committed; the
binaries are not.

`agents/macos/Sources/AgentProtocol.generated.swift` **is** committed — it is the artefact that makes
a field rename a Swift compile error instead of a runtime failure (spec §4). Two frozen facts about
its contents, because both have been "fixed" in the wrong direction before:

- The generator emits `let protocolVersion = 1` and the `Codable` structs, and **nothing else**. It
  does **not** emit the numeric limits. `Wire.swift` declares those **six** itself —
  `CHUNK_THRESHOLD_BYTES`, `CHUNK_PAYLOAD_BYTES`, `MAX_REP_BYTES`, `MAX_LINE_BYTES`,
  `AGENT_REQUEST_TIMEOUT_MS`, `WATCH_INTERVAL_MS` — because `swiftc` compiles the whole module at
  once, so emitting them from the generator as well is `error: invalid redeclaration`. The guard
  against drift is `tools/agent-selftest.test.ts`, which reads `packages/protocol/src/constants.ts`
  and asserts each Swift literal matches its TypeScript value.
- The generated nested struct for a write request's reps is named **`WriteParamsRepsItem`**. There is
  no hand-written `WriteRep`. Every zod base64 field maps to Swift `Data`, never `String` — the whole
  point is that the Swift side holds bytes, not a re-encodable string.

---

## 2. Root config — verbatim and complete

### Versions, all verified with `npm view <pkg> version` on this machine

| package | version | note |
|---|---|---|
| `electron` | `44.1.1` | required exact by spec §3; `[verified]` latest is also 44.1.1 |
| `electron-vite` | `5.0.0` | peer `vite: ^5 \|\| ^6 \|\| ^7` — **this is why vite is 7, not 8** |
| `vite` | `7.3.6` | latest 7.x; latest overall is 8.2.2 and is incompatible with electron-vite 5 |
| `@sveltejs/vite-plugin-svelte` | `6.2.4` | peer `vite: ^6.3 \|\| ^7`; **7.3.0 requires vite ^8 and must not be used** |
| `svelte` | `5.57.0` | |
| `svelte-check` | `4.7.6` | |
| `typescript` | `5.9.3` | spec pins TS 5.9; latest overall is 7.0.2 and is out of scope |
| `vitest` | `4.1.11` | peer `vite: ^6 \|\| ^7 \|\| ^8` |
| `@vitest/coverage-v8` | `4.1.11` | must equal the vitest version exactly |
| `jsdom` | `30.0.1` | only for the `security` project's Svelte render test |
| `@types/node` | `24.9.2` | matches Electron 44's bundled Node 24 |
| `zod` | `4.5.4` | |
| `sharp` | `0.35.4` | |
| `@leeoniya/ufuzzy` | `1.0.19` | |

`[verified]` The whole set installs together as one npm workspace root with **zero peer conflicts**:
`npm install` → `added 179 packages in 5s`; `npm ls --depth=0` lists every package above at the exact
version with no `invalid`/`peer dep missing` markers.

### `.nvmrc`

```
24.20.0
```

This is a **hard floor, not a preference**. Besides matching Electron 44's bundled Node 24, it is the
only version on which the `renderer` and `security` vitest projects can start at all: `jsdom@30.0.1`
transitively `require()`s a pure-ESM module, and unflagged `require(esm)` landed in Node 22.12. See
the note under `vitest.config.ts` below for the exact failure on an older Node — it reports
`Test Files  no tests`, which looks like a config bug and is not one.

### `.npmrc`

```
ignore-scripts=true
save-exact=true
audit=false
fund=false
engine-strict=true
package-lock=true
```

`ignore-scripts=true` is spec §11 control 9: a clipboard manager is an attractive place to hide a
postinstall script. Consequences, both measured:

- **`sharp` needs no allowlist.** `[verified]` `npm install sharp@0.35.4` with `ignore-scripts=true`
  → `added 6 packages`, pulling `@img/sharp-darwin-arm64` and `@img/sharp-libvips-darwin-arm64` as
  *optional dependencies* (sharp has shipped its prebuilds this way since 0.33 — there is no install
  script at all). A probe then reported `sharp version: 0.35.4 vips: 8.18.6`, created an 800×600 PNG
  and produced a 557-byte 256×192 q70 JPEG thumbnail. **No allowlist entry is needed for sharp.**
- **`electron` needs one explicit, audited step.** `[verified]` with `ignore-scripts=true`,
  `node_modules/electron/` has no `dist/` and no `path.txt`, so `require('electron')` cannot resolve a
  binary. Electron 44.1.1 publishes its downloader as a **bin** (`install-electron` → `install.js`).
  Running `node node_modules/electron/install.js` once completed in **1.8 s** and produced
  `dist/Electron.app/...`; `./node_modules/.bin/electron --version` then printed `v44.1.1`.

So the contract is: **there is no npm install-script allowlist at all.** One named script,
`npm run bootstrap`, runs exactly one audited line. CI is
`npm ci && npm run guard:no-rebuild && npm run bootstrap && npm test`. This is strictly stronger than
an allowlist, because the allowed command is visible in `package.json` rather than inside a
dependency.

### `package.json` (root)

```json
{
  "name": "cairn",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=24.20.0" },
  "workspaces": ["packages/*", "apps/desktop"],
  "scripts": {
    "bootstrap": "node node_modules/electron/install.js",
    "guard:no-rebuild": "node scripts/guard-no-electron-rebuild.mjs",
    "scan:transcripts": "node scripts/scan-transcripts.mjs",
    "gen:agent-types": "node tools/gen-agent-types.ts",
    "agent:macos": "make agent",
    "typecheck": "tsc -p tsconfig.json && svelte-check --tsconfig apps/desktop/renderer/tsconfig.json --threshold error",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:renderer": "vitest run --project renderer",
    "test:security": "vitest run --project security",
    "test:watch": "vitest",
    "build": "npm run guard:no-rebuild && npm run agent:macos && electron-vite build",
    "dev": "npm run agent:macos && electron-vite dev",
    "verify": "npm run guard:no-rebuild && npm run typecheck && npm run test && npm run scan:transcripts"
  },
  "devDependencies": {
    "@leeoniya/ufuzzy": "1.0.19",
    "@sveltejs/vite-plugin-svelte": "6.2.4",
    "@types/node": "24.9.2",
    "@vitest/coverage-v8": "4.1.11",
    "electron": "44.1.1",
    "electron-vite": "5.0.0",
    "jsdom": "30.0.1",
    "sharp": "0.35.4",
    "svelte": "5.57.0",
    "svelte-check": "4.7.6",
    "typescript": "5.9.3",
    "vite": "7.3.6",
    "vitest": "4.1.11",
    "zod": "4.5.4"
  }
}
```

Notes that are contract, not taste:

- `workspaces` lists `apps/desktop`, **not** `apps/*`, so an M3 `apps/` sibling cannot silently join.
- Every dependency lives at the root. Workspace packages declare only their `@cairn/*` and runtime
  deps (see the template below); the toolchain is hoisted once so there is one version of vitest.
- No `postinstall`. `ignore-scripts=true` would skip it anyway, and a lifecycle script that silently
  does nothing is worse than an explicit `npm run bootstrap`.
- There are **three** `test:*` project scripts, one per vitest project, and they exist for LOCAL
  convenience only. `.github/workflows/ci.yml` deliberately runs a bare **`npm test`** (`vitest run`
  with no `--project`), which executes every project in `vitest.config.ts`. That is a security
  decision, not brevity: a per-project step list in CI silently skips any project added later, so the
  first renderer or security project someone introduces would never run on a branch and nobody would
  see a red build. One `npm test` has no such failure mode. `npm run verify` uses the same bare form.

### ESM vs CJS — decided, and one of the three is not a free choice

| Surface | Module format | Reason |
|---|---|---|
| `@cairn/*` packages | **ESM TypeScript source, never built** | `"type": "module"` + `"exports": {".": "./src/index.ts"}`. `[verified]` vitest imports across workspaces with no build step; `[verified]` `node tools/gen-agent-types.ts` resolves `@cairn/protocol` through those exports using Node 24's built-in type stripping, no flag and no `tsx`. There is **no `tsup` and no `dist/` in M1** — a stale `dist` is a bug class we simply do not have. |
| Electron **main** | **CJS bundle** (`out/main/index.js`) | electron-vite's default and the least surprising with `require('sharp')`. `[verified]` the emitted bundle is `"use strict"; const electron = require("electron"); const sharp = require("sharp"); …` with all `@cairn/*` code **inlined**. |
| Electron **preload** | **CJS bundle — mandatory** | `[verified]` on Electron 44.1.1: with `sandbox: true`, a CJS preload works (`window.api.ping()` → `pong-cjs`), and an ESM `.mjs` preload makes the page load fail outright with `ERR_FAILED (-2)`. **A sandboxed preload cannot be ESM. Do not try.** |
| Renderer | ESM, bundled by vite | Browser context. |
| `scripts/*.mjs` | ESM by extension | Immune to any future `"type"` change. |
| `apps/desktop/package.json` | **no `"type"` field** | Nearest-package-json for `out/main/index.js` must resolve to CommonJS. Adding `"type": "module"` there breaks the app at launch. |

### `tsconfig.base.json`

Two config files, no project references, no `composite`, no emit — `tsc` is a type checker here and
nothing else. vite and vitest do all transpilation.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "preserve",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Relative imports are **extensionless** (`import { ok } from './result'`) — `moduleResolution: bundler`
resolves them, and so do vite and vitest. Cross-package imports use the package name
(`import { WIRE_MAJOR } from '@cairn/protocol'`), never a relative path into another workspace.

### `tsconfig.json` (root, node side)

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023"], "types": ["node"] },
  "include": [
    "packages/*/src/**/*.ts",
    "apps/desktop/main/src/**/*.ts",
    "apps/desktop/preload/src/**/*.ts",
    "tools/**/*.ts",
    "security/**/*.ts",
    "*.config.ts"
  ],
  "exclude": ["**/node_modules/**", "**/out/**"]
}
```

### `apps/desktop/renderer/tsconfig.json` (web side)

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "types": ["vite/client", "node"] },
  "include": ["src/**/*.ts", "src/**/*.svelte"],
  "exclude": ["**/node_modules/**"]
}
```

**Both differences from the obvious version are load-bearing, and this file must typecheck cleanly
from the very first task** — `npm run typecheck` runs `svelte-check` against it, so a broken renderer
tsconfig turns every later task's green gate red.

- **`"node"` is in `types`.** Without it, the moment any `@cairn/*` source imports a node builtin
  `svelte-check` fails. That happens on the scaffolding task's own
  `packages/protocol/src/testing.ts` (`node:url`, `node:path`) — the very step that writes this
  tsconfig also creates the file that breaks it — and again on the protocol task's
  `packages/protocol/src/hash.ts` (`node:crypto`, `Buffer`).
- **`include` does NOT glob `../../../packages/*/src/**/*.ts`.** That keeps node-targeting package
  sources out of the renderer program's *roots*, so the renderer's own type surface stays the
  browser one.

Narrowing `include` alone is **not** sufficient and neither half may be dropped. `[verified]` on a
throwaway tree holding this `tsconfig.base.json`, a `packages/protocol/src/testing.ts` that imports
`node:url`/`node:path`, a barrel that re-exports it, and one renderer file doing
`import { PREVIEW_MAX_CHARS } from '@cairn/protocol'`, with `tsc` 5.9.3:

| `types` | `packages/*` glob | result |
|---|---|---|
| `["vite/client"]` | absent | `error TS2307: Cannot find module 'node:url' or its corresponding type declarations.` at `testing.ts(1,31)` and the same for `node:path` at `(2,31)`, exit 2 — TypeScript pulls `testing.ts` in as a transitive dependency of the import, so the glob was never what dragged it in |
| `["vite/client"]` | present | the same two errors |
| `["vite/client", "node"]` | absent | exit 0, no output |

`[verified]` `npx tsc -p tsconfig.json` → exit 0, and on that same tree
`npx svelte-check --tsconfig apps/desktop/renderer/tsconfig.json --threshold error` →
`COMPLETED 193 FILES 0 ERRORS`, exit 0. The FILES count rises as the renderer's imports pull in more
package sources; **`0 ERRORS` and exit 0 are the contract, the count is not.**

Having `node` types in the renderer *program* costs nothing at runtime: what keeps the shipped bundle
browser-safe is the sandboxed `webPreferences` (§8), the CSP, and the real `electron-vite build` — not
the absence of a type declaration.

### `vitest.config.ts`

**THREE projects: `unit`, `renderer`, `security`.** All three are written once, by the scaffolding
task, so that no later task ever has to touch this file — a later task that rewrites it wholesale from
a stale snippet silently deletes another task's includes. Verify the three projects; do not replace
the file.

```ts
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/desktop/main/src/**/*.test.ts',
            'apps/desktop/preload/src/**/*.test.ts',
            'tools/**/*.test.ts',
            // security/source-scan.ts is the shared scanner EVERY source ban runs through, so its
            // own comment-stripping has a plain unit test here. `*.security.test.ts` is excluded
            // below, so this line picks up source-scan.test.ts and nothing else.
            'security/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.security.test.ts'],
        },
      },
      {
        // Renderer component tests. Needs the svelte plugin (for .svelte and .svelte.ts), a DOM, and
        // the `browser` resolve condition — without it Svelte 5 resolves its server build and
        // `mount()` throws `lifecycle_function_unavailable`.
        plugins: [svelte({ configFile: false })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['apps/desktop/renderer/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.security.test.ts'],
        },
      },
      {
        // The security project renders real Svelte components, so it needs the svelte plugin,
        // a DOM, and the `browser` resolve condition. Without that condition Svelte 5 resolves
        // its server build and `mount()` throws `lifecycle_function_unavailable`.
        plugins: [svelte({ configFile: false })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'security',
          environment: 'jsdom',
          include: [
            'security/**/*.security.test.ts',
            'packages/*/src/**/*.security.test.ts',
            'apps/desktop/*/src/**/*.security.test.ts',
          ],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
})
```

Three details here are the frozen part, not the formatting:

1. **The `unit` project's fifth include, `'security/**/*.test.ts'`.** It is the only thing that runs
   `security/source-scan.test.ts` — the unit tests of the quote-aware comment stripper that the
   `crashReporter`, socket, shell-execution, URI-scheme and raw-HTML-directive bans *all* depend on.
   `*.security.test.ts` is excluded on the next line, so this glob picks up that one file and nothing
   else. Rewriting the file from a four-include snapshot deletes the whole security suite's
   foundation with no test failure to warn you.
2. **The `renderer` project exists at all.** `unit` globs `apps/desktop/main` and
   `apps/desktop/preload` but never `apps/desktop/renderer`, and `security` only matches
   `*.security.test.ts`. So without this project every **plain** `*.test.ts` under
   `apps/desktop/renderer/src/` is collected by nobody and "passes" by never running.
3. **`resolve: { conditions: ['browser'] }` on both jsdom projects.** Do not delete it as "unused":
   `[verified]` removing it makes the Svelte render tests fail with
   ``Svelte error: `mount(...)` is not available on the server``, because Svelte 5 otherwise resolves
   its server build and `mount()` throws `lifecycle_function_unavailable`.

`[verified]` This exact config was run against a tree holding one test file per glob — a
`packages/p/src/a.test.ts`, an `apps/desktop/main/src/b.test.ts`, an
`apps/desktop/renderer/src/c.test.ts`, a `security/source-scan.test.ts`, a
`security/x.security.test.ts` and an `apps/desktop/renderer/src/d.security.test.ts` — on vitest
4.1.11. Each project collects exactly what it should, with **nothing collected twice**:

```
npx vitest run --project unit        →  Test Files  3 passed (3)   # a, b, source-scan
npx vitest run --project renderer    →  Test Files  1 passed (1)   # c
npx vitest run --project security    →  Test Files  2 passed (2)   # x, d
npx vitest run                       →  Test Files  6 passed (6)
```

`npx vitest run --project renderer` on the bare scaffold, before any renderer test exists, instead
prints `No test files found, exiting with code 1` — that exit code is correct, not a misconfiguration.
`npm run test -w @cairn/agent-host` runs only that workspace's tests.

**Run all of this on Node 24.** `[verified]` `jsdom@30.0.1` reaches
`html-encoding-sniffer@6.0.0`, whose CJS entry does `require('@exodus/bytes/encoding-lite.js')`, and
`@exodus/bytes` is pure ESM in every 1.x. Unflagged `require(esm)` landed in Node 22.12, so on Node
20 **both jsdom projects die before collection** with
`Error: [vitest-pool]: Failed to start forks worker … Caused by: Error: require() of ES Module … not
supported`, `Serialized Error: { code: 'ERR_REQUIRE_ESM' }` and — the misleading part —
`Test Files  no tests`. The same run on Node 24 passes. `.nvmrc` (`24.20.0`) and
`engines: { node: ">=24.20.0" }` already pin this, but `engine-strict=true` only guards `npm install`;
it does not stop `npx vitest` under a stale shell. If the security or renderer project reports
`no tests` and one `ERR_REQUIRE_ESM`, check `node --version` before touching this file.

### `electron.vite.config.ts`

```ts
import { builtinModules } from 'node:module'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'electron-vite'

// Everything NOT in this list is bundled — which is exactly how `@cairn/*` TypeScript source
// reaches the main process with no build step. `electron` and `sharp` must stay external:
// one is injected by the runtime, the other is a Node-API .node binary.
const NODE_EXTERNALS = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'electron',
  'sharp',
]

export default defineConfig({
  main: {
    build: {
      outDir: 'apps/desktop/out/main',
      lib: { entry: 'apps/desktop/main/src/index.ts', formats: ['cjs'] },
      rollupOptions: { external: NODE_EXTERNALS, output: { entryFileNames: 'index.js' } },
      minify: false,
      sourcemap: false,
    },
  },
  preload: {
    build: {
      outDir: 'apps/desktop/out/preload',
      lib: { entry: 'apps/desktop/preload/src/index.ts', formats: ['cjs'] },
      rollupOptions: { external: NODE_EXTERNALS, output: { entryFileNames: 'index.js' } },
      minify: false,
      sourcemap: false,
    },
  },
  renderer: {
    root: 'apps/desktop/renderer',
    plugins: [svelte()],
    build: {
      outDir: 'apps/desktop/out/renderer',
      rollupOptions: { input: 'apps/desktop/renderer/index.html' },
    },
  },
})
```

`sourcemap: false` is a security choice, not a size choice: a sourcemap of the main process is a map
of where decrypted history lives.

`[verified]` `npx electron-vite build` with exactly this config: main built in 66 ms, preload in 6 ms,
renderer (107 modules, Svelte 5 with `$state`/`$props`) in 253 ms.

### `apps/desktop/renderer/svelte.config.mjs`

```js
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default { preprocess: vitePreprocess() }
```

It lives in the **renderer root** (`root:` above), not the repo root — `[verified]` a repo-root
`svelte.config.js` produces `[vite-plugin-svelte] no Svelte config found at .../renderer`. And it is
`.mjs`, not `.js`, because `apps/desktop/package.json` has no `"type"` field — `[verified]` a `.js`
config there triggers `[MODULE_TYPELESS_PACKAGE_JSON]` on every `svelte-check` run.

### `Makefile`

```make
SWIFT_SOURCES := $(wildcard agents/macos/Sources/*.swift)
AGENT_BIN     := agents/macos/build/cairn-agent-macos
SWIFT_TARGET  := $(shell /usr/bin/uname -m)-apple-macos13.0

$(AGENT_BIN): $(SWIFT_SOURCES)
	@mkdir -p $(dir $@)
	swiftc -O -whole-module-optimization -target $(SWIFT_TARGET) -framework AppKit -framework Carbon -o $@ $(SWIFT_SOURCES)

.PHONY: agent clean
agent: $(AGENT_BIN)
clean:
	rm -rf agents/macos/build
```

`[verified]` This exact recipe compiled a probe that imports `AppKit`, `Carbon`, `CryptoKit` and
`Foundation`, in **1.65 s** with Command Line Tools only (no full Xcode), producing
`Mach-O 64-bit executable arm64`. Running it printed `changeCount=363`, the concealed-hint probe
result, per-item UTIs from `pb.pasteboardItems`, `IsSecureEventInputEnabled()=false`,
`frontmost=com.google.Chrome` with `AXIsProcessTrusted()=false`, a
`sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ` content hash from CryptoKit, and one
`\n`-terminated NDJSON line on stdout. `[verified]` incremental rebuild works: no-op when nothing
changed, rebuild after `touch`, rebuild when a new `.swift` file appears.

M1 builds for the host architecture only. Universal (`lipo` of two `-target` passes) is M3 packaging.

**Swift agent JSON rule (frozen):** the agent sets `encoder.outputFormatting = .sortedKeys`.
`[verified]` `JSONEncoder` otherwise emits keys in a **non-deterministic order across runs**, which
would make recorded transcripts undiffable. Tests compare parsed values, never raw line bytes.

### Per-package `package.json` template

Copy this for every `packages/<name>`, changing only `name`, the one-line `description`, and
`dependencies`. `test` is identical in every package except the directory.

```json
{
  "name": "@cairn/<name>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "<one line from the file tree in §1>",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run --root ../.. --project unit packages/<name>",
    "test:security": "vitest run --root ../.. --project security packages/<name>"
  },
  "dependencies": {}
}
```

`dependencies` per package, exactly:

| package | dependencies |
|---|---|
| `@cairn/protocol` | `{ "zod": "4.5.4" }` |
| `@cairn/agent-host` | `{ "@cairn/protocol": "0.1.0" }` |
| `@cairn/capture` | **four:** `{ "@cairn/agent-host": "0.1.0", "@cairn/privacy": "0.1.0", "@cairn/protocol": "0.1.0", "sharp": "0.35.4" }` |
| `@cairn/privacy` | `{ "@cairn/protocol": "0.1.0" }` |
| `@cairn/store` | `{ "@cairn/protocol": "0.1.0" }` |
| `@cairn/keyring` | `{ "@cairn/protocol": "0.1.0" }` |
| `@cairn/history` | `{ "@cairn/protocol": "0.1.0", "@cairn/store": "0.1.0", "@cairn/search": "0.1.0", "@cairn/privacy": "0.1.0" }` |
| `@cairn/search` | `{ "@cairn/protocol": "0.1.0", "@leeoniya/ufuzzy": "1.0.19" }` |
| `@cairn/hotkey` | `{ "@cairn/protocol": "0.1.0", "@cairn/agent-host": "0.1.0" }` |

`apps/desktop/package.json`:

```json
{
  "name": "@cairn/desktop",
  "version": "0.1.0",
  "private": true,
  "description": "Electron composition root, hardened palette window and typed IPC",
  "main": "out/main/index.js",
  "dependencies": {
    "@cairn/agent-host": "0.1.0",
    "@cairn/capture": "0.1.0",
    "@cairn/history": "0.1.0",
    "@cairn/hotkey": "0.1.0",
    "@cairn/keyring": "0.1.0",
    "@cairn/privacy": "0.1.0",
    "@cairn/protocol": "0.1.0",
    "@cairn/search": "0.1.0",
    "@cairn/store": "0.1.0"
  }
}
```

Every one of those `package.json` files, including `packages/capture/package.json`, is created
**once**, by the scaffolding task, with exactly the dependency set in that table. Every later task
**verifies** its own manifest and changes nothing — e.g.
`node -e "const d=require('./packages/capture/package.json').dependencies; for (const k of ['@cairn/agent-host','@cairn/privacy','@cairn/protocol','sharp']) if (!d[k]) throw new Error('missing '+k); console.log('deps ok')"`
prints `deps ok`. `@cairn/capture` has **four** dependencies. `@cairn/agent-host` is the fourth
because `packages/capture/src/capture.test.ts` calls `createFakeAgent({transcriptPath, clock, logger})`
— a value import, not a type-only one, so it must be declared even though no `src/` product file
imports it.

`@cairn/keyring` does **not** list `electron` as a dependency. `safeStorage` is injected into
`createKeyring({safeStorage})` so every keyring test runs in plain Node with a fake.

### `scripts/guard-no-electron-rebuild.mjs`

```js
#!/usr/bin/env node
// Fails the build if @electron/rebuild or node-gyp appear anywhere: a direct dependency, a
// transitive one, or a lockfile entry. Spec §2 makes this a CI-enforced invariant, because it is
// the only thing that would drag V8-ABI rebuilds back into a repo whose native artefacts are all
// either Node-API (sharp) or standalone processes (the agents).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BANNED = ['@electron/rebuild', 'electron-rebuild', 'node-gyp', '@electron/node-gyp']
const hits = []

if (!existsSync('package-lock.json')) {
  console.error('guard: package-lock.json is missing — run `npm install` and commit the lockfile')
  process.exit(2)
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const lockEntries = Object.keys(lock.packages ?? {})
for (const p of lockEntries) {
  for (const b of BANNED) {
    if (p === `node_modules/${b}` || p.endsWith(`/node_modules/${b}`)) hits.push(`package-lock.json: ${p}`)
  }
}

const manifests = ['package.json']
for (const group of ['packages', 'apps', 'agents']) {
  if (!existsSync(group)) continue
  for (const d of readdirSync(group)) {
    const m = join(group, d, 'package.json')
    if (existsSync(m)) manifests.push(m)
  }
}
for (const m of manifests) {
  const pkg = JSON.parse(readFileSync(m, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (BANNED.includes(name)) hits.push(`${m}: ${field}.${name}`)
    }
  }
}

if (hits.length > 0) {
  console.error('guard-no-electron-rebuild FAILED. Banned packages found:')
  for (const h of hits) console.error('  - ' + h)
  console.error('\nEvery native artefact must be Node-API (sharp) or a standalone process (the agents).')
  process.exit(1)
}
console.log(`guard-no-electron-rebuild OK — scanned ${lockEntries.length} lockfile entries and ${manifests.length} manifests`)
```

`[verified]` On the real M1 tree: `guard-no-electron-rebuild OK — scanned 285 lockfile entries and 4
manifests`, exit 0. With a single `node_modules/app-builder-lib/node_modules/@electron/rebuild` entry
injected into the lockfile it printed `guard-no-electron-rebuild FAILED` and exited 1.

**This is not hypothetical.** `[verified]` `app-builder-lib@26.15.3` — which `electron-builder@26`
depends on — declares `"@electron/rebuild": "^4.0.4"`. That is a second, independent reason
electron-builder is not an M1 dependency, and it means whoever adds packaging in M3 must add an npm
`overrides` entry at the same time or this guard will (correctly) stop the build.

---

## 3. The agent NDJSON protocol — frozen

### Framing rules

1. One JSON object per line, `\n`-terminated (`0x0A`). No `\r`. No pretty-printing.
2. No literal newline may appear inside a line; JSON string escaping (`\n`) is how newlines travel.
3. Lines are UTF-8. A multi-byte character may be split across two pipe chunks; the splitter buffers
   bytes and only decodes complete lines.
4. Max line length `MAX_LINE_BYTES = 1_048_576`. A longer line is dropped with `E_LINE_TOO_LONG` and
   the agent is restarted — an unbounded line is a memory attack.
5. **Unknown map keys are IGNORED, never an error.** `[verified]` zod 4.5.4's default `z.object()`
   strips unknown keys, and a `clipboard.changed` event carrying `futureField` plus a top-level
   `alsoNew` parses successfully with both keys absent from the output. This is enforced by test in
   `packages/protocol/src/agent.test.ts`.
6. `v` must equal `WIRE_MAJOR` (1). Any other value fails to parse (`E_WIRE_MAJOR`).
7. stdout carries protocol lines only. Anything the agent wants to say for humans goes on **stderr**
   or through a `log` event. A non-JSON stdout line is dropped with `E_PARSE`, counted, and after 10
   in a row the agent is restarted.

### Envelope — three shapes, discriminated by `t`

```
{"v":1,"t":"req","id":"7","method":"read","params":{"changeCount":363}}
{"v":1,"t":"res","id":"7","ok":true,"result":{...}}
{"v":1,"t":"res","id":"7","ok":false,"error":{"code":"E_TIMEOUT","message":"promised read timed out"}}
{"v":1,"t":"ev","event":"clipboard.changed","data":{...}}
```

- `t` is the outer discriminator: `'req' | 'res' | 'ev'`.
- `id` correlates a `res` to its `req`. The **host** allocates ids as a decimal counter starting at
  `"1"`; the agent echoes the id verbatim and never invents one.
- `ok` is the inner discriminator on responses: `ok: true` carries `result`, `ok: false` carries
  `error`. There is never both.
- Events have **no** `id`. An event is never a reply.
- `parseAgentLine` parses all three shapes, because `tools/gen-agent-types.ts` emits the same Swift
  types for both sides of the pipe.

`[verified]` `z.discriminatedUnion('t', [AgentRequestSchema, AgentResponseSchema, AgentEventSchema])`
— where two of the three options are themselves discriminated unions — works at runtime in zod 4.5.4,
and an unknown `t` produces `issues[0].code === 'invalid_union'`.

### `packages/protocol/src/agent.ts` — the frozen source

This file compiles under the §2 `tsconfig.base.json` and its accompanying tests pass. `[verified]`
`npx tsc` exit 0; `npx vitest run` → `15 passed`.

```ts
import * as z from 'zod'
import {
  CHUNK_THRESHOLD_BYTES,
  MAX_REP_BYTES,
  WIRE_MAJOR,
} from './constants'

export const ContentHashSchema = z
  .string()
  .regex(/^sha256-[A-Za-z0-9_-]{43}$/, 'expected sha256-<43 char base64url>')
export const MimeSchema = z.string().min(1).max(255)
export const IdSchema = z.string().min(1).max(64)

/**
 * A representation as it travels on the wire. Exactly one of `inline` / `repId` is present, and
 * which one is a pure function of `byteLength` — see §4. The in-memory form after reassembly is
 * `ResolvedRep` in ./types.ts.
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
    'changecount-poll',
    'sequence-poll',
    'xfixes',
    'wl-paste-watch',
    'focus-only',
    'none',
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

`hotkey.register` returns `{bound: boolean}` and **never** an error response for a taken combination.
Spec §4 makes a silently dead hotkey a first-class state, so the boolean must be inspected by
`@cairn/hotkey`, not swallowed by a rejected promise.

### Reserved for M2 — names taken, schemas absent

These method and event names are **reserved** and must not be used for anything else. M1 ships no
schema for them, and `AgentRequestSchema` rejects them, which is correct: an M1 host has no business
sending them.

Reserved requests: `paste`, `focus.capture`, `focus.restore`, `permission.check`,
`permission.request`, `permission.openSettings`, `secureInput.check`, `capture.now`.
Reserved events: `permission.changed`.

### `parseAgentLine`

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

`[verified]` `z.prettifyError` exists in zod 4.5.4 and renders
`✖ Invalid discriminator value. Expected 'hello' | 'read'` for a bad discriminator.

---

## 4. BYTE TRANSPORT — no spool files, no temp files, ever

An earlier revision of this design spooled oversized representations to plaintext files in
`$TMPDIR`. That was a real vulnerability: a copied private key, `.env` paste or password-manager
export would land **unencrypted on disk**, outside the store we go to trouble to encrypt, readable by
any process running as the user, and likely to survive in free space after `unlink`. It is gone.
**Do not reintroduce it under any name — not "spool", not "cache", not "scratch", not
`os.tmpdir()`, not `fs.mkdtemp`.** `security/no-plaintext-on-disk.security.test.ts` fails if you do.

### The two paths

| Condition | Transport |
|---|---|
| `byteLength < 65536` | inline, `Rep.inline` = base64 of the whole representation, on the `clipboard.changed` event itself |
| `byteLength >= 65536` | `Rep.repId` is set and the bytes follow as `rep.chunk` events on the **same stdout pipe**, reassembled **in memory** by `@cairn/agent-host` |

Frozen constants (`packages/protocol/src/constants.ts`):

```ts
export const CHUNK_THRESHOLD_BYTES = 65_536      // >= this streams; < this is inline
export const CHUNK_PAYLOAD_BYTES = 32_768        // raw bytes carried by one rep.chunk
export const MAX_REP_BYTES = 20_971_520          // 20 MiB, matching the agent's read cap
export const MAX_LINE_BYTES = 1_048_576          // 1 MiB NDJSON line guard
export const REP_STREAM_TIMEOUT_MS = 5_000       // no chunk for this long -> abort the rep
export const MAX_CONCURRENT_REP_STREAMS = 8      // in-flight reassemblies before refusing
```

**Why 32 KiB per chunk.** 32 768 raw bytes base64-encode to exactly 43 692 characters, so the whole
NDJSON line measures ~43.8 KB `[verified: max line 43 783 bytes over a 200 000-byte payload]` — under
Node's default 64 KiB pipe `highWaterMark`, so one chunk is at most one pipe buffer and a slow reader
never sees a partially-flushed giant line; and comfortably under `MAX_LINE_BYTES`, so the line guard
protects against attack without ever tripping on legitimate traffic. `MAX_REP_BYTES /
CHUNK_PAYLOAD_BYTES = 640` exactly `[verified]`, so `seq` is bounded at 639 and the whole cap is
expressible in three digits.

Base64's 33 % overhead is irrelevant here: `[verified]` 200 KB took 7 chunks, and pipes are not the
bottleneck. Correctness beats bytes.

### Error code set — these ten and no others

| code | fires when |
|---|---|
| `E_REP_UNKNOWN_ID` | a `rep.chunk` arrives for a `repId` never declared by a `Rep` |
| `E_REP_SEQ_GAP` | `seq > expected` — a chunk was lost |
| `E_REP_SEQ_DUPLICATE` | `seq < expected` — a chunk was replayed |
| `E_REP_AFTER_FINAL` | any chunk arrives after the one with `final: true` |
| `E_REP_BAD_BASE64` | `b64` does not decode |
| `E_REP_OVERFLOW` | accumulated bytes exceed `Rep.byteLength`, or exceed `MAX_REP_BYTES` |
| `E_REP_SHORT` | `final: true` arrived but accumulated bytes `!== Rep.byteLength` |
| `E_REP_HASH_MISMATCH` | `contentHash(assembled) !== Rep.sha256` |
| `E_REP_TIMEOUT` | no chunk for `REP_STREAM_TIMEOUT_MS`, or the process exited mid-stream |
| `E_REP_TOO_MANY` | a ninth concurrent stream is declared while eight are in flight |

**On any of these, the whole representation is discarded** — not truncated, not partially delivered.
Its buffers are dropped and the `Candidate` proceeds with the remaining representations, or is
dropped entirely if the primary representation was the one that failed. Every abort emits
`logger.warn('rep.stream-aborted', { code, repId … })` — metadata only, never bytes.

### The reassembler state machine — exact

One `RepStream` per declared `repId`.

**States:** `Declared` → `Receiving` → `Complete` | `Aborted`.

**Per-stream state:**

```ts
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
```

**Transitions:**

1. `Rep{repId}` seen on `clipboard.changed`
   → if `streams.size === MAX_CONCURRENT_REP_STREAMS` → abort with `E_REP_TOO_MANY`.
   → if `declaredBytes > MAX_REP_BYTES` → abort with `E_REP_OVERFLOW` (never allocate).
   → create the stream in `Declared` with `receivedBytes = 0`, `expectedSeq = 0`,
     `sawFinal = false`, and arm `clock.setTimeout(abort(E_REP_TIMEOUT), REP_STREAM_TIMEOUT_MS)`.
2. `rep.chunk{repId, seq, final, b64}`
   → unknown `repId` → `E_REP_UNKNOWN_ID` (log, drop the chunk, no stream to abort).
   → `sawFinal === true` → `E_REP_AFTER_FINAL`.
   → `seq < expectedSeq` → `E_REP_SEQ_DUPLICATE`.
   → `seq > expectedSeq` → `E_REP_SEQ_GAP`.
   → decode `b64`; failure → `E_REP_BAD_BASE64`.
   → `receivedBytes + chunk.length > declaredBytes` **or** `> MAX_REP_BYTES` → `E_REP_OVERFLOW`.
   → push, `receivedBytes += chunk.length`, `expectedSeq += 1`, state `Receiving`,
     re-arm the timeout.
   → if `final` → `sawFinal = true`, go to step 3.
3. Completion check
   → `receivedBytes !== declaredBytes` → `E_REP_SHORT`.
   → `contentHash(concat(parts)) !== declaredHash` → `E_REP_HASH_MISMATCH`.
   → otherwise `Complete`: cancel the timeout, delete the stream, hand a `ResolvedRep` to the
     capture pipeline. **The host verifies the hash before handing the bytes to anyone.**
4. Agent exit or `dispose()` with streams open → abort every open stream with `E_REP_TIMEOUT` and
   zero-fill its `parts` before dropping them.
5. Abort, in every case → cancel the timeout, `parts.forEach(p => p.fill(0))`, `streams.delete(repId)`,
   `logger.warn('rep.stream-aborted', { code, repCount: streams.size })`.

`[verified]` A reference implementation of exactly this machine round-tripped a 200 000-byte random
payload through 7 chunks byte-for-byte, and returned `E_REP_SEQ_GAP`, `E_REP_SEQ_DUPLICATE`,
`E_REP_SHORT`, `E_REP_HASH_MISMATCH` and `E_REP_TIMEOUT` for the matching injected faults.

Timeouts use the **injected `Clock`** (§5.8), so `reassembler.test.ts` needs no real timers.

---

## 5. Every shared TypeScript interface

All of the following live in `@cairn/protocol` and are re-exported from
`packages/protocol/src/index.ts`, which is a plain barrel:

```ts
// packages/protocol/src/index.ts — the finished barrel: exactly these ELEVEN lines, alphabetical
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

The scaffolding task ships the first draft of this file with the first **two** lines
(`'./constants'` and `'./testing'` — the only two modules it creates); the protocol task appends the
other **nine** (`'./agent'`, `'./clock'`, `'./hash'`, `'./id'`, `'./ipc'`, `'./log'`,
`'./parse-agent-line'`, `'./result'`, `'./types'`), keeping the list sorted, and no later task touches
the barrel again. **Eleven lines is the finished state** — if your barrel has ten, one module is
unreachable and some other task's import of `@cairn/protocol` will fail to resolve at type-check
time.

`packages/protocol/src/log.ts` **exists**, and the protocol task creates it. It holds exactly six
names — `LogLevel`, `LOG_EVENTS` (all **46** ids, §5.3), `LogEvent`, `LogFields`, `ExactLogFields`
and `Logger` — and `types.ts` type-imports `LogLevel` back from it (for `AgentLogPayload`, §5.4),
while `result.ts` type-imports `LogFields` from it (for `Err.detail`, §5.2). They live in their own
module because they are security invariant 2 in source form: one small file that a reviewer can read
end to end and confirm has no field a clipboard byte could be assigned to. Its own test,
`log.test.ts`, pins the id count at 46 with no duplicates, which is the whole reason later tasks
**verify** the list rather than append to it.

`log.ts` deliberately exports **no `createLogger`**. The only concrete `Logger` in M1 is
`apps/desktop/main/src/logger.ts` (the desktop-shell task), which writes NDJSON to stderr. A second
logger implementation inside `@cairn/protocol` would be a second place clipboard content could reach
a sink, and every package would then be one import away from it. `@cairn/protocol` exports the type,
never a factory — do not expect a `createLogger` from it, because nothing in M1 imports one.

No task may redeclare any of these locally, and no task imports a deep path
(`@cairn/protocol/src/types` is wrong; `@cairn/protocol` is right — it is the only export the
manifest declares).

`log.ts`, `types.ts`, `agent.ts` and `result.ts` import from each other. That is fine and intended:
**every direction is `import type` only**, so there is no runtime cycle — after compilation `log.ts`
exports one array (`LOG_EVENTS`) and imports nothing. `constants.ts` imports nothing at all, which is
what keeps that true — put a new constant there, never in `types.ts` or `log.ts`.

`[verified]` The whole of §5 — `constants.ts`, `log.ts`, `result.ts`, `hash.ts`, `id.ts`, `clock.ts`,
`types.ts`, `agent.ts`, `parse-agent-line.ts`, `ipc.ts`, `testing.ts` and the eleven-line barrel —
compiles clean (`tsc -p tsconfig.json`, exit 0) under the §2 `tsconfig.base.json` plus
`"lib": ["ES2023"], "types": ["node"]`, and the tests over it pass under the §2 vitest config.

`[verified]` Re-checked with `typescript@5.9.3` and `zod@4.5.4` on this machine: `ipc.ts` exactly as
written in §5.9 type-checks with exit 0 under `strict`, `verbatimModuleSyntax`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `moduleResolution: "bundler"` — the
`z.int()`, `z.string().startsWith('data:image/jpeg;base64,')` and the two mapped types over
`IpcRequestSchema` / `IpcEventSchema` all resolve. `clock.ts` and `id.ts` type-check and *run* to the
values asserted below them: `createTestClock(1_000)` with timers at +100/+200 and a cancelled +150
prints `pending 2`, then `advance(150)` fires only the first and leaves `now === 1150`, then
`advance(100)` fires the second and leaves `now === 1250`, `pending === 0`; and
`newItemId(1_767_225_600_000, Uint8Array [1..10])` is the 26-char
`01KDVDNA00041061050R3GG28A`.

### 5.1 Branded primitives

```ts
declare const contentHashBrand: unique symbol
/** Always the string `sha256-` followed by 43 chars of unpadded base64url. */
export type ContentHash = string & { readonly [contentHashBrand]: 'sha256-b64url' }
export type BlobId = ContentHash

declare const itemIdBrand: unique symbol
/** 26-char Crockford base32: 10 chars of ms timestamp then 16 chars of randomness. Sorts by time. */
export type ItemId = string & { readonly [itemIdBrand]: 'cairn-id' }
```

```ts
// packages/protocol/src/hash.ts
import { createHash } from 'node:crypto'
import type { ContentHash } from './types'

/** `sha256-<43 char base64url>`. Hashed over RAW representation bytes, never over JSON. */
export function contentHash(bytes: Uint8Array): ContentHash {
  return ('sha256-' + createHash('sha256').update(bytes).digest('base64url')) as ContentHash
}
```

`[verified]` `contentHash(Buffer.from('hello'))` is
`sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ` — 43 chars after the prefix, matching
`ContentHashSchema` — and the Swift agent's CryptoKit path produces the identical string.

```ts
// packages/protocol/src/id.ts
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

### 5.2 `Result<T>` and error codes

```ts
// packages/protocol/src/result.ts
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
  // byte transport (§4)
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

### 5.3 The metadata-only `LogFields` — security invariant 2

```ts
// packages/protocol/src/log.ts — these six names live HERE, not in types.ts.
// The three imports are type-only, so this module has no runtime dependency on any of them.
import type { AgentEventName, AgentMethod } from './agent'
import type { ErrorCode } from './result'
import type { AgentPlatform, DetectorName, Flag, ItemId, ItemKind, KeyringMode } from './types'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** The closed set of log message ids. A free-form string is a compile error, which is what stops
 *  `log.info('the user copied ' + text)`. Add ids here; never inline a message.
 *  ALL 46 ids are below, and the order is frozen: `log.test.ts` pins the count at 46 with no
 *  duplicates, so appending is the only legal edit and appending an id that is already here fails
 *  that test. Later tasks VERIFY this list; none of them appends to it. */
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
 * Metadata only. Every value type is a primitive or an array of a closed string union, so there is
 * no field into which clipboard bytes or a preview could be placed even by accident.
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

`[verified]` These six calls are each a **compile error**, proven by `tsc` accepting the
`@ts-expect-error` directives above them and rejecting a seventh, deliberately-wrong directive with
`TS2578: Unused '@ts-expect-error' directive`:

```ts
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
```

That exact block is the body of `packages/protocol/src/types.test.ts` — it keeps that filename even
though the six names it exercises now live in `log.ts`, because §1 assigns the `@ts-expect-error`
block to `types.test.ts` and the file is the compile-time half of security invariant 2. It is a real
test: adding an index signature to `LogFields`, or widening `LogEvent` to `string`, makes `tsc` fail.

The runtime half of the same invariant is split in two, and both must exist:
`packages/protocol/src/log.test.ts` asserts `LOG_EVENTS` holds **46** ids with no duplicates, that
every id matches `/^[a-z][a-z-]*\.[a-z][a-z-]*$/`, and that the seven desktop-shell ids are present —
so a task that "adds" an id it already has turns 46 into 53 and fails here.
`apps/desktop/main/src/logger.security.test.ts` asserts the canary never reaches the sink (§8).

### 5.4 `ClipboardAgent`

```ts
export type Unsub = () => void

export interface AgentEventMap {
  'clipboard.changed': ClipboardChangedPayload
  'rep.chunk': RepChunkPayload
  'hotkey.fired': HotkeyFiredPayload
  log: AgentLogPayload
}

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
```

Spec §4 writes this as `request<M>(m, params, timeoutMs?): Promise<Result<M>>`; the `M` there is
shorthand for the method's result type, spelled out above as `AgentResult<M>`. `[decided here]`
`start()` returns a bare promise that **rejects** on spawn failure — it is called once, at
composition, and a failure there is fatal, not a value to thread. Every other call returns
`Result<T>`.

Factories:

```ts
export function spawnAgent(opts: {
  platform: AgentPlatform
  binPath: string
  clock: Clock
  logger: Logger
  maxRestarts?: number   // default 5
}): ClipboardAgent

export function createFakeAgent(opts: {
  transcriptPath: string
  clock: Clock
  logger: Logger
}): ClipboardAgent
```

Restart backoff `[decided here]`: `250, 500, 1000, 2000, 4000` ms, then give up and surface
`E_AGENT_EXIT` on every subsequent `request`. Deterministic through the injected `Clock`.

`ClipboardChangedPayload` is the post-reassembly form — the host has already turned every wire `Rep`
into a `ResolvedRep`, so **no consumer of `ClipboardAgent` ever sees `repId`, `inline` or a chunk**:

```ts
export interface ClipboardChangedPayload {
  readonly changeCount: number
  readonly changeToken: string          // String(changeCount) on macOS
  readonly hints: readonly PasteboardHint[]
  readonly reps: readonly ResolvedRep[]
  readonly sourceApp: SourceApp | null
  readonly droppedReps: readonly { readonly mime: string; readonly code: ErrorCode }[]
}
export interface RepChunkPayload { readonly repId: string; readonly seq: number; readonly final: boolean }
export interface HotkeyFiredPayload { readonly accelerator: string; readonly focusToken: string; readonly firedAt: number }
export interface AgentLogPayload { readonly level: LogLevel; readonly event: string }
```

`RepChunkPayload` carries **no bytes** — it exists only so a progress indicator and the tests can
observe chunking. `AgentLogPayload` carries no `fields`, because the agent is not trusted to keep
clipboard content out of them; the host logs the level and event id and drops the rest.

### 5.5 Capture-side types

```ts
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
```

**Primary representation order** `[decided here]`, used for `contentHash` and for `Candidate.kind`:
`text/plain` → `text/uri-list` → `image/png` → `text/html` → `text/rtf` → first remaining. Frozen so
two machines hash the same copy identically.

`@cairn/capture` exports the `Capture` handle itself, and the composition root imports **that type**:

```ts
// packages/capture/src/index.ts — the ONE declaration of this shape in M1
export interface Capture {
  start(): Promise<Result<{ intervalMs: number }>>
  stop(): Promise<void>
  onCandidate(cb: (c: Candidate) => void): Unsub
  suppressToken(token: string): void
  /** Resolves when no candidate is mid-assembly. */
  whenIdle(): Promise<void>
}
export function createCapture(deps: CaptureDeps): Capture
```

There is **no `CapturePort`** and no structural copy of this interface anywhere. `wiring.ts` writes
`import type { Capture } from '@cairn/capture'` and takes it as a dependency. A parallel local
re-declaration is not "decoupling": it is a shape that can silently drift from the real one, and the
two members most likely to drift are the two that matter on shutdown — `stop()` returns a
`Promise<void>` that the quit path **awaits** (so the poll timer is really cancelled before the key is
zeroed), and `whenIdle()` is what a test awaits so it never asserts on a half-assembled candidate.
Drop either from a copy and both bugs are invisible to `tsc`.

### 5.6 Domain and store types

```ts
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
```

`DeleteReason` exists precisely so spec §4's "local eviction emits no tombstone" is enforceable:
`ITEM_DELETED` is always written to the local log (the hash chain requires it), but only
`reason: 'user'` will ever be syncable. M1 asserts that in `retention.test.ts` and M5 relies on it.

`watermarks` is a **vector keyed by device id**, empty `{}` in M1. It is in the `CHECKPOINT` record
from day one because retrofitting it is a wire break (spec §10).

```ts
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

/** `meta.json`. NOT `KeyringMode`: `'locked'` is a RUNTIME mode, never a persisted one. */
export interface StoreMeta {
  readonly schemaVersion: 1
  readonly keyMode: 'os-keyring' | 'passphrase' | 'unknown'
  readonly scryptSaltB64: string | null
}
```

`[verified]` ufuzzy 1.0.19's `info.ranges[n]` is a flat `number[]`: matching `hlwrd` against
`hello world from a long preview` yields `[0,1,2,3,6,7,8,9,10,11]`, i.e. the pairs
`(0,1) (2,3) (6,7) (8,9) (10,11)`. A `[number, number][]` type here would be wrong.

`KeyringMode` has **no `'unencrypted'` member in M1** `[decided here]`. Spec §6 offers "store history
unencrypted" as a first-run choice, but M1 has no first-run UI; if `safeStorage` is unusable, M1
requires a passphrase. Adding the mode later is additive.

`StoreMeta.keyMode` is **exactly** `'os-keyring' | 'passphrase' | 'unknown'` — three members, and
`'locked'` is deliberately not one of them, so `StoreMeta.keyMode` is **not** `KeyringMode`.
`'locked'` is a fact about *right now*; persisting it would claim the store was written by a locked
keyring, which is not a thing that can happen. Writing `keyMode: 'locked'` into `meta.json` is
therefore a **type error**, and the composition root maps it
(`keyMode === 'locked' ? 'unknown' : keyMode`) before calling `writeMeta`. `'unknown'` is also the
value a freshly created `meta.json` carries, before the keyring has reported anything.

### 5.7 The privacy layer's frozen numbers and rules

```ts
export const SECRET_TTL_MS = 300_000                     // 5 minutes, spec §11 control 5
export const RETENTION_MAX_ITEMS = 500
export const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
export const RETENTION_MAX_BYTES = 512 * 1024 * 1024
export const SEARCH_INDEX_DEFAULT = 500
export const SEARCH_INDEX_HARD_CAP = 2_000
export const PREVIEW_MAX_CHARS = 512
export const THUMBNAIL_MAX_EDGE_PX = 256
export const THUMBNAIL_JPEG_QUALITY = 70
export const THUMBNAIL_MAX_BYTES = 24 * 1024
export const CAPTURE_DEBOUNCE_MS = 150
export const WATCH_INTERVAL_MS = 500
```

**Mask format, frozen:**

```ts
export const MASK_BULLET = '•'      // •
/** `AKIA••••A7QD`: first 4 + four bullets + last 4. Under 12 chars, eight bullets and nothing else. */
export function maskToken(raw: string): string {
  return raw.length >= 12 ? raw.slice(0, 4) + MASK_BULLET.repeat(4) + raw.slice(-4) : MASK_BULLET.repeat(8)
}
```

`[verified]` `maskToken('AKIA2E0PQIN4XA7QD') === 'AKIA••••A7QD'` — the exact string in the M1 demo.

**Detector patterns, frozen** (spec §4). Each is anchored to a whitespace-free run:

| `DetectorName` | pattern |
|---|---|
| `pem-private-key` | `/-----BEGIN (?:RSA \| EC \| OPENSSH \| DSA \| PGP )?PRIVATE KEY(?: BLOCK)?-----/` |
| `aws-access-key` | `/\b(?:AKIA\|ASIA)[0-9A-Z]{12,20}\b/` |
| `github-token` | `/\b(?:ghp_\|gho_\|ghu_\|ghs_\|ghr_)[A-Za-z0-9]{30,}\b\|\bgithub_pat_[A-Za-z0-9_]{20,}\b/` |
| `openai-key` | `/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/` |
| `anthropic-key` | `/\bsk-ant-[A-Za-z0-9_-]{20,}\b/` |
| `slack-token` | `/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/` |
| `stripe-live-key` | `/\b(?:sk\|rk)_live_[A-Za-z0-9]{20,}\b/` |
| `google-api-key` | `/\bAIza[A-Za-z0-9_-]{35}\b/` |
| `jwt` | `/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/` |
| `high-entropy` | the rule below — **not** a bare regex |

**`high-entropy`, frozen — and this is the part the spec gets almost right and the plan must get
exactly right.** Spec §4 says "Shannon entropy > 4.0 bits/char over any 20+ char whitespace-free
run", and spec §7 requires a false-positive corpus of "base64 image data, minified JS, git SHAs,
UUIDs, long URLs" that must not trip. `[verified]` the bare rule **fails its own corpus**: a long
URL with tracking parameters scores **4.317** and minified JS scores **4.622**, both above 4.0. Git
SHAs (3.565) and UUIDs (3.391) are safe, and uniform lowercase hex is exactly 4.0000 as the spec
says, so that half of the claim holds.

The frozen rule that passes the whole corpus:

```ts
export const ENTROPY_MIN_RUN = 20
export const ENTROPY_MAX_RUN = 512
export const ENTROPY_BITS_PER_CHAR = 4.0

const TOKEN_RE = /^[A-Za-z0-9+/_=.-]{20,512}$/
const URLISH_RE = /^[a-z][a-z0-9+.-]*:/i                    // http:, https:, data:, file:, mailto:
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

Each guard earns its place: the `URLISH_RE` skip is what saves the long URL **and** a
`data:image/png;base64,…` paste; `CODEISH_RE` is what saves minified JS; and the 512-char ceiling is
what saves a large raw base64 image body, which is information-theoretically indistinguishable from
a secret and cannot be saved any other way.

`fixtures/secrets/false-positive-corpus.json` contains **exactly these 13 entries**, and
`packages/privacy/src/corpus.test.ts` asserts none of them trips:

| key | value |
|---|---|
| `git sha` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4` |
| `git log line` | `commit 9f2b1c8a4d6e7f0a1b2c3d4e5f60718293a4b5c6 Author: Someone` |
| `uuid v4` | `550e8400-e29b-41d4-a716-446655440000` |
| `uuid upper` | `F47AC10B-58CC-4372-A567-0E02B2C3D479` |
| `long url` | `https://example.com/some/very/long/path/to/a/page?utm_source=newsletter&utm_medium=email` |
| `data url png` | `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==` |
| `minified js` | `function a(b,c){return b+c}var d=a(1,2);console.log(d);` |
| `minified js 2` | `!function(e,t){"object"==typeof exports?module.exports=t():e.x=t()}(this,function(){return 42});` |
| `posix path` | `/Users/someone/Library/Application Support/Cairn/history.ndjson` |
| `sentence` | `The quick brown fox jumps over the lazy dog and then keeps going for a while` |
| `big base64 png body` | `'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH'.repeat(9)` (639 chars) |
| `semver list` | `electron@44.1.1 vite@7.3.6 vitest@4.1.11 typescript@5.9.3` |
| `lorem hex table` | `0123456789abcdef 0123456789abcdef 0123456789abcdef` |

And the `high-entropy` half of `fixtures/secrets/detector-corpus.json` contains **exactly these
four**, each of which must trip:

| key | value | entropy |
|---|---|---|
| `base64url 43 secret` | `LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ` | 4.868 |
| `random 32-byte b64` | `q7mHKp2vX9Lz4NsRt6Wc1YbEgJd0AfUiOo3xQlZn8kM=` | 5.459 |
| `hex-ish mixed case api key` | `aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY` | 4.688 |
| `db password blob` | `Tr0ub4dor-and-3-ZzQq9WvXm2Lk8Np` | 4.672 |

`[verified]` All 13 false positives pass and all 4 true positives trip, with the code above.

**Privacy API:**

```ts
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
export function classify(snapshot: Snapshot, rules: PrivacyRules): Classification
export function mask(text: string): { readonly preview: string; readonly spans: readonly MaskSpan[] }
/** THROWS by design (spec §4, §11 control 5). See §6. */
export function assertSyncable(item: Item): void
```

`classify` layer order is fixed and short-circuits: (1) OS hints — `concealed` ⇒
`{action:'skip'}` with no byte inspected; (2) exclusion list — `[]` in M1, and when a rule is active
and the owner is unknowable it fails **closed**; (3) detectors ⇒ `{action:'record', flags:['secret',…]}`
because a masked, TTL'd, unpinnable, unsyncable row is more useful than a hole in the history.

### 5.8 The injected `Clock`

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

A cancel **closure** rather than an opaque handle type, so there is no `TimerHandle` to brand and no
way to pass a handle to the wrong clock. `advance(ms)` fires every timer whose deadline falls in the
window, in deadline order, and re-entrant timers scheduled during the sweep fire in the same sweep if
they land inside the window — the `for (;;)` re-scans on every iteration precisely for that.

`[verified]` two timers at +100 and +200 with a third at +150 cancelled: `pending === 2`,
`advance(150)` fires only the first and leaves `now === 1_150`, `advance(100)` fires the second and
leaves `pending === 0`, `now === 1_250`.

Nothing outside `systemClock` may call `Date.now()`, `setTimeout`, `setInterval` or `performance.now()`.

### 5.9 The renderer IPC union

Frozen channel names. **One channel per method** — there is no generic `invoke(channel, …)`.

```ts
// packages/protocol/src/ipc.ts
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

**Both directions are validated** (spec §11 control 8): main validates `params` on receipt and
`result` before replying; the renderer's `api.ts` validates every event payload before it reaches
component state. A validation failure in main logs `ipc.rejected` and returns
`E_IPC_REJECTED` — it never reaches domain code.

The **preload surface, frozen and enumerated**:

```ts
// apps/desktop/preload/src/index.ts — the whole exposed API. Nothing dynamic.
contextBridge.exposeInMainWorld('cairn', {
  list: (params) => ipcRenderer.invoke('cairn:history.list', params),
  search: (params) => ipcRenderer.invoke('cairn:history.search', params),
  preview: (params) => ipcRenderer.invoke('cairn:history.preview', params),
  pin: (params) => ipcRenderer.invoke('cairn:history.pin', params),
  remove: (params) => ipcRenderer.invoke('cairn:history.remove', params),
  copy: (params) => ipcRenderer.invoke('cairn:recall.copy', params),
  close: () => ipcRenderer.invoke('cairn:palette.close', {}),
  securityStatus: () => ipcRenderer.invoke('cairn:security.status', {}),
  onHistoryChanged: (cb) => subscribe('cairn:history.changed', cb),
  onHotkeyStatus: (cb) => subscribe('cairn:hotkey.status', cb),
  onToast: (cb) => subscribe('cairn:toast', cb),
  onPaletteShown: (cb) => subscribe('cairn:palette.shown', cb),
})
```

Twelve methods, hard-coded channel strings, each `onX` returning an unsubscribe function. There is no
`invoke`, no `send`, no `channel` parameter, and no `ipcRenderer` reachable from the page.

---

## 6. The `Result<T>` / error convention

**One convention: expected failures are returned as `Result<T>`; unexpected failures throw.**

Justification, one line: `Result<T>` makes forgetting to handle a failure a *compile* error — you
cannot read `.value` off a `Result<T>` without narrowing `.ok` first under `strict` — and a clipboard
manager's characteristic bug is silently stopping work, so the failure path must be impossible to
skip.

- **Return `Result<T>`** for: every `ClipboardAgent.request`; every store read, write, blob and chain
  operation; keyring unlock and mode transitions; `parseAgentLine`; every IPC handler's outcome;
  every history operation that can legitimately fail (`E_ITEM_NOT_FOUND`, `E_ITEM_EXPIRED`,
  `E_PIN_REFUSED_SECRET`).
- **Throw** for: programmer errors and broken invariants — a bad argument shape that types should
  have prevented (`newItemId` with 9 random bytes), an unreachable `switch` default, a `Clock`
  misuse. These are bugs, not states, and a stack trace is the right output.
- **`start()` rejects** rather than returning `Result` — see §5.4.
- Never `throw` an `Err`. Never wrap a `Result` in a `try`. There is no `CairnError` class in M1.

**The one deliberate exception, from spec §4 and §11 control 5:**

```ts
/** THROWS on purpose. A silent filter is how "why didn't my item sync?" becomes unanswerable. */
export function assertSyncable(item: Item): void {
  const offending = item.flags.filter((f) => (NON_SYNCABLE_FLAGS as readonly Flag[]).includes(f))
  if (offending.length > 0) {
    throw new Error(`cairn: refusing to sync item ${item.id}: flags ${offending.join(',')}`)
  }
}
```

The thrown message contains the item **id and flags only** — never the preview, never bytes.
`packages/privacy/src/assert-syncable.security.test.ts` asserts it throws for all four flags in
`NON_SYNCABLE_FLAGS`, returns `undefined` for a clean item, and that the message does not contain a
canary copied earlier in the test.

---

## 7. Fixture and test conventions

### Where things live

- Tests sit **next to source** as `*.test.ts` (the `unit` project — or the `renderer` project when the
  file is under `apps/desktop/renderer/src/`) or `*.security.test.ts` (the `security` project,
  wherever it lives). There is no `tests/` tree. The one exception to "next to source" is the
  `security/` directory, whose tests are repo-wide by nature and belong to no package.
- Byte fixtures: `fixtures/formats/`. Transcripts: `fixtures/agent-transcripts/`. Detector corpora:
  `fixtures/secrets/`.
- **Every test file is ESM. A dynamic import is `await import(...)`, never `require(...)`.** Root
  `package.json` sets `"type": "module"` (§2) and vitest loads these files as ESM. A `require` of a
  relative module cannot resolve, because CJS resolution has no `.ts` extension to work with.
  `[verified]` on vitest 4.1.11: a top-level `const { composeApp } = require('./wiring')` in a
  `*.test.ts` reports

  ```
  ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
   FAIL  packages/p/src/req3.test.ts [ packages/p/src/req3.test.ts ]
  Error: Cannot find module './wiring'
  Require stack:
  - .../packages/p/src/req3.test.ts
  ...
   Test Files  1 failed (1)
        Tests  no tests
  ```

  `Tests  no tests` is the dangerous part: the file fails **as a suite**, so **every** assertion in it
  is skipped rather than failed. That is worth spelling out because of where it bites hardest —
  `apps/desktop/main/src/wiring.test.ts` needs a dynamic import to re-load the composition root with
  mocked Electron, and it is also the file holding the lock-path and quit-path key-zeroing assertions.
  One `require(` at its top level takes those two security assertions down with it while the error
  names the module resolver, so it reads like a harness problem rather than a missing control. Write
  `const { composeApp } = await import('./wiring')` inside an `async` test.
  (`require` of a *builtin* such as `node:path` happens to work — vitest shims it — which is exactly
  why this cannot be left to "it worked when I tried it".)
- Tests read fixtures through one helper so no test hard-codes a path:

```ts
// packages/protocol/src/testing.ts
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Repo root, resolved from this file, so a test's cwd never matters. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const fixturePath = (...p: string[]): string => join(REPO_ROOT, 'fixtures', ...p)
```

### Temp dir + random key, one helper, used by every store test

```ts
// packages/store/src/testing.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** A fresh 0700 directory that is removed on cleanup. Never reused between tests. */
export function tempStoreDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A random 32-byte master key. The store takes a key as an argument precisely so every test can
 *  run on a machine with no keychain and no compiler (spec §4). */
export function randomTestKey(): Buffer {
  return randomBytes(32)
}
```

`[verified]` `mkdirSync(deepPath, { recursive: true, mode: 0o700 })` applies `0700` to **every**
intermediate directory it creates, and `appendFileSync` to a file created with `mode: 0o600`
preserves `600`.

### The NDJSON transcript format for `createFakeAgent`

A transcript is an NDJSON file. **Line 1 must be the meta line**; every later line is a directed
frame.

```
{"v":1,"t":"meta","transcript":"hello-watch-text","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"scrubbed by hand 2026-09-02"}
{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}
{"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"wireMajor":1,"agent":"macos","agentVersion":"0.1.0","platformVersion":"26.5.1","tier":"A","clipboardWatch":"changecount-poll","paste":"none","hotkey":"carbon","focusApp":true,"concealedTypeHints":true,"maxRepBytes":20971520,"chunkThresholdBytes":65536,"missingTools":[]}}}
{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"watch.start","params":{"intervalMs":500}}}
{"dir":"out","line":{"v":1,"t":"res","id":"*","ok":true,"result":{"watching":true,"intervalMs":500}}}
{"dir":"out","delayMs":500,"line":{"v":1,"t":"ev","event":"clipboard.changed","data":{"changeCount":364,"hints":[],"reps":[{"mime":"text/plain","uti":"public.utf8-plain-text","byteLength":11,"sha256":"sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek","inline":"aGVsbG8gd29ybGQ="}],"frontmostBundleId":"com.apple.TextEdit","frontmostName":"TextEdit","attributionConfidence":"heuristic"}}}
```

Rules, frozen:

- `dir: "in"` = a request the **host is expected to send**. `createFakeAgent` compares the host's
  next outbound request against it and **fails the test** if it differs — this is spec §4's "asserts
  the host's outbound request script".
- `dir: "out"` = a line the agent emits, replayed to the host.
- The literal string `"*"` in an `in` line means "any value" for that field. `id` is always `"*"`
  because the host allocates ids. In an `out` response, `id: "*"` means "echo the id of the most
  recent matched `in` request".
- `delayMs` (optional, `out` only) advances the **injected clock** by that much before emitting.
  There are no real timers in a transcript replay.
- Replay is strictly in file order. An `out` line is emitted as soon as its preceding `in` line has
  been matched.

Mismatch failure messages are exact, so a broken test is diagnosable at a glance:

```
FakeAgent: outbound request #3 did not match the transcript script.
  transcript: {"method":"read","params":{"changeCount":364}}
  actual:     {"method":"read","params":{"changeCount":363}}
  transcript: fixtures/agent-transcripts/hello-watch-text.ndjson line 6
```

and at the end of a replay:

```
FakeAgent: transcript not fully consumed — 2 of 9 frames unplayed (next: in read).
```

`createFakeAgent` also asserts the negative: an outbound request with **no** matching `in` line fails
with `FakeAgent: unexpected outbound request `write` — the transcript scripts no further requests.`

### Committed transcripts contain SYNTHETIC content only

The repo README states this and `.gitignore` already excludes `fixtures/agent-transcripts/*.raw.ndjson`
and `fixtures/agent-transcripts/unscrubbed/`. `tools/record-transcript.ts` writes **only** to
`*.raw.ndjson`; promoting one to a committed fixture is a deliberate human rename plus a scrub.

`scripts/scan-transcripts.mjs`, run by `npm run scan:transcripts` and by
`security/transcripts-synthetic.security.test.ts`, fails if any committed transcript:

1. has no meta line, or `meta.synthetic !== true`;
2. contains a `Rep.inline` or `rep.chunk.b64` whose decoded bytes, interpreted as UTF-8, trip any
   detector in `@cairn/privacy` — the same code path as the product, so the scan cannot drift;
3. contains a `frontmostBundleId` outside a small allowlist of well-known bundle ids
   (`com.apple.*`, `com.google.Chrome`, `com.1password.1password`, `app.cairn.desktop`);
4. is over 512 KiB, which is a sign someone committed a real screenshot.

---

## 8. The `security` test-suite contract

Spec §11's "Verified as a CI job, not as a habit" list, turned into files. Run with:

```sh
npm run test:security       # vitest run --project security
```

and as part of `npm run verify`. Every entry below must exist and must **fail if its control is
removed** — that is the acceptance criterion for each of these tests, and each task section that
owns one must demonstrate the failure.

Two structural rules for this table:

- **Every file in it has a row in §1's tree, and every task that creates one names it.** A security
  test with no contract row is a security test a later task deletes as unaccounted-for. That is
  precisely how `security/agent-no-file-writes.security.test.ts` — the only assertion that the
  clipboard-holding Swift process has no disk or network sink — spent a revision orphaned.
- Two entries below are **not** in the `security` project: `security/source-scan.ts`'s own unit test
  runs in `unit` (via that project's `'security/**/*.test.ts'` include, §2), and the shell-execution
  ban is a `describe` block inside an existing security file rather than a new one. Both still run in
  CI, which is what matters.

| Spec §11 invariant | File | The precise assertion |
|---|---|---|
| No plaintext clipboard bytes under the data dir or the temp dir after a capture | `security/no-plaintext-on-disk.security.test.ts` (created by the **store** task; every other task only bends its own code around it) | Redirect `process.env.TMPDIR` to a private empty directory the test owns — `[verified]` `os.tmpdir()` re-reads `$TMPDIR` on every call — then ingest a `Candidate` whose text is the canary `CAIRN-CANARY-9f3a1c7e` through a real `openStore` + `putBlob` + `appendEvent`. Assert the private temp dir is still **empty** under any filename; read **every byte of every file** under the data dir and assert neither the canary nor its base64 form appears; and assert a planted plaintext file IS found, so the walker is not vacuous. The **shared** temp dir's listing is deliberately NOT compared for equality (concurrent vitest workers make that flaky both ways) — it is checked by name for anything matching `/spool/i`. Plus a source scan of `packages/**` and `apps/desktop/**`, `.ts` only, **comments stripped** (the ban is on code; several files legitimately document "it never spools to a file"), for these seven identifiers: `mkdtemp`, `tmpdir(`, `os.tmpdir`, `spool`, `writeFileSync(`, `appendFileSync(`, `createWriteStream(`. Exemptions are exactly three: any path ending **`.test.ts`** (a test builds its own temp dir and writes hostile fixtures on purpose); the three WRITE identifiers under `packages/store/`; and the single file `packages/store/src/testing.ts` for the temp-dir identifiers. `apps/desktop/main/src/config.ts` is deliberately NOT exempt — it uses `openSync`/`writeSync`/`fchmodSync` so it narrows a pre-existing world-readable file, and exempting it would let that regress silently. The scan asserts `scanned.length > 10` and `scanned` contains `packages/store/src/blobs.ts` **before** the ban, so a scan that read nothing cannot pass. |
| Data-dir and file permissions are `0700`/`0600` | `packages/store/src/paths.security.test.ts` | After `openStore`, `statSync(dir).mode & 0o777 === 0o700`; after an `appendEvent`, a `putBlob` and a `key.bin` write, each file is `0o600`; asserted again after a second append, because `appendFileSync` on a pre-existing file must not widen the mode. |
| No socket is listening at startup, and no local control socket | `security/no-socket-at-startup.security.test.ts` | `composeApp(deps)` with a fake agent, then `process.getActiveResourcesInfo()` must contain no entry matching `/TCPSERVERWRAP\|TCPWRAP\|UDPWRAP/i`. `[verified]` this API reports `TCPServerWrap` the moment a `net.createServer().listen()` succeeds, so the test can fail. Plus a source scan: no `net.createServer`, `http.createServer`, `dgram.createSocket`, `tls.createServer`, `new WebSocketServer`, `bonjour`, `fetch(` or `https.request` anywhere in `packages/**` or `apps/desktop/**`. |
| **No shell in the capture or recall path** (spec §11 control 3, last clause) | a third `describe` block in `security/no-socket-at-startup.security.test.ts` — one place, not a new file | Over the same product roots (`packages/**`, `apps/desktop/**`; `security/**` and `tools/**` are NOT product roots, so the guard's own legitimate `execFileSync`/`spawnSync` are untouched), the source scan finds none of: `execSync`, `execFile`, `spawnSync`, `child_process.exec(`, `shell: true`, `shell:true`, `shell: process.env`, `/bin/sh`, `/bin/bash`, `osascript`. Bare `exec(` is deliberately NOT on the list, and this is not an oversight to be "fixed" later: `RegExp#exec` is the idiomatic way to run a sticky regex, so `packages/privacy/src/detectors.ts` and `packages/capture/src/normalize-reps.ts` both call `.exec(` legitimately and banning the bare token would make the guard cry wolf until someone deleted it. `child_process.exec(` covers the real thing. Second assertion, positive: `packages/agent-host/src/spawn-agent.ts` contains `spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })` and does **not** contain the substring `shell`. **Why this exists:** a copied file path is a string we display and hand to the OS clipboard. The moment one is interpolated into a command line, `$(…)` in a filename is remote code execution triggered by a copy. Nothing else in the suite asserted this. Proof of failure: adding `shell: true` to `spawn-agent.ts`'s spawn options makes the second assertion report `expected 'const c = spawn(binPath, args, { stdio…' not to contain 'shell'`. |
| A copied canary string never appears in any log output | `apps/desktop/main/src/logger.security.test.ts` | Build the real logger with an injected `write(line)` sink; run a full ingest of the canary through `composeApp`; assert every captured line parses as JSON, that the union of all keys across all lines is a subset of `keyof LogFields ∪ {level, event, ts}`, and that `JSON.stringify(allLines).includes('CAIRN-CANARY-9f3a1c7e') === false`. Paired with the compile-time proof in `packages/protocol/src/types.test.ts` and the id-list proof in `packages/protocol/src/log.test.ts`. |
| `crashReporter` is not initialised | `security/no-crash-reporter.security.test.ts` | The identifier `crashReporter` appears in **no** file under `apps/desktop/**`, `packages/**` or `tools/**`. `[verified]` a weaker runtime check is not enough: with `start()` never called, `crashReporter.getUploadToServer()` returns `false` and `getLastCrashReport()` returns `null` — but both are also true after `start({uploadToServer:false})`, so only the source ban actually proves the control. |
| The renderer's `webPreferences` match the hardened set | `apps/desktop/main/src/windows.security.test.ts` | `PALETTE_WEB_PREFERENCES` deep-equals `{sandbox:true, contextIsolation:true, nodeIntegration:false, nodeIntegrationInSubFrames:false, nodeIntegrationInWorker:false, webSecurity:true, allowRunningInsecureContent:false, experimentalFeatures:false, webviewTag:false, enableBlinkFeatures:'', spellcheck:false, devTools:false}` when `isPackaged` is true, and identically except `devTools:true` when false. Separately: `CSP_POLICY_PROD` contains no `unsafe-inline` and no `unsafe-eval`, includes `default-src 'none'` and `connect-src 'none'`, `CSP_POLICY_DEV` is unreachable when `isPackaged`, and `registerNavigationGuards(wc)` makes `will-navigate` call `preventDefault()` for `https://evil.example` and `setWindowOpenHandler` return `{action:'deny'}`. |
| The renderer's CSP, permissions and navigation, asserted repo-wide | `security/renderer-hardening.security.test.ts` | Five `describe` blocks: (1) every dangerous `webPreference` is off in a packaged build, and the baseline constant cannot be widened without this test noticing; (2) `CSP_POLICY_PROD` has no `unsafe-inline`, no `unsafe-eval` and no wildcard, and denies all network egress (`connect-src 'none'`); (3) `CSP_POLICY_DEV` is unreachable from a packaged build; (4) `will-navigate`, `will-frame-navigate` and `will-redirect-navigate` all `preventDefault()`, `setWindowOpenHandler` returns `{action:'deny'}`, and **every** permission request is denied; (5) a packaged build never resolves a URL — content comes from local files only. This is the repo-wide companion to `windows.security.test.ts`: that one asserts the constants, this one asserts the wiring that consumes them. |
| The preload bridge is an enumerated method set, not a passthrough | `apps/desktop/preload/src/index.security.test.ts` | Three assertions: the bridge is exposed under exactly one global name (`cairn`); the exposed object's own keys are **EXACTLY these twelve** — `list`, `search`, `preview`, `pin`, `remove`, `copy`, `close`, `securityStatus`, `onHistoryChanged`, `onHotkeyStatus`, `onToast`, `onPaletteShown` — no more and no fewer; and there is **no generic bridge** (`invoke`, `send`, `on` and any `channel` parameter are all `undefined` on the exposed object). Spec §11 control 4. Proof of failure: adding `invoke: (channel, params) => ipcRenderer.invoke(channel, params)` makes `-t 'no generic bridge'` report `expected [Function] to be undefined` and `-t 'EXACTLY these twelve'` report `expected 13 to be 12`. |
| The config file cannot become a plaintext cache | `apps/desktop/main/src/config.security.test.ts` | Five assertions: the data dir is created `0700` and the file `0600`; a **pre-existing world-readable** config file is NARROWED to `0600` (which is why `config.ts` uses `openSync`/`writeSync`/`fchmodSync` and not `writeFileSync`); the mode stays `0600` across repeated saves; an extra key carrying clipboard content is stripped by the zod schema **before** anything is written; and a config that fails its own schema is refused rather than written. |
| A canary copied into the store appears nowhere in its bytes | `packages/store/src/store.security.test.ts` | Seal a record and a blob whose text is `TEST_CANARY`, then read every byte of every file the store owns and assert neither the canary nor its base64 form is present — the per-package layer beneath the repo-wide `security/no-plaintext-on-disk.security.test.ts`. |
| A hostile HTML clipboard item is text in **every** renderer sink | `apps/desktop/renderer/src/Palette.security.test.ts` | Mount the real `Palette` with a fake `window.cairn` whose one item's preview is `<img src=x onerror="window.cairn.list({limit:1,offset:0,pinnedOnly:false})">`, then assert `host.querySelectorAll('img').length === 0`, the preview pane's `textContent` **is** the payload verbatim, the row's `textContent` contains it, and the badge reads `HTML source`. Then `setQuery('img')` to drive the ufuzzy match-highlighting path — a second possible sink, because it builds DOM from offsets — and assert `mark.textContent === '<img'`, still zero `img` elements, `globalThis.__pwned === undefined`, exactly **one** `list` call (nothing in the payload reached the bridge) and zero `copy` calls. `Preview.security.test.ts` covers one component; this covers the whole path from IPC to row to preview. |
| The preview pane escapes an HTML payload containing `<img onerror>` | `apps/desktop/renderer/src/Preview.security.test.ts` | `mount(Preview, {props:{text:'<img src=x onerror="window.__pwned = true">', mime:'text/html'}})` then `pre.textContent === payload`, `pre.querySelector('img') === null`, `pre.innerHTML === '&lt;img src=x onerror="window.__pwned = true"&gt;'`, and `globalThis.__pwned === undefined`. `[verified]` this exact test passes with Svelte 5.57.0 + jsdom 30.0.1 under the §2 security project config. |
| — same control, statically | `security/no-html-sink.security.test.ts` | No `.svelte` file under `apps/desktop/renderer/` contains the raw-HTML directive token `{@html`, nor `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `new Function`. Svelte's raw-HTML directive is the only HTML-injection sink the framework offers, so banning it is the whole control. **`.svelte` files are scanned RAW — comments are not stripped**, because a Svelte comment is still template text a preprocessor could act on. Consequence, and it is not optional: no `.svelte` file may contain that token even inside a comment, so `Preview.svelte`'s header comment describes it in prose ("never the Svelte raw-HTML directive") instead of quoting it. A comment quoting the token fails the very ban it documents. |
| `assertSyncable()` throws for every flag in the secret set | `packages/privacy/src/assert-syncable.security.test.ts` | `for (const flag of NON_SYNCABLE_FLAGS)` → `expect(() => assertSyncable(itemWith([flag]))).toThrow(/refusing to sync/)`; a clean item returns `undefined`; and the thrown message contains no canary. |
| Secrets masked at ingest, index never holds the raw value | `packages/search/src/index.security.test.ts` | Ingest an item whose raw text is `AKIA2E0PQIN4XA7QD`; assert the index's stored haystack entry is `AKIA••••A7QD`; assert `query('AKIA2E0PQIN4XA7QD')` returns `[]` and `query('akia')` returns the item; assert the full raw string appears nowhere in `JSON.stringify(index.debugHaystack())`. |
| Secret TTL 5 minutes, exempt from pinning | `packages/history/src/retention.test.ts` | With `createTestClock()`, a secret-flagged item is listed at `t+299_999` and gone at `t+300_000`; `pin(id, true)` returns `err('E_PIN_REFUSED_SECRET')` and the item is still gone at `t+300_000`. |
| Master key zero-filled on lock and quit | `packages/keyring/src/keyring.security.test.ts` | Capture the `Buffer` returned by `getOrCreateMasterKey()`, call `lock()`, assert `buf.every(b => b === 0)`; repeat for the quit path; assert `getMode()` becomes `'locked'`. The assertion is on the buffer's **contents**, not on a flag or a nulled reference — a nulled reference leaves the bytes in the heap. |
| Passphrase-mode re-lock on screen lock (spec §11 control 6, third clause) — **M1 deviation, recorded** | `apps/desktop/main/src/wiring.test.ts -t 'a screen lock zeroes the master key'` | In M1 the lock zero-fills the key and the palette shows `KEYRING_RELOCKED_BANNER`; re-entering the passphrase requires relaunching Cairn, because the in-session prompt is renderer surface deferred to M3. `keyring.unlockWithPassphrase()` therefore has **no M1 call site** and is covered only by `packages/keyring/src/keyring.test.ts`. The security property (the key is gone from memory) holds; only the recovery ergonomics are deferred. |
| No custom URI scheme | `security/no-uri-scheme.security.test.ts` | The identifiers `setAsDefaultProtocolClient`, `removeAsDefaultProtocolClient`, `CFBundleURLTypes`, `open-url` and the literal `cairn://` appear in no source file, no `Info.plist` fragment and no config. Spec §11 control 10. |
| Supply chain | `security/supply-chain.security.test.ts` | `package-lock.json` exists and `lockfileVersion >= 3`; every version string in root `devDependencies` and every workspace `dependencies` matches `/^\d+\.\d+\.\d+$/` (no `^`, `~`, ranges or tags); `.npmrc` contains `ignore-scripts=true`; `electron` is exactly `44.1.1`; and `scripts/guard-no-electron-rebuild.mjs` exits 0 when spawned. |
| Transcripts are synthetic | `security/transcripts-synthetic.security.test.ts` | Runs the four checks in §7 over every committed `fixtures/agent-transcripts/*.ndjson`. |
| No plaintext bytes written during a capture | `packages/capture/src/capture.security.test.ts` | Monkey-patch `node:fs`'s write surface for the duration of a transcript-driven capture (`writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `createWriteStream`, `open` with a write flag, `mkdtemp`, `mkdtempSync`) and assert **zero** calls. `@cairn/capture` "never writes to disk" (spec §4) — this is what makes that sentence true. |
| No filesystem **and no network** sink in the macOS agent (spec §11 control 1) | `security/agent-no-file-writes.security.test.ts` (created by the **macOS agent** task) | Every `.swift` file directly under `agents/macos/Sources` is read, **comment-stripped** (comments legitimately name these APIs to say "never do this"), and scanned line by line. Filesystem set: `FileManager`, `createFile`, `write(toFile`, `writeToFile`, `NSTemporaryDirectory`, `mkstemp`, `mkdtemp`, `fopen(`, `fwrite(`, `FileHandle(forWritingAtPath`, `FileHandle(forUpdatingAtPath`, `URL(fileURLWithPath`, `Data(contentsOf`, `String(contentsOf`, `UserDefaults`, `CFPreferences`. Network set: `URLSession`, `NWConnection`, `NWListener`, `NWBrowser`, `Network`, `NetService`, `CFSocket`, `CFStream`, `socket(`, `getaddrinfo`, `NSXPCConnection`, `Process(`. Not vacuous: asserts the file list contains `main.swift` before asserting `hits` is empty. `agents/macos/Tests/SelfTest.swift` is deliberately **not** scanned — it legitimately builds `URL(fileURLWithPath:)` for `/bin/ls`, and it is a test binary that never ships. **Why the agent needs its own file:** it is the process that holds clipboard bytes **first**, its only legitimate sinks are stdout (protocol) and stderr (human text), and it sits outside every other ban's roots — `no-plaintext-on-disk` scans `packages/**` and `apps/desktop/**`, and `no-socket-at-startup` scans the same two, so nothing else looks at `.swift` at all. An earlier revision of this design spooled oversized representations to `$TMPDIR`; this is what stops that coming back. Proof of failure: appending `let _ = FileManager.default.temporaryDirectory` to any file under `agents/macos/Sources/` makes it fail. |

The canary constant is shared, so no test invents its own:

```ts
// packages/protocol/src/constants.ts
/** Copied during security tests; must never appear on disk or in a log line. */
export const TEST_CANARY = 'CAIRN-CANARY-9f3a1c7e'
```

---

## 9. M1 dependency table

| package | exact version | workspace | why |
|---|---|---|---|
| `electron` | `44.1.1` | root (dev) | the runtime; pinned exact by spec §3. Verified present and launching. |
| `electron-vite` | `5.0.0` | root (dev) | the only build tool: main + preload + renderer in one config. |
| `vite` | `7.3.6` | root (dev) | electron-vite 5's peer range stops at 7. **Not 8.** |
| `@sveltejs/vite-plugin-svelte` | `6.2.4` | root (dev) | Svelte 5 compilation for vite 7. **Not 7.3.0** — that needs vite 8. |
| `svelte` | `5.57.0` | root (dev) | the palette UI; `mount()`/`$state`/`$props` used directly, no component-test library. |
| `svelte-check` | `4.7.6` | root (dev) | the only way to type-check `.svelte` files. |
| `typescript` | `5.9.3` | root (dev) | spec §3 pins TS 5.9; used as a checker only, never to emit. |
| `vitest` | `4.1.11` | root (dev) | the test runner; **three** projects (`unit`, `renderer`, `security`), each with its own `npm run test:*` script so CI cannot skip one. |
| `@vitest/coverage-v8` | `4.1.11` | root (dev) | coverage; must match vitest's version exactly (it is a strict peer). |
| `jsdom` | `30.0.1` | root (dev) | a DOM for exactly one thing: the Preview escaping test. Latest is 30.0.1 — **there is no jsdom 28**. |
| `@types/node` | `24.9.2` | root (dev) | matches Electron 44's bundled Node 24. |
| `zod` | `4.5.4` | `protocol` | every contract: agent NDJSON, renderer IPC, transcripts. |
| `sharp` | `0.35.4` | `capture` | thumbnails and TIFF→PNG. Node-API prebuilds ship as optional deps, so `ignore-scripts=true` is fine. |
| `@leeoniya/ufuzzy` | `1.0.19` | `search` | in-memory fuzzy ranking over decrypted previews. |

Nothing else. In particular: no `tsup` (§2), no `electron-builder` (M3, and it drags
`@electron/rebuild`), no `jsonwebtoken`/`ulid`/`nanoid`/`lodash` (hand-rolled: `newItemId`,
`shannonBits`, the JWT detector are 40 lines total), no `@electron-toolkit/*`, no
`@testing-library/*`, no `dotenv`, no logging library.

**Nothing in this table is unverified.** Every version above was printed by `npm view <pkg> version`
on this machine and then installed together as one workspace root without a peer warning.

The two versions the plan is most likely to get wrong, called out because a range would resolve to
them: `vite@8.2.2` is the `latest` tag and breaks electron-vite 5; `@sveltejs/vite-plugin-svelte@7.3.0`
is the `latest` tag and requires vite 8. Use the exact pins in this table.

---

## 10. Naming rules and the one constants file

Every name below lives in **`packages/protocol/src/constants.ts`** and nowhere else, so renaming the
product is a one-file edit.

```ts
// packages/protocol/src/constants.ts — the ONE place names and limits live.

export const WIRE_MAJOR = 1 as const

/** Product identity. */
export const APP_NAME = 'Cairn'
export const BUNDLE_ID = 'app.cairn.desktop'
export const APP_DESKTOP_NAME = 'app.cairn.desktop'     // app.setDesktopName(), Linux/M4
export const MDNS_SERVICE_TYPE = '_cairn._tcp'          // M5–M6 only; no socket in M1
export const SYNC_PORT = 47811                          // M6 only; nothing binds it in M1
export const NPM_SCOPE = '@cairn'
export const DATA_DIR_NAME = 'Cairn'                    // app.setName() -> userData basename
export const STORE_LOG_FILE = 'history.ndjson'
export const STORE_META_FILE = 'meta.json'
export const STORE_KEY_FILE = 'key.bin'
export const STORE_BLOB_DIR = 'blobs'
export const AGENT_BIN_NAME = 'cairn-agent-macos'

/** Crypto domain separation strings. Changing one is a store format break. */
export const STORE_AAD_MAGIC = 'cairn/store/v1'
export const BLOB_HKDF_INFO = 'cairn/blob/v1'

/** Byte transport (§4). */
export const CHUNK_THRESHOLD_BYTES = 65_536
export const CHUNK_PAYLOAD_BYTES = 32_768
export const MAX_REP_BYTES = 20_971_520
export const MAX_LINE_BYTES = 1_048_576
export const REP_STREAM_TIMEOUT_MS = 5_000
export const MAX_CONCURRENT_REP_STREAMS = 8

/** Behaviour (§5.7). */
export const DEFAULT_ACCELERATOR = 'Cmd+Shift+V'
export const WATCH_INTERVAL_MS = 500
export const CAPTURE_DEBOUNCE_MS = 150
export const AGENT_REQUEST_TIMEOUT_MS = 2_000
export const SECRET_TTL_MS = 300_000
export const RETENTION_MAX_ITEMS = 500
export const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
export const RETENTION_MAX_BYTES = 512 * 1024 * 1024
export const SEARCH_INDEX_DEFAULT = 500
export const SEARCH_INDEX_HARD_CAP = 2_000
export const PREVIEW_MAX_CHARS = 512
export const THUMBNAIL_MAX_EDGE_PX = 256
export const THUMBNAIL_JPEG_QUALITY = 70
export const THUMBNAIL_MAX_BYTES = 24 * 1024
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 * 1024 } as const

/** The mime the macOS agent emits for Chrome's `org.chromium.source-url` rider. Frozen here so the
 *  agent and the capture layer cannot disagree; it is NOT `text/uri-list` and must never classify
 *  as a file list. The UTI stays `org.chromium.source-url`; only the mime is ours. */
export const MIME_SOURCE_URL = 'text/x-source-url'

/** The frozen mask format (§5.7, spec §11 control 5). `packages/privacy/src/mask.ts` imports these
 *  two — there is exactly one implementation of the format in the repo. */
export const MASK_BULLET = '•'
/** `AKIA••••A7QD`: first 4 + four bullets + last 4. Under 12 chars, eight bullets and nothing else,
 *  so a short secret leaks not even its length. */
export function maskToken(raw: string): string {
  return raw.length >= 12 ? raw.slice(0, 4) + MASK_BULLET.repeat(4) + raw.slice(-4) : MASK_BULLET.repeat(8)
}

/** User-visible strings held as constants so they cannot silently drift (spec §11 control 11). */
export const TOAST_COPIED_MANUAL = 'Copied — press Cmd+V'
export const TOAST_COPIED_SECURE_INPUT = 'A password field is focused — press Cmd+V yourself'
export const BANNER_KEYRING_WEAK =
  'Your desktop has no secure keyring, so Cairn will not pretend to encrypt. Set a passphrase.'

/** The canary used by the security suite. */
export const TEST_CANARY = 'CAIRN-CANARY-9f3a1c7e'

/** macOS pasteboard hint UTIs, probed BEFORE any byte is read. */
export const UTI_CONCEALED = 'org.nspasteboard.ConcealedType'
export const UTI_TRANSIENT = 'org.nspasteboard.TransientType'
export const UTI_AUTO_GENERATED = 'org.nspasteboard.AutoGeneratedType'
```

That block is the **whole** file: `packages/protocol/src/constants.test.ts` asserts nine of these
values by hand, including `MIME_SOURCE_URL === 'text/x-source-url'` and
`maskToken('AKIA2E0PQIN4XA7QD') === 'AKIA••••A7QD'`. §5.7 restates the mask half in context; the
declaration is here and only here.

`MIME_SOURCE_URL` is `'text/x-source-url'` **everywhere, with no second spelling**: the constant, the
mime the macOS agent emits, the `mime` field in `fixtures/agent-transcripts/chrome-source-url.ndjson`,
and every `normalizeReps` assertion. The **UTI** stays `'org.chromium.source-url'` — that string is
Chrome's, not ours, and it is what the pasteboard actually carries. Two names for the same rider is
how a provenance hint silently becomes a file list.

`SCRYPT_PARAMS.maxmem` is **not optional**. `[verified]` `scryptSync(pw, salt, 32, {N: 2**17, r: 8,
p: 1})` without it throws `RangeError: Invalid scrypt params: … memory limit exceeded` with code
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, because N=2¹⁷ r=8 needs 128 MiB and Node's default cap is 32 MiB.
With `maxmem: 192 MiB` it derives a 32-byte key in **269 ms** — the right order of magnitude for a
once-per-launch prompt.

**The desktop registers NO URI scheme** (spec §11 control 10). `cairn:pair` is a *payload format* a
phone parses out of a QR code the desktop **displays**. Registering `cairn://` would let any web page
you visit invoke this app with attacker-chosen parameters — a remote trigger into the pairing path
for no benefit, since the desktop never receives a QR. Enforced by
`security/no-uri-scheme.security.test.ts`.

`app.setName(DATA_DIR_NAME)` must be called **before** the first `app.getPath('userData')`.
`[verified]` without it, Electron 44 reports
`/Users/<you>/Library/Application Support/Electron` — the store would land in a shared directory.

### One more verified gotcha for whoever writes `@cairn/keyring`

`[verified]` **`safeStorage.getSelectedStorageBackend` does not exist at runtime on macOS** in
Electron 44.1.1 — calling it throws `TypeError: safeStorage.getSelectedStorageBackend is not a
function`, even though `electron.d.ts` declares it unconditionally as
`() => 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown'`. So
`probeBackend()` must be written as:

```ts
const canProbe = typeof safeStorage.getSelectedStorageBackend === 'function'
const backend = canProbe ? safeStorage.getSelectedStorageBackend() : 'unknown'
// Refuse os-keyring ONLY for a real basic_text report. A missing API is not a weak backend.
if (backend === 'basic_text') return { backend, strength: 'none', warning: BANNER_KEYRING_WEAK }
```

`[verified]` on macOS `safeStorage.isEncryptionAvailable()` returns `true` after `app.whenReady()`,
so the M1 happy path is `'os-keyring'`. Spec §4's note that `isEncryptionAvailable()` is only
meaningful after `ready` on Linux still applies — sequence the check after `whenReady()` on every OS.
