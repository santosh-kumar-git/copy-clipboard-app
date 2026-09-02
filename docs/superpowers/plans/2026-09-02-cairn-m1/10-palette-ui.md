### Task 10: apps/desktop/renderer — the Svelte palette, end to end

This task closes the M1 loop. Everything below the renderer already exists after Tasks 1–9: the Swift
agent captures, `@cairn/privacy` masks at ingest, `@cairn/store` encrypts, `@cairn/history` +
`@cairn/search` rank, and `apps/desktop/main` exposes exactly twelve IPC methods through a
`contextBridge` preload. What is missing is the thing the user actually touches: a Spotlight-style
palette that opens on the hotkey, fuzzy-finds, and puts the chosen item back on the real clipboard.

Three things about this task are unusual and worth reading before you start.

1. **The renderer is the hostile-content boundary.** Every string it displays was authored by whatever
   the user copied — a web page, a `.env` file, a password manager. Spec §11 control 3 is therefore
   the single most important requirement here: **copied HTML is never rendered as HTML.** The preview
   pane prints `text/plain`, or the HTML *source* escaped as text. Rendering copied markup would hand
   any page the user copies from script execution inside our privileged renderer, with the whole
   decrypted history one IPC call away. Concretely: **Svelte's raw-HTML directive never appears under
   `apps/desktop/renderer/`, ever.** Two tests enforce it — a DOM test that pastes
   `<img src=x onerror="window.cairn.list(…)">` through the real pipeline and asserts the DOM contains
   the literal text and no `img` element, and a source scan that fails if the directive's token ever
   appears under `apps/desktop/renderer/`, because that is the regression that would silently
   reintroduce it. **The ban covers comments too**, and that is deliberate: `security/source-scan.ts`
   matches `.svelte` files RAW rather than stripping comments, because a comment-stripping exemption
   is exactly the hole a reintroduced sink would hide behind. So no renderer file — not even a header
   comment documenting the rule — spells the directive out. Say "Svelte's raw-HTML directive" in prose
   instead; the only place the literal token is written in this whole repo is the one string literal in
   `security/no-html-sink.security.test.ts` that the scanner searches for.
2. **There is no auto-paste in M1.** `Enter` calls `cairn:recall.copy`, which puts the item on the real
   clipboard, then the palette toasts `Copied — press Cmd+V` for two seconds and closes. That is not a
   placeholder: it is exactly the M2 "Accessibility denied" degraded mode from spec §6, which is the
   *default assumption* on macOS. The code path ships now and stays.
3. **Secrets arrive pre-masked.** `ItemSummary` (contract §5.9) has no `repRefs`, no bytes and no raw
   body — only `preview`, which `@cairn/privacy` already masked at ingest (`AKIA••••A7QD`). The
   renderer cannot ask for a raw secret because no channel returns one, and it holds at most 32 rows at
   a time, not the history. Both facts are asserted, not assumed.

---

**Files:**

*Create:*

```
apps/desktop/renderer/src/api.ts                     the typed wrapper over window.cairn + payload guards
apps/desktop/renderer/src/palette-state.svelte.ts    $state store: query, results, selection, geometry
apps/desktop/renderer/src/testing.ts                 the fake window.cairn every renderer test uses
apps/desktop/renderer/src/Palette.svelte             search field + virtualised list + toast host
apps/desktop/renderer/src/ItemRow.svelte             one row: kind chip, masked preview, thumbnail, highlights
apps/desktop/renderer/src/Preview.svelte             text/plain or ESCAPED HTML source; no raw-HTML directive
apps/desktop/renderer/src/Toast.svelte               the "Copied — press Cmd+V" toast
apps/desktop/renderer/src/app.css                    palette styling; no remote fonts, no stylesheet imports
apps/desktop/renderer/src/main.ts                    mount(Palette, {target})
```

*Modify:*

```
(no CI change — `npm test` already runs every vitest project; see Step 4)
apps/desktop/renderer/index.html       empty the placeholder <main>, add the module script tag
```

*Verify only — never rewritten here:*

```
vitest.config.ts                       already has THREE projects: unit, security, renderer
apps/desktop/renderer/tsconfig.json    already typechecks clean; git diff must stay empty
```

`vitest.config.ts` is **not** rewritten by this task. It is written once, by Task 1's step that writes
`tsconfig.base.json`, the two `tsconfig.json` files and `vitest.config.ts`, and it already carries all
three projects — `unit`, `security` and `renderer` — precisely so that no later task has to touch it.
Rewriting it here from the contract §2 snippet would silently delete the `unit` project's fifth
include entry, `'security/**/*.test.ts'`, and that entry is the only thing that runs
`security/source-scan.test.ts` — the 13 unit tests of the quote-aware comment stripper that the
`crashReporter`, socket, shell-execution, URI-scheme and raw-HTML-directive bans *all* run through —
under `npm run test:unit`, and therefore in CI. Step 2 verifies the three projects instead, and only
falls back to writing the file if a project is genuinely missing.

`apps/desktop/renderer/tsconfig.json` is **not** modified here either. Task 1's step that writes the
tsconfigs ships it already working, in two respects that matter and were both measured with `tsc`
5.9.3 under the contract's `tsconfig.base.json`:

- `"types": ["vite/client", "node"]`. Without `"node"`, the moment `packages/protocol/src/hash.ts`
  exists `svelte-check` fails with
  `error TS2307: Cannot find module 'node:crypto' or its corresponding type declarations` and two
  `error TS2591: Cannot find name 'Buffer'` — which would break `npm run typecheck` in Tasks 2, 4, 5,
  6 and 7, long before this task.
- `"include": ["src/**/*.ts", "src/**/*.svelte"]` — the renderer project does **not** glob
  `../../../packages/*/src/**/*.ts`, so it does not *compile* node-targeting package sources as roots.
  Note this narrowing alone is not sufficient: TypeScript still pulls `hash.ts` into the program as a
  transitive dependency of `import type { ItemSummary } from '@cairn/protocol'`, and dropping the glob
  while leaving `types: ["vite/client"]` reproduces the same three errors verbatim. Both halves are
  required; `"node"` is the half that makes it pass.

The *bundle* stays browser-safe through a real test (Step 39) and the real build (Step 42), not through
the absence of a type — which is why having `node` types in the renderer program costs nothing.

*Test:*

```
apps/desktop/renderer/src/palette-state.test.ts      (renderer project, 19 tests)
apps/desktop/renderer/src/api.test.ts                (renderer project, 6 tests)
apps/desktop/renderer/src/Palette.test.ts            (renderer project, 13 tests)
apps/desktop/renderer/src/Preview.security.test.ts   (security project, 3 tests)
apps/desktop/renderer/src/Palette.security.test.ts   (security project, 1 test)
security/no-html-sink.security.test.ts               (security project, 6 tests)
```

Four of those paths are not in the contract's §1 file tree: `src/testing.ts`, `src/api.test.ts`,
`src/Palette.test.ts` and `src/Palette.security.test.ts`. They are test-only additions in the same
spirit as `packages/store/src/testing.ts`, which the contract does list. The contract's tree names
exactly two renderer test files, which cannot cover "component tests with a fake `window.cairn`" for
nine distinct behaviours.

---

**Interfaces:**

`Consumes:` — exact signatures this task relies on. Import them; do not redeclare them.

From the **preload** (Task 9, contract §5.9). Twelve methods, hard-coded channel strings, no
`invoke`, no `send`, no `channel` parameter, each `onX` returning an unsubscribe function:

```ts
contextBridge.exposeInMainWorld('cairn', {
  list, search, preview, pin, remove, copy, close, securityStatus,
  onHistoryChanged, onHotkeyStatus, onToast, onPaletteShown,
})
```

From `@cairn/protocol` (Task 2) — **as types only** in product code (see Step 12 for why):

```ts
export type ItemKind = 'text' | 'richtext' | 'image' | 'files'
export type Unsub = () => void
export type Cancel = () => void
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Cancel }
export interface TestClock extends Clock { advance(ms: number): void; readonly pending: number }

export type ItemSummary = {
  id: string; kind: ItemKind; preview: string; previewTruncated: boolean
  flags: ('secret'|'concealed'|'transient'|'auto-generated'|'excluded'|'no-sync'|'cut')[]
  maskedSpanCount: number; sourceAppName: string | null; byteLength: number
  createdAt: number; pinned: boolean; expiresAt: number | null
  thumbnailDataUrl: string | null
}
export type IpcRequest = { channel: C; params: …; result: … }   // discriminated over the 8 channels
export type IpcEvent   = { channel: C; payload: … }             // discriminated over the 4 channels
export type IpcRequestChannel =
  | 'cairn:history.list' | 'cairn:history.search' | 'cairn:history.preview' | 'cairn:history.pin'
  | 'cairn:history.remove' | 'cairn:recall.copy' | 'cairn:palette.close' | 'cairn:security.status'
export type IpcEventChannel =
  | 'cairn:history.changed' | 'cairn:hotkey.status' | 'cairn:toast' | 'cairn:palette.shown'
```

From `@cairn/protocol` at **runtime, in test files only** (a test runs in Node, where `node:crypto`
resolves):

```ts
export const TOAST_COPIED_MANUAL: 'Copied — press Cmd+V'
export const TOAST_COPIED_SECURE_INPUT: 'A password field is focused — press Cmd+V yourself'
export function createTestClock(startMs?: number): TestClock      // default 1_767_225_600_000
```

From `security/source-scan.ts` (Task 1):

```ts
export const REPO_ROOT: string
export function sourceFiles(roots: readonly string[]): string[]   // includes .svelte and .html
export interface SourceHit { readonly file: string; readonly line: number; readonly text: string }
export function findInSources(needle: string, roots: readonly string[]): SourceHit[]
export function formatHits(hits: readonly SourceHit[]): string
```

`Produces:` — exported names later tasks (M2's auto-paste, M3's Settings pane) rely on.

```ts
// apps/desktop/renderer/src/api.ts
export type ListParams, ListResult, SearchParams, SearchResult, PreviewResult, CopyResult,
            CopyReason, SecurityStatus, HistoryChangedPayload, HotkeyStatusPayload, ToastPayload,
            PaletteShownPayload, HotkeyStatus
export interface CairnBridge {
  list(params: ListParams): Promise<ListResult>
  search(params: SearchParams): Promise<SearchResult>
  preview(params: { id: string }): Promise<PreviewResult>
  pin(params: { id: string; pinned: boolean }): Promise<{ pinned: boolean }>
  remove(params: { id: string }): Promise<{ removed: boolean }>
  copy(params: { id: string }): Promise<CopyResult>
  close(): Promise<{ closed: true }>
  securityStatus(): Promise<SecurityStatus>
  onHistoryChanged(cb: (p: HistoryChangedPayload) => void): Unsub
  onHotkeyStatus(cb: (p: HotkeyStatusPayload) => void): Unsub
  onToast(cb: (p: ToastPayload) => void): Unsub
  onPaletteShown(cb: (p: PaletteShownPayload) => void): Unsub
}
declare global { interface Window { readonly cairn: CairnBridge } }
export function parseHistoryChanged(u: unknown): HistoryChangedPayload | null
export function parseHotkeyStatus(u: unknown): HotkeyStatusPayload | null
export function parseToast(u: unknown): ToastPayload | null
export function parsePaletteShown(u: unknown): PaletteShownPayload | null
export const THUMBNAIL_DATA_URL_PREFIX = 'data:image/jpeg;base64,'
export function safeThumbnailSrc(value: string | null): string | null

// apps/desktop/renderer/src/palette-state.svelte.ts
export const ROW_HEIGHT_PX = 44, VISIBLE_ROWS = 8, OVERSCAN_ROWS = 2
export const FETCH_SPAN = 32, SEARCH_LIMIT = 50, TOAST_MS = 2_000
export const EMPTY_TEXT, NO_RESULTS_TEXT, SECRET_PIN_REFUSED_TEXT, RECALL_FAILED_TEXT, LOAD_FAILED_TEXT: string
export const RECALL_TOAST_TEXT: Readonly<Record<CopyReason, string>>
export function hotkeyFailedText(accelerator: string): string
export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
export function nextIndex(current: number, key: NavKey, total: number): number
export function windowStartFor(selected: number, windowStart: number, total: number): number
export function visibleRange(windowStart: number, total: number): { start: number; end: number }
export interface Segment { readonly text: string; readonly hit: boolean }
export function highlightSegments(preview: string, ranges: readonly number[]): Segment[]
export function filePathsFromPreview(preview: string): string[]
export function kindChipLabel(kind: ItemKind): string
export function secretExpiryLabel(expiresAt: number | null, nowMs: number): string | null
export interface VisibleRow { readonly index: number; readonly top: number; readonly item: ItemSummary | null; readonly ranges: readonly number[] }
export interface PaletteDeps { readonly api: CairnBridge; readonly clock: Clock }
export class PaletteState {
  constructor(deps: PaletteDeps)
  query: string; selectedIndex: number; windowStart: number; total: number
  mode: 'recent' | 'search'; hotkeyStatus: HotkeyStatus; hotkeyAccelerator: string
  toast: ToastPayload | null; statusText: string | null
  previewText: string; previewMime: 'text/plain' | 'text/html'
  shownAt: number; nowMs: number
  rows: (ItemSummary | null)[]; rowsOffset: number; rangesByIndex: number[][]
  pending: Promise<unknown>
  readonly visibleRows: VisibleRow[]
  get selectedItem(): ItemSummary | null
  get loadedRowCount(): number
  rowAt(index: number): ItemSummary | null
  start(): Promise<void>; dispose(): void; reload(): Promise<void>
  setQuery(q: string): Promise<void>; moveSelection(key: NavKey): void; setScrollTop(px: number): void
  ensureLoaded(): Promise<void>; loadPreview(): Promise<void>
  recall(): Promise<void>; togglePin(): Promise<void>; removeSelected(): Promise<void>
  close(): Promise<void>
}

// apps/desktop/renderer/src/testing.ts  (test-only)
export function testItemId(n: number): string                       // 26-char Crockford base32
export function makeItem(n: number, over?: Partial<ItemSummary>): ItemSummary
export interface SearchHit { item: ItemSummary; score: number; ranges: number[] }
export interface FakeApi { … }                                      // full shape in Step 15
export function createFakeApi(init?: Partial<Pick<FakeApi, 'items'|'searchHitsFor'|'previews'|'copyResult'>>): FakeApi

// Component props, exactly — nothing here can hold a raw body:
//   Palette   { palette: PaletteState }
//   ItemRow   { item: ItemSummary; selected: boolean; ranges: readonly number[]; top: number; nowMs: number; onpick: () => void }
//   Preview   { text: string; mime: 'text/plain' | 'text/html'; filePaths?: readonly string[] }
//   Toast     { text: string; tone: 'info' | 'warn' }
```

**Branch:** `m1/10-palette-ui`

---

- [ ] **Step 1: Create the branch.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git fetch origin && git checkout -b m1/10-palette-ui origin/main
```

Expected: `Switched to a new branch 'm1/10-palette-ui'`.

- [ ] **Step 2: Verify the three vitest projects and the renderer tsconfig. Change neither.**

Zero edits in this step. Both files this task depends on were written by Task 1's step that writes
`tsconfig.base.json`, the two `tsconfig.json` files and `vitest.config.ts`. Confirm that, then move on.

*Why three projects exist:* `unit` is `environment: 'node'` with no Svelte plugin and its `include`
list does not mention `apps/desktop/renderer`; `security` only matches `*.security.test.ts`. Neither
would run `apps/desktop/renderer/src/palette-state.test.ts`, which contract §1 lists. A `.svelte.ts`
module using `$state` also cannot run without the Svelte plugin, and Svelte 5 resolves its *server*
build unless `resolve.conditions` includes `browser` (deleting that line makes `mount()` throw
``Svelte error: `mount(...)` is not available on the server``). Hence the third project, `renderer`.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
grep -n "name: '" vitest.config.ts
grep -n "'security/\*\*/\*.test.ts'" vitest.config.ts
grep -c "conditions: \['browser'\]" vitest.config.ts
grep -n '"types"' apps/desktop/renderer/tsconfig.json
grep -n 'packages/\*/src' apps/desktop/renderer/tsconfig.json
```

Expected, in order:

- three `name:` lines — `name: 'unit'`, `name: 'renderer'`, `name: 'security'`.
- exactly one hit for `'security/**/*.test.ts'`, inside the **`unit`** project's `include` array. That
  entry is the only thing that runs `security/source-scan.test.ts` under `npm run test:unit`. Do not
  remove it and do not "tidy" it into the `security` project: `source-scan.test.ts` is not a
  `*.security.test.ts` file, it is the 13 plain unit tests of the quote-aware comment stripper that
  the `crashReporter`, socket, shell-execution, URI-scheme and raw-HTML-directive bans all run
  through.
- `grep -c` prints `2` — the `renderer` and `security` projects each carry
  `resolve: { conditions: ['browser'] }`, because both mount real Svelte components.
- `"types": ["vite/client", "node"]` on the `compilerOptions` line.
- **no output** (exit 1) from the last grep: the renderer tsconfig must not glob
  `../../../packages/*/src/**/*.ts` as compilation roots.

`git diff vitest.config.ts apps/desktop/renderer/tsconfig.json` must stay empty for the whole of
Task 10.

*Fallback, only if a grep above disagrees.* Then Task 1's step shipped an older shape and every
`npm run typecheck` since has been failing; repair the file(s) to exactly the text below, `git add`
them in Step 4's commit, and continue. Reproduce `vitest.config.ts` in full — do not hand-patch it,
and above all do not drop the `unit` project's fifth include entry:

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

`apps/desktop/renderer/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "types": ["vite/client", "node"] },
  "include": ["src/**/*.ts", "src/**/*.svelte"],
  "exclude": ["**/node_modules/**"]
}
```

Both halves of that tsconfig are load-bearing and were measured with `tsc` 5.9.3 on a throwaway tree
holding the contract's `tsconfig.base.json`, a `packages/protocol/src/hash.ts` that imports
`node:crypto` and returns a `Buffer`, and a renderer file doing
`import type { ItemKind } from '@cairn/protocol'`:

- `types: ["vite/client"]` **with** the `packages/*` glob → 3 errors: one
  `error TS2307: Cannot find module 'node:crypto' or its corresponding type declarations` and two
  `error TS2591: Cannot find name 'Buffer'`.
- `types: ["vite/client"]` **without** the glob → the *same* 3 errors. Narrowing `include` alone does
  not help, because TypeScript pulls `hash.ts` into the program as a transitive dependency of the
  `import type`.
- `types: ["vite/client", "node"]` → exit 0, no output, with or without the glob.

So `"node"` is what makes `npm run typecheck` pass, and dropping the glob is what stops the renderer
project from compiling node-targeting package sources as roots of its own program. Keep both.

- [ ] **Step 3: Confirm the renderer project resolves and is empty.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project renderer
```

Expected: `No test files found, exiting with code 1`, and the report prints
`include: apps/desktop/renderer/src/**/*.test.ts`. That exit code is correct — there is nothing to run
yet.

- [ ] **Step 4: Confirm CI already runs the `renderer` project — change nothing.**

You do **not** need to touch `.github/workflows/ci.yml`, and you must not add a `Renderer tests` step
to it. Verify that, rather than taking it on trust:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
grep -n 'run: npm' .github/workflows/ci.yml
grep -n '"test' package.json
```

Expected: the workflow runs a bare **`npm test`** (plus `guard:no-rebuild`, `bootstrap` and
`typecheck`), and `package.json` already has all three of `test:unit`, `test:renderer` and
`test:security` — the scaffold task created them. `npm test` is `vitest run` with no `--project`, which
executes **every** project in `vitest.config.ts`, so the `renderer` project has been in CI since the
moment the scaffold task defined it.

Why this is the correct design and not an oversight, measured on this machine with vitest 4.1.11 and a
three-project config whose `renderer` project matched no files:

| command | renderer project | exit code |
|---|---|---|
| `vitest run` | empty | **0** — `Test Files 2 passed (2)` |
| `vitest run --project renderer` | empty | **1** — `No test files found` |

Both halves matter. The bare form means CI cannot silently skip a project someone adds later — the
failure mode a hand-maintained per-project step list has. And it means CI stayed green for Tasks 1
through 9 while this project legitimately had no files, which a named `Renderer tests` step would
**not** have: it would have exited 1 and red-failed every branch for nine tasks.

The three `test:*` scripts exist for local convenience — `npm run test:renderer` is how you run just
this task's suite while working. Note it exits 1 right now, before Step 5 writes the first test file,
and that is correct.

There is nothing to commit in this step. If the fallback in Step 2 had to repair `vitest.config.ts` or
`apps/desktop/renderer/tsconfig.json`, commit only those:

```sh
git add vitest.config.ts apps/desktop/renderer/tsconfig.json
git commit -m "fix(test): repair the renderer vitest project and tsconfig"
```

Otherwise `git status --short` is empty and you move straight to Step 5.

---

- [ ] **Step 5: Write the first failing test — palette geometry, wrap-around, highlighting and labels.**

These are pure functions with no DOM and no IPC, and they are where the palette's real decisions live:
how far a keypress moves, how many rows exist at once, and where a match is highlighted. The
wrap-around behaviour is **decided here and stated**: `ArrowDown` past the last row goes to the first,
`ArrowUp` past the first goes to the last, so holding a key never dead-ends.

Create `apps/desktop/renderer/src/palette-state.test.ts`:

```ts
import { TOAST_COPIED_MANUAL, TOAST_COPIED_SECURE_INPUT } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  RECALL_TOAST_TEXT,
  VISIBLE_ROWS,
  filePathsFromPreview,
  highlightSegments,
  kindChipLabel,
  nextIndex,
  secretExpiryLabel,
  visibleRange,
  windowStartFor,
} from './palette-state.svelte'

describe('keyboard navigation arithmetic', () => {
  it('wraps Down past the last row to the first, and Up past the first to the last', () => {
    expect(nextIndex(0, 'ArrowDown', 3)).toBe(1)
    expect(nextIndex(2, 'ArrowDown', 3)).toBe(0)
    expect(nextIndex(0, 'ArrowUp', 3)).toBe(2)
    expect(nextIndex(1, 'ArrowUp', 3)).toBe(0)
    expect(nextIndex(1, 'Home', 3)).toBe(0)
    expect(nextIndex(1, 'End', 3)).toBe(2)
  })

  it('stays at 0 when there is nothing to select', () => {
    expect(nextIndex(0, 'ArrowDown', 0)).toBe(0)
    expect(nextIndex(0, 'End', 0)).toBe(0)
  })
})

describe('virtualisation arithmetic', () => {
  it('renders a bounded window over 500 items', () => {
    expect(visibleRange(0, 500)).toEqual({ start: 0, end: 10 })
    expect(visibleRange(100, 500)).toEqual({ start: 98, end: 110 })
    expect(visibleRange(492, 500)).toEqual({ start: 490, end: 500 })
    expect(visibleRange(0, 3)).toEqual({ start: 0, end: 3 })
  })

  it('scrolls by the minimum needed to keep the selection visible', () => {
    expect(windowStartFor(0, 0, 500)).toBe(0)
    expect(windowStartFor(VISIBLE_ROWS - 1, 0, 500)).toBe(0)
    expect(windowStartFor(VISIBLE_ROWS, 0, 500)).toBe(1)
    expect(windowStartFor(499, 0, 500)).toBe(492)
    expect(windowStartFor(0, 492, 500)).toBe(0)
    expect(windowStartFor(3, 0, 5)).toBe(0)
  })
})

describe('highlightSegments', () => {
  it('splits a preview into hit and miss segments from ufuzzy flat ranges', () => {
    expect(highlightSegments('hello world', [0, 1, 2, 3])).toEqual([
      { text: 'h', hit: true },
      { text: 'e', hit: false },
      { text: 'l', hit: true },
      { text: 'lo world', hit: false },
    ])
  })

  it('returns one miss segment when there are no ranges', () => {
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', hit: false }])
  })

  it('ignores malformed ranges rather than throwing, because they crossed a process boundary', () => {
    expect(highlightSegments('abc', [2, 1])).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('abc', [0, 99])).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('abc', [0, 1, 5])).toEqual([
      { text: 'a', hit: true },
      { text: 'bc', hit: false },
    ])
  })
})

describe('file paths', () => {
  it('decodes a file:// uri-list into displayable paths', () => {
    expect(filePathsFromPreview('file:///Users/me/a%20b.txt\nfile:///Users/me/c.png\n')).toEqual([
      '/Users/me/a b.txt',
      '/Users/me/c.png',
    ])
  })

  it('leaves a malformed percent escape alone instead of throwing', () => {
    expect(filePathsFromPreview('file:///tmp/100%')).toEqual(['/tmp/100%'])
  })
})

describe('labels', () => {
  it('names every kind in the union', () => {
    expect(kindChipLabel('text')).toBe('Text')
    expect(kindChipLabel('richtext')).toBe('Rich text')
    expect(kindChipLabel('image')).toBe('Image')
    expect(kindChipLabel('files')).toBe('Files')
  })

  it('counts a secret down from five minutes', () => {
    expect(secretExpiryLabel(null, 1_000)).toBe(null)
    expect(secretExpiryLabel(301_000, 1_000)).toBe('expires in 5m')
    expect(secretExpiryLabel(43_000, 1_000)).toBe('expires in 42s')
    expect(secretExpiryLabel(1_000, 1_000)).toBe('expired')
  })

  it('uses the same toast strings the main process holds as constants', () => {
    expect(RECALL_TOAST_TEXT['user-preference']).toBe(TOAST_COPIED_MANUAL)
    expect(RECALL_TOAST_TEXT['no-permission']).toBe(TOAST_COPIED_MANUAL)
    expect(RECALL_TOAST_TEXT['elevated-target']).toBe(TOAST_COPIED_MANUAL)
    expect(RECALL_TOAST_TEXT['secure-input']).toBe(TOAST_COPIED_SECURE_INPUT)
  })
})
```

That last test is load-bearing: the renderer cannot import `@cairn/protocol` at runtime (Step 12), so
it holds its own copy of two user-visible strings. This test is what stops the copy drifting from
spec §11 control 11's constants.

- [ ] **Step 6: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project renderer palette-state
```

Expected: FAIL with
`Error: Failed to resolve import "./palette-state.svelte" from "apps/desktop/renderer/src/palette-state.test.ts". Does the file exist?`
and `Tests no tests`.

- [ ] **Step 7: Write the pure half of the state module.**

`.svelte.ts` is the Svelte 5 extension for a module that may use runes; the Svelte plugin compiles it.
The class comes in Steps 16–18 — this step is constants and pure functions only.

Create `apps/desktop/renderer/src/palette-state.svelte.ts`:

```ts
import type { ItemKind } from '@cairn/protocol'

/** Fixed row geometry. jsdom has no layout — `clientHeight` is always 0 and `scrollIntoView` does
 *  not exist — so nothing in the palette may be measured from the DOM. */
export const ROW_HEIGHT_PX = 44
export const VISIBLE_ROWS = 8
export const OVERSCAN_ROWS = 2
/** Rows fetched per `list` call. The renderer never holds more than this many previews. */
export const FETCH_SPAN = 32
export const SEARCH_LIMIT = 50
export const TOAST_MS = 2_000

export const EMPTY_TEXT = 'Nothing copied yet'
export const NO_RESULTS_TEXT = 'No matches'
export const SECRET_PIN_REFUSED_TEXT = 'Secrets cannot be pinned — this one expires in 5 minutes'
export const RECALL_FAILED_TEXT = 'Cairn could not put that on the clipboard'
export const LOAD_FAILED_TEXT = 'Cairn could not read its history'

/** Mirrors `TOAST_COPIED_MANUAL` / `TOAST_COPIED_SECURE_INPUT` in `@cairn/protocol`; asserted equal
 *  by palette-state.test.ts, because the renderer cannot import that barrel at runtime. */
export const RECALL_TOAST_TEXT: Readonly<Record<
  'user-preference' | 'no-permission' | 'elevated-target' | 'secure-input',
  string
>> = {
  'user-preference': 'Copied — press Cmd+V',
  'no-permission': 'Copied — press Cmd+V',
  'elevated-target': 'Copied — press Cmd+V',
  'secure-input': 'A password field is focused — press Cmd+V yourself',
}

/** Spec §6: a dead hotkey is a first-class state, so the row is persistent and names the fix. */
export function hotkeyFailedText(accelerator: string): string {
  return `${accelerator} is not registered — another app already owns it. Try Cmd+Shift+C instead; rebinding lives in Settings, which this build does not have yet.`
}

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/** Wrap-around: Down past the end goes to the first row, Up past the start to the last. */
export function nextIndex(current: number, key: NavKey, total: number): number {
  if (total <= 0) return 0
  switch (key) {
    case 'ArrowDown':
      return current + 1 >= total ? 0 : current + 1
    case 'ArrowUp':
      return current - 1 < 0 ? total - 1 : current - 1
    case 'Home':
      return 0
    case 'End':
      return total - 1
  }
}

export function windowStartFor(selected: number, windowStart: number, total: number): number {
  const maxStart = Math.max(0, total - VISIBLE_ROWS)
  let start = Math.min(Math.max(0, windowStart), maxStart)
  if (selected < start) start = selected
  else if (selected >= start + VISIBLE_ROWS) start = selected - VISIBLE_ROWS + 1
  return Math.max(0, Math.min(start, maxStart))
}

export function visibleRange(windowStart: number, total: number): { start: number; end: number } {
  const start = Math.max(0, windowStart - OVERSCAN_ROWS)
  const end = Math.max(start, Math.min(total, windowStart + VISIBLE_ROWS + OVERSCAN_ROWS))
  return { start, end }
}

export interface Segment {
  readonly text: string
  readonly hit: boolean
}

/** ufuzzy ranges are a FLAT array of alternating [start, end) offsets (contract §5.6). Malformed
 *  input is ignored rather than thrown, because these offsets crossed a process boundary. */
export function highlightSegments(preview: string, ranges: readonly number[]): Segment[] {
  const out: Segment[] = []
  let cursor = 0
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i]
    const end = ranges[i + 1]
    if (start === undefined || end === undefined) break
    if (start < cursor || end <= start || end > preview.length) break
    if (start > cursor) out.push({ text: preview.slice(cursor, start), hit: false })
    out.push({ text: preview.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < preview.length) out.push({ text: preview.slice(cursor), hit: false })
  return out
}

/** `file:///Users/me/a%20b.txt` -> `/Users/me/a b.txt`. Displayed and copied only. Spec §11 control 3
 *  promises no shell in the capture or recall path at all on macOS: a copied path is attacker-chosen
 *  text, so it is never interpolated into a command line. The renderer spawns nothing, and the
 *  shell-execution ban in the wiring task's security suite — no child-process spawn helper and no
 *  `shell: true` anywhere under `packages/**` or `apps/desktop/**` — is what keeps that true. */
export function filePathsFromPreview(preview: string): string[] {
  return preview
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (!line.startsWith('file://')) return line
      const withoutScheme = line.slice('file://'.length)
      try {
        return decodeURIComponent(withoutScheme)
      } catch {
        return withoutScheme
      }
    })
}

export function kindChipLabel(kind: ItemKind): string {
  switch (kind) {
    case 'text':
      return 'Text'
    case 'richtext':
      return 'Rich text'
    case 'image':
      return 'Image'
    case 'files':
      return 'Files'
  }
}

export function secretExpiryLabel(expiresAt: number | null, nowMs: number): string | null {
  if (expiresAt === null) return null
  const leftMs = expiresAt - nowMs
  if (leftMs <= 0) return 'expired'
  const seconds = Math.ceil(leftMs / 1_000)
  return seconds >= 60 ? `expires in ${Math.ceil(seconds / 60)}m` : `expires in ${seconds}s`
}
```

- [ ] **Step 8: Run it and watch it pass.**

```sh
npx vitest run --project renderer palette-state
```

Expected: `Tests 12 passed (12)`.

- [ ] **Step 9: Commit.**

```sh
git add apps/desktop/renderer/src/palette-state.svelte.ts apps/desktop/renderer/src/palette-state.test.ts
git commit -m "feat(renderer): palette geometry, wrap-around navigation and label helpers"
```

---

- [ ] **Step 10: Write the failing test for the typed bridge and its payload guards.**

Spec §11 control 8 says IPC is validated **in both directions**. Main validates what the renderer
sends; this file is the renderer's half, so a malformed event can never reach component state.
`safeThumbnailSrc` is the second control here: it is the only place a string from the store reaches an
`<img src>`, and it drops anything that is not a JPEG data URL.

Create `apps/desktop/renderer/src/api.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  THUMBNAIL_DATA_URL_PREFIX,
  parseHistoryChanged,
  parseHotkeyStatus,
  parsePaletteShown,
  parseToast,
  safeThumbnailSrc,
} from './api'

// Spec §11 control 8: IPC is validated in BOTH directions. Main validates what the renderer sends;
// these guards are the renderer's half, so a malformed event can never reach component state.
describe('event payload guards', () => {
  it('accepts a well-formed payload of each kind', () => {
    expect(parseHistoryChanged({ reason: 'ingest', total: 3 })).toEqual({ reason: 'ingest', total: 3 })
    expect(parseHotkeyStatus({ status: 'failed', accelerator: 'Cmd+Shift+V' })).toEqual({
      status: 'failed',
      accelerator: 'Cmd+Shift+V',
    })
    expect(parseToast({ text: 'Copied', tone: 'warn' })).toEqual({ text: 'Copied', tone: 'warn' })
    expect(parsePaletteShown({ shownAt: 1_767_225_600_000 })).toEqual({ shownAt: 1_767_225_600_000 })
  })

  it('rejects a bad discriminator instead of passing it through', () => {
    expect(parseHistoryChanged({ reason: 'exploded', total: 3 })).toBe(null)
    expect(parseHotkeyStatus({ status: 'exploded', accelerator: 'x' })).toBe(null)
    expect(parseToast({ text: 'hi', tone: 'shout' })).toBe(null)
  })

  it('rejects wrong primitive types and non-objects', () => {
    expect(parseHistoryChanged({ reason: 'ingest', total: '3' })).toBe(null)
    expect(parseHistoryChanged({ reason: 'ingest', total: -1 })).toBe(null)
    expect(parseHistoryChanged({ reason: 'ingest', total: 1.5 })).toBe(null)
    expect(parsePaletteShown({ shownAt: 'yesterday' })).toBe(null)
    expect(parseToast('not an object')).toBe(null)
    expect(parseToast(null)).toBe(null)
    expect(parseToast([{ text: 'hi', tone: 'info' }])).toBe(null)
  })

  it('rejects an over-long toast, matching the 200-char cap in the IPC schema', () => {
    expect(parseToast({ text: 'x'.repeat(200), tone: 'info' })?.text.length).toBe(200)
    expect(parseToast({ text: 'x'.repeat(201), tone: 'info' })).toBe(null)
    expect(parseToast({ text: '', tone: 'info' })).toBe(null)
  })
})

// The one place a string from the store reaches an <img src>. Anything but a JPEG data URL is
// dropped, so no copied item can name a scheme or a type we did not intend to render.
describe('safeThumbnailSrc', () => {
  it('passes a JPEG data URL through unchanged', () => {
    const src = `${THUMBNAIL_DATA_URL_PREFIX}/9j/4AAQSkZJRg==`
    expect(safeThumbnailSrc(src)).toBe(src)
  })

  it('drops anything that is not a JPEG data URL', () => {
    expect(safeThumbnailSrc(null)).toBe(null)
    expect(safeThumbnailSrc('data:image/svg+xml;base64,PHN2Zy8+')).toBe(null)
    expect(safeThumbnailSrc('javascript:alert(1)')).toBe(null)
    expect(safeThumbnailSrc('https://example.com/a.jpg')).toBe(null)
    expect(safeThumbnailSrc(`${THUMBNAIL_DATA_URL_PREFIX}${'A'.repeat(64 * 1024)}`)).toBe(null)
  })
})
```

- [ ] **Step 11: Run it and watch it fail for the right reason.**

```sh
npx vitest run --project renderer api.test
```

Expected: FAIL with
`Error: Failed to resolve import "./api" from "apps/desktop/renderer/src/api.test.ts". Does the file exist?`

- [ ] **Step 12: Write `api.ts`.**

Read the comment at the top of the imports before you change it: **every import from
`@cairn/protocol` in renderer product code must be `import type`.** The barrel re-exports
`./hash`, which does `import { createHash } from 'node:crypto'`, and a renderer *bundle* containing
that fails the build with `"createHash" is not exported by "__vite-browser-external"`. Types are
erased, so type-only imports cost nothing and still make a protocol rename a compile error here.
Test files are exempt: they run in Node, where `node:crypto` resolves.

Create `apps/desktop/renderer/src/api.ts`:

```ts
// TYPE-ONLY, always: the @cairn/protocol barrel re-exports hash.ts, which imports node:crypto, and a
// renderer bundle containing that fails with `"createHash" is not exported by
// "__vite-browser-external"`. Types are erased, so the shapes still cannot drift.
import type { IpcEvent, IpcEventChannel, IpcRequest, ItemSummary, Unsub } from '@cairn/protocol'

type ParamsOf<C extends IpcRequest['channel']> = Extract<IpcRequest, { channel: C }>['params']
type ResultOf<C extends IpcRequest['channel']> = Extract<IpcRequest, { channel: C }>['result']
type PayloadOf<C extends IpcEventChannel> = Extract<IpcEvent, { channel: C }>['payload']

export type ListParams = ParamsOf<'cairn:history.list'>
export type ListResult = ResultOf<'cairn:history.list'>
export type SearchParams = ParamsOf<'cairn:history.search'>
export type SearchResult = ResultOf<'cairn:history.search'>
export type PreviewResult = ResultOf<'cairn:history.preview'>
export type CopyResult = ResultOf<'cairn:recall.copy'>
export type CopyReason = CopyResult['reason']
export type SecurityStatus = ResultOf<'cairn:security.status'>
export type HistoryChangedPayload = PayloadOf<'cairn:history.changed'>
export type HotkeyStatusPayload = PayloadOf<'cairn:hotkey.status'>
export type ToastPayload = PayloadOf<'cairn:toast'>
export type PaletteShownPayload = PayloadOf<'cairn:palette.shown'>
export type HotkeyStatus = HotkeyStatusPayload['status']

/** Exactly the twelve methods the preload exposes. No `invoke`, no channel parameter. */
export interface CairnBridge {
  list(params: ListParams): Promise<ListResult>
  search(params: SearchParams): Promise<SearchResult>
  preview(params: { id: string }): Promise<PreviewResult>
  pin(params: { id: string; pinned: boolean }): Promise<{ pinned: boolean }>
  remove(params: { id: string }): Promise<{ removed: boolean }>
  copy(params: { id: string }): Promise<CopyResult>
  close(): Promise<{ closed: true }>
  securityStatus(): Promise<SecurityStatus>
  onHistoryChanged(cb: (p: HistoryChangedPayload) => void): Unsub
  onHotkeyStatus(cb: (p: HotkeyStatusPayload) => void): Unsub
  onToast(cb: (p: ToastPayload) => void): Unsub
  onPaletteShown(cb: (p: PaletteShownPayload) => void): Unsub
}

declare global {
  interface Window { readonly cairn: CairnBridge }
}

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u)

export function parseHistoryChanged(u: unknown): HistoryChangedPayload | null {
  if (!isRecord(u)) return null
  const { reason, total } = u
  if (reason !== 'ingest' && reason !== 'update' && reason !== 'delete' && reason !== 'evict') return null
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null
  return { reason, total }
}

export function parseHotkeyStatus(u: unknown): HotkeyStatusPayload | null {
  if (!isRecord(u)) return null
  const { status, accelerator } = u
  if (status !== 'active' && status !== 'unbound' && status !== 'failed') return null
  if (typeof accelerator !== 'string' || accelerator.length > 64) return null
  return { status, accelerator }
}

export function parseToast(u: unknown): ToastPayload | null {
  if (!isRecord(u)) return null
  const { text, tone } = u
  if (typeof text !== 'string' || text.length === 0 || text.length > 200) return null
  if (tone !== 'info' && tone !== 'warn') return null
  return { text, tone }
}

export function parsePaletteShown(u: unknown): PaletteShownPayload | null {
  if (!isRecord(u)) return null
  const { shownAt } = u
  if (typeof shownAt !== 'number' || !Number.isInteger(shownAt)) return null
  return { shownAt }
}

export const THUMBNAIL_DATA_URL_PREFIX = 'data:image/jpeg;base64,'

/** The ONLY value ever placed in an <img src>. Anything else becomes null. */
export function safeThumbnailSrc(value: ItemSummary['thumbnailDataUrl']): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith(THUMBNAIL_DATA_URL_PREFIX)) return null
  if (value.length > 64 * 1024) return null
  return value
}
```

The four `parseX` functions **declare the protocol's payload type as their return type**, so a field
rename in `@cairn/protocol` breaks compilation here rather than silently producing `null` at runtime.
That is why they are hand-rolled instead of importing the zod schemas.

- [ ] **Step 13: Run it and watch it pass.**

```sh
npx vitest run --project renderer api.test
```

Expected: `Tests 6 passed (6)`.

- [ ] **Step 14: Commit.**

```sh
git add apps/desktop/renderer/src/api.ts apps/desktop/renderer/src/api.test.ts
git commit -m "feat(renderer): typed window.cairn wrapper with validated event payloads"
```

---

- [ ] **Step 15: Write the fake bridge every renderer test uses.**

This is test infrastructure, not product code: one fake `window.cairn` that records every call,
pages out of a synthetic history, can be made to fail, and can defer its responses so a test can land
them out of order. It is the renderer's equivalent of `createFakeAgent`.

Create `apps/desktop/renderer/src/testing.ts`:

```ts
import type { ItemSummary } from '@cairn/protocol'
import type { CairnBridge, CopyResult, ListParams, PreviewResult, SearchParams } from './api'

/** A 26-char Crockford base32 id that `ItemIdSchema` in @cairn/protocol accepts (no I, L, O or U). */
export function testItemId(n: number): string {
  return 'CARN' + String(n).padStart(22, '0')
}

export function makeItem(n: number, over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: testItemId(n),
    kind: 'text',
    preview: `item ${n}`,
    previewTruncated: false,
    flags: [],
    maskedSpanCount: 0,
    sourceAppName: 'TextEdit',
    byteLength: 8,
    createdAt: 1_767_225_600_000 - n * 1_000,
    pinned: false,
    expiresAt: null,
    thumbnailDataUrl: null,
    ...over,
  }
}

export interface SearchHit {
  item: ItemSummary
  score: number
  ranges: number[]
}

export interface FakeApi {
  readonly api: CairnBridge
  readonly listCalls: ListParams[]
  readonly searchCalls: SearchParams[]
  readonly previewCalls: string[]
  readonly copyCalls: string[]
  readonly pinCalls: { id: string; pinned: boolean }[]
  readonly removeCalls: string[]
  closeCalls: number
  /** The whole synthetic history the fake pages out of. */
  items: ItemSummary[]
  /** Search results per query, so a test can prove a stale response is dropped. */
  searchHitsFor: (q: string) => SearchHit[]
  previews: Map<string, PreviewResult>
  copyResult: CopyResult
  failCopy: boolean
  failList: boolean
  /** Deferred mode: every call resolves only when you invoke its entry in `pending`. */
  deferred: boolean
  readonly pending: (() => void)[]
  emitHistoryChanged(payload: unknown): void
  emitHotkeyStatus(payload: unknown): void
  emitToast(payload: unknown): void
  emitPaletteShown(payload: unknown): void
}

export function createFakeApi(
  init: Partial<Pick<FakeApi, 'items' | 'searchHitsFor' | 'previews' | 'copyResult'>> = {},
): FakeApi {
  const listeners = {
    'history.changed': [] as ((p: unknown) => void)[],
    'hotkey.status': [] as ((p: unknown) => void)[],
    toast: [] as ((p: unknown) => void)[],
    'palette.shown': [] as ((p: unknown) => void)[],
  }
  // The bridge types each callback with its own payload type; the fake stores them as
  // `(p: unknown) => void` on purpose, so a test can push a malformed payload through.
  const sub = (bucket: ((p: unknown) => void)[], cb: unknown): (() => void) => {
    const fn = cb as (p: unknown) => void
    bucket.push(fn)
    return () => {
      const i = bucket.indexOf(fn)
      if (i >= 0) bucket.splice(i, 1)
    }
  }

  const fake: FakeApi = {
    api: undefined as unknown as CairnBridge,
    listCalls: [],
    searchCalls: [],
    previewCalls: [],
    copyCalls: [],
    pinCalls: [],
    removeCalls: [],
    closeCalls: 0,
    items: init.items ?? [],
    searchHitsFor: init.searchHitsFor ?? (() => []),
    previews: init.previews ?? new Map(),
    copyResult: init.copyResult ?? { result: 'copied-manual', reason: 'user-preference' },
    failCopy: false,
    failList: false,
    deferred: false,
    pending: [],
    emitHistoryChanged: (p) => listeners['history.changed'].forEach((cb) => cb(p)),
    emitHotkeyStatus: (p) => listeners['hotkey.status'].forEach((cb) => cb(p)),
    emitToast: (p) => listeners.toast.forEach((cb) => cb(p)),
    emitPaletteShown: (p) => listeners['palette.shown'].forEach((cb) => cb(p)),
  }

  const settle = <T>(value: T): Promise<T> =>
    fake.deferred
      ? new Promise<T>((resolve) => fake.pending.push(() => resolve(value)))
      : Promise.resolve(value)

  const api: CairnBridge = {
    list: (params) => {
      fake.listCalls.push(params)
      if (fake.failList) return Promise.reject(new Error('E_IPC_REJECTED'))
      return settle({
        items: fake.items.slice(params.offset, params.offset + params.limit),
        total: fake.items.length,
      })
    },
    search: (params) => {
      fake.searchCalls.push(params)
      return settle({ results: fake.searchHitsFor(params.q).slice(0, params.limit) })
    },
    preview: (params) => {
      fake.previewCalls.push(params.id)
      return settle(
        fake.previews.get(params.id) ?? { text: '', isHtmlSource: false, truncated: false },
      )
    },
    pin: (params) => {
      fake.pinCalls.push(params)
      return settle({ pinned: params.pinned })
    },
    remove: (params) => {
      fake.removeCalls.push(params.id)
      return settle({ removed: true })
    },
    copy: (params) => {
      fake.copyCalls.push(params.id)
      if (fake.failCopy) return Promise.reject(new Error('E_IPC_REJECTED'))
      return settle(fake.copyResult)
    },
    close: () => {
      fake.closeCalls += 1
      return settle({ closed: true as const })
    },
    securityStatus: () =>
      settle({
        keyringMode: 'os-keyring' as const,
        encryptedAtRest: true,
        dataDirMode: '700',
        notes: [],
      }),
    onHistoryChanged: (cb) => sub(listeners['history.changed'], cb),
    onHotkeyStatus: (cb) => sub(listeners['hotkey.status'], cb),
    onToast: (cb) => sub(listeners.toast, cb),
    onPaletteShown: (cb) => sub(listeners['palette.shown'], cb),
  }
  ;(fake as { api: CairnBridge }).api = api
  return fake
}
```

- [ ] **Step 16: Write the failing tests for the state machine.**

Seven behaviours, each one a claim the M1 demo makes: a bounded window over 500 items, search with a
frozen limit, stale responses dropped, recall → toast → close on a deterministic clock, an honest
warning when the IPC fails, a secret that refuses to be pinned, and a malformed event that changes
nothing.

Append to `apps/desktop/renderer/src/palette-state.test.ts` — and extend the two import blocks at the
top of the file to exactly this:

```ts
import { TOAST_COPIED_MANUAL, TOAST_COPIED_SECURE_INPUT, createTestClock } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import {
  FETCH_SPAN,
  PaletteState,
  RECALL_TOAST_TEXT,
  SEARCH_LIMIT,
  SECRET_PIN_REFUSED_TEXT,
  TOAST_MS,
  VISIBLE_ROWS,
  filePathsFromPreview,
  highlightSegments,
  kindChipLabel,
  nextIndex,
  secretExpiryLabel,
  visibleRange,
  windowStartFor,
} from './palette-state.svelte'
import { createFakeApi, makeItem, testItemId } from './testing'
```

then add this block at the end:

```ts
describe('PaletteState', () => {
  it('loads a bounded window and never holds more than FETCH_SPAN previews', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 500 }, (_, i) => makeItem(i)) })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    expect(state.total).toBe(500)
    expect(state.loadedRowCount).toBe(FETCH_SPAN)
    expect(fake.listCalls).toEqual([{ limit: 32, offset: 0, pinnedOnly: false }])

    state.moveSelection('End')
    await state.pending

    expect(state.selectedIndex).toBe(499)
    expect(state.loadedRowCount).toBeLessThanOrEqual(FETCH_SPAN)
    expect(state.rowAt(499)?.preview).toBe('item 499')
    expect(state.rowAt(0)).toBe(null)
  })

  it('searches with the frozen limit and shows no results honestly', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    await state.setQuery('wrhs')
    expect(fake.searchCalls).toEqual([{ q: 'wrhs', limit: SEARCH_LIMIT }])
    expect(state.mode).toBe('search')
    expect(state.total).toBe(0)

    await state.setQuery('  ')
    expect(state.mode).toBe('recent')
    expect(state.total).toBe(1)
  })

  it('drops a stale search response instead of overwriting a newer one', async () => {
    const fake = createFakeApi({
      items: [makeItem(1)],
      searchHitsFor: (q) => [
        { item: makeItem(7, { preview: q === 'ab' ? 'NEW' : 'OLD' }), score: 1, ranges: [] },
      ],
    })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    fake.deferred = true
    const first = state.setQuery('a')
    const second = state.setQuery('ab')
    expect(fake.pending.length).toBe(2)

    // Land them out of order: the OLDER request resolves last and must be ignored.
    const [resolveOld, resolveNew] = fake.pending.splice(0, 2)
    resolveNew?.()
    resolveOld?.()
    fake.deferred = false
    await Promise.all([first, second])

    expect(state.query).toBe('ab')
    expect(state.total).toBe(1)
    expect(state.rowAt(0)?.preview).toBe('NEW')
  })

  it('copies the selected item, toasts the honest M1 sentence, and closes after two seconds', async () => {
    const clock = createTestClock()
    const fake = createFakeApi({ items: [makeItem(1), makeItem(2)] })
    const state = new PaletteState({ api: fake.api, clock })
    await state.start()
    state.moveSelection('ArrowDown')

    await state.recall()

    expect(fake.copyCalls).toEqual([testItemId(2)])
    expect(state.toast).toEqual({ text: TOAST_COPIED_MANUAL, tone: 'info' })
    expect(fake.closeCalls).toBe(0)

    clock.advance(TOAST_MS - 1)
    expect(fake.closeCalls).toBe(0)
    clock.advance(1)
    expect(fake.closeCalls).toBe(1)
    expect(state.toast).toBe(null)
  })

  it('warns instead of lying when the copy IPC is rejected', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    fake.failCopy = true
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    await state.recall()

    expect(state.toast?.tone).toBe('warn')
    expect(state.toast?.text).toBe('Cairn could not put that on the clipboard')
    expect(fake.closeCalls).toBe(0)
  })

  it('refuses to pin a secret without even calling the IPC', async () => {
    const secret = makeItem(1, { preview: 'AKIA••••A7QD', flags: ['secret'], expiresAt: 301_000 })
    const fake = createFakeApi({ items: [secret] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    await state.togglePin()

    expect(fake.pinCalls).toEqual([])
    expect(state.toast).toEqual({ text: SECRET_PIN_REFUSED_TEXT, tone: 'warn' })
  })

  it('ignores a malformed event payload instead of trusting it', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = new PaletteState({ api: fake.api, clock: createTestClock() })
    await state.start()

    fake.emitHotkeyStatus({ status: 'exploded', accelerator: 'Cmd+Shift+V' })
    fake.emitToast({ text: 'x'.repeat(201), tone: 'info' })
    fake.emitToast('not an object')
    fake.emitPaletteShown({ shownAt: 'yesterday' })

    expect(state.hotkeyStatus).toBe('active')
    expect(state.toast).toBe(null)
    expect(state.shownAt).toBe(0)

    fake.emitHotkeyStatus({ status: 'failed', accelerator: 'Cmd+Shift+V' })
    expect(state.hotkeyStatus).toBe('failed')
  })
})
```

Note what the pin test proves: spec §11 control 5 says secret-flagged items are **exempt from
pinning**, and the renderer enforces that locally rather than relying on main returning an error — so
the user gets an explanation instead of a silent no-op.

- [ ] **Step 17: Run them and watch them fail for the right reason.**

```sh
npx vitest run --project renderer palette-state
```

Expected: FAIL — 7 failures, each `TypeError: PaletteState is not a constructor`, with
`Tests 7 failed | 12 passed (19)`.

- [ ] **Step 18: Implement the `PaletteState` class.**

Design notes, because two of these will look arbitrary otherwise:

- **Paging, not pages.** The renderer fetches a 32-row window around what is visible and throws the
  previous one away, so it holds ~32 masked previews and never the history (spec §4: "the renderer
  holds no history beyond the current page"). `total` comes from main, so the scrollbar is right for
  500 items — or for 100k when the roadmap's FTS5 store lands — without loading them.
- **No debounce, but a sequence guard.** Search is in-process over an in-memory ufuzzy index of at
  most 2000 previews, so there is nothing to debounce; what does matter is that a slow response
  cannot overwrite a newer one, which `#listSeq` / `#previewSeq` handle.
- **The clock is injected**, matching contract §5.8's rule that nothing calls `setTimeout` directly.
  The renderer cannot import `systemClock` (that would be a runtime import of the barrel), so
  `main.ts` passes an equivalent two-line browser clock and tests pass `createTestClock()`.

Append to `apps/desktop/renderer/src/palette-state.svelte.ts` — and change its first line to add the
extra type imports:

```ts
import type { Cancel, Clock, ItemKind, ItemSummary } from '@cairn/protocol'
import {
  parseHistoryChanged,
  parseHotkeyStatus,
  parsePaletteShown,
  parseToast,
  type CairnBridge,
  type CopyReason,
  type HotkeyStatus,
  type ToastPayload,
} from './api'
```

You can now also narrow `RECALL_TOAST_TEXT`'s declared type from the inline union to
`Readonly<Record<CopyReason, string>>`. Then append:

```ts
export interface VisibleRow {
  readonly index: number
  readonly top: number
  readonly item: ItemSummary | null
  readonly ranges: readonly number[]
}

export interface PaletteDeps {
  readonly api: CairnBridge
  readonly clock: Clock
}

export class PaletteState {
  query = $state('')
  selectedIndex = $state(0)
  windowStart = $state(0)
  total = $state(0)
  mode: 'recent' | 'search' = $state('recent')
  hotkeyStatus: HotkeyStatus = $state('active')
  hotkeyAccelerator = $state('')
  toast: ToastPayload | null = $state(null)
  statusText: string | null = $state(null)
  previewText = $state('')
  previewMime: 'text/plain' | 'text/html' = $state('text/plain')
  shownAt = $state(0)
  nowMs = $state(0)
  /** At most FETCH_SPAN summaries — the renderer never holds the whole history. */
  rows: (ItemSummary | null)[] = $state([])
  rowsOffset = $state(0)
  rangesByIndex: number[][] = $state([])

  /** The promise of the most recent background work. The UI never awaits it; tests do. */
  pending: Promise<unknown> = Promise.resolve()

  readonly #deps: PaletteDeps
  readonly #unsubs: (() => void)[] = []
  #listSeq = 0
  #previewSeq = 0
  #cancelToast: Cancel | null = null

  constructor(deps: PaletteDeps) {
    this.#deps = deps
  }

  visibleRows: VisibleRow[] = $derived.by(() => {
    const { start, end } = visibleRange(this.windowStart, this.total)
    const out: VisibleRow[] = []
    for (let i = start; i < end; i++) {
      out.push({
        index: i,
        top: i * ROW_HEIGHT_PX,
        item: this.rowAt(i),
        ranges: this.rangesByIndex[i] ?? [],
      })
    }
    return out
  })

  get selectedItem(): ItemSummary | null {
    return this.rowAt(this.selectedIndex)
  }

  get loadedRowCount(): number {
    return this.rows.length
  }

  rowAt(index: number): ItemSummary | null {
    const local = index - this.rowsOffset
    if (local < 0 || local >= this.rows.length) return null
    return this.rows[local] ?? null
  }

  async start(): Promise<void> {
    const { api } = this.#deps
    this.#unsubs.push(
      api.onHotkeyStatus((raw) => {
        const p = parseHotkeyStatus(raw)
        if (p === null) return
        this.hotkeyStatus = p.status
        this.hotkeyAccelerator = p.accelerator
      }),
      api.onToast((raw) => {
        const p = parseToast(raw)
        if (p === null) return
        this.toast = p
      }),
      api.onHistoryChanged((raw) => {
        const p = parseHistoryChanged(raw)
        if (p === null) return
        if (this.mode === 'recent') this.pending = this.reload()
      }),
      api.onPaletteShown((raw) => {
        const p = parsePaletteShown(raw)
        if (p === null) return
        // Main re-shows the same window, so "opening the palette" is an event, not a mount.
        this.shownAt = p.shownAt
        this.query = ''
        this.mode = 'recent'
        this.selectedIndex = 0
        this.windowStart = 0
        this.toast = null
        this.pending = this.reload()
      }),
    )
    await this.reload()
  }

  dispose(): void {
    for (const un of this.#unsubs.splice(0)) un()
    this.#cancelToast?.()
    this.#cancelToast = null
  }

  async reload(): Promise<void> {
    this.mode = 'recent'
    this.nowMs = this.#deps.clock.now()
    this.rowsOffset = 0
    this.rows = []
    this.rangesByIndex = []
    await this.#fetchWindow(0)
    await this.loadPreview()
  }

  async setQuery(q: string): Promise<void> {
    this.query = q
    this.selectedIndex = 0
    this.windowStart = 0
    if (q.trim().length === 0) {
      await this.reload()
      return
    }
    this.mode = 'search'
    const seq = ++this.#listSeq
    try {
      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })
      if (seq !== this.#listSeq) return
      this.rows = res.results.map((r) => r.item)
      this.rangesByIndex = res.results.map((r) => [...r.ranges])
      this.rowsOffset = 0
      this.total = res.results.length
      this.statusText = null
    } catch {
      if (seq !== this.#listSeq) return
      this.statusText = LOAD_FAILED_TEXT
    }
    await this.loadPreview()
  }

  moveSelection(key: NavKey): void {
    this.selectedIndex = nextIndex(this.selectedIndex, key, this.total)
    this.windowStart = windowStartFor(this.selectedIndex, this.windowStart, this.total)
    this.pending = Promise.all([this.ensureLoaded(), this.loadPreview()])
  }

  setScrollTop(px: number): void {
    const maxStart = Math.max(0, this.total - VISIBLE_ROWS)
    this.windowStart = Math.max(0, Math.min(Math.floor(px / ROW_HEIGHT_PX), maxStart))
    this.pending = this.ensureLoaded()
  }

  async ensureLoaded(): Promise<void> {
    if (this.mode !== 'recent') return
    const { start, end } = visibleRange(this.windowStart, this.total)
    if (start >= this.rowsOffset && end <= this.rowsOffset + this.rows.length) return
    await this.#fetchWindow(Math.max(0, start))
  }

  async #fetchWindow(offset: number): Promise<void> {
    const seq = ++this.#listSeq
    try {
      const res = await this.#deps.api.list({ limit: FETCH_SPAN, offset, pinnedOnly: false })
      if (seq !== this.#listSeq) return
      this.rows = [...res.items]
      this.rowsOffset = offset
      this.total = res.total
      this.rangesByIndex = []
      this.statusText = null
      if (this.selectedIndex >= this.total) this.selectedIndex = Math.max(0, this.total - 1)
    } catch {
      if (seq !== this.#listSeq) return
      this.statusText = LOAD_FAILED_TEXT
    }
  }

  async loadPreview(): Promise<void> {
    const item = this.selectedItem
    if (item === null) {
      this.previewText = ''
      this.previewMime = 'text/plain'
      return
    }
    const seq = ++this.#previewSeq
    try {
      const res = await this.#deps.api.preview({ id: item.id })
      if (seq !== this.#previewSeq) return
      this.previewText = res.text
      // `text` is ALWAYS plain text: for an HTML item it is the HTML *source*, and `isHtmlSource`
      // only labels the pane. Nothing here ever becomes markup.
      this.previewMime = res.isHtmlSource ? 'text/html' : 'text/plain'
    } catch {
      if (seq !== this.#previewSeq) return
      this.previewText = ''
      this.previewMime = 'text/plain'
    }
  }

  async recall(): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    try {
      const res = await this.#deps.api.copy({ id: item.id })
      // M1 has no synthetic paste: the toast IS the outcome, and it is exactly the M2
      // Accessibility-denied degraded mode (spec §6).
      this.#showToast({ text: RECALL_TOAST_TEXT[res.reason], tone: 'info' })
      this.#cancelToast = this.#deps.clock.setTimeout(() => {
        void this.close()
      }, TOAST_MS)
    } catch {
      this.#showToast({ text: RECALL_FAILED_TEXT, tone: 'warn' })
    }
  }

  async togglePin(): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    // Spec §11 control 5: secrets are exempt from pinning. Refusing here, with a reason, beats
    // sending an IPC we know will fail.
    if (item.flags.includes('secret')) {
      this.#showToast({ text: SECRET_PIN_REFUSED_TEXT, tone: 'warn' })
      return
    }
    try {
      await this.#deps.api.pin({ id: item.id, pinned: !item.pinned })
    } catch {
      this.#showToast({ text: LOAD_FAILED_TEXT, tone: 'warn' })
      return
    }
    await this.reload()
  }

  async removeSelected(): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    try {
      await this.#deps.api.remove({ id: item.id })
    } catch {
      this.#showToast({ text: LOAD_FAILED_TEXT, tone: 'warn' })
      return
    }
    await this.reload()
  }

  async close(): Promise<void> {
    this.#cancelToast?.()
    this.#cancelToast = null
    this.toast = null
    await this.#deps.api.close()
  }

  #showToast(t: ToastPayload): void {
    this.#cancelToast?.()
    this.#cancelToast = null
    this.toast = t
  }
}
```

- [ ] **Step 19: Run them and watch them pass.**

```sh
npx vitest run --project renderer palette-state
```

Expected: `Tests 19 passed (19)`.

- [ ] **Step 20: Prove the stale-response guard has teeth.**

A guard you have never seen fire is not a guard.

```sh
# delete the sequence check from setQuery's success path
python3 - <<'PY'
p = 'apps/desktop/renderer/src/palette-state.svelte.ts'
s = open(p).read()
s = s.replace("""      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })
      if (seq !== this.#listSeq) return""", """      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })""")
open(p, 'w').write(s)
PY
npx vitest run --project renderer palette-state -t 'drops a stale search response'
```

Expected: FAIL with `AssertionError: expected 'OLD' to be 'NEW' // Object.is equality`.

Now put the line back. `git checkout` is not available here — the file is still untracked — so restore
it the same way you removed it:

```sh
python3 - <<'PY'
p = 'apps/desktop/renderer/src/palette-state.svelte.ts'
s = open(p).read()
s = s.replace("""      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })
      if (seq !== this.#listSeq) return""", """      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })""")
s = s.replace("""      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })""", """      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })
      if (seq !== this.#listSeq) return""")
open(p, 'w').write(s)
PY
grep -c 'if (seq !== this.#listSeq) return' apps/desktop/renderer/src/palette-state.svelte.ts
npx vitest run --project renderer palette-state
```

Expected: `grep -c` prints `4` (one in `setQuery`'s success path, one in its `catch`, two in
`#fetchWindow`), and `Tests 19 passed (19)` again.

- [ ] **Step 21: Commit.**

```sh
git add apps/desktop/renderer/src/palette-state.svelte.ts apps/desktop/renderer/src/palette-state.test.ts apps/desktop/renderer/src/testing.ts
git commit -m "feat(renderer): PaletteState — windowed paging, search, recall and toast"
```

---

- [ ] **Step 22: Write the failing security test for the preview pane.**

This is the most important test in the task. It is the contract's frozen assertion (§8), plus two:
one that names the real bridge in the payload and proves it was never called, and one that the
`HTML source` label appears without changing the body.

Create `apps/desktop/renderer/src/Preview.security.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Preview from './Preview.svelte'

// Spec §11 control 3. Copied HTML is content an attacker's page authored. Rendering it would hand
// that page script execution inside our privileged renderer, with the whole history one IPC call
// away — the single worst vulnerability this app class can have.
let host: HTMLDivElement
let app: Record<string, unknown> | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (app !== null) void unmount(app)
  app = null
  host.remove()
  delete (globalThis as Record<string, unknown>).__pwned
})

describe('the preview pane never renders copied HTML as HTML', () => {
  it('escapes an <img onerror> payload to text', () => {
    const payload = '<img src=x onerror="window.__pwned = true">'
    app = mount(Preview, {
      target: host,
      props: { text: payload, mime: 'text/html' },
    }) as Record<string, unknown>
    flushSync()

    const pre = host.querySelector('pre')
    expect(pre).not.toBe(null)
    expect(pre?.textContent).toBe(payload)
    expect(pre?.querySelector('img')).toBe(null)
    expect(pre?.innerHTML).toBe('&lt;img src=x onerror="window.__pwned = true"&gt;')
    expect((globalThis as Record<string, unknown>).__pwned).toBe(undefined)
  })

  it('never reaches the IPC bridge from a payload that names it', () => {
    let bridgeCalls = 0
    Object.defineProperty(globalThis, 'cairn', {
      configurable: true,
      value: {
        list: () => {
          bridgeCalls += 1
          return Promise.resolve({ items: [], total: 0 })
        },
      },
    })
    const payload = '<img src=x onerror="window.cairn.list({limit:1,offset:0,pinnedOnly:false})">'
    app = mount(Preview, {
      target: host,
      props: { text: payload, mime: 'text/html' },
    }) as Record<string, unknown>
    flushSync()

    expect(host.querySelectorAll('img').length).toBe(0)
    expect(host.querySelector('pre')?.textContent).toBe(payload)
    expect(bridgeCalls).toBe(0)
  })

  it('labels HTML source without changing the body, and drops the label for plain text', () => {
    app = mount(Preview, {
      target: host,
      props: { text: 'plain', mime: 'text/plain' },
    }) as Record<string, unknown>
    flushSync()

    expect(host.querySelector('[data-testid="preview-badge"]')).toBe(null)
    expect(host.querySelector('pre')?.textContent).toBe('plain')
  })
})
```

- [ ] **Step 23: Run it and watch it fail for the right reason.**

```sh
npx vitest run --project security apps/desktop/renderer/src/Preview.security.test.ts
```

Expected: FAIL with
`Error: Failed to resolve import "./Preview.svelte" from "apps/desktop/renderer/src/Preview.security.test.ts". Does the file exist?`

- [ ] **Step 24: Write `Preview.svelte` and `Toast.svelte`.**

`Preview` takes `mime` rather than the IPC result's `isHtmlSource` boolean, because the contract's
frozen test in §8 mounts it that way; `Palette.svelte` maps one to the other. The `<pre>` contains a
single `{text}` expression and nothing else, which is what makes the exact `innerHTML` assertion above
stable.

Create `apps/desktop/renderer/src/Preview.svelte`:

```svelte
<script lang="ts">
  // Spec §11 control 3: this component renders text/plain, or HTML *source* as text. Svelte's
  // raw-HTML directive is absent here and always will be — security/no-html-sink.security.test.ts
  // fails if one appears. The comment says it in prose on purpose: .svelte is scanned RAW, so
  // writing the directive's own token here would trip the very ban this comment documents.
  interface Props {
    text: string
    mime: 'text/plain' | 'text/html'
    filePaths?: readonly string[]
  }
  let { text, mime, filePaths = [] }: Props = $props()
</script>

{#if mime === 'text/html'}
  <div class="preview-badge" data-testid="preview-badge">HTML source</div>
{/if}
{#if filePaths.length > 0}
  <ul class="file-list" data-testid="file-list">
    {#each filePaths as path, i (i)}<li>{path}</li>{/each}
  </ul>
{/if}
<pre class="preview-body" data-testid="preview">{text}</pre>
```

Create `apps/desktop/renderer/src/Toast.svelte`:

```svelte
<script lang="ts">
  interface Props {
    text: string
    tone: 'info' | 'warn'
  }
  let { text, tone }: Props = $props()
</script>

<div class="toast" data-testid="toast" data-tone={tone} role="status" aria-live="polite">{text}</div>
```

- [ ] **Step 25: Run it and watch it pass.**

```sh
npx vitest run --project security apps/desktop/renderer/src/Preview.security.test.ts
```

Expected: `Tests 3 passed (3)`.

- [ ] **Step 26: Prove the escaping control has teeth.**

```sh
python3 - <<'PY'
p = 'apps/desktop/renderer/src/Preview.svelte'
s = open(p).read()
s = s.replace('<pre class="preview-body" data-testid="preview">{text}</pre>',
              '<pre class="preview-body" data-testid="preview">{@html text}</pre>')
open(p, 'w').write(s)
PY
npx vitest run --project security apps/desktop/renderer/src/Preview.security.test.ts
```

Expected: FAIL, 2 of 3 tests, with
`AssertionError: expected '' to be '<img src=x onerror="window.__pwned = …'` and
`AssertionError: expected 1 to be +0` (jsdom really did create an `img` element from the copied
payload). Now put it back:

```sh
python3 - <<'PY'
p = 'apps/desktop/renderer/src/Preview.svelte'
s = open(p).read()
s = s.replace('{@html text}', '{text}')
open(p, 'w').write(s)
PY
grep -c '{@html' apps/desktop/renderer/src/Preview.svelte
npx vitest run --project security apps/desktop/renderer/src/Preview.security.test.ts
```

Expected: `grep -c` prints `0` (and exits 1, which is fine), then `Tests 3 passed (3)`. Zero is only
reachable because the header comment describes the directive in prose instead of spelling it — if you
"helpfully" rewrote that comment to name the token, this grep prints `1` and Step 40's source scan
fails on the comment. Leave the wording alone.

- [ ] **Step 27: Commit.**

```sh
git add apps/desktop/renderer/src/Preview.svelte apps/desktop/renderer/src/Toast.svelte apps/desktop/renderer/src/Preview.security.test.ts
git commit -m "feat(renderer): Preview escapes copied HTML, Toast reports the outcome"
```

---

- [ ] **Step 28: Write the failing component tests for the palette shell.**

Thirteen tests over nine behaviours: focus on show, Escape and blur, the persistent hotkey row, the
empty and no-results states, virtualisation, mouse scrolling, arrow-key navigation with
`aria-activedescendant`, chips + secret badge + thumbnail + highlights, the thumbnail guard, recall
with its toast and close, the pin/delete keys with `Cmd+A` left alone, the file list, and the props
shape.

Two implementation facts these tests depend on, both measured in jsdom 30.0.1: `clientHeight` is
always `0` and `scrollIntoView` **does not exist**, so the list may never measure or scroll-into-view;
but `element.scrollTop = 4400` does round-trip, so a scroll can be simulated.

Create `apps/desktop/renderer/src/Palette.test.ts`:

```ts
import { TOAST_COPIED_MANUAL, createTestClock } from '@cairn/protocol'
import { flushSync, mount, unmount, type ComponentProps } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ItemRow from './ItemRow.svelte'
import Palette from './Palette.svelte'
import { PaletteState, ROW_HEIGHT_PX, TOAST_MS, VISIBLE_ROWS } from './palette-state.svelte'
import { createFakeApi, makeItem, testItemId, type FakeApi } from './testing'

let host: HTMLDivElement
let app: Record<string, unknown> | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (app !== null) void unmount(app)
  app = null
  host.remove()
})

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const input = host.querySelector<HTMLInputElement>('[data-testid="search"]')
  if (input === null) throw new Error('the search field is missing')
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  input.dispatchEvent(event)
  flushSync()
  return event
}

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="option"]')]
}

async function render(fake: FakeApi, clock = createTestClock()): Promise<PaletteState> {
  const state = new PaletteState({ api: fake.api, clock })
  await state.start()
  app = mount(Palette, { target: host, props: { palette: state } }) as Record<string, unknown>
  flushSync()
  return state
}

describe('the palette shell', () => {
  it('focuses the search field on mount and again on every palette.shown', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    const state = await render(fake)
    const input = host.querySelector<HTMLInputElement>('[data-testid="search"]')!

    expect(document.activeElement).toBe(input)

    state.query = 'stale query'
    flushSync()
    input.blur()
    expect(document.activeElement).not.toBe(input)

    fake.emitPaletteShown({ shownAt: 1_767_225_600_123 })
    flushSync()

    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')
    expect(state.shownAt).toBe(1_767_225_600_123)
  })

  it('closes on Escape and on losing focus, which is what hides the window', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    await render(fake)

    press('Escape')
    expect(fake.closeCalls).toBe(1)

    window.dispatchEvent(new Event('blur'))
    flushSync()
    expect(fake.closeCalls).toBe(2)
  })

  it('shows the persistent hotkey row only when registration failed', async () => {
    const fake = createFakeApi({ items: [makeItem(1)] })
    await render(fake)

    expect(host.querySelector('[data-testid="hotkey-status"]')).toBe(null)

    fake.emitHotkeyStatus({ status: 'failed', accelerator: 'Cmd+Shift+V' })
    flushSync()

    const row = host.querySelector('[data-testid="hotkey-status"]')
    expect(row?.textContent?.trim()).toBe(
      'Cmd+Shift+V is not registered — another app already owns it. Try Cmd+Shift+C instead; rebinding lives in Settings, which this build does not have yet.',
    )
    expect(row?.getAttribute('role')).toBe('status')
  })

  it('says nothing is copied yet, and says no matches for a query that misses', async () => {
    const fake = createFakeApi({ items: [] })
    const state = await render(fake)

    expect(host.querySelector('[data-testid="empty"]')?.textContent?.trim()).toBe('Nothing copied yet')

    await state.setQuery('zzz')
    flushSync()

    expect(host.querySelector('[data-testid="empty"]')?.textContent?.trim()).toBe('No matches')
  })
})

describe('the virtualised result list', () => {
  it('renders a bounded window of rows for 500 items, not 500 rows', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 500 }, (_, i) => makeItem(i)) })
    const state = await render(fake)

    expect(state.total).toBe(500)
    expect(rows().length).toBe(VISIBLE_ROWS + 2)
    expect(host.querySelector<HTMLElement>('[data-testid="spacer"]')?.style.height).toBe('22000px')
    expect(rows()[0]?.style.top).toBe('0px')
    expect(rows()[1]?.style.top).toBe(`${ROW_HEIGHT_PX}px`)

    press('End')
    await state.pending
    flushSync()

    expect(state.selectedIndex).toBe(499)
    expect(rows().length).toBeLessThanOrEqual(VISIBLE_ROWS + 4)
    expect(rows().at(-1)?.getAttribute('aria-selected')).toBe('true')
  })

  it('follows a mouse scroll by re-windowing, not by rendering more rows', async () => {
    const fake = createFakeApi({ items: Array.from({ length: 500 }, (_, i) => makeItem(i)) })
    const state = await render(fake)
    const list = host.querySelector<HTMLDivElement>('#cairn-results')!

    list.scrollTop = 100 * ROW_HEIGHT_PX
    list.dispatchEvent(new Event('scroll'))
    await state.pending
    flushSync()

    expect(state.windowStart).toBe(100)
    expect(rows().length).toBeLessThanOrEqual(VISIBLE_ROWS + 4)
    expect(rows()[0]?.style.top).toBe(`${98 * ROW_HEIGHT_PX}px`)
    expect(fake.listCalls.length).toBe(2)
    expect(fake.listCalls[1]).toEqual({ limit: 32, offset: 98, pinnedOnly: false })
  })

  it('moves the selection with the arrow keys and reports it as aria-activedescendant', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1), makeItem(2)] })
    await render(fake)
    const input = host.querySelector<HTMLInputElement>('[data-testid="search"]')!

    expect(input.getAttribute('aria-activedescendant')).toBe(`cairn-row-${testItemId(0)}`)
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true')

    press('ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(`cairn-row-${testItemId(1)}`)
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true')
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('false')

    press('ArrowUp')
    press('ArrowUp')
    expect(input.getAttribute('aria-activedescendant')).toBe(`cairn-row-${testItemId(2)}`)
  })

  it('draws a kind chip, a masked secret badge, a thumbnail and match highlights', async () => {
    const thumb = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    const fake = createFakeApi({
      items: [
        makeItem(0, { kind: 'image', preview: 'Screenshot', thumbnailDataUrl: thumb }),
        makeItem(1, {
          kind: 'text',
          preview: 'AKIA••••A7QD',
          flags: ['secret'],
          expiresAt: 1_767_225_600_000 + 300_000,
        }),
        makeItem(2, { kind: 'files', preview: 'file:///Users/me/a.txt' }),
      ],
      searchHitsFor: () => [
        { item: makeItem(0, { preview: 'Screenshot' }), score: 1, ranges: [0, 6] },
      ],
    })
    const state = await render(fake)

    expect([...host.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual([
      'Image',
      'Text',
      'Files',
    ])
    expect(host.querySelector<HTMLImageElement>('.thumb')?.getAttribute('src')).toBe(thumb)
    expect(host.querySelector('.badge-secret')?.textContent?.trim()).toBe('Secret · expires in 5m')
    expect(rows()[1]?.textContent).toContain('AKIA••••A7QD')

    await state.setQuery('Screen')
    flushSync()

    expect(host.querySelector('mark')?.textContent).toBe('Screen')
  })

  it('refuses a thumbnail that is not a JPEG data URL', async () => {
    const fake = createFakeApi({
      items: [makeItem(0, { thumbnailDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })],
    })
    await render(fake)

    expect(host.querySelector('.thumb')).toBe(null)
  })
})

describe('recall', () => {
  it('puts the item on the clipboard, toasts the M1 sentence, then closes', async () => {
    const clock = createTestClock()
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    await render(fake, clock)

    press('ArrowDown')
    press('Enter')
    await Promise.resolve()
    await Promise.resolve()
    flushSync()

    expect(fake.copyCalls).toEqual([testItemId(1)])
    expect(host.querySelector('[data-testid="toast"]')?.textContent).toBe(TOAST_COPIED_MANUAL)
    expect(host.querySelector('[data-testid="toast"]')?.getAttribute('role')).toBe('status')
    expect(fake.closeCalls).toBe(0)

    clock.advance(TOAST_MS)
    flushSync()

    expect(fake.closeCalls).toBe(1)
    expect(host.querySelector('[data-testid="toast"]')).toBe(null)
  })
})

describe('pin and delete', () => {
  it('pins with Cmd+P, removes with Cmd+Backspace, and leaves Cmd+A to the text field', async () => {
    const fake = createFakeApi({ items: [makeItem(0), makeItem(1)] })
    const state = await render(fake)

    press('p', { metaKey: true })
    await state.pending
    expect(fake.pinCalls).toEqual([{ id: testItemId(0), pinned: true }])

    press('Backspace', { metaKey: true })
    await state.pending
    expect(fake.removeCalls).toEqual([testItemId(0)])

    // Cmd+A / Cmd+C / Cmd+V belong to the search field and the app's Edit menu, not to us.
    expect(press('a', { metaKey: true }).defaultPrevented).toBe(false)
    expect(press('c', { metaKey: true }).defaultPrevented).toBe(false)
    expect(press('v', { metaKey: true }).defaultPrevented).toBe(false)
    expect(fake.pinCalls.length).toBe(1)
  })
})

describe('the preview pane', () => {
  it('lists copied files one per line for a files item', async () => {
    const item = makeItem(0, { kind: 'files', preview: 'file:///Users/me/a%20b.txt' })
    const fake = createFakeApi({
      items: [item],
      previews: new Map([
        [
          item.id,
          {
            text: 'file:///Users/me/a%20b.txt\nfile:///Users/me/c.png',
            isHtmlSource: false,
            truncated: false,
          },
        ],
      ]),
    })
    await render(fake)

    const list = host.querySelector('[data-testid="file-list"]')
    expect([...(list?.querySelectorAll('li') ?? [])].map((li) => li.textContent)).toEqual([
      '/Users/me/a b.txt',
      '/Users/me/c.png',
    ])
  })
})

describe('the props shape', () => {
  it('gives ItemRow exactly the masked summary and nothing that could hold a raw body', () => {
    // A compile-time exhaustiveness check: add a prop to ItemRow and this literal stops compiling.
    const propKeys: Record<keyof ComponentProps<typeof ItemRow>, true> = {
      item: true,
      selected: true,
      ranges: true,
      top: true,
      nowMs: true,
      onpick: true,
    }
    expect(Object.keys(propKeys).sort()).toEqual([
      'item',
      'nowMs',
      'onpick',
      'ranges',
      'selected',
      'top',
    ])
  })
})
```

That last test is the "props shape enforces pre-masked data" assertion the security model asks for:
`ItemRow` receives an `ItemSummary` — which has no `repRefs`, no bytes and no unmasked field — plus
four scalars, and adding any prop that could hold a body makes `svelte-check` fail on the `Record`
literal.

- [ ] **Step 29: Run them and watch them fail for the right reason.**

```sh
npx vitest run --project renderer Palette.test
```

Expected: FAIL with
`Error: Failed to resolve import "./ItemRow.svelte" from "apps/desktop/renderer/src/Palette.test.ts". Does the file exist?`

- [ ] **Step 30: Write `ItemRow.svelte`.**

Highlighting is done by iterating `highlightSegments()` and emitting a `<mark>` per hit — that is the
whole reason those segments exist, because the alternative (splicing `<mark>` tags into a string) would
need Svelte's raw-HTML directive. The row is `role="option"` with `tabindex="-1"`: focus never leaves the search field,
so rows are reachable only through `aria-activedescendant`.

Create `apps/desktop/renderer/src/ItemRow.svelte`:

```svelte
<script lang="ts">
  import type { ItemSummary } from '@cairn/protocol'
  import { safeThumbnailSrc } from './api'
  import {
    ROW_HEIGHT_PX,
    highlightSegments,
    kindChipLabel,
    secretExpiryLabel,
  } from './palette-state.svelte'

  interface Props {
    item: ItemSummary
    selected: boolean
    ranges: readonly number[]
    top: number
    nowMs: number
    onpick: () => void
  }
  let { item, selected, ranges, top, nowMs, onpick }: Props = $props()

  const segments = $derived(highlightSegments(item.preview, ranges))
  const thumbnail = $derived(safeThumbnailSrc(item.thumbnailDataUrl))
  const expiry = $derived(secretExpiryLabel(item.expiresAt, nowMs))
</script>

<!-- The listbox container owns the keyboard; a row is reachable only via aria-activedescendant,
     so it takes tabindex="-1" and no key handler of its own. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  id={'cairn-row-' + item.id}
  tabindex="-1"
  class="row"
  class:selected
  role="option"
  aria-selected={selected}
  style="top: {top}px; height: {ROW_HEIGHT_PX}px"
  onclick={onpick}
>
  <span class="chip" data-kind={item.kind}>{kindChipLabel(item.kind)}</span>
  {#if thumbnail !== null}
    <img class="thumb" src={thumbnail} alt="" width="32" height="32" />
  {/if}
  <span class="row-preview"
    >{#each segments as seg, i (i)}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
  >
  {#if item.pinned}<span class="badge badge-pinned">Pinned</span>{/if}
  {#if item.flags.includes('secret')}
    <span class="badge badge-secret">Secret{expiry === null ? '' : ` · ${expiry}`}</span>
  {/if}
</div>
```

- [ ] **Step 31: Write `Palette.svelte`.**

Read the first comment in the script block before you rename anything. **The prop must not be called
`state`:** with a local binding named `state`, the Svelte compiler reads `$state(...)` as a *store
subscription* to it, and the component dies at runtime with
``Svelte error: store_invalid_shape — `state` is not a store with a `subscribe` method``. It is called
`palette`.

`aria-activedescendant` goes on the **input**, not on the listbox, because ARIA 1.2 puts it on the
element that holds focus, and focus never leaves the search field. The listbox keeps `role="listbox"`
and an `aria-label`.

Create `apps/desktop/renderer/src/Palette.svelte`:

```svelte
<script lang="ts">
  import ItemRow from './ItemRow.svelte'
  import Preview from './Preview.svelte'
  import Toast from './Toast.svelte'
  import {
    EMPTY_TEXT,
    NO_RESULTS_TEXT,
    PaletteState,
    ROW_HEIGHT_PX,
    VISIBLE_ROWS,
    filePathsFromPreview,
    hotkeyFailedText,
    type NavKey,
  } from './palette-state.svelte'

  // NOT `state`: a prop called `state` makes the compiler read `$state(...)` as a store
  // subscription to it, and the component dies with `store_invalid_shape` at runtime.
  interface Props {
    palette: PaletteState
  }
  let { palette }: Props = $props()

  let inputEl: HTMLInputElement | null = $state(null)
  let listEl: HTMLDivElement | null = $state(null)

  const selected = $derived(palette.selectedItem)
  const activeId = $derived(selected === null ? null : `cairn-row-${selected.id}`)
  const filePaths = $derived(
    selected !== null && selected.kind === 'files' ? filePathsFromPreview(palette.previewText) : [],
  )

  // The palette is re-shown without being re-created, so focus follows `shownAt`, not mount.
  $effect(() => {
    void palette.shownAt
    inputEl?.focus()
  })

  // Clicking away is a dismissal: an accessory panel that lingers after losing focus is a bug.
  $effect(() => {
    const onBlur = (): void => {
      palette.pending = palette.close()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  })

  // Fixed row geometry, so the scroll position is a pure function of the window start. Never
  // scrollIntoView(): jsdom does not implement it, and we do not need it.
  $effect(() => {
    const top = palette.windowStart * ROW_HEIGHT_PX
    if (listEl !== null && listEl.scrollTop !== top) listEl.scrollTop = top
  })

  function onKeyDown(event: KeyboardEvent): void {
    const key = event.key
    if (key === 'Escape') {
      event.preventDefault()
      palette.pending = palette.close()
      return
    }
    if (key === 'Enter') {
      event.preventDefault()
      palette.pending = palette.recall()
      return
    }
    // Home/End drive the list, not the caret: this is a list-first UI and Cmd+Left/Right still
    // moves the caret on macOS.
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault()
      palette.moveSelection(key satisfies NavKey)
      return
    }
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'p') {
      event.preventDefault()
      palette.pending = palette.togglePin()
      return
    }
    if ((event.metaKey || event.ctrlKey) && (key === 'Backspace' || key === 'Delete')) {
      event.preventDefault()
      palette.pending = palette.removeSelected()
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="palette" onkeydown={onKeyDown} role="none">
  <input
    bind:this={inputEl}
    class="search"
    data-testid="search"
    type="text"
    role="combobox"
    aria-expanded="true"
    aria-controls="cairn-results"
    aria-activedescendant={activeId}
    aria-label="Search your clipboard history"
    placeholder="Search your clipboard history"
    autocomplete="off"
    spellcheck="false"
    value={palette.query}
    oninput={(event) => (palette.pending = palette.setQuery(event.currentTarget.value))}
  />

  {#if palette.hotkeyStatus === 'failed'}
    <div class="status-row" data-testid="hotkey-status" role="status">
      {hotkeyFailedText(palette.hotkeyAccelerator)}
    </div>
  {/if}
  {#if palette.statusText !== null}
    <div class="status-row" data-testid="status-text" role="status">{palette.statusText}</div>
  {/if}

  <div
    bind:this={listEl}
    id="cairn-results"
    class="results"
    role="listbox"
    aria-label="Clipboard history"
    style="height: {VISIBLE_ROWS * ROW_HEIGHT_PX}px"
    onscroll={(event) => palette.setScrollTop(event.currentTarget.scrollTop)}
  >
    {#if palette.total === 0}
      <div class="empty" data-testid="empty">
        {palette.mode === 'search' ? NO_RESULTS_TEXT : EMPTY_TEXT}
      </div>
    {:else}
      <div class="spacer" data-testid="spacer" style="height: {palette.total * ROW_HEIGHT_PX}px">
        {#each palette.visibleRows as row (row.index)}
          {#if row.item !== null}
            <ItemRow
              item={row.item}
              ranges={row.ranges}
              top={row.top}
              nowMs={palette.nowMs}
              selected={row.index === palette.selectedIndex}
              onpick={() => {
                palette.selectedIndex = row.index
                palette.pending = palette.recall()
              }}
            />
          {:else}
            <div class="row row-placeholder" style="top: {row.top}px; height: {ROW_HEIGHT_PX}px"></div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  <div class="preview-pane">
    <Preview text={palette.previewText} mime={palette.previewMime} {filePaths} />
  </div>

  {#if palette.toast !== null}
    <Toast text={palette.toast.text} tone={palette.toast.tone} />
  {/if}
</div>
```

- [ ] **Step 32: Run them and watch them pass.**

```sh
npx vitest run --project renderer Palette.test
```

Expected: `Tests 13 passed (13)`, and **no** `[vite-plugin-svelte]` warning lines in the output. If
you see `store_rune_conflict`, you named the prop `state`.

- [ ] **Step 33: Prove the virtualisation really is virtualisation.**

```sh
python3 - <<'PY'
p = 'apps/desktop/renderer/src/palette-state.svelte.ts'
s = open(p).read()
s = s.replace("""  const start = Math.max(0, windowStart - OVERSCAN_ROWS)
  const end = Math.max(start, Math.min(total, windowStart + VISIBLE_ROWS + OVERSCAN_ROWS))
  return { start, end }""", """  return { start: 0, end: total }""")
open(p, 'w').write(s)
PY
npx vitest run --project renderer
```

Expected: FAIL, 3 tests, with `AssertionError: expected 32 to be 10` (the component rendered every
loaded row), `AssertionError: expected { start: +0, end: 500 } to deeply equal { start: +0, end: 10 }`
and `AssertionError: expected undefined to be 'item 499'`. Then restore the three lines:

```sh
python3 - <<'PY'
p = 'apps/desktop/renderer/src/palette-state.svelte.ts'
s = open(p).read()
s = s.replace("""  return { start: 0, end: total }""", """  const start = Math.max(0, windowStart - OVERSCAN_ROWS)
  const end = Math.max(start, Math.min(total, windowStart + VISIBLE_ROWS + OVERSCAN_ROWS))
  return { start, end }""")
open(p, 'w').write(s)
PY
npx vitest run --project renderer
```

Expected: `Tests 38 passed (38)` — 19 + 6 + 13.

- [ ] **Step 34: Commit.**

```sh
git add apps/desktop/renderer/src/ItemRow.svelte apps/desktop/renderer/src/Palette.svelte apps/desktop/renderer/src/Palette.test.ts
git commit -m "feat(renderer): ItemRow and the virtualised Palette shell"
```

---

- [ ] **Step 35: Write the end-to-end escaping test, through the whole palette.**

`Preview.security.test.ts` mounts one component in isolation. This one drives the *real* pipeline —
main → IPC → list row → highlight → preview pane — with a payload copied from a hostile page, because
the row and the match-highlighting path are two more places the same mistake could be made.

Create `apps/desktop/renderer/src/Palette.security.test.ts`:

```ts
import { createTestClock } from '@cairn/protocol'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it } from 'vitest'
import Palette from './Palette.svelte'
import { PaletteState } from './palette-state.svelte'
import { createFakeApi, makeItem } from './testing'

// The same control as Preview.security.test.ts, but end to end: a hostile payload copied from a web
// page travels main -> IPC -> list row -> preview pane, through the match-highlighting path too,
// and must arrive as text in every one of them.
const PAYLOAD = '<img src=x onerror="window.cairn.list({limit:1,offset:0,pinnedOnly:false})">'

let host: HTMLDivElement
let app: Record<string, unknown> | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (app !== null) void unmount(app)
  app = null
  host.remove()
  delete (globalThis as Record<string, unknown>).__pwned
})

it('renders a hostile HTML clipboard item as text in the row and in the preview', async () => {
  const item = makeItem(0, { kind: 'richtext', preview: PAYLOAD })
  const fake = createFakeApi({
    items: [item],
    previews: new Map([[item.id, { text: PAYLOAD, isHtmlSource: true, truncated: false }]]),
    searchHitsFor: () => [{ item, score: 1, ranges: [0, 4] }],
  })
  const state = new PaletteState({ api: fake.api, clock: createTestClock() })
  await state.start()
  app = mount(Palette, { target: host, props: { palette: state } }) as Record<string, unknown>
  flushSync()

  expect(host.querySelectorAll('img').length).toBe(0)
  expect(host.querySelector('[data-testid="preview"]')?.textContent).toBe(PAYLOAD)
  expect(host.querySelector('[role="option"]')?.textContent).toContain(PAYLOAD)
  expect(host.querySelector('[data-testid="preview-badge"]')?.textContent?.trim()).toBe('HTML source')

  // The highlight path builds DOM from ufuzzy offsets, so it is a second possible sink.
  await state.setQuery('img')
  flushSync()

  expect(host.querySelector('mark')?.textContent).toBe('<img')
  expect(host.querySelectorAll('img').length).toBe(0)
  expect((globalThis as Record<string, unknown>).__pwned).toBe(undefined)
  // Only the initial list call: nothing in the payload reached the bridge.
  expect(fake.listCalls.length).toBe(1)
  expect(fake.copyCalls).toEqual([])
})
```

- [ ] **Step 36: Run it — and expect it to PASS, then prove it can fail.**

```sh
npx vitest run --project security apps/desktop/renderer/src/Palette.security.test.ts
```

Expected: `Tests 1 passed (1)`. This one is green on first write because the control was implemented
in Steps 24–31; a regression test that has never failed is worthless, so break the control now:

```sh
python3 - <<'PY'
p = 'apps/desktop/renderer/src/Preview.svelte'
s = open(p).read()
s = s.replace('<pre class="preview-body" data-testid="preview">{text}</pre>',
              '<pre class="preview-body" data-testid="preview">{@html text}</pre>')
open(p, 'w').write(s)
PY
npx vitest run --project security apps/desktop/renderer/src/Palette.security.test.ts
git checkout apps/desktop/renderer/src/Preview.svelte
npx vitest run --project security apps/desktop/renderer/src/Palette.security.test.ts
```

Expected: FAIL with `AssertionError: expected 1 to be +0` (the payload became a real `img` element
inside the palette), then `Tests 1 passed (1)` again after the checkout, and `git status --short`
shows no modification to `Preview.svelte`.

- [ ] **Step 37: Commit.**

```sh
git add apps/desktop/renderer/src/Palette.security.test.ts
git commit -m "test(renderer): hostile copied HTML stays text through the whole palette"
```

---

- [ ] **Step 38: Mount the palette — `main.ts`, `app.css`, and the HTML entry point.**

Task 1's `index.html` has a placeholder `<main id="app">Cairn scaffold window</main>` and **no script
tag**, so nothing is mounted yet. The CSP meta tag is unchanged: `default-src 'none'`, no
`unsafe-inline`, `connect-src 'none'`.

Replace `apps/desktop/renderer/index.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <!-- No 'unsafe-inline', no 'unsafe-eval', no remote origin, and connect-src 'none' so this
         window cannot make a network request at all (spec §11 control 1 and 4). -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'"
    />
    <title>Cairn</title>
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Create `apps/desktop/renderer/src/main.ts`:

```ts
import './app.css'
import { mount } from 'svelte'
import Palette from './Palette.svelte'
import { PaletteState } from './palette-state.svelte'

const target = document.getElementById('app')
if (target === null) throw new Error('cairn: index.html is missing its #app mount point')
target.textContent = ''

const state = new PaletteState({
  api: window.cairn,
  // The renderer cannot import `systemClock` from @cairn/protocol (that would drag node:crypto into
  // the bundle), so this is the same two lines, inline. Tests inject createTestClock() instead.
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const handle = window.setTimeout(fn, ms)
      return () => window.clearTimeout(handle)
    },
  },
})

void state.start()
mount(Palette, { target, props: { palette: state } })
```

Create `apps/desktop/renderer/src/app.css`. The `prefers-reduced-transparency` block is a
requirement, not polish: the palette window uses `vibrancy: 'hud'`, and with macOS "Reduce
transparency" enabled AppKit ignores vibrancy entirely, so contrast must never depend on the blur
behind us.

```css
/* Local styling only: no stylesheet imports, no remote font, nothing the CSP would have to allow. */
:root {
  --cairn-row-height: 44px;
  --cairn-bg: rgba(28, 28, 30, 0.72);
  --cairn-bg-opaque: #1c1c1e;
  --cairn-fg: #f2f2f7;
  --cairn-dim: #a1a1a6;
  --cairn-accent: rgba(120, 120, 255, 0.28);
  --cairn-hit: #ffd479;
  --cairn-toast-ms: 160ms;
}

/* With macOS "Reduce transparency" on, AppKit ignores window vibrancy, so contrast must never
   depend on the blur behind us. */
@media (prefers-reduced-transparency: reduce) {
  :root {
    --cairn-bg: var(--cairn-bg-opaque);
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --cairn-toast-ms: 0ms;
  }
}

html,
body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--cairn-fg);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
  overflow: hidden;
}

.palette {
  background: var(--cairn-bg);
  border-radius: 10px;
  padding: 8px;
}

.search {
  width: 100%;
  box-sizing: border-box;
  font-size: 18px;
  padding: 8px 10px;
  color: var(--cairn-fg);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
}

.search:focus {
  outline: 2px solid var(--cairn-accent);
  outline-offset: 1px;
}

.status-row {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255, 214, 121, 0.16);
  color: var(--cairn-fg);
}

.results {
  position: relative;
  overflow-y: auto;
  margin-top: 8px;
}

.spacer {
  position: relative;
}

.row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0 8px;
  box-sizing: border-box;
  border-radius: 6px;
  white-space: nowrap;
  overflow: hidden;
}

.row.selected {
  background: var(--cairn-accent);
}

.row-preview {
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip {
  flex: none;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: var(--cairn-dim);
}

.thumb {
  flex: none;
  border-radius: 3px;
  object-fit: cover;
}

.badge {
  flex: none;
  margin-left: auto;
  font-size: 10px;
  color: var(--cairn-dim);
}

.badge-secret {
  color: var(--cairn-hit);
}

mark {
  background: transparent;
  color: var(--cairn-hit);
  font-weight: 600;
}

.empty {
  padding: 14px 10px;
  color: var(--cairn-dim);
}

.preview-pane {
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding-top: 8px;
  max-height: 132px;
  overflow: auto;
}

.preview-badge {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--cairn-dim);
}

.preview-body {
  margin: 4px 0 0;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.file-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--cairn-bg-opaque);
  border: 1px solid rgba(255, 255, 255, 0.16);
  transition: opacity var(--cairn-toast-ms) ease-out;
}

.toast[data-tone='warn'] {
  border-color: var(--cairn-hit);
}
```

- [ ] **Step 39: Write the static security test — no HTML sink, and a browser-safe bundle.**

Contract §8 assigns `security/no-html-sink.security.test.ts` the `{@html` ban. Two more static
checks live here because they protect the same file set: that renderer product code imports
`@cairn/protocol` **only** as types (otherwise the build dies), and that the CSP and CSS never grow a
remote origin.

Create `security/no-html-sink.security.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, findInSources, formatHits, sourceFiles } from './source-scan'

// Spec §11 control 3, enforced statically. Svelte's raw-HTML directive is the only HTML-injection
// sink the language offers, so banning its token is the whole control: the component tests prove
// today's code escapes, this proves nobody reintroduces the sink tomorrow. The needle appears exactly
// once below, as a string literal, and nowhere in a comment — `.svelte` files are matched RAW by
// source-scan.ts (comment stripping would be a hole in this ban), so a renderer comment that spelled
// the token would fail this test. Describe it in prose there; spell it only here.
const RENDERER = 'apps/desktop/renderer'
const DOM_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'new Function', 'eval(']

const productFiles = (): string[] => sourceFiles([RENDERER]).filter((f) => !f.endsWith('.test.ts'))

describe('the renderer has no HTML sink', () => {
  it('scans a non-empty set of renderer files, so a zero-hit result means something', () => {
    expect(productFiles().length).toBeGreaterThan(4)
    expect(findInSources('$props(', [RENDERER]).length).toBeGreaterThan(0)
  })

  it('contains no {@html anywhere under the renderer', () => {
    expect(formatHits(findInSources('{@html', [RENDERER]))).toBe('')
  })

  it('contains no direct DOM HTML sink in renderer product code', () => {
    // Test files are excluded on purpose: Preview.security.test.ts asserts on `pre.innerHTML`,
    // which is how it proves the payload was escaped.
    const hits: string[] = []
    for (const file of productFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const sink of DOM_SINKS) {
        if (text.includes(sink)) hits.push(`${file}: ${sink}`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('the renderer bundle stays browser-safe', () => {
  it('imports @cairn/protocol only as types, because the barrel pulls node:crypto', () => {
    // `import { x } from '@cairn/protocol'` passes under vitest and then fails the real build with
    // `"createHash" is not exported by "__vite-browser-external"`.
    const offenders: string[] = []
    const statement = /import\s+(type\s+)?\{[^}]*\}\s+from '@cairn\/protocol'/g
    for (const file of productFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(statement)) {
        if (m[1] === undefined) offenders.push(`${file}: ${m[0].replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the index.html CSP free of unsafe-inline and of any remote origin', () => {
    const html = readFileSync(join(REPO_ROOT, RENDERER, 'index.html'), 'utf8')
    // Only the policy itself, never the surrounding comment — otherwise the comment explaining the
    // ban is what trips the assertion.
    const policy = /Content-Security-Policy"[\s\S]*?content="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain('unsafe-inline')
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toContain('http://')
    expect(policy).not.toContain('https://')
    expect(html).toContain('<script type="module" src="/src/main.ts"></script>')
  })

  it('loads no remote font or stylesheet from app.css', () => {
    const css = readFileSync(join(REPO_ROOT, RENDERER, 'src', 'app.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).not.toContain('@import')
    expect(css).not.toContain('url(http')
    expect(css).not.toContain('//fonts.')
  })
})
```

- [ ] **Step 40: Run it and watch it pass, then prove two of its six assertions can fail.**

```sh
npx vitest run --project security security/no-html-sink
```

Expected: `Tests 6 passed (6)`.

```sh
# 1. reintroduce the sink
python3 - <<'PY'
p = 'apps/desktop/renderer/src/Preview.svelte'
s = open(p).read().replace('data-testid="preview">{text}</pre>', 'data-testid="preview">{@html text}</pre>')
open(p, 'w').write(s)
PY
npx vitest run --project security security/no-html-sink
```

Expected: FAIL with
`AssertionError: expected 'apps/desktop/renderer/src/Preview.sve…' to be ''`.

```sh
git checkout apps/desktop/renderer/src/Preview.svelte
# 2. turn a type-only protocol import into a value import
python3 - <<'PY'
p = 'apps/desktop/renderer/src/api.ts'
s = open(p).read().replace(
    "import type { IpcEvent, IpcEventChannel, IpcRequest, ItemSummary, Unsub } from '@cairn/protocol'",
    "import { IpcEvent, IpcEventChannel, IpcRequest, ItemSummary, Unsub } from '@cairn/protocol'")
open(p, 'w').write(s)
PY
npx vitest run --project security security/no-html-sink
```

Expected: FAIL with `AssertionError: expected [ '…/api.ts: import { IpcEvent, …' ] to deeply equal []`.

```sh
git checkout apps/desktop/renderer/src/api.ts
npx vitest run --project security security/no-html-sink
git status --short
```

Expected: `Tests 6 passed (6)` and `git status --short` lists only the untracked files from Step 38.

- [ ] **Step 41: Commit.**

```sh
git add apps/desktop/renderer/index.html apps/desktop/renderer/src/main.ts apps/desktop/renderer/src/app.css security/no-html-sink.security.test.ts
git commit -m "feat(renderer): mount the palette and ban every HTML sink statically"
```

---

- [ ] **Step 42: Run the whole suite, both type-checkers, and the real build.**

The build is not optional here: it is the only thing that proves the bundle has no Node-only import,
and it is what the manual script in Step 43 runs against.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run
npx tsc -p tsconfig.json
npx svelte-check --tsconfig apps/desktop/renderer/tsconfig.json --threshold error
npx electron-vite build
```

Expected, in order:

- every project green, with this task's six files reported as `palette-state.test.ts (19 tests)`,
  `api.test.ts (6 tests)`, `Palette.test.ts (13 tests)`, `Preview.security.test.ts (3 tests)`,
  `Palette.security.test.ts (1 test)` and `no-html-sink.security.test.ts (6 tests)` — 48 tests from
  this task, on top of whatever Tasks 1–9 contribute.
- `tsc` exits 0 with no output.
- `COMPLETED … 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.
- `electron-vite build` prints three sections and finishes, with the renderer reporting roughly
  `114 modules transformed`, an `index.html`, one CSS asset (~2.4 kB) and one JS asset (~50 kB). If it
  instead prints `"createHash" is not exported by "__vite-browser-external"`, a renderer file gained a
  value import of `@cairn/protocol` — Step 39's test names the file.

- [ ] **Step 43: Run the M1 demo by hand, on this machine.**

Everything above runs against fakes. This is the only step that proves the milestone. It needs Tasks
1–9 merged, the Swift agent built, and no TCC grant of any kind (M1 asks for none: NSPasteboard reads,
NSWorkspace attribution and Carbon hotkeys are all permission-free).

Pick a canary string you have never typed before and keep it handy. This script uses
`cairn-manual-canary-77x`.

1. `cd /Users/santoshkumarreddy/copy-clipboard-app && nvm use && npm ci && npm run bootstrap && npm run agent:macos`
   → Expected: `Now using node v24.20.0`, `npm ci` completes, `bootstrap` prints an Electron download
   or is instant if `dist/` exists, and `make` produces
   `agents/macos/build/cairn-agent-macos` (`file` reports `Mach-O 64-bit executable arm64`).
2. `npm run dev`
   → Expected: Electron starts with **no Dock icon** (`LSUIElement`), no window visible, and the
   terminal shows NDJSON log lines including `app.ready` and `hotkey.bound`.
3. In TextEdit, type `cairn-manual-canary-77x` and press `Cmd+C`.
   → Expected: within ~650 ms the dev terminal logs `capture.candidate` then `history.ingested`. No
   preview text appears in any log line — only `kind`, `byteLength` and a hash prefix.
4. Press `Cmd+Shift+4`, drag over part of the screen while holding `Ctrl` (`Cmd+Ctrl+Shift+4`) so the
   screenshot goes to the clipboard.
   → Expected: another `history.ingested`, this time `kind: 'image'`, plus one `capture.thumbnail`.
5. In Finder, select **two** files and press `Cmd+C`.
   → Expected: one more `history.ingested` with `kind: 'files'`.
6. In a browser, select a paragraph with a link in it and press `Cmd+C`.
   → Expected: one more `history.ingested` with `kind: 'richtext'`.
7. Click into TextEdit so it is frontmost, then press `Cmd+Shift+V`.
   → Expected: the palette appears **over** TextEdit, the search field already has the caret (type a
   letter and it lands in the field, not in TextEdit), and the four items are listed newest-first with
   `Rich text`, `Files`, `Image`, `Text` chips.
8. Type `crnmnl` — deliberately out of order and with letters missing.
   → Expected: the canary row survives the filter and the matched letters are highlighted in amber.
9. Press `ArrowDown` until the canary row is selected, then `ArrowUp` past the top.
   → Expected: the selection wraps to the last row rather than sticking, and the preview pane below
   updates to whatever is selected.
10. Select the `richtext` item.
    → Expected: the preview pane shows an `HTML SOURCE` label and the raw tags as **text** —
    `<a href="…">` visible literally. Nothing is bold, nothing is a link, and no image loads.
11. Select the canary row again and press `Enter`.
    → Expected: a toast reading exactly `Copied — press Cmd+V`, the palette closes about two seconds
    later, and TextEdit is frontmost again.
12. Press `Cmd+V` in TextEdit.
    → Expected: `cairn-manual-canary-77x` is pasted. This is the M1 contract: Cairn puts the item on
    the real clipboard, you press the keys.
13. Open 1Password, find any login, and use **Copy Password**.
    → Expected: the dev terminal logs `privacy.skipped` with `flags: ['concealed']` and **no**
    `history.ingested`. Press `Cmd+Shift+V`: the item count is unchanged and the password is nowhere
    in the list. (This is the OS concealed-type hint, read *before* any byte of the pasteboard.)
14. In TextEdit, type an AWS key by hand — `AKIA2E0PQIN4XA7QD` — select it and press `Cmd+C`.
    → Expected: `privacy.masked` with `detectors: ['aws-access-key']`, then `history.ingested` with
    `flags: ['secret']`.
15. Press `Cmd+Shift+V`.
    → Expected: the top row reads `AKIA••••A7QD` — first four characters, four bullets, last four —
    with a `Secret · expires in 5m` badge. The full key appears nowhere on screen.
16. With that row selected, press `Cmd+P`.
    → Expected: a warning toast `Secrets cannot be pinned — this one expires in 5 minutes`, and no
    `history.pinned` line in the log.
17. Press `Escape`, wait five minutes, then press `Cmd+Shift+V` again.
    → Expected: the masked row is gone and the log shows `history.evicted` with
    `reason: 'secret-ttl'`. The 5-minute TTL is spec §11 control 5.
18. Press `Cmd+Shift+V`, then click on any other application.
    → Expected: the palette hides on blur without needing Escape.
19. Quit the app (`Cmd+Q` in the dev process, or `Ctrl+C` in the terminal), then `npm run dev` again
    and press `Cmd+Shift+V`.
    → Expected: the history is still there — text, image, files, rich text — in the same order, with
    thumbnails. The masked AWS row is **not** back.
20. `grep -a 'cairn-manual-canary-77x' -r ~/Library/Application\ Support/Cairn`
    → Expected: **no output**, exit status 1. The store is AES-256-GCM at rest.
21. `grep -a 'AKIA2E0PQIN4XA7QD' -r ~/Library/Application\ Support/Cairn "$TMPDIR"`
    → Expected: **no output**. No spool file, no temp file, no plaintext cache anywhere (spec §11
    control 1).
22. `ls -ld ~/Library/Application\ Support/Cairn && ls -l ~/Library/Application\ Support/Cairn`
    → Expected: `drwx------` on the directory and `-rw-------` on `history.ndjson`, `meta.json` and
    `key.bin`.
23. Turn on System Settings → Accessibility → Display → **Reduce transparency**, then press
    `Cmd+Shift+V`.
    → Expected: the palette is fully opaque dark grey and every label is still legible — no
    washed-out text over a now-solid background. Turn it back off.
24. Prove the dead-hotkey degraded mode two ways — do **not** try to reproduce it by launching a
    second `npm run dev`. Task 9's `index.ts` runs
    `if (!app.requestSingleInstanceLock()) { app.exit(0) }` before it creates a window, a hotkey or a
    renderer, so a second instance just focuses the first one's palette and exits: there is no second
    palette to observe, by design.

    a. Confirm the agent really answers `bound: false` instead of erroring, which is the signal that
    drives the row. With the dev process **stopped** (`Ctrl+C`), run the agent by hand:

    ```sh
    cd /Users/santoshkumarreddy/copy-clipboard-app
    { printf '%s\n' \
      '{"v":1,"t":"req","id":"1","method":"hotkey.register","params":{"accelerator":"Bogus+Nope"}}'
      sleep 2
    } | agents/macos/build/cairn-agent-macos
    ```

    → Expected, on stdout: a log line
    `{"data":{"event":"hotkey.unparseable","fields":{"accelerator":"Bogus+Nope"},"level":"warn"},"event":"log","t":"ev","v":1}`
    (it appears *first* because `Out.log` writes straight to fd 1 while `print` is block-buffered on a
    pipe) and then
    `{"id":"1","ok":true,"result":{"accelerator":"Bogus+Nope","bound":false},"t":"res","v":1}` —
    `ok: true` with `bound: false`, never an error response. That is exactly what makes Task 9 emit
    `cairn:hotkey.status` with `{ status: 'failed', accelerator }`.

    b. Confirm the palette turns that signal into the persistent row, with the renderer test that
    already exists:

    ```sh
    npx vitest run --project renderer -t 'shows the persistent hotkey row only when registration failed'
    ```

    → Expected: `Tests 1 passed | 37 skipped (38)` — the filter runs all three renderer files and
    skips every other test. It emits
    `{ status: 'failed', accelerator: 'Cmd+Shift+V' }` on the real bridge shape and asserts
    `[data-testid="hotkey-status"]` has `role="status"` and text exactly
    `Cmd+Shift+V is not registered — another app already owns it. Try Cmd+Shift+C instead; rebinding
    lives in Settings, which this build does not have yet.`

    c. Finally, `npm run dev` again and confirm the single-instance behaviour itself: in a second
    terminal run `npm run dev` once more → Expected: the second
    process exits immediately (its terminal returns to the prompt, no `hotkey.bound` line) and the
    **first** instance shows the palette, because Task 9's `second-instance` handler calls
    `paletteRef?.show()`. Press `Escape` to hide it.

If any step above disagrees with its expectation, stop and fix it before pushing — every one of them
is a sentence from spec §8 or §11.

- [ ] **Step 44: Push the branch for the user to merge.**

```sh
git push -u origin m1/10-palette-ui
git log --oneline origin/main..
```

Expected: `branch 'm1/10-palette-ui' set up to track 'origin/m1/10-palette-ui'`, and eight commits
listed, none containing a `Co-Authored-By` or any other attribution trailer. Do not merge.

---

**Task 10 done when:**

- [ ] `git branch --show-current` prints `m1/10-palette-ui` and `git log --oneline origin/main..`
      shows 8 commits, none containing `Co-Authored-By`.
- [ ] `npx vitest run --project renderer` prints `Test Files 3 passed (3)` and `Tests 38 passed (38)`.
- [ ] `npx vitest run --project security apps/desktop/renderer` prints `Tests 4 passed (4)`.
- [ ] `npx vitest run --project security security/no-html-sink` prints `Tests 6 passed (6)`.
- [ ] `npx vitest run --project unit security/source-scan.test.ts` prints `Tests 13 passed (13)` — proof
      that the `unit` project's `'security/**/*.test.ts'` include survived this task intact.
- [ ] `git diff origin/main -- vitest.config.ts apps/desktop/renderer/tsconfig.json` is **empty** — this
      task verified both files and rewrote neither. The one exception is Step 2's fallback: if a grep
      there disagreed, the diff shows that repair and nothing else.
- [ ] `grep -n "'security/\*\*/\*.test.ts'" vitest.config.ts` still returns exactly one line, inside
      the `unit` project's `include` array, and `grep -c "conditions: \['browser'\]" vitest.config.ts`
      still prints `2`.
- [ ] `.github/workflows/ci.yml` is UNCHANGED by this task, and its test step is a bare `npm test` —
      verified to run all three vitest projects, and to exit 0 even while one project has no files.
- [ ] `npx tsc -p tsconfig.json` exits 0 with no output, and
      `npx svelte-check --tsconfig apps/desktop/renderer/tsconfig.json --threshold error` prints
      `0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.
- [ ] `npx electron-vite build` succeeds and emits `apps/desktop/out/renderer/index.html` plus one JS
      and one CSS asset; `grep -rc 'createHash' apps/desktop/out/renderer/assets/*.js` finds nothing.
- [ ] `grep -rn '{@html' apps/desktop/renderer` returns nothing, and
      `grep -rn 'innerHTML\|insertAdjacentHTML\|document.write\|new Function' apps/desktop/renderer/src/*.svelte`
      returns nothing.
- [ ] `npx vitest run --project security -t 'escapes an <img onerror> payload to text'` passes, and
      replacing `{text}` with `{@html text}` in `Preview.svelte` makes it fail with
      `AssertionError: expected '' to be '<img src=x onerror="window.__pwned = …'` — reverted.
- [ ] `npx vitest run --project security -t 'renders a hostile HTML clipboard item as text'` passes,
      and the same edit makes it fail with `AssertionError: expected 1 to be +0`.
- [ ] `npx vitest run --project renderer -t 'renders a bounded window of rows for 500 items'` passes:
      500 items produce exactly 10 `[role="option"]` elements and a 22000px spacer.
- [ ] `npx vitest run --project renderer -t 'wraps Down past the last row'` passes, so the
      wrap-around decision is a test rather than a note.
- [ ] `npx vitest run --project renderer -t 'toasts the honest M1 sentence'` passes: `Enter` calls
      `cairn:recall.copy`, the toast text equals `TOAST_COPIED_MANUAL` imported from
      `@cairn/protocol`, and `close()` fires at exactly `TOAST_MS` on the injected clock — not before.
- [ ] `npx vitest run --project renderer -t 'refuses to pin a secret'` passes with zero `pin` IPC
      calls.
- [ ] `npx vitest run --project renderer -t 'never holds more than FETCH_SPAN previews'` passes:
      after jumping to item 499 of 500 the renderer holds ≤ 32 summaries and `rowAt(0)` is `null`.
- [ ] `npx vitest run --project renderer -t 'ignores a malformed event payload'` passes, so a bad
      `cairn:hotkey.status` or over-long `cairn:toast` cannot reach component state.
- [ ] `grep -rn "Date.now()\|setTimeout(" apps/desktop/renderer/src/palette-state.svelte.ts` returns
      nothing — the only clock is the injected one.
- [ ] `grep -rn "console\." apps/desktop/renderer/src` returns nothing.
- [ ] Every step of the Step 43 manual script produced its stated observation, including: the toast
      reading exactly `Copied — press Cmd+V`; the 1Password copy recording nothing; `AKIA••••A7QD`
      shown with `expires in 5m` and gone after five minutes; history intact after quit and relaunch;
      and `grep -a 'cairn-manual-canary-77x' -r ~/Library/Application\ Support/Cairn` printing
      nothing.
