# Corrections found by executing the M1 plan

Every item below is a defect in the plan, found by running it rather than reading it, together with
what was done instead. The task files have **not** been rewritten — the code is correct and committed,
and this list is the record of where the plan and reality diverged. Read it before re-running any task.

Grouped by cause, because the same few mistakes recur.

---

## 1. A fence's shape does not match how the step describes it

The single most common failure. A step says "append" but its fence is a whole module tail carrying its
own `import` block; or a step says "implement" but its fence is a patch that assumes earlier content.

| Where | Problem | Done instead |
|---|---|---|
| T3 S17 | "Replace the single active stream with a Map" — five separate patch fences, not a file | Applied all five against S15's file |
| T3 S23, S27, S43, S47 · T6 S36, S46 · T7 S56 · T8 S34 | Fence starts with its own `import` lines; pasting it inside a `describe` is a syntax error | Merged the imports into the target's block, appended only the body. Wrote `append_tail.py` to do this once |
| T3 S16 (windows) · T9 S16 | "Implement the rest of `windows.ts`" is an **append**; treating it as a replacement drops `paletteWebPreferences` | Appended |
| T8 S12 fence 3 | Not just the `rank` helper — replaces the whole `const needle …` block, and `rank` must end up **above** its uses or it is a TDZ `ReferenceError` | Replaced the block, hoisted `rank` |
| T8 S41 · T5 S38 | The fence's first line matches **two** places: the interface declaration and the implementation of the same name. Patching the first breaks the interface | Anchored on the stub body, not the name |
| T5 S26, S42 | An `it` must land inside a named `describe`; the nearest `})` closes an inner `it` | Insert before the describe's own column-0 `})` |
| T10 S16, S18 | Import-block replacement must respect **multi-line** imports; matching only lines starting with `import` leaves a dangling `}` | Ended the import section at the last `} from '…'` |

## 2. Imports the step never adds

Each of these fails at runtime or under `tsc`, and none is mentioned by its step.

- **T3 S25/S29** — `ClipboardChangedPayload`, `PasteboardHint` (the change assembler needs both).
- **T3 S65** — `CHUNK_THRESHOLD_BYTES`, `CHUNK_PAYLOAD_BYTES`.
- **T6 S31/S41** — `writeFileSync`, `existsSync` in `log-store.test.ts`.
- **T6 S38** — `createChainVerifier` is missing from the existing `./chain` import, so a conditional
  "add the import if absent" silently skips it.
- **T7 S51** — `capture.ts` imports `Classification` and `PrivacyRules` from `@cairn/privacy`, but
  S33's barrel deliberately does **not** re-export them (contract §5.7 freezes both in
  `@cairn/protocol`, and the barrel says so in a comment). The barrel is right.
- **T8 S34** — the import fence supplies only `afterEach`; the tests need `describe`, `expect`, `it`,
  plus `SECRET_TTL_MS`, `RETENTION_MAX_AGE_MS` and `type ItemId`.
- **T8 S36** — fence 1 supplies a widened `./retention` import, duplicating the narrow one already
  there → `TS2300: Duplicate identifier`.
- **T9 S35** — `ChangeReason` is exported by `@cairn/history`, not `@cairn/protocol`.

## 3. Strict-mode violations the plan's own tsconfig rejects

- **T6 blobs.test.ts** — `buf[i] ^= 0xff` is `TS2532` under `noUncheckedIndexedAccess`. Used the
  `Buffer.readUInt8`/`writeUInt8` API, which is typed non-optional.
- **T9 ipc-handlers.ts** — `{ method: undefined, … }` is `TS2379` under
  `exactOptionalPropertyTypes`. The intent is "nothing to report", so the key is omitted.
- **T9 wiring.test.ts** — `isHtmlSource: true === false` is `TS2367`, an impossible comparison.

## 4. Ordering and dependency errors

- **T4 S24 cannot link where it sits.** `main.swift` (S23) references `Hotkey`, which S29 introduces.
  S29's `Hotkey` enum was pulled forward.
- **T4 S37** asserts `Tests 9 passed (9)` for the transcript scanner's security suite, but that suite
  cannot even load until T7 ships `@cairn/privacy` — vite resolves the package statically at
  import-analysis time. The step's own CLI paragraph already documents the analogous `exit=2`; the test
  expectation should too.
- **T7 S35** generates the six byte fixtures and is easy to skip; `thumbnail.test.ts` fails with
  `ENOENT … screenshot.png` without it. Its script must also run somewhere `sharp` resolves — the
  plan writes it to `/tmp`, where `node` cannot find the dependency.
- **T4 S36** — `scripts/scan-transcripts.mjs` dynamically imports `@cairn/privacy` from **plain Node**,
  whose ESM resolver has no extension search, so every extensionless relative import inside the
  package barrel fails. It needs the same `registerHooks` resolver `tools/gen-agent-types.ts` installs.

## 5. Tests that contradict the implementation shipped beside them

These are the ones worth reading closely: in each case the **implementation was right**.

- **T9 S31, the preload channel ban.** It demanded a `'cairn:…'` literal at every `ipcRenderer.on`
  call site and counted ≥12. The preload deliberately routes the four event methods through a local,
  **unexposed** `subscribe(channel, cb)` helper — ten call sites, two variable by design, and its own
  comment explains why. Rewritten to assert the property that matters (no channel reachable *from the
  page* is variable), then re-verified that it still fails for a generic `invoke()`, for exposing
  `subscribe`, and for a template-literal channel.
- **T9 S48, renderer hardening.** Three assertions checked call **order** against raw source. But
  `index.ts` documents why it never calls `Menu.setApplicationMenu(null)` and why `app.setName` must
  precede `app.requestSingleInstanceLock()` — so `indexOf` found those identifiers inside the
  explanations first and every ordering assertion inverted. `ENTRY` is now comment-stripped, matching
  the repo-wide rule that a ban matches non-comment lines only.
- **T9 S46, the crash-SDK ban.** Bare case-insensitive substrings: `sentry` matches **`Corpu·sEntry`**
  and **`i·sEntry·Point`**. A control that cries wolf on ordinary identifiers is one somebody deletes.
  Word-bounded, then re-verified it still catches `@sentry/electron`, `Sentry.init`, `bugsnag`,
  `crashpad` and `uploadToServer`.
- **T9 S39**, "surfaces a missing item": four dead lines spying on
  `Object.getPrototypeOf(app)` for a method that lives on a plain object literal, then immediately
  `mockRestore()`d. Their only effect was to throw before the real assertion below them.
- **T8 S39** destructures `index` from `harness()`, which S34 never exposes.

## 6. Timing and flakiness

- **T7 S56** — the transcript-driven tests advance the injected clock by 150 ms, but every transcript
  emits its `clipboard.changed` at `delayMs: 500` (**relative**, so `self-write-suppression`'s second
  event lands at 1000 ms). Nothing ever fired and every assertion saw an empty list.
- **T7 capture.security.test.ts** — diffed the **shared** temp dir before/after, which other vitest
  workers churn via `tempStoreDir()`. It passed alone and failed in the full run. Given a private
  `TMPDIR` sandbox instead, so the assertion is strict rather than relaxed; re-verified that planting
  the spool write still fails it.

## 7. Predicted output that does not match reality

- **T1 S19** — restoring the pin with `npm pkg set` does not round-trip: npm reformats the whole
  document, so `git diff --stat` is not empty. Use `git checkout -- package.json`.
- **T1 S23** — main is **4 modules / 1.52 kB**, not 3 / 1.36 kB.
- **T2 S5** — predicts `Failed Suites 2`; `types.test.ts` uses only `import type`, which is erased at
  runtime, so it passes vacuously. `tsc` is the real runner for that half.
- **T1 S8/S11/S17, T3 passim** — vitest's missing-module wording is project-specific: the `unit`
  project resolves through Node and says `Cannot find module`, the `security` project goes through
  vite and says `Failed to resolve import`. Both appear; each step should predict its own.

## 8. Two things only the real binary revealed

No unit test could have caught either, because every test injects its paths. This is what the manual
demo is for.

- **`apps/desktop/main/src/index.ts` resolved all three of the agent, preload and renderer paths as if
  `app.getAppPath()` were the repo root.** It is `<repo>/apps/desktop` — the only `package.json` with a
  `main`, so that is the app root Electron is handed. The agent was looked for under
  `apps/desktop/agents/…` (`ENOENT`, so the app ran with **no clipboard capture at all**) and the
  renderer path was doubled into `apps/desktop/apps/desktop/out/…` (`ERR_FILE_NOT_FOUND`).
- **The first-run hotkey dialog blocks composition.** Wiping the data directory before each run makes
  every run a first run, so `chooseHotkey`'s native message box stalls startup before
  `hotkey.bound`/`app.ready`. Correct behaviour, but it makes the demo un-scriptable without
  pre-seeding `config.json` with `firstRunHotkeyDone: true`.

## 9. Also worth knowing

- **T1 S23** — the barrel re-exports `./testing`, so a test-only fixture-path helper is bundled into
  the production main process. Dead code, leaks nothing, ~160 bytes. Do **not** "fix" it by editing the
  barrel: that breaks T7's imports and the eleven-line barrel the contract freezes. The clean fix is a
  `"./testing"` subpath export, which is a contract change.
- **T10 S38's `index.html`** names the two banned CSP keywords in a comment. T1's version deliberately
  did not, because `.html` is matched **raw** by the source scanner. Reworded to preserve T1's
  invariant.
- `git checkout --` only restores **tracked** files. Several mutate-run-restore proofs silently reverted
  a file to an earlier task's version because the current step's content was not yet committed. Commit
  before proving a control fails.
