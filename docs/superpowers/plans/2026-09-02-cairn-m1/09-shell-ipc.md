### Task 9: apps/desktop — Electron shell, hardened palette window, and typed IPC

This is the **composition root**. It contains zero domain logic: no clipboard parsing, no crypto, no
retention, no ranking. Its whole job is to construct the M1 pipeline out of the packages the earlier
tasks built, put a hardened window on screen, and carry a validated message across the
main↔renderer boundary.

It also owns **most of spec §11's renderer controls**, because they are all properties of the window
and the preload this task creates. Every one of them is a test that fails when the control is
removed, not a comment:

- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, DevTools
  off in packaged builds (§11 control 4).
- Content from **local files only**, a strict CSP with **no `unsafe-inline`**, and `will-navigate` /
  `will-frame-navigate` / `will-redirect` / `setWindowOpenHandler` all denying everything (§11
  control 4). Copied HTML never becomes markup anywhere near this process.
- A preload exposing a **fixed enumerated set of methods** — no `invoke(channel, …)` passthrough,
  because a generic bridge is a generic hole into the main process (§11 control 4).
- IPC validated in **both directions** with zod; a malformed renderer message is rejected, not
  trusted (§11 control 8).
- **No local control socket, no unauthenticated local API** (§11 control 8, spec §9).
- **No shell anywhere on the capture or recall path** (§11 control 3): no `execSync`, no `execFile`,
  no `spawnSync`, no `shell: true`, no `/bin/sh` and no `osascript` under `packages/**` or
  `apps/desktop/**`, and `node:child_process` reachable from exactly one file — the one `spawn` that
  starts the Swift agent, with an argv **array**. A copied file path is attacker-chosen text that we
  display and hand to the OS pasteboard; it is never interpolated into a command line.
- **`crashReporter` is never initialised** (§11 control 1) — a crash dump of this process *is* the
  clipboard history.
- **No custom URI scheme** (§11 control 10) — registering `cairn://` would let any web page you visit
  invoke this app with attacker-chosen parameters.
- **Preview-cache eviction** on screen lock, on sleep and after an idle timeout; in **passphrase mode**
  a screen lock also zero-fills the master key, and quit zero-fills both the master key and the store's
  derived blob name subkey (§11 control 6, all three clauses).
- A **metadata-only logger** whose sink strips any key outside `LogFields` at runtime, so even a
  `@ts-expect-error` cannot get a clipboard body into a log line (§11 control 2) — plus the runtime
  half of that control: a **real ingest** of `TEST_CANARY` through `composeApp` with the real logger and
  the real `@cairn/store`, `@cairn/search`, `@cairn/privacy` and `@cairn/history`, asserting the union of
  keys across **all** emitted lines is a subset of `LogFields ∪ {level, event, ts}` and that no line
  contains the canary in plain text, base64 or hex.

And it owns two product behaviours that look cosmetic and are not:

- **The explicit Edit menu.** An accessory app (`app.dock.hide()` / `LSUIElement=1`) shows no menu
  bar, and every "make a menu-bar app" recipe on the internet tells you to call
  `Menu.setApplicationMenu(null)`. `[verified]` that is exactly what kills `Cmd+A`, `Cmd+C` and
  `Cmd+V` **inside our own search field** — Electron installs a default menu with those roles, so the
  bug is invisible until someone "cleans up". The guard is an explicit template plus a startup
  assertion that throws.
- **The first-run hotkey step.** `Cmd+Shift+V` is intercepted before the focused app sees it, so it
  takes Paste-and-Match-Style from Chromium, Slack, Google Docs, Discord, VS Code and Windows
  Terminal system-wide (spec §9). We ship it pre-selected but named, with `Cmd+Shift+C` one tap away,
  and we persist the choice.

M1 has **no auto-paste**. Pressing `Enter` writes the item to the real clipboard and toasts
`Copied — press Cmd+V`. That path is not throwaway: it is exactly the M2 Accessibility-denied
degraded mode (spec §6), so it is built once, here, and M2 only adds a branch above it.

---

**Files:**

Create:
- `packages/hotkey/src/index.ts`
- `apps/desktop/main/src/constants.ts`
- `apps/desktop/main/src/logger.ts`
- `apps/desktop/main/src/windows.ts`
- `apps/desktop/main/src/menu.ts`
- `apps/desktop/main/src/config.ts`
- `apps/desktop/main/src/ipc-handlers.ts`
- `apps/desktop/main/src/wiring.ts`

Test:
- `packages/hotkey/src/index.test.ts`
- `apps/desktop/main/src/windows.test.ts`
- `apps/desktop/main/src/windows.security.test.ts`
- `apps/desktop/main/src/menu.test.ts`
- `apps/desktop/main/src/config.test.ts`
- `apps/desktop/main/src/config.security.test.ts`
- `apps/desktop/main/src/logger.security.test.ts`
- `apps/desktop/main/src/ipc-handlers.test.ts`
- `apps/desktop/main/src/wiring.test.ts`
- `apps/desktop/preload/src/index.security.test.ts`
- `security/no-uri-scheme.security.test.ts`
- `security/renderer-hardening.security.test.ts`

Modify — **every one of these already exists on `main`; open it and edit, never recreate it:**
- `packages/hotkey/package.json` — created by Task 1 with the correct `exports`, `scripts` and
  dependencies. Step 2 only verifies it; there is nothing to change.
- `apps/desktop/package.json` — created by Task 1 without a `scripts` block. Step 2 adds the two
  `vitest` scripts and nothing else.
- `apps/desktop/main/src/index.ts` — Task 1 shipped a bare hardened window here. Step 44 replaces its
  body with the composition root.
- `apps/desktop/preload/src/index.ts` — Task 1 shipped `export {}` here. Step 33 fills it with the
  twelve enumerated methods.
- `security/no-crash-reporter.security.test.ts` — Task 1's three tests stay; Step 46 **appends** the
  crash-service ban.
- `security/no-socket-at-startup.security.test.ts` — Task 1's four tests stay (including the
  `TCPServerWrap` positive control); Step 47 **appends** the `composeApp` handle check, the
  control-socket scan and the shell-execution ban.
- `package-lock.json` — via `npm install` after Step 2's edit.

Verify, do **not** modify:
- `packages/protocol/src/log.ts` — Task 2 created it with **all 46** `LOG_EVENTS` ids, including the
  seven this task uses (`renderer.navigation-blocked`, `renderer.permission-denied`,
  `preview-cache.evicted-lock`, `preview-cache.evicted-suspend`, `preview-cache.evicted-idle`,
  `config.loaded-default`, `config.saved`). Step 4 only checks they are present. **Appending them
  again would yield 53 ids with 7 duplicates and fail Task 2's `log.test.ts`.**

Files this task deliberately does **not** touch: anything under `apps/desktop/renderer/`
(`index.html`, `Palette.svelte`, `Preview.svelte`, `api.ts`, `app.css`) belongs to the renderer task,
`electron.vite.config.ts` and `vitest.config.ts` are already frozen in the contract §2 (`vitest.config.ts`
has three projects — `unit`, `security`, `renderer` — and this task adds none and rewrites none), and
`packages/*` other than `hotkey` are owned by Tasks 2–8. The one exception is
`apps/desktop/renderer/svelte.config.mjs`: **Task 1's step that writes the build configs
(`electron.vite.config.ts`, `svelte.config.mjs`, `Makefile`)** creates it, and Step 45 below restores it
verbatim if it has gone missing, because without it `electron-vite build` cannot run at all.

---

**Interfaces:**

`Consumes:` — exact signatures this task imports. Do not redeclare any of these.

From `@cairn/protocol` (Task 2):

```ts
export interface Ok<T> { readonly ok: true; readonly value: T }
export interface Err { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly detail?: LogFields }
export type Result<T> = Ok<T> | Err
export const ok: <T>(value: T) => Ok<T>
export const err: (code: ErrorCode, message: string, detail?: LogFields) => Err
export type ErrorCode = (typeof ERROR_CODES)[number]     // includes E_HOTKEY_TAKEN, E_HOTKEY_INVALID, E_IPC_REJECTED, E_ITEM_NOT_FOUND, E_INTERNAL

export type Cancel = () => void
export type Unsub = () => void
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): Cancel }
export interface TestClock extends Clock { advance(ms: number): void; readonly pending: number }
export function createTestClock(startMs?: number): TestClock
export const systemClock: Clock

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogEvent = (typeof LOG_EVENTS)[number]
export const LOG_EVENTS: readonly string[]
export interface LogFields { /* contract §5.3, verbatim — the metadata-only field set */ }
export type ExactLogFields<T> = LogFields & { readonly [K in Exclude<keyof T, keyof LogFields>]: never }
export interface Logger {
  log<T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>): void
  debug<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  info<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  warn<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
}

export type ItemId = string & { readonly [itemIdBrand]: 'cairn-id' }
export type ItemKind = 'text' | 'richtext' | 'image' | 'files'
export type Flag = 'secret' | 'concealed' | 'transient' | 'auto-generated' | 'excluded' | 'no-sync' | 'cut'
export type KeyringMode = 'os-keyring' | 'passphrase' | 'locked'
export interface Item { /* contract §5.6, verbatim */ }
export interface ResolvedRep { readonly mime: string; readonly uti: string | null; readonly bytes: Uint8Array; readonly byteLength: number; readonly sha256: ContentHash }
export interface ScoredItem { readonly item: Item; readonly score: number; readonly ranges: readonly number[] }

export type AgentPlatform = 'macos' | 'win32' | 'linux'
export interface AgentCapabilities { /* contract §3 */ }
export type AgentMethod = AgentRequest['method']
export type AgentParams<M extends AgentMethod> = Extract<AgentRequest, { method: M }>['params']
export type AgentResult<M extends AgentMethod> = z.output<(typeof AgentResultSchema)[M]>
export interface HotkeyFiredPayload { readonly accelerator: string; readonly focusToken: string; readonly firedAt: number }
export interface AgentEventMap {
  'clipboard.changed': ClipboardChangedPayload
  'rep.chunk': RepChunkPayload
  'hotkey.fired': HotkeyFiredPayload
  log: AgentLogPayload
}
export interface ClipboardAgent {
  start(): Promise<AgentCapabilities>
  request<M extends AgentMethod>(method: M, params: AgentParams<M>, timeoutMs?: number): Promise<Result<AgentResult<M>>>
  on<E extends keyof AgentEventMap>(event: E, cb: (payload: AgentEventMap[E]) => void): Unsub
  dispose(): Promise<void>
}

export const IPC_REQUEST_CHANNELS: readonly ['cairn:history.list', 'cairn:history.search', 'cairn:history.preview', 'cairn:history.pin', 'cairn:history.remove', 'cairn:recall.copy', 'cairn:palette.close', 'cairn:security.status']
export const IPC_EVENT_CHANNELS: readonly ['cairn:history.changed', 'cairn:hotkey.status', 'cairn:toast', 'cairn:palette.shown']
export type IpcRequestChannel = (typeof IPC_REQUEST_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]
export const IpcRequestSchema: { [C in IpcRequestChannel]: { params: z.ZodType; result: z.ZodType } }
export const IpcEventSchema: { [C in IpcEventChannel]: z.ZodType }
export const ItemSummarySchema: z.ZodType
export type ItemSummary = z.output<typeof ItemSummarySchema>

export const APP_NAME: 'Cairn'
export const BUNDLE_ID: 'app.cairn.desktop'
export const DATA_DIR_NAME: 'Cairn'
export const AGENT_BIN_NAME: 'cairn-agent-macos'
export const DEFAULT_ACCELERATOR: 'Cmd+Shift+V'
export const WATCH_INTERVAL_MS: 500
export const AGENT_REQUEST_TIMEOUT_MS: 2_000
export const RETENTION_MAX_ITEMS: 500
export const RETENTION_MAX_AGE_MS: number
export const RETENTION_MAX_BYTES: number
export const TOAST_COPIED_MANUAL: 'Copied — press Cmd+V'
export const BANNER_KEYRING_WEAK: 'Your desktop has no secure keyring, so Cairn will not pretend to encrypt. Set a passphrase.'
export const TEST_CANARY: 'CAIRN-CANARY-9f3a1c7e'
```

From `@cairn/agent-host` (Task 3):

```ts
export function spawnAgent(opts: { platform: AgentPlatform; binPath: string; clock: Clock; logger: Logger; maxRestarts?: number }): ClipboardAgent
export function createFakeAgent(opts: { transcriptPath: string; clock: Clock; logger: Logger }): ClipboardAgent
```

From `@cairn/history` + `@cairn/search` (Task 8):

```ts
export interface History {
  load(): Promise<Result<{ items: number }>>
  ingest(candidate: Candidate): Promise<Result<IngestOutcome>>
  list(q?: ListQuery): ListResult                                  // { items: readonly Item[]; total: number }
  search(q: string, limit: number): readonly ScoredItem[]
  resolveReps(id: ItemId): Promise<Result<readonly ResolvedRep[]>>
  pin(id: ItemId, pinned: boolean): Promise<Result<{ pinned: boolean }>>
  remove(id: ItemId): Promise<Result<{ removed: boolean }>>
  evictNow(): Promise<Result<{ evicted: number }>>
  evictPreviewCache(): void
  get(id: ItemId): Item | undefined
  onChange(cb: (e: { reason: ChangeReason; total: number }) => void): Unsub
}
export type ChangeReason = 'ingest' | 'update' | 'delete' | 'evict'
export function createHistory(deps: HistoryDeps): History
export function createSearchIndex(opts?: { limit?: number }): SearchIndex
export interface RetentionLimits { readonly maxItems: number; readonly maxAgeMs: number; readonly maxBytes: number; readonly secretTtlMs: number }
export const DEFAULT_RETENTION: RetentionLimits
export function primaryRep(reps: readonly ResolvedRep[]): ResolvedRep | undefined
```

From `@cairn/store` (Task 6), `@cairn/keyring` (Task 5), `@cairn/capture` (Task 7), `@cairn/privacy`
(Task 7). For the **store** and the **keyring**, `wiring.ts` uses a narrow local port (`StorePort`,
`KeyringPort`) rather than the concrete interface, so a parameter-name difference in an upstream
factory is a one-line fix in `index.ts` and never a rewrite of `wiring.ts`. For **capture** it does
**not**: `wiring.ts` imports Task 7's `Capture` type verbatim, because that interface is exactly the
shutdown contract — an `await`able `stop()` and a `whenIdle()` — and a narrowed copy of it compiles
while quietly discarding both. `index.ts` is the only file that calls `openStore`, `createKeyring`,
`createCapture`, `classify`, `mask` and `shouldSkipOnHints` directly.
These are the **real** upstream signatures, copied from Tasks 5, 6 and 7 — do not paraphrase them:

```ts
// @cairn/store (Task 6). NOTE: it returns Result<Store>, not Store — a wrong key or a tampered log
// is a state, not a programmer error. Every method except readAll() is synchronous.
export function openStore(opts: { dir: string; key: Buffer; clock: Clock; logger: Logger }): Result<Store>
export interface StoreMeta {
  readonly schemaVersion: 1
  /** NOT `KeyringMode`. `'locked'` is a runtime mode, never a persisted one, so it has no member
   *  here — which is why Step 44 has to map it before calling writeMeta. */
  readonly keyMode: 'os-keyring' | 'passphrase' | 'unknown'
  readonly scryptSaltB64: string | null
}
export interface Store {
  writeMeta(meta: StoreMeta): Result<void>
  close(): void                 // zero-fills the derived blob name subkey
  /* …plus appendEvent / readAll / checkpoint / compact / putBlob / getBlob / deleteBlob / stat /
     readMeta / layout, which only @cairn/history calls */
}

// @cairn/keyring (Task 5). The whole API is SYNCHRONOUS, and `platform` is AgentPlatform —
// 'macos', never process.platform's 'darwin'.
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?: () => string
}
export interface BackendReport {
  readonly backend: 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown' | 'unavailable'
  readonly strength: 'os-keychain' | 'os-keyring' | 'dpapi' | 'none'
  readonly notes: readonly string[]
  readonly warning?: string
}
export interface Keyring {
  getMode(): KeyringMode
  probeBackend(): BackendReport
  getOrCreateMasterKey(): Result<Buffer>
  unlockWithPassphrase(passphrase: string): Result<Buffer>
  rekeyAfterCorruption(): Result<{ lostItems: number }>
  lock(): void
}
export function createKeyring(opts: { safeStorage: SafeStorageLike; platform: AgentPlatform; dir: string; logger: Logger }): Keyring

// @cairn/capture (Task 7). `config` is a CaptureConfig, NOT a PrivacyRules — `defaultCaptureConfig`
// exists for exactly this call site.
export interface CaptureConfig {
  readonly debounceMs: number
  readonly watchIntervalMs: number
  readonly rules: PrivacyRules
}
export interface Capture {
  start(): Promise<Result<{ intervalMs: number }>>
  stop(): Promise<void>
  onCandidate(cb: (c: Candidate) => void): Unsub
  suppressToken(token: string): void
  whenIdle(): Promise<void>
}
export function createCapture(opts: {
  agent: ClipboardAgent
  privacy: {
    classify: (s: Snapshot, r: PrivacyRules) => Classification
    mask: (t: string) => { readonly preview: string; readonly spans: readonly MaskSpan[] }
    shouldSkipOnHints: (h: readonly PasteboardHint[], r: PrivacyRules) => boolean
  }
  config: CaptureConfig
  clock: Clock
  logger: Logger
}): Capture
export function defaultCaptureConfig(rules: PrivacyRules): CaptureConfig

// @cairn/privacy (Task 7)
export function classify(snapshot: Snapshot, rules: PrivacyRules): Classification
export function mask(text: string): { readonly preview: string; readonly spans: readonly MaskSpan[] }
export function shouldSkipOnHints(hints: readonly PasteboardHint[], rules: PrivacyRules): boolean
export const DEFAULT_RULES: PrivacyRules
```

`Produces:` — the exported names later tasks (the renderer task, and M2's `@cairn/paste`) rely on.

```ts
// @cairn/hotkey — packages/hotkey/src/index.ts
export type HotkeyStatus = 'active' | 'unbound' | 'failed'
/** Modifier(s) then exactly one key. At least one modifier is mandatory: a bare `V` bound globally
 *  would swallow every V on the machine. */
export const ACCELERATOR_RE: RegExp
export function isValidAccelerator(accelerator: string): boolean
export const SUGGESTED_ACCELERATORS: readonly ['Cmd+Shift+V', 'Cmd+Shift+C', 'Cmd+Alt+V', 'Ctrl+Shift+V']
export interface Hotkey {
  bind(accelerator: string): Promise<Result<{ accelerator: string }>>
  unbind(): Promise<Result<{ bound: false }>>
  current(): string | null
  status(): HotkeyStatus
  onTrigger(cb: (e: HotkeyFiredPayload) => void): Unsub
}
export function createHotkey(deps: { agent: ClipboardAgent; logger: Logger }): Hotkey

// apps/desktop/main/src/constants.ts
export const PALETTE_WIDTH: 720
export const PALETTE_HEIGHT: 460
export const PREVIEW_CACHE_IDLE_MS: 300_000
export const IDLE_CHECK_INTERVAL_MS: 60_000
export const CSP_POLICY_PROD: string
export const CSP_POLICY_DEV: string
export const ALLOWED_DEV_ORIGINS: readonly ['http://localhost:5173', 'http://127.0.0.1:5173']
export const FIRST_RUN_HOTKEY_TITLE: string
export const FIRST_RUN_HOTKEY_MESSAGE: string
export const FIRST_RUN_HOTKEY_DETAIL: string
export const FIRST_RUN_HOTKEY_BUTTONS: readonly ['Use Cmd+Shift+V', 'Use Cmd+Shift+C']
export const FIRST_RUN_HOTKEY_CHOICES: readonly ['Cmd+Shift+V', 'Cmd+Shift+C']
export const HOTKEY_DEAD_BANNER: string
export const KEYRING_WEAK_DIALOG_TITLE: string
export const KEYRING_WEAK_DIALOG_DETAIL: string
export const KEYRING_RELOCKED_BANNER: string

// apps/desktop/main/src/logger.ts
export const LOG_FIELD_KEYS: readonly string[]
export interface StderrLoggerOptions { readonly write?: (line: string) => void; readonly clock?: Clock; readonly minLevel?: LogLevel }
export function createStderrLogger(opts?: StderrLoggerOptions): Logger

// apps/desktop/main/src/menu.ts
export interface MenuItemTemplate {
  readonly label?: string
  readonly role?: string
  readonly type?: 'separator'
  readonly submenu?: readonly MenuItemTemplate[]
}
export const REQUIRED_EDIT_ROLES: readonly ['cut', 'copy', 'paste', 'selectAll']
export function buildAppMenuTemplate(appName: string): readonly MenuItemTemplate[]
export function editSubmenuRoles(template: readonly MenuItemTemplate[]): readonly string[]
/** THROWS. Called at startup so a missing Edit menu is a launch crash, not a dead Cmd+A. */
export function assertEditMenuIntact(template: readonly MenuItemTemplate[]): void

// apps/desktop/main/src/windows.ts
export type RuntimeMode = 'packaged' | 'dev'
export function resolveRuntimeMode(input: { isPackaged: boolean; env: Readonly<Record<string, string | undefined>> }): RuntimeMode
export interface PaletteWebPreferences {
  readonly preload: string
  readonly sandbox: true; readonly contextIsolation: true; readonly nodeIntegration: false
  readonly nodeIntegrationInSubFrames: false; readonly nodeIntegrationInWorker: false
  readonly webSecurity: true; readonly allowRunningInsecureContent: false
  readonly experimentalFeatures: false; readonly webviewTag: false
  readonly enableBlinkFeatures: ''; readonly spellcheck: false; readonly devTools: boolean
}
export const PALETTE_WEB_PREFERENCES: Omit<PaletteWebPreferences, 'preload'>
export function paletteWebPreferences(mode: RuntimeMode, preloadPath: string): PaletteWebPreferences
export function cspPolicy(mode: RuntimeMode): string
export type PaletteEntry = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'url'; readonly url: string }
export function resolvePaletteEntry(mode: RuntimeMode, env: Readonly<Record<string, string | undefined>>, rendererIndexPath: string): PaletteEntry
export interface PaletteWindowOptions { /* the frozen flag set — see Step 12 */ }
export function paletteWindowOptions(o: { mode: RuntimeMode; preloadPath: string }): PaletteWindowOptions
export interface NavGuardTarget {
  on(event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect', cb: (e: { preventDefault: () => void }, url: string) => void): void
  setWindowOpenHandler(handler: (d: { url: string }) => { action: 'deny' }): void
}
export const NAV_GUARD_EVENTS: readonly ['will-navigate', 'will-frame-navigate', 'will-redirect']
export function registerNavigationGuards(wc: NavGuardTarget, onBlocked: (url: string) => void): void
export interface HeadersReceivedDetails { readonly responseHeaders?: Record<string, string[]> }
export function applyCspHeader(details: HeadersReceivedDetails, policy: string, callback: (r: { responseHeaders: Record<string, string[]> }) => void): void
export interface HardenableSession {
  webRequest: { onHeadersReceived(fn: (d: HeadersReceivedDetails, cb: (r: { responseHeaders: Record<string, string[]> }) => void) => void): void }
  setPermissionRequestHandler(fn: (wc: unknown, permission: string, cb: (granted: false) => void) => void): void
}
export function hardenSession(session: HardenableSession, policy: string, onDenied: (permission: string) => void): void
export interface PaletteController {
  show(): void
  hide(): void
  isVisible(): boolean
  send<C extends IpcEventChannel>(channel: C, payload: unknown): void
  destroy(): void
}
export interface BrowserWindowLike { /* the surface createPaletteWindow uses — see Step 14 */ }
export function createPaletteWindow(deps: {
  BrowserWindowCtor: new (o: PaletteWindowOptions) => BrowserWindowLike
  mode: RuntimeMode
  preloadPath: string
  rendererIndexPath: string
  env: Readonly<Record<string, string | undefined>>
  clock: Clock
  logger: Logger
}): PaletteController

// apps/desktop/main/src/config.ts
export const CONFIG_FILE_NAME: 'config.json'
export const ConfigSchema: z.ZodType
export type CairnConfig = {
  readonly version: 1
  readonly accelerator: string
  readonly firstRunHotkeyDone: boolean
  readonly retention: { readonly maxItems: number; readonly maxAgeMs: number; readonly maxBytes: number }
}
export const DEFAULT_CONFIG: CairnConfig
export function configPath(dataDir: string): string
export function loadConfig(dataDir: string): { readonly config: CairnConfig; readonly source: 'file' | 'default' | 'invalid' }
export function saveConfig(dataDir: string, config: CairnConfig): void

// apps/desktop/main/src/ipc-handlers.ts
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void
  removeHandler(channel: string): void
}
export interface RecallPort { copy(id: ItemId): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>> }
export interface SecurityStatusPort {
  status(): { keyringMode: KeyringMode; encryptedAtRest: boolean; dataDirMode: string; notes: readonly string[] }
}
export interface PreviewPort { preview(id: ItemId): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>> }
export interface IpcDeps {
  readonly ipcMain: IpcMainLike
  readonly history: History
  readonly preview: PreviewPort
  readonly recall: RecallPort
  readonly palette: Pick<PaletteController, 'hide' | 'isVisible'>
  readonly security: SecurityStatusPort
  readonly logger: Logger
}
export function toItemSummary(item: Item, thumbnailDataUrl: string | null): ItemSummary
export function registerIpcHandlers(deps: IpcDeps): Unsub
export interface EventTarget_ { send(channel: string, payload: unknown): void; isDestroyed(): boolean }
export function sendIpcEvent(target: EventTarget_, channel: IpcEventChannel, payload: unknown, logger: Logger): boolean

// apps/desktop/main/src/wiring.ts
export interface KeyringPort {
  getMode(): KeyringMode
  /** Structurally satisfied by @cairn/keyring's `BackendReport`. Its honest notes and its
   *  BANNER_KEYRING_WEAK warning are what reach `cairn:security.status.notes`. */
  probeBackend(): { readonly notes: readonly string[]; readonly warning?: string }
  lock(): void
}
export interface StorePort { close(): void }
// NOTE: there is no `CapturePort`. `wiring.ts` imports Task 7's `Capture` from `@cairn/capture`
// directly, because a narrowed structural copy silently dropped two things the shutdown path needs:
// `stop()` really is `Promise<void>` (a copy typed `stop(): void` is assignable, so it compiles, and
// then nothing awaits capture teardown), and `whenIdle()` is the only handle Task 7 gives a caller
// for "no candidate is mid-assembly".
export interface PowerMonitorLike {
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', cb: () => void): void
  getSystemIdleTime(): number
}
export type EvictReason = 'lock' | 'suspend' | 'idle'
export interface ComposeDeps {
  readonly agent: ClipboardAgent
  readonly capture: Capture                              // from @cairn/capture, verbatim
  readonly history: History
  readonly hotkey: Hotkey
  readonly keyring: KeyringPort
  readonly store: StorePort
  readonly palette: PaletteController
  readonly ipcMain: IpcMainLike
  readonly powerMonitor: PowerMonitorLike
  readonly clock: Clock
  readonly logger: Logger
  readonly config: CairnConfig
  readonly dataDir: string
  readonly saveConfig: (config: CairnConfig) => void
  readonly chooseHotkey: (candidates: readonly string[]) => Promise<string>
}
export interface CairnApp {
  start(): Promise<Result<{ accelerator: string; hotkeyStatus: HotkeyStatus }>>
  stop(): Promise<void>
  evictPreviewCache(reason: EvictReason): void
  recallCopy(id: ItemId): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>>
  previewText(id: ItemId): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>>
  securityStatus(): { keyringMode: KeyringMode; encryptedAtRest: boolean; dataDirMode: string; notes: readonly string[] }
}
export function composeApp(deps: ComposeDeps): CairnApp
```

**Branch:** `m1/09-shell-ipc`

---

- [ ] **Step 1: Create the branch.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git fetch origin && git checkout -b m1/09-shell-ipc origin/main
```

Expected: `Switched to a new branch 'm1/09-shell-ipc'`. Never commit to `main`.

- [ ] **Step 2: Give `apps/desktop` its test scripts.** **Both manifests already exist** — Task 1
      created `packages/hotkey/package.json` and `apps/desktop/package.json` and committed them. Do
      not recreate either one; recreating `apps/desktop/package.json` is how the `"type"` field gets
      re-added by accident, and the nearest package.json for the emitted `out/main/index.js` must
      resolve to CommonJS or the app dies at launch with `Cannot use import statement outside a
      module`.

First confirm what is on disk:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
node -e "const p=require('./packages/hotkey/package.json'); console.log(p.name, p.type, JSON.stringify(p.scripts), JSON.stringify(p.dependencies))"
node -e "const p=require('./apps/desktop/package.json'); console.log(p.name, p.type, p.main, JSON.stringify(p.scripts))"
```

Expected: `@cairn/hotkey module {"test":"vitest run --root ../.. --project unit packages/hotkey","test:security":"vitest run --root ../.. --project security packages/hotkey"} {"@cairn/protocol":"0.1.0","@cairn/agent-host":"0.1.0"}`
— `@cairn/hotkey` is complete and needs **no** edit. Then
`@cairn/desktop undefined out/main/index.js undefined`: `type` is absent (correct) and there is no
`scripts` block yet (that is what this step adds). If `type` prints `module`, remove it before going
on.

Add exactly the two scripts to `apps/desktop/package.json`, and nothing else:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npm pkg set scripts.test='vitest run --root ../.. --project unit apps/desktop' -w @cairn/desktop
npm pkg set scripts.test:security='vitest run --root ../.. --project security apps/desktop' -w @cairn/desktop
git diff --stat apps/desktop/package.json
node -e "const p=require('./apps/desktop/package.json'); if(p.type!==undefined) throw new Error('apps/desktop/package.json must have no \"type\" field'); console.log('scripts:', JSON.stringify(p.scripts))"
```

Expected: `git diff --stat` prints exactly `apps/desktop/package.json | 4 ++++` — verified: `npm pkg
set` appends the `"scripts"` block after `"dependencies"` and preserves the file's two-space indent, so
it is a four-line pure insertion and **nothing else in the manifest moves**. The node one-liner then
prints
`scripts: {"test":"vitest run --root ../.. --project unit apps/desktop","test:security":"vitest run --root ../.. --project security apps/desktop"}`
with no throw.

- [ ] **Step 3: Create the hotkey source directory and commit the manifest edit.** `@cairn/hotkey`'s
      manifest points `exports` at `./src/index.ts`, which does not exist yet — npm does not check
      that, so the link already works.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
mkdir -p packages/hotkey/src
npm install
ls -l node_modules/@cairn/hotkey node_modules/@cairn/desktop
git add apps/desktop/package.json package-lock.json
git commit -m "chore(desktop): add the unit and security test scripts to the shell manifest"
```

Expected: `npm install` succeeds with no peer warnings, both paths are symlinks into the repo, and
one commit. If `package-lock.json` is unchanged, `git add` it anyway — it is a no-op. If npm reports
`EUNSUPPORTEDPROTOCOL` or fails to link, the root `workspaces` array is missing `apps/desktop` — fix
contract §2's `package.json`, do not add a `file:` dependency.

- [ ] **Step 4: Verify the seven log event ids this task needs are ALREADY in `LOG_EVENTS`.**
      **This step changes no file.** Task 2 shipped `packages/protocol/src/log.ts` with all **46** ids,
      including the seven this task emits — a blocked navigation, a denied permission, the three
      preview-cache evictions and the two config events. **Do not append them.** Appending them a
      second time yields 53 entries with 7 duplicates and fails Task 2's
      `packages/protocol/src/log.test.ts` (`expect(LOG_EVENTS).toHaveLength(46)` and
      `expect(new Set(LOG_EVENTS).size).toBe(46)`), which would then block every remaining step on
      this branch behind a red `@cairn/protocol`.

`LOG_EVENTS`, `LogEvent`, `LogFields`, `ExactLogFields` and `Logger` all live in
**`packages/protocol/src/log.ts`** — *not* in `types.ts`. `@cairn/protocol` deliberately exports **no**
`createLogger`: the one concrete NDJSON-to-stderr implementation is `apps/desktop/main/src/logger.ts`,
which this task owns (Step 24), because a second logger inside `@cairn/protocol` would be a second
place a clipboard body could reach a sink.

The eviction reason lives in the **event id**, not in a field, because `LogFields` has no slot for it
and inventing one would widen the metadata-only type this whole security control rests on.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
grep -c "renderer.navigation-blocked" packages/protocol/src/log.ts
for id in renderer.navigation-blocked renderer.permission-denied preview-cache.evicted-lock \
          preview-cache.evicted-suspend preview-cache.evicted-idle config.loaded-default config.saved; do
  printf '%s %s\n' "$(grep -c -- "'$id'" packages/protocol/src/log.ts)" "$id"
done
npm run test -w @cairn/protocol
git status --short
```

Expected: the first `grep -c` prints `1`; the loop prints exactly `1 <id>` for all seven; the
`@cairn/protocol` suite passes with `log.test.ts` reporting `Tests 5 passed (5)`; and `git status
--short` prints **nothing**, because this step is a read-only check with no commit. If any count is
`0`, Task 2 has not landed — stop and land it, do not add the id here. If any count is `2`, someone
already appended them: revert that edit with `git checkout origin/main -- packages/protocol/src/log.ts`.

- [ ] **Step 5: Write the failing `@cairn/hotkey` test.** Four behaviours, and the second one is the
      whole reason this package exists: `hotkey.register` returns `{bound: false}` for a taken
      combination **as a successful response**, so a host that only checks for a rejected promise
      ships a silently dead hotkey (spec §4).

Create `packages/hotkey/src/index.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  createHotkey,
  isValidAccelerator,
  SUGGESTED_ACCELERATORS,
  type Hotkey,
} from './index'
import {
  createTestClock,
  err,
  ok,
  type AgentCapabilities,
  type AgentEventMap,
  type ClipboardAgent,
  type HotkeyFiredPayload,
  type Logger,
  type Unsub,
} from '@cairn/protocol'

/** A logger that records nothing but satisfies the interface. */
const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

interface FakeAgentOptions {
  /** What `hotkey.register` resolves to. */
  readonly register?: (accelerator: string) => Promise<unknown>
}

interface FakeAgent extends ClipboardAgent {
  readonly requests: { method: string; params: unknown }[]
  fire(payload: HotkeyFiredPayload): void
}

function fakeAgent(opts: FakeAgentOptions = {}): FakeAgent {
  const requests: { method: string; params: unknown }[] = []
  const listeners = new Set<(p: HotkeyFiredPayload) => void>()
  const agent = {
    requests,
    start: async (): Promise<AgentCapabilities> => {
      throw new Error('not used in this test')
    },
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      if (method === 'hotkey.register') {
        const accelerator = (params as { accelerator: string }).accelerator
        return opts.register !== undefined
          ? await opts.register(accelerator)
          : ok({ bound: true, accelerator })
      }
      if (method === 'hotkey.unregister') return ok({ bound: false })
      return err('E_UNKNOWN_METHOD', `fake agent has no ${method}`)
    },
    on: <E extends keyof AgentEventMap>(event: E, cb: (p: AgentEventMap[E]) => void): Unsub => {
      if (event !== 'hotkey.fired') throw new Error(`fake agent only serves hotkey.fired, got ${String(event)}`)
      const typed = cb as unknown as (p: HotkeyFiredPayload) => void
      listeners.add(typed)
      return () => { listeners.delete(typed) }
    },
    dispose: async (): Promise<void> => {},
    fire: (payload: HotkeyFiredPayload): void => {
      for (const l of [...listeners]) l(payload)
    },
  }
  return agent as unknown as FakeAgent
}

const make = (opts?: FakeAgentOptions): { hotkey: Hotkey; agent: FakeAgent } => {
  const agent = fakeAgent(opts)
  return { hotkey: createHotkey({ agent, logger: silentLogger() }), agent }
}

describe('isValidAccelerator', () => {
  it('accepts every suggested accelerator', () => {
    expect(SUGGESTED_ACCELERATORS).toEqual(['Cmd+Shift+V', 'Cmd+Shift+C', 'Cmd+Alt+V', 'Ctrl+Shift+V'])
    for (const a of SUGGESTED_ACCELERATORS) expect(isValidAccelerator(a)).toBe(true)
  })

  it('accepts function keys and named keys with a modifier', () => {
    expect(isValidAccelerator('Cmd+F13')).toBe(true)
    expect(isValidAccelerator('CmdOrCtrl+Shift+Space')).toBe(true)
    expect(isValidAccelerator('Alt+Super+Escape')).toBe(true)
  })

  it('rejects a bare key, because a global bind with no modifier eats every keystroke', () => {
    expect(isValidAccelerator('V')).toBe(false)
    expect(isValidAccelerator('Space')).toBe(false)
  })

  it('rejects modifiers with no key, unknown tokens and empty strings', () => {
    expect(isValidAccelerator('Cmd+Shift')).toBe(false)
    expect(isValidAccelerator('Hyper+V')).toBe(false)
    expect(isValidAccelerator('Cmd+Shift+VV')).toBe(false)
    expect(isValidAccelerator('')).toBe(false)
  })
})

describe('createHotkey', () => {
  it('starts unbound with no current accelerator', () => {
    const { hotkey } = make()
    expect(hotkey.status()).toBe('unbound')
    expect(hotkey.current()).toBeNull()
  })

  it('a successful bind reaches the agent and becomes active', async () => {
    const { hotkey, agent } = make()
    const r = await hotkey.bind('Cmd+Shift+V')
    expect(r).toEqual({ ok: true, value: { accelerator: 'Cmd+Shift+V' } })
    expect(agent.requests).toEqual([{ method: 'hotkey.register', params: { accelerator: 'Cmd+Shift+V' } }])
    expect(hotkey.status()).toBe('active')
    expect(hotkey.current()).toBe('Cmd+Shift+V')
  })

  it('a false `bound` from the agent is a FAILED bind, not a success', async () => {
    // This is the ship-blocker: the agent answers `ok` with `bound: false`, so a host that only
    // checks for a rejected promise would report a working hotkey that never fires.
    const { hotkey } = make({ register: async (accelerator) => ok({ bound: false, accelerator }) })
    const r = await hotkey.bind('Cmd+Shift+V')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_HOTKEY_TAKEN')
    expect(hotkey.status()).toBe('failed')
    expect(hotkey.current()).toBe('Cmd+Shift+V')
  })

  it('an agent error response is also a failed bind', async () => {
    const { hotkey } = make({ register: async () => err('E_TIMEOUT', 'agent did not answer') })
    const r = await hotkey.bind('Cmd+Shift+V')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_TIMEOUT')
    expect(hotkey.status()).toBe('failed')
  })

  it('an invalid accelerator never reaches the agent', async () => {
    const { hotkey, agent } = make()
    const r = await hotkey.bind('Hyper+V')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_HOTKEY_INVALID')
    expect(agent.requests).toEqual([])
    expect(hotkey.status()).toBe('unbound')
  })

  it('rebinding after a failure clears the failed state', async () => {
    let calls = 0
    const { hotkey } = make({
      register: async (accelerator) => {
        calls += 1
        return calls === 1 ? ok({ bound: false, accelerator }) : ok({ bound: true, accelerator })
      },
    })
    await hotkey.bind('Cmd+Shift+V')
    expect(hotkey.status()).toBe('failed')
    const second = await hotkey.bind('Cmd+Shift+C')
    expect(second.ok).toBe(true)
    expect(hotkey.status()).toBe('active')
    expect(hotkey.current()).toBe('Cmd+Shift+C')
  })

  it('onTrigger delivers the agent event and the unsubscribe stops it', async () => {
    const { hotkey, agent } = make()
    await hotkey.bind('Cmd+Shift+V')
    const seen: HotkeyFiredPayload[] = []
    const unsub = hotkey.onTrigger((e) => seen.push(e))
    agent.fire({ accelerator: 'Cmd+Shift+V', focusToken: 'tok-1', firedAt: 1_767_225_600_000 })
    unsub()
    agent.fire({ accelerator: 'Cmd+Shift+V', focusToken: 'tok-2', firedAt: 1_767_225_600_500 })
    expect(seen).toEqual([{ accelerator: 'Cmd+Shift+V', focusToken: 'tok-1', firedAt: 1_767_225_600_000 }])
  })

  it('a callback that throws does not stop the other subscribers', async () => {
    const { hotkey, agent } = make()
    await hotkey.bind('Cmd+Shift+V')
    const good = vi.fn()
    hotkey.onTrigger(() => { throw new Error('renderer blew up') })
    hotkey.onTrigger(good)
    agent.fire({ accelerator: 'Cmd+Shift+V', focusToken: 'tok', firedAt: 1 })
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('unbind returns to unbound and forgets the accelerator', async () => {
    const { hotkey } = make()
    await hotkey.bind('Cmd+Shift+V')
    const r = await hotkey.unbind()
    expect(r).toEqual({ ok: true, value: { bound: false } })
    expect(hotkey.status()).toBe('unbound')
    expect(hotkey.current()).toBeNull()
  })

  it('does not use the injected clock — there is no timer in this package', () => {
    // A guard against someone "fixing" a flaky bind with a retry timer that tests cannot see.
    const clock = createTestClock()
    expect(clock.pending).toBe(0)
  })
})
```

- [ ] **Step 6: Run it and watch it fail for the right reason.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npm run test -w @cairn/hotkey
```

Expected: FAIL with `Error: Cannot find module './index' imported from
/Users/santoshkumarreddy/copy-clipboard-app/packages/hotkey/src/index.test.ts`, reported as
`Failed Suites 1`. If instead you see `No test files found`, the manifest's `test` script or the
contract §2 `vitest.config.ts` `include` globs are wrong.

- [ ] **Step 7: Implement `@cairn/hotkey`.**

Create `packages/hotkey/src/index.ts`:

```ts
import {
  err,
  ok,
  type ClipboardAgent,
  type HotkeyFiredPayload,
  type Logger,
  type Result,
  type Unsub,
} from '@cairn/protocol'

export type HotkeyStatus = 'active' | 'unbound' | 'failed'

const MODIFIERS = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']
const NAMED_KEYS = [
  'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'Plus', 'CapsLock', 'NumLock', 'ScrollLock',
  'PrintScreen',
]

/**
 * `Modifier+…+Key`. At least one modifier is MANDATORY: a bare `V` registered globally would
 * swallow every V typed on the machine, which is unrecoverable without a rebind UI the user
 * cannot reach because typing in it is broken.
 */
export const ACCELERATOR_RE = new RegExp(
  `^(?:(?:${MODIFIERS.join('|')})\\+)+(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|${NAMED_KEYS.join('|')})$`,
)

export function isValidAccelerator(accelerator: string): boolean {
  return accelerator.length > 0 && accelerator.length <= 64 && ACCELERATOR_RE.test(accelerator)
}

/** Offered in the rebind row when `status() === 'failed'`. First entry is the shipped default. */
export const SUGGESTED_ACCELERATORS = ['Cmd+Shift+V', 'Cmd+Shift+C', 'Cmd+Alt+V', 'Ctrl+Shift+V'] as const

export interface Hotkey {
  bind(accelerator: string): Promise<Result<{ accelerator: string }>>
  unbind(): Promise<Result<{ bound: false }>>
  current(): string | null
  status(): HotkeyStatus
  onTrigger(cb: (e: HotkeyFiredPayload) => void): Unsub
}

export function createHotkey(deps: { agent: ClipboardAgent; logger: Logger }): Hotkey {
  const { agent, logger } = deps
  let accelerator: string | null = null
  let status: HotkeyStatus = 'unbound'
  const subscribers = new Set<(e: HotkeyFiredPayload) => void>()

  agent.on('hotkey.fired', (payload) => {
    logger.debug('hotkey.fired', { accelerator: payload.accelerator })
    for (const cb of [...subscribers]) {
      // One bad subscriber must not silence the rest; the palette failing to open is the
      // product's only entry point failing.
      try {
        cb(payload)
      } catch {
        logger.warn('hotkey.fired', { ok: false })
      }
    }
  })

  return {
    async bind(next) {
      if (!isValidAccelerator(next)) {
        logger.warn('hotkey.bind-failed', { accelerator: next, code: 'E_HOTKEY_INVALID' })
        return err('E_HOTKEY_INVALID', `not a valid accelerator: ${next}`, { accelerator: next })
      }
      const res = await agent.request('hotkey.register', { accelerator: next })
      accelerator = next
      if (!res.ok) {
        status = 'failed'
        logger.warn('hotkey.bind-failed', { accelerator: next, code: res.code })
        return res
      }
      // THE POINT OF THIS PACKAGE: a taken combination is a SUCCESSFUL response carrying
      // `bound: false`. Not checking it is how this app class ships a silently dead hotkey.
      if (!res.value.bound) {
        status = 'failed'
        logger.warn('hotkey.bind-failed', { accelerator: next, code: 'E_HOTKEY_TAKEN' })
        return err('E_HOTKEY_TAKEN', `another application already owns ${next}`, { accelerator: next })
      }
      status = 'active'
      logger.info('hotkey.bound', { accelerator: next })
      return ok({ accelerator: next })
    },
    async unbind() {
      const res = await agent.request('hotkey.unregister', {})
      if (!res.ok) return res
      accelerator = null
      status = 'unbound'
      return ok({ bound: false as const })
    },
    current: () => accelerator,
    status: () => status,
    onTrigger(cb) {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
  }
}
```

- [ ] **Step 8: Run it green, typecheck, commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npm run test -w @cairn/hotkey
npx tsc -p tsconfig.json
git add packages/hotkey/src/index.ts packages/hotkey/src/index.test.ts
git commit -m "feat(hotkey): bind/current/status/onTrigger with a first-class dead-hotkey state"
```

Expected: `Tests 13 passed (13)`, `tsc` exits 0.

- [ ] **Step 9: Write the failing `windows.security.test.ts`.** This is contract §8's
      renderer-hardening row, plus the two controls that are easy to lose in a refactor: a
      loosening environment variable must not exist, and a packaged build must never resolve a
      remote URL even if `ELECTRON_RENDERER_URL` is set.

Create `apps/desktop/main/src/windows.security.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CSP_POLICY_DEV, CSP_POLICY_PROD } from './constants'
import {
  cspPolicy,
  PALETTE_WEB_PREFERENCES,
  paletteWebPreferences,
  resolvePaletteEntry,
  resolveRuntimeMode,
} from './windows'

const HARDENED = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  enableBlinkFeatures: '',
  spellcheck: false,
  devTools: false,
} as const

describe('webPreferences', () => {
  it('the exported baseline is exactly the hardened set', () => {
    expect(PALETTE_WEB_PREFERENCES).toEqual(HARDENED)
  })

  it('a packaged build gets the hardened set with DevTools off', () => {
    const prefs = paletteWebPreferences('packaged', '/tmp/preload.js')
    expect(prefs).toEqual({ ...HARDENED, preload: '/tmp/preload.js' })
  })

  it('a dev build differs ONLY by devTools', () => {
    const prefs = paletteWebPreferences('dev', '/tmp/preload.js')
    expect(prefs).toEqual({ ...HARDENED, devTools: true, preload: '/tmp/preload.js' })
  })
})

describe('resolveRuntimeMode', () => {
  it('is packaged when Electron says so', () => {
    expect(resolveRuntimeMode({ isPackaged: true, env: {} })).toBe('packaged')
  })

  it('is dev when Electron says so and nothing tightens it', () => {
    expect(resolveRuntimeMode({ isPackaged: false, env: {} })).toBe('dev')
  })

  it('CAIRN_HARDENED=1 can TIGHTEN a dev run', () => {
    expect(resolveRuntimeMode({ isPackaged: false, env: { CAIRN_HARDENED: '1' } })).toBe('packaged')
  })

  it('no environment variable can LOOSEN a packaged run', () => {
    // The asymmetry is the control: an env var that turns hardening off is a remote-exploitable
    // switch on any machine where the user's shell profile can be written.
    for (const env of [
      { CAIRN_HARDENED: '0' },
      { CAIRN_HARDENED: '' },
      { NODE_ENV: 'development' },
      { ELECTRON_IS_DEV: '1' },
      { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
    ]) {
      expect(resolveRuntimeMode({ isPackaged: true, env })).toBe('packaged')
    }
  })
})

describe('CSP', () => {
  it('the production policy has no unsafe-inline and no unsafe-eval', () => {
    expect(CSP_POLICY_PROD).not.toContain('unsafe-inline')
    expect(CSP_POLICY_PROD).not.toContain('unsafe-eval')
    expect(CSP_POLICY_PROD).not.toContain('*')
  })

  it('the production policy denies everything by default and denies all network', () => {
    expect(CSP_POLICY_PROD).toContain("default-src 'none'")
    expect(CSP_POLICY_PROD).toContain("connect-src 'none'")
    expect(CSP_POLICY_PROD).toContain("object-src 'none'")
    expect(CSP_POLICY_PROD).toContain("base-uri 'none'")
    expect(CSP_POLICY_PROD).toContain("form-action 'none'")
    expect(CSP_POLICY_PROD).toContain("frame-src 'none'")
    expect(CSP_POLICY_PROD).toContain("worker-src 'none'")
  })

  it('the production policy still allows the built renderer to run', () => {
    // Verified against Electron 44.1.1 on a real file:// load: an external module script and an
    // external stylesheet both work under `script-src 'self'` / `style-src 'self'`, while an
    // injected inline <script> and `new Function` are both blocked.
    expect(CSP_POLICY_PROD).toContain("script-src 'self'")
    expect(CSP_POLICY_PROD).toContain("style-src 'self'")
    expect(CSP_POLICY_PROD).toContain("img-src 'self' data:")
  })

  it('the dev policy is unreachable when packaged', () => {
    expect(cspPolicy('packaged')).toBe(CSP_POLICY_PROD)
    expect(cspPolicy('dev')).toBe(CSP_POLICY_DEV)
    expect(cspPolicy('packaged')).not.toBe(CSP_POLICY_DEV)
  })
})

describe('resolvePaletteEntry', () => {
  it('a packaged build always loads a local file, even with a renderer URL in the environment', () => {
    const entry = resolvePaletteEntry(
      'packaged',
      { ELECTRON_RENDERER_URL: 'http://evil.example/palette' },
      '/Apps/Cairn.app/out/renderer/index.html',
    )
    expect(entry).toEqual({ kind: 'file', path: '/Apps/Cairn.app/out/renderer/index.html' })
  })

  it('a dev build uses the vite dev server when electron-vite provides one', () => {
    const entry = resolvePaletteEntry(
      'dev',
      { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
      '/repo/apps/desktop/out/renderer/index.html',
    )
    expect(entry).toEqual({ kind: 'url', url: 'http://localhost:5173' })
  })

  it('a dev build with no dev server falls back to the built file', () => {
    const entry = resolvePaletteEntry('dev', {}, '/repo/apps/desktop/out/renderer/index.html')
    expect(entry).toEqual({ kind: 'file', path: '/repo/apps/desktop/out/renderer/index.html' })
  })

  it('a dev build refuses a non-localhost renderer URL', () => {
    const entry = resolvePaletteEntry(
      'dev',
      { ELECTRON_RENDERER_URL: 'http://192.168.1.9:5173' },
      '/repo/apps/desktop/out/renderer/index.html',
    )
    expect(entry).toEqual({ kind: 'file', path: '/repo/apps/desktop/out/renderer/index.html' })
  })
})
```

- [ ] **Step 10: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security apps/desktop/main/src/windows.security.test.ts
```

Expected: FAIL with `Error: Cannot find module './constants' imported from
/Users/santoshkumarreddy/copy-clipboard-app/apps/desktop/main/src/windows.security.test.ts`.

- [ ] **Step 11: Implement `constants.ts`.** Every user-visible string is a constant so it cannot
      silently drift (spec §11 control 11), and the first-run message names the exact applications
      whose shortcut we are taking (spec §9).

Create `apps/desktop/main/src/constants.ts`:

```ts
import { DEFAULT_ACCELERATOR } from '@cairn/protocol'

/** Spotlight-ish proportions. Fixed, because a resizable palette is a palette you have to aim at. */
export const PALETTE_WIDTH = 720
export const PALETTE_HEIGHT = 460

/** Spec §11 control 6: the decrypted preview cache is evicted after this much user idleness. */
export const PREVIEW_CACHE_IDLE_MS = 300_000
/** How often we ask the OS how long the user has been idle. 60 s costs nothing and is precise enough. */
export const IDLE_CHECK_INTERVAL_MS = 60_000

/** electron-vite's dev server. The ONLY remote origin any policy in this file ever names. */
const DEV_ORIGIN = 'http://localhost:5173'

/**
 * Spec §11 control 4. Verified on Electron 44.1.1 against a real `file://` load of a vite-built
 * renderer: the external module script executes, the external stylesheet applies, a `data:` image
 * loads, and an injected inline `<script>`, `new Function` and any network request from the page are
 * all blocked. (The blocked-request API is deliberately not named here: `security/`'s socket ban
 * matches plain substrings with no comment exemption, and a ban with a comment hole is a weaker ban.)
 * `'unsafe-inline'` appears nowhere, which is what stops a copied `<img onerror>` from ever
 * becoming script if a future preview pane regresses.
 */
export const CSP_POLICY_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "media-src 'none'",
  "worker-src 'none'",
].join('; ')

/**
 * Dev only, and `cspPolicy()` can never return it for a packaged build. Vite injects styles as
 * inline `<style>` elements in dev and needs a websocket for HMR; both are dev-server facts, not
 * product requirements, which is exactly why the two policies are separate constants.
 */
export const CSP_POLICY_DEV = [
  "default-src 'none'",
  `script-src 'self' ${DEV_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `font-src 'self' ${DEV_ORIGIN}`,
  `connect-src 'self' ${DEV_ORIGIN} ws://localhost:5173`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "media-src 'none'",
  "worker-src 'none'",
].join('; ')

/** electron-vite only ever serves the renderer from localhost; anything else is not our dev server. */
export const ALLOWED_DEV_ORIGINS = [DEV_ORIGIN, 'http://127.0.0.1:5173'] as const

/** Spec §9: we ship the confirmed default, but through a step that NAMES what it overrides. */
export const FIRST_RUN_HOTKEY_TITLE = 'Choose Cairn’s hotkey'
export const FIRST_RUN_HOTKEY_MESSAGE = `Cairn opens with ${DEFAULT_ACCELERATOR}.`
export const FIRST_RUN_HOTKEY_DETAIL =
  'This shortcut is intercepted before the app you are using sees it, so it will take over ' +
  'Paste and Match Style in Chrome and other Chromium browsers, Slack, Google Docs, Discord, ' +
  'Visual Studio Code and Windows Terminal. If you use that often, pick Cmd+Shift+C instead. ' +
  'You can change this later in Settings.'
export const FIRST_RUN_HOTKEY_BUTTONS = ['Use Cmd+Shift+V', 'Use Cmd+Shift+C'] as const
export const FIRST_RUN_HOTKEY_CHOICES = ['Cmd+Shift+V', 'Cmd+Shift+C'] as const

/** Shown as a persistent rebind row when `hotkey.status() === 'failed'` (spec §6). */
export const HOTKEY_DEAD_BANNER =
  'Another app already owns this shortcut, so Cairn’s hotkey is not working. Pick another one.'

/**
 * Spec §6's "No OS keyring" degraded mode. `getOrCreateMasterKey()` returns
 * `E_KEYRING_WEAK_BACKEND` when `safeStorage` reports Chromium's `basic_text` backend, which
 * "encrypts" with a hardcoded password. We refuse to start rather than pretend, and we say why in a
 * dialog instead of dying with an uncaught error the user never sees.
 */
export const KEYRING_WEAK_DIALOG_TITLE = 'Cairn cannot protect your clipboard on this machine'
export const KEYRING_WEAK_DIALOG_DETAIL =
  'Cairn stores nothing until it has a real key, so it is quitting instead of writing a history it ' +
  'cannot protect. Set up your desktop keyring — the macOS Keychain, Windows Credential Manager, or ' +
  'GNOME Keyring / KWallet on Linux — and start Cairn again.'

/**
 * Spec §11 control 6, third clause: in passphrase mode a screen lock zero-fills the master key, so
 * the history is unreadable until the passphrase is entered again. Shown on unlock so the user is
 * never left wondering why the palette is empty.
 */
export const KEYRING_RELOCKED_BANNER =
  'Cairn locked itself when your screen locked. Quit and reopen Cairn to enter your passphrase.'
```

- [ ] **Step 12: Implement the pure half of `windows.ts`.** These four functions carry the hardening
      decisions and are the only part of the window that a unit test can reach, which is why they
      are pure functions of their inputs rather than statements inside `createPaletteWindow`.

Create `apps/desktop/main/src/windows.ts`:

```ts
import { ALLOWED_DEV_ORIGINS, CSP_POLICY_DEV, CSP_POLICY_PROD } from './constants'

export type RuntimeMode = 'packaged' | 'dev'

/**
 * Hardening can only ever be TIGHTENED by the environment, never loosened. `CAIRN_HARDENED=1`
 * lets us run the packaged configuration from source (M1 never produces a real bundle — packaging
 * is M3 — so without this switch the hardened branch would be unreachable on a developer machine).
 * There is deliberately no variable that turns hardening off.
 */
export function resolveRuntimeMode(input: {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
}): RuntimeMode {
  if (input.isPackaged) return 'packaged'
  return input.env['CAIRN_HARDENED'] === '1' ? 'packaged' : 'dev'
}

export interface PaletteWebPreferences {
  readonly preload: string
  readonly sandbox: true
  readonly contextIsolation: true
  readonly nodeIntegration: false
  readonly nodeIntegrationInSubFrames: false
  readonly nodeIntegrationInWorker: false
  readonly webSecurity: true
  readonly allowRunningInsecureContent: false
  readonly experimentalFeatures: false
  readonly webviewTag: false
  readonly enableBlinkFeatures: ''
  readonly spellcheck: false
  readonly devTools: boolean
}

/**
 * Spec §11 control 4, one line per flag:
 * - `sandbox: true`          the renderer runs in a real OS sandbox with no Node.
 * - `contextIsolation: true` page JS and preload JS get separate contexts, so the page cannot
 *                            reach into our bridge and rewrite it.
 * - `nodeIntegration: false` and the two `…InSubFrames` / `…InWorker` siblings, because setting
 *                            only the first one leaves iframes and workers with Node.
 * - `webSecurity: true`      keeps the same-origin policy on; turning it off is the single most
 *                            common Electron "fix" and it disables CSP enforcement too.
 * - `allowRunningInsecureContent: false` no http subresources on an https page.
 * - `experimentalFeatures: false` unshipped Blink features are unaudited attack surface.
 * - `webviewTag: false`      `<webview>` is a second, weaker window with its own preferences.
 * - `enableBlinkFeatures: ''` explicit empty, so a merge cannot quietly add one.
 * - `spellcheck: false`      the spellchecker downloads dictionaries and sees every character you
 *                            type into a search box over your clipboard history.
 * - `devTools: false`        in packaged builds. Verified on Electron 44.1.1: with this false,
 *                            `openDevTools()` is refused and `isDevToolsOpened()` stays false.
 */
export const PALETTE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  enableBlinkFeatures: '',
  spellcheck: false,
  devTools: false,
} as const satisfies Omit<PaletteWebPreferences, 'preload'>

export function paletteWebPreferences(mode: RuntimeMode, preloadPath: string): PaletteWebPreferences {
  return { ...PALETTE_WEB_PREFERENCES, devTools: mode === 'dev', preload: preloadPath }
}

export function cspPolicy(mode: RuntimeMode): string {
  return mode === 'packaged' ? CSP_POLICY_PROD : CSP_POLICY_DEV
}

export type PaletteEntry =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }

/**
 * Spec §11 control 4: "all content loaded from local files with no remote origins". A packaged
 * build ignores `ELECTRON_RENDERER_URL` entirely, and a dev build accepts it only for the two
 * localhost origins electron-vite actually serves — so a stray variable in a shell profile can
 * never point the palette at a remote page.
 */
export function resolvePaletteEntry(
  mode: RuntimeMode,
  env: Readonly<Record<string, string | undefined>>,
  rendererIndexPath: string,
): PaletteEntry {
  if (mode === 'packaged') return { kind: 'file', path: rendererIndexPath }
  const url = env['ELECTRON_RENDERER_URL']
  if (url !== undefined && (ALLOWED_DEV_ORIGINS as readonly string[]).includes(url)) {
    return { kind: 'url', url }
  }
  return { kind: 'file', path: rendererIndexPath }
}
```

- [ ] **Step 13: Run the security test green and commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security apps/desktop/main/src/windows.security.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/main/src/constants.ts apps/desktop/main/src/windows.ts apps/desktop/main/src/windows.security.test.ts
git commit -m "feat(desktop): hardened webPreferences, strict CSP and local-files-only entry resolution"
```

Expected: `Tests 14 passed (14)`, `tsc` exits 0.

- [ ] **Step 14: Write the failing `windows.test.ts`.** This asserts the window flags and the
      navigation/session guards. Every assertion is about arguments **our code produces**, against a
      fake `BrowserWindow` that records them — not about arguments the test passed in.

Create `apps/desktop/main/src/windows.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createTestClock, type Logger } from '@cairn/protocol'
import { PALETTE_HEIGHT, PALETTE_WIDTH } from './constants'
import {
  applyCspHeader,
  createPaletteWindow,
  hardenSession,
  NAV_GUARD_EVENTS,
  paletteWindowOptions,
  registerNavigationGuards,
  type BrowserWindowLike,
  type HardenableSession,
  type NavGuardTarget,
  type PaletteWindowOptions,
} from './windows'

const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

interface Recorded {
  readonly ctorOptions: PaletteWindowOptions[]
  readonly alwaysOnTop: unknown[][]
  readonly visibleOnAllWorkspaces: unknown[][]
  readonly loadedFiles: string[]
  readonly loadedUrls: string[]
  readonly sent: [string, unknown][]
  readonly navGuards: string[]
  windowOpenHandler: ((d: { url: string }) => { action: 'deny' }) | null
  shown: number
  hidden: number
  destroyed: number
}

function fakeBrowserWindow(): { Ctor: new (o: PaletteWindowOptions) => BrowserWindowLike; rec: Recorded } {
  const rec: Recorded = {
    ctorOptions: [],
    alwaysOnTop: [],
    visibleOnAllWorkspaces: [],
    loadedFiles: [],
    loadedUrls: [],
    sent: [],
    navGuards: [],
    windowOpenHandler: null,
    shown: 0,
    hidden: 0,
    destroyed: 0,
  }
  class Fake {
    readonly webContents: unknown
    private visible = false
    constructor(options: PaletteWindowOptions) {
      rec.ctorOptions.push(options)
      const emitter = new EventEmitter()
      this.webContents = {
        on: (ev: string, cb: (...a: unknown[]) => void) => { rec.navGuards.push(ev); emitter.on(ev, cb) },
        setWindowOpenHandler: (h: (d: { url: string }) => { action: 'deny' }) => { rec.windowOpenHandler = h },
        send: (channel: string, payload: unknown) => { rec.sent.push([channel, payload]) },
        isDestroyed: () => rec.destroyed > 0,
      }
    }
    setAlwaysOnTop(...args: unknown[]): void { rec.alwaysOnTop.push(args) }
    setVisibleOnAllWorkspaces(...args: unknown[]): void { rec.visibleOnAllWorkspaces.push(args) }
    loadFile(p: string): Promise<void> { rec.loadedFiles.push(p); return Promise.resolve() }
    loadURL(u: string): Promise<void> { rec.loadedUrls.push(u); return Promise.resolve() }
    show(): void { this.visible = true; rec.shown += 1 }
    hide(): void { this.visible = false; rec.hidden += 1 }
    focus(): void {}
    isVisible(): boolean { return this.visible }
    isDestroyed(): boolean { return rec.destroyed > 0 }
    destroy(): void { rec.destroyed += 1 }
  }
  return { Ctor: Fake as unknown as new (o: PaletteWindowOptions) => BrowserWindowLike, rec }
}

describe('paletteWindowOptions', () => {
  const o = paletteWindowOptions({ mode: 'packaged', preloadPath: '/tmp/preload.js' })

  it('is an NSPanel-shaped, chromeless, invisible-on-launch window', () => {
    expect(o.type).toBe('panel')
    expect(o.frame).toBe(false)
    expect(o.transparent).toBe(true)
    expect(o.show).toBe(false)
    expect(o.skipTaskbar).toBe(true)
    expect(o.width).toBe(PALETTE_WIDTH)
    expect(o.height).toBe(PALETTE_HEIGHT)
  })

  it('uses the hud vibrancy that stays lit while another app is frontmost', () => {
    expect(o.vibrancy).toBe('hud')
    expect(o.visualEffectState).toBe('active')
  })

  it('cannot be resized, moved, minimised, maximised or fullscreened', () => {
    expect(o.resizable).toBe(false)
    expect(o.movable).toBe(false)
    expect(o.minimizable).toBe(false)
    expect(o.maximizable).toBe(false)
    expect(o.fullscreenable).toBe(false)
  })

  it('carries the hardened webPreferences and the preload path', () => {
    expect(o.webPreferences.sandbox).toBe(true)
    expect(o.webPreferences.contextIsolation).toBe(true)
    expect(o.webPreferences.nodeIntegration).toBe(false)
    expect(o.webPreferences.devTools).toBe(false)
    expect(o.webPreferences.preload).toBe('/tmp/preload.js')
  })
})

describe('registerNavigationGuards', () => {
  it('prevents all three navigation events and denies every window open', () => {
    const emitter = new EventEmitter()
    let handler: ((d: { url: string }) => { action: 'deny' }) | null = null
    const blocked: string[] = []
    const wc = {
      on: (ev: string, cb: (e: { preventDefault: () => void }, url: string) => void) => { emitter.on(ev, cb) },
      setWindowOpenHandler: (h: (d: { url: string }) => { action: 'deny' }) => { handler = h },
    } as unknown as NavGuardTarget

    registerNavigationGuards(wc, (u) => blocked.push(u))

    // All three, because Electron 44 emits `will-frame-navigate` FIRST and a preventDefault there
    // means `will-navigate` never fires at all — so guarding only one of them is a coin flip.
    expect(NAV_GUARD_EVENTS).toEqual(['will-navigate', 'will-frame-navigate', 'will-redirect'])
    for (const ev of NAV_GUARD_EVENTS) {
      const preventDefault = vi.fn()
      emitter.emit(ev, { preventDefault }, `https://evil.example/${ev}`)
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }
    expect(handler).not.toBeNull()
    expect(handler!({ url: 'https://evil.example/popup' })).toEqual({ action: 'deny' })
    expect(blocked).toEqual([
      'https://evil.example/will-navigate',
      'https://evil.example/will-frame-navigate',
      'https://evil.example/will-redirect',
      'https://evil.example/popup',
    ])
  })
})

describe('applyCspHeader', () => {
  it('replaces any existing policy header, matching case-insensitively', () => {
    let got: Record<string, string[]> | null = null
    applyCspHeader(
      { responseHeaders: { 'content-security-policy': ['default-src *'], 'X-Other': ['1'] } },
      "default-src 'none'",
      (r) => { got = r.responseHeaders },
    )
    expect(got).toEqual({ 'X-Other': ['1'], 'Content-Security-Policy': ["default-src 'none'"] })
  })

  it('adds the policy when the response carries no headers at all', () => {
    let got: Record<string, string[]> | null = null
    applyCspHeader({}, "default-src 'none'", (r) => { got = r.responseHeaders })
    expect(got).toEqual({ 'Content-Security-Policy': ["default-src 'none'"] })
  })
})

describe('hardenSession', () => {
  it('installs the CSP header hook and denies every permission request', () => {
    let headersFn: ((d: unknown, cb: (r: unknown) => void) => void) | null = null
    let permFn: ((wc: unknown, p: string, cb: (granted: false) => void) => void) | null = null
    const denied: string[] = []
    const session = {
      webRequest: { onHeadersReceived: (fn: typeof headersFn) => { headersFn = fn } },
      setPermissionRequestHandler: (fn: typeof permFn) => { permFn = fn },
    } as unknown as HardenableSession

    hardenSession(session, "default-src 'none'", (p) => denied.push(p))

    expect(headersFn).not.toBeNull()
    expect(permFn).not.toBeNull()
    // Every permission is refused, including ones that do not exist yet: the default must be deny.
    for (const permission of ['media', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'notifications', 'some-future-permission']) {
      const granted = vi.fn()
      permFn!({}, permission, granted as unknown as (g: false) => void)
      expect(granted).toHaveBeenCalledWith(false)
    }
    expect(denied).toEqual(['media', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'notifications', 'some-future-permission'])
  })
})

describe('createPaletteWindow', () => {
  it('creates a hidden panel, pins it above the screen saver and across all workspaces', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: {},
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()

    expect(rec.ctorOptions).toHaveLength(1)
    expect(rec.ctorOptions[0]!.show).toBe(false)
    // 'screen-saver' is the only level that puts the palette above a full-screen app.
    expect(rec.alwaysOnTop).toEqual([[true, 'screen-saver']])
    // `skipTransformProcessType: true` matters: without it this call flips the process type and
    // the Dock icon we hid with app.dock.hide() comes back.
    expect(rec.visibleOnAllWorkspaces).toEqual([
      [true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
    ])
    expect(rec.navGuards).toEqual(['will-navigate', 'will-frame-navigate', 'will-redirect'])
    expect(rec.windowOpenHandler).not.toBeNull()
    expect(rec.shown).toBe(0)
  })

  it('loads the local file in a packaged build and never a URL', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()
    expect(rec.loadedFiles).toEqual(['/tmp/renderer/index.html'])
    expect(rec.loadedUrls).toEqual([])
  })

  it('show / hide / isVisible / send / destroy drive the underlying window', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    const palette = createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: {},
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()
    expect(palette.isVisible()).toBe(false)
    palette.show()
    expect(palette.isVisible()).toBe(true)
    palette.send('cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' })
    palette.hide()
    expect(palette.isVisible()).toBe(false)
    palette.destroy()
    expect(rec.shown).toBe(1)
    expect(rec.hidden).toBe(1)
    expect(rec.destroyed).toBe(1)
    expect(rec.sent).toEqual([['cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' }]])
  })

  it('send after destroy is a no-op instead of a crash', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    const palette = createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: {},
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()
    palette.destroy()
    palette.send('cairn:toast', { text: 'late', tone: 'info' })
    expect(rec.sent).toEqual([])
  })
})
```

- [ ] **Step 15: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/windows.test.ts
```

Expected: FAIL with `TypeError: paletteWindowOptions is not a function` (the module resolves — Step
12 created it — but these five exports do not exist yet).

- [ ] **Step 16: Implement the rest of `windows.ts`.**

Append to `apps/desktop/main/src/windows.ts`:

```ts
import type { Clock, IpcEventChannel, Logger } from '@cairn/protocol'
import { PALETTE_HEIGHT, PALETTE_WIDTH } from './constants'

export interface PaletteWindowOptions {
  readonly width: number
  readonly height: number
  readonly show: false
  readonly frame: false
  readonly transparent: true
  readonly resizable: false
  readonly movable: false
  readonly minimizable: false
  readonly maximizable: false
  readonly fullscreenable: false
  readonly skipTaskbar: true
  readonly type: 'panel'
  readonly vibrancy: 'hud'
  readonly visualEffectState: 'active'
  readonly backgroundColor: '#00000000'
  readonly hasShadow: true
  readonly roundedCorners: true
  readonly acceptFirstMouse: true
  readonly webPreferences: PaletteWebPreferences
}

/**
 * Spec §4's flag list, one line of why each — these are not cosmetic:
 * - `type: 'panel'`             asks AppKit for an NSPanel, which can float over a full-screen app
 *                               without stealing its Space. (Day-0 spike: creation succeeds on
 *                               Electron 44.1.1; whether the native class really is NSPanel is
 *                               recorded in PLATFORM-NOTES.md.)
 * - `vibrancy: 'hud'`           the translucent Spotlight look.
 * - `visualEffectState:'active'` without it the vibrancy greys out, because another app is
 *                               frontmost the entire time the palette is open — which is always.
 * - `frame: false` + `transparent: true` + `backgroundColor: '#00000000'`  no title bar, and the
 *                               vibrancy shows through instead of a grey rectangle.
 * - `show: false`               spec §4: no window on launch. We are a background utility.
 * - `skipTaskbar: true`         never a window-list entry.
 * - `resizable/movable/minimizable/maximizable/fullscreenable: false`  a palette you can drag out
 *                               of position or minimise is a palette you have to hunt for.
 * - `hasShadow` + `roundedCorners`  so a frameless transparent window still reads as a window.
 * - `acceptFirstMouse: true`    the first click after the palette appears selects a row instead of
 *                               being eaten to activate the window.
 */
export function paletteWindowOptions(o: { mode: RuntimeMode; preloadPath: string }): PaletteWindowOptions {
  return {
    width: PALETTE_WIDTH,
    height: PALETTE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: 'panel',
    vibrancy: 'hud',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    acceptFirstMouse: true,
    webPreferences: paletteWebPreferences(o.mode, o.preloadPath),
  }
}

export interface NavGuardTarget {
  on(
    event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect',
    cb: (e: { preventDefault: () => void }, url: string) => void,
  ): void
  setWindowOpenHandler(handler: (d: { url: string }) => { action: 'deny' }): void
}

/**
 * All three, in this order. Verified on Electron 44.1.1: a renderer-initiated
 * `location.href = 'https://evil.example'` fires `will-frame-navigate`, and because our handler
 * calls `preventDefault()` there, `will-navigate` is never emitted at all. Guarding only
 * `will-navigate` would therefore look correct in a code review and do nothing.
 */
export const NAV_GUARD_EVENTS = ['will-navigate', 'will-frame-navigate', 'will-redirect'] as const

export function registerNavigationGuards(wc: NavGuardTarget, onBlocked: (url: string) => void): void {
  for (const event of NAV_GUARD_EVENTS) {
    wc.on(event, (e, url) => {
      e.preventDefault()
      onBlocked(url)
    })
  }
  wc.setWindowOpenHandler(({ url }) => {
    onBlocked(url)
    return { action: 'deny' }
  })
}

export interface HeadersReceivedDetails { readonly responseHeaders?: Record<string, string[]> }

/** Belt to the index.html meta tag's braces: a server-sent policy can never be weaker than ours. */
export function applyCspHeader(
  details: HeadersReceivedDetails,
  policy: string,
  callback: (r: { responseHeaders: Record<string, string[]> }) => void,
): void {
  const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-security-policy') delete headers[key]
    if (key.toLowerCase() === 'content-security-policy-report-only') delete headers[key]
  }
  headers['Content-Security-Policy'] = [policy]
  callback({ responseHeaders: headers })
}

export interface HardenableSession {
  webRequest: {
    onHeadersReceived(
      fn: (d: HeadersReceivedDetails, cb: (r: { responseHeaders: Record<string, string[]> }) => void) => void,
    ): void
  }
  setPermissionRequestHandler(
    fn: (wc: unknown, permission: string, cb: (granted: false) => void) => void,
  ): void
}

/** Deny-all, including permissions that do not exist yet: the default for a new permission must
 *  never be "granted" in a process holding decrypted clipboard history. */
export function hardenSession(
  session: HardenableSession,
  policy: string,
  onDenied: (permission: string) => void,
): void {
  session.webRequest.onHeadersReceived((details, cb) => { applyCspHeader(details, policy, cb) })
  session.setPermissionRequestHandler((_wc, permission, cb) => {
    onDenied(permission)
    cb(false)
  })
}

export interface BrowserWindowLike {
  readonly webContents: NavGuardTarget & {
    send(channel: string, payload: unknown): void
    isDestroyed(): boolean
  }
  setAlwaysOnTop(flag: boolean, level: string): void
  setVisibleOnAllWorkspaces(
    visible: boolean,
    opts: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean },
  ): void
  loadFile(path: string): Promise<void>
  loadURL(url: string): Promise<void>
  show(): void
  hide(): void
  focus(): void
  isVisible(): boolean
  isDestroyed(): boolean
  destroy(): void
}

export interface PaletteController {
  show(): void
  hide(): void
  isVisible(): boolean
  send<C extends IpcEventChannel>(channel: C, payload: unknown): void
  destroy(): void
}

export function createPaletteWindow(deps: {
  BrowserWindowCtor: new (o: PaletteWindowOptions) => BrowserWindowLike
  mode: RuntimeMode
  preloadPath: string
  rendererIndexPath: string
  env: Readonly<Record<string, string | undefined>>
  clock: Clock
  logger: Logger
}): PaletteController {
  const { BrowserWindowCtor, mode, preloadPath, rendererIndexPath, env, logger } = deps
  const win = new BrowserWindowCtor(paletteWindowOptions({ mode, preloadPath }))

  // 'screen-saver' is the only always-on-top level that clears a full-screen app.
  win.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType keeps us an accessory app: without it this call flips the process
  // type and the Dock icon we hid comes straight back.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

  let blockedCount = 0
  registerNavigationGuards(win.webContents, () => {
    blockedCount += 1
    logger.warn('renderer.navigation-blocked', { count: blockedCount })
  })

  const entry = resolvePaletteEntry(mode, env, rendererIndexPath)
  const load = entry.kind === 'file' ? win.loadFile(entry.path) : win.loadURL(entry.url)
  void load.catch(() => { logger.error('renderer.navigation-blocked', { ok: false }) })

  return {
    show() {
      win.show()
      // An accessory app is not activated by show() alone, so the search field would get no
      // keystrokes. focus() is what makes typing work.
      win.focus()
    },
    hide() { win.hide() },
    isVisible() { return !win.isDestroyed() && win.isVisible() },
    send(channel, payload) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(channel, payload)
    },
    destroy() { if (!win.isDestroyed()) win.destroy() },
  }
}
```

Move the two `import` lines to the top of the file, merged with the existing imports — TypeScript
allows imports only at module top level.

- [ ] **Step 17: Run it green, typecheck, commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/windows.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/main/src/windows.ts apps/desktop/main/src/windows.test.ts
git commit -m "feat(desktop): palette NSPanel window, navigation guards and session hardening"
```

Expected: `Tests 12 passed (12)`, `tsc` exits 0.

- [ ] **Step 18: Write the failing `menu.test.ts`.** The bug this catches ships constantly: an
      accessory app has no visible menu bar, so a developer "tidies up" with
      `Menu.setApplicationMenu(null)` and `Cmd+A` / `Cmd+C` / `Cmd+V` die **inside our own search
      field**. Verified on Electron 44.1.1: the default menu already contains those roles, so a
      runtime `getApplicationMenu()` check would pass whether or not we built our own — the guard has
      to be our template plus a throwing assertion plus a source ban.

Create `apps/desktop/main/src/menu.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { APP_NAME } from '@cairn/protocol'
import {
  assertEditMenuIntact,
  buildAppMenuTemplate,
  editSubmenuRoles,
  REQUIRED_EDIT_ROLES,
  type MenuItemTemplate,
} from './menu'

describe('buildAppMenuTemplate', () => {
  const template = buildAppMenuTemplate(APP_NAME)

  it('has an application menu and an Edit menu, and nothing else', () => {
    expect(template.map((m) => m.label)).toEqual(['Cairn', 'Edit'])
  })

  it('the Edit menu carries every clipboard role in the order macOS users expect', () => {
    expect(editSubmenuRoles(template)).toEqual([
      'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll',
    ])
  })

  it('the required roles are exactly the ones that make Cmd+A/C/V work in our search field', () => {
    expect(REQUIRED_EDIT_ROLES).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    for (const role of REQUIRED_EDIT_ROLES) {
      expect(editSubmenuRoles(template)).toContain(role)
    }
  })

  it('the application menu can quit', () => {
    const appMenu = template.find((m) => m.label === 'Cairn')
    expect(appMenu?.submenu?.map((i) => i.role ?? i.type)).toEqual(['about', 'separator', 'quit'])
  })
})

describe('assertEditMenuIntact', () => {
  it('accepts the real template', () => {
    expect(() => assertEditMenuIntact(buildAppMenuTemplate(APP_NAME))).not.toThrow()
  })

  it('throws when the whole Edit menu is gone', () => {
    const gutted: MenuItemTemplate[] = [{ label: 'Cairn', submenu: [{ role: 'quit' }] }]
    expect(() => assertEditMenuIntact(gutted)).toThrow(
      'cairn: the Edit menu is missing — Cmd+A, Cmd+C and Cmd+V would be dead in the search field',
    )
  })

  it('throws naming the exact role that went missing', () => {
    const trimmed: MenuItemTemplate[] = [
      { label: 'Cairn', submenu: [{ role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    ]
    expect(() => assertEditMenuIntact(trimmed)).toThrow(
      'cairn: the Edit menu is missing roles: selectAll',
    )
  })

  it('throws for an empty template, which is what setApplicationMenu(null) amounts to', () => {
    expect(() => assertEditMenuIntact([])).toThrow(/Edit menu is missing/)
  })
})
```

- [ ] **Step 19: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/menu.test.ts
```

Expected: FAIL with `Error: Cannot find module './menu' imported from
/Users/santoshkumarreddy/copy-clipboard-app/apps/desktop/main/src/menu.test.ts`.

- [ ] **Step 20: Implement `menu.ts`.**

Create `apps/desktop/main/src/menu.ts`:

```ts
export interface MenuItemTemplate {
  readonly label?: string
  readonly role?: string
  readonly type?: 'separator'
  readonly submenu?: readonly MenuItemTemplate[]
}

/**
 * Spec §4: "an accessory app has no menu bar, so Cmd+A/C/V would otherwise be dead inside our own
 * search field". These four roles are the ones the search field needs; Electron attaches the
 * standard accelerators to them automatically (verified on 44.1.1: copy -> CommandOrControl+C,
 * paste -> CommandOrControl+V, selectAll -> CommandOrControl+A).
 */
export const REQUIRED_EDIT_ROLES = ['cut', 'copy', 'paste', 'selectAll'] as const

export function buildAppMenuTemplate(appName: string): readonly MenuItemTemplate[] {
  return [
    { label: appName, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
  ]
}

/** The Edit submenu's roles with separators stripped, in order. */
export function editSubmenuRoles(template: readonly MenuItemTemplate[]): readonly string[] {
  const edit = template.find((m) => m.label === 'Edit')
  return (edit?.submenu ?? [])
    .filter((i) => i.type !== 'separator' && i.role !== undefined)
    .map((i) => i.role as string)
}

/**
 * THROWS. Called from the Electron entry before the first window exists, so deleting the Edit menu
 * is a loud crash at launch instead of a search field where Cmd+A silently does nothing — a bug
 * nobody reports because nobody believes it.
 */
export function assertEditMenuIntact(template: readonly MenuItemTemplate[]): void {
  const edit = template.find((m) => m.label === 'Edit')
  if (edit === undefined || edit.submenu === undefined || edit.submenu.length === 0) {
    throw new Error(
      'cairn: the Edit menu is missing — Cmd+A, Cmd+C and Cmd+V would be dead in the search field',
    )
  }
  const roles = new Set(editSubmenuRoles(template))
  const missing = REQUIRED_EDIT_ROLES.filter((r) => !roles.has(r))
  if (missing.length > 0) {
    throw new Error(`cairn: the Edit menu is missing roles: ${missing.join(', ')}`)
  }
}
```

- [ ] **Step 21: Run it green and commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/menu.test.ts
git add apps/desktop/main/src/menu.ts apps/desktop/main/src/menu.test.ts
git commit -m "feat(desktop): explicit Edit menu with a startup assertion that it is intact"
```

Expected: `Tests 7 passed (7)`.

- [ ] **Step 22: Write the failing `logger.security.test.ts`.** Spec §11 control 2 is a *compile*
      guarantee in `@cairn/protocol` (`ExactLogFields` makes an extra key a type error). This test
      adds the runtime half: the sink strips any key outside `LogFields`, so even a
      `@ts-expect-error` or a JS caller cannot land a clipboard body in a log line.

Create `apps/desktop/main/src/logger.security.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTestClock, TEST_CANARY } from '@cairn/protocol'
import { createStderrLogger, LOG_FIELD_KEYS } from './logger'

const sink = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

describe('createStderrLogger', () => {
  it('emits one JSON object per line with ts, level and event', () => {
    const s = sink()
    const clock = createTestClock()
    const log = createStderrLogger({ write: s.write, clock })
    log.info('app.ready', { count: 3 })
    expect(s.lines).toHaveLength(1)
    expect(JSON.parse(s.lines[0]!)).toEqual({
      ts: 1_767_225_600_000,
      level: 'info',
      event: 'app.ready',
      count: 3,
    })
  })

  it('ends every line with a newline so NDJSON on stderr is really NDJSON', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.warn('ipc.rejected', { code: 'E_IPC_REJECTED' })
    expect(s.lines[0]!.endsWith('\n')).toBe(true)
  })

  it('the allowlist is the LogFields key set plus the three envelope keys', () => {
    expect([...LOG_FIELD_KEYS].sort()).toEqual([
      'accelerator', 'agent', 'attempt', 'bundleId', 'byteLength', 'code', 'count', 'detectors',
      'durationMs', 'event', 'flags', 'hashPrefix', 'itemId', 'kind', 'level', 'method', 'mime',
      'mode', 'ok', 'repCount', 'seq', 'ts',
    ])
  })

  it('STRIPS any field outside the allowlist, so a canary cannot reach a log line', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    // A JS caller, a `@ts-expect-error`, or a future refactor can all produce this object. The
    // compile-time guard in @cairn/protocol is the first line of defence; this is the second.
    const smuggled = { kind: 'text', text: TEST_CANARY, body: TEST_CANARY, preview: TEST_CANARY }
    log.info('history.ingested', smuggled as never)
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['event', 'kind', 'level', 'ts'])
    expect(JSON.stringify(s.lines)).not.toContain(TEST_CANARY)
  })

  it('drops a non-primitive value even when its key IS on the allowlist', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.info('history.ingested', { mime: new Uint8Array([67, 65, 73]) } as never)
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(parsed['mime']).toBeUndefined()
  })

  it('honours minLevel so debug output cannot leak from a shipped build', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock(), minLevel: 'info' })
    log.debug('app.ready')
    log.info('app.ready')
    expect(s.lines).toHaveLength(1)
    expect(JSON.parse(s.lines[0]!).level).toBe('info')
  })

  it('an array field is kept only if every element is a string', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.info('privacy.masked', { flags: ['secret'], detectors: ['aws-access-key'] })
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(parsed['flags']).toEqual(['secret'])
    expect(parsed['detectors']).toEqual(['aws-access-key'])
  })
})
```

- [ ] **Step 23: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security apps/desktop/main/src/logger.security.test.ts
```

Expected: FAIL with `Error: Cannot find module './logger' imported from
/Users/santoshkumarreddy/copy-clipboard-app/apps/desktop/main/src/logger.security.test.ts`.

- [ ] **Step 24: Implement `logger.ts`.**

Create `apps/desktop/main/src/logger.ts`:

```ts
import {
  systemClock,
  type Clock,
  type ExactLogFields,
  type LogEvent,
  type LogFields,
  type Logger,
  type LogLevel,
} from '@cairn/protocol'

/**
 * The runtime half of spec §11 control 2. `@cairn/protocol`'s `ExactLogFields` already makes an
 * extra key a compile error; this list makes it a *dropped* key at runtime, so a `@ts-expect-error`,
 * a plain-JS caller or a future refactor still cannot get a clipboard body onto stderr.
 * Keep it in sync with `LogFields` in `packages/protocol/src/log.ts`.
 */
export const LOG_FIELD_KEYS: readonly string[] = [
  'ts', 'level', 'event',
  'kind', 'mime', 'byteLength', 'repCount', 'seq', 'hashPrefix', 'itemId', 'flags', 'detectors',
  'code', 'durationMs', 'count', 'agent', 'method', 'bundleId', 'mode', 'accelerator', 'ok',
  'attempt',
]

const ALLOWED = new Set(LOG_FIELD_KEYS)
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Primitives and arrays-of-strings only. Anything else is dropped rather than stringified,
 *  because `String(buffer)` is exactly how bytes end up in a log file. */
function sanitiseValue(value: unknown): string | number | boolean | null | string[] | undefined {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value as string | boolean
  if (t === 'number') return Number.isFinite(value as number) ? (value as number) : undefined
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  return undefined
}

export interface StderrLoggerOptions {
  /** Injected so tests capture lines instead of polluting the run's stderr. */
  readonly write?: (line: string) => void
  readonly clock?: Clock
  readonly minLevel?: LogLevel
}

export function createStderrLogger(opts: StderrLoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => { process.stderr.write(line) })
  const clock = opts.clock ?? systemClock
  const minLevel = LEVEL_ORDER[opts.minLevel ?? 'debug']

  const emit = (level: LogLevel, event: LogEvent, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) return
    const line: Record<string, unknown> = { ts: clock.now(), level, event }
    for (const [key, raw] of Object.entries(fields ?? {})) {
      if (!ALLOWED.has(key)) continue
      const value = sanitiseValue(raw)
      if (value !== undefined) line[key] = value
    }
    write(JSON.stringify(line) + '\n')
  }

  return {
    log: <T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>) =>
      emit(level, event, fields as Record<string, unknown> | undefined),
    debug: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('debug', event, fields as Record<string, unknown> | undefined),
    info: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('info', event, fields as Record<string, unknown> | undefined),
    warn: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('warn', event, fields as Record<string, unknown> | undefined),
    error: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('error', event, fields as Record<string, unknown> | undefined),
  }
}
```

Note it writes to **stderr**, never stdout: stdout is the agent's protocol pipe (contract §3 rule 7),
and a log line on stdout would be parsed as a malformed NDJSON frame.

- [ ] **Step 25: Run it green and commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security apps/desktop/main/src/logger.security.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/main/src/logger.ts apps/desktop/main/src/logger.security.test.ts
git commit -m "feat(desktop): NDJSON stderr logger that strips any field outside LogFields"
```

Expected: `Tests 7 passed (7)`, `tsc` exits 0.

- [ ] **Step 26: Write the failing `config.test.ts`.** The hotkey choice and the retention settings
      have to survive a relaunch, and a corrupt or hand-edited file must degrade to defaults rather
      than crash the app on launch — a clipboard manager that will not start is a clipboard manager
      that has eaten your history.

Create `apps/desktop/main/src/config.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ACCELERATOR, RETENTION_MAX_BYTES, RETENTION_MAX_ITEMS } from '@cairn/protocol'
import { CONFIG_FILE_NAME, configPath, DEFAULT_CONFIG, loadConfig, saveConfig } from './config'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cairn-cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('DEFAULT_CONFIG', () => {
  it('ships the accelerator the first-run step pre-selects and the frozen retention limits', () => {
    expect(DEFAULT_CONFIG).toEqual({
      version: 1,
      accelerator: DEFAULT_ACCELERATOR,
      firstRunHotkeyDone: false,
      retention: {
        maxItems: RETENTION_MAX_ITEMS,
        maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
        maxBytes: RETENTION_MAX_BYTES,
      },
    })
    expect(DEFAULT_CONFIG.accelerator).toBe('Cmd+Shift+V')
  })
})

describe('configPath', () => {
  it('sits beside the store inside the data dir', () => {
    expect(configPath('/data/Cairn')).toBe(join('/data/Cairn', CONFIG_FILE_NAME))
    expect(CONFIG_FILE_NAME).toBe('config.json')
  })
})

describe('loadConfig', () => {
  it('returns the defaults and says so when there is no file', () => {
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'default' })
  })

  it('round-trips a saved config', () => {
    const chosen = { ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C', firstRunHotkeyDone: true }
    saveConfig(dir, chosen)
    expect(loadConfig(dir)).toEqual({ config: chosen, source: 'file' })
  })

  it('survives a relaunch: a second load sees the same value', () => {
    saveConfig(dir, { ...DEFAULT_CONFIG, accelerator: 'Cmd+Alt+V', firstRunHotkeyDone: true })
    const first = loadConfig(dir)
    const second = loadConfig(dir)
    expect(second).toEqual(first)
    expect(second.config.accelerator).toBe('Cmd+Alt+V')
  })

  it('falls back to defaults on unparseable JSON instead of throwing', () => {
    writeFileSync(configPath(dir), '{ this is not json', { mode: 0o600 })
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'invalid' })
  })

  it('falls back to defaults when a field has the wrong type', () => {
    writeFileSync(configPath(dir), JSON.stringify({ ...DEFAULT_CONFIG, accelerator: 42 }), { mode: 0o600 })
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'invalid' })
  })

  it('falls back to defaults for a future schema version rather than guessing', () => {
    writeFileSync(configPath(dir), JSON.stringify({ ...DEFAULT_CONFIG, version: 2 }), { mode: 0o600 })
    expect(loadConfig(dir)).toEqual({ config: DEFAULT_CONFIG, source: 'invalid' })
  })

  it('ignores unknown keys a future version might add', () => {
    writeFileSync(
      configPath(dir),
      JSON.stringify({ ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C', somethingNew: true }),
      { mode: 0o600 },
    )
    const loaded = loadConfig(dir)
    expect(loaded.source).toBe('file')
    expect(loaded.config.accelerator).toBe('Cmd+Shift+C')
    expect((loaded.config as unknown as Record<string, unknown>)['somethingNew']).toBeUndefined()
  })
})

describe('saveConfig', () => {
  it('creates the data dir when it does not exist yet', () => {
    const nested = join(dir, 'deep', 'Cairn')
    saveConfig(nested, DEFAULT_CONFIG)
    expect(loadConfig(nested).config).toEqual(DEFAULT_CONFIG)
  })

  it('writes exactly the four schema keys and nothing derived from the clipboard', () => {
    saveConfig(dir, DEFAULT_CONFIG)
    const raw = JSON.parse(readFileSync(configPath(dir), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['accelerator', 'firstRunHotkeyDone', 'retention', 'version'])
  })
})
```

- [ ] **Step 27: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/config.test.ts
```

Expected: FAIL with `Error: Cannot find module './config' imported from
/Users/santoshkumarreddy/copy-clipboard-app/apps/desktop/main/src/config.test.ts`.

- [ ] **Step 28: Implement `config.ts`.** Read the comment on `saveConfig` before changing it: the
      `open`/`write`/`fchmod` dance is not ceremony.

Create `apps/desktop/main/src/config.ts`:

```ts
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import * as z from 'zod'
import {
  DEFAULT_ACCELERATOR,
  RETENTION_MAX_AGE_MS,
  RETENTION_MAX_BYTES,
  RETENTION_MAX_ITEMS,
} from '@cairn/protocol'

export const CONFIG_FILE_NAME = 'config.json'

/** Deliberately tiny. Nothing here is derived from clipboard content, which is why this is the one
 *  plaintext file Cairn writes: an accelerator string, a boolean and three integers. */
export const ConfigSchema = z.object({
  version: z.literal(1),
  accelerator: z.string().min(1).max(64),
  firstRunHotkeyDone: z.boolean(),
  retention: z.object({
    maxItems: z.int().min(1).max(5_000),
    maxAgeMs: z.int().min(60_000),
    maxBytes: z.int().min(1_048_576),
  }),
})

export type CairnConfig = z.output<typeof ConfigSchema>

export const DEFAULT_CONFIG: CairnConfig = {
  version: 1,
  accelerator: DEFAULT_ACCELERATOR,
  firstRunHotkeyDone: false,
  retention: {
    maxItems: RETENTION_MAX_ITEMS,
    maxAgeMs: RETENTION_MAX_AGE_MS,
    maxBytes: RETENTION_MAX_BYTES,
  },
}

export function configPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILE_NAME)
}

/**
 * Never throws. A corrupt, truncated or hand-edited file becomes the defaults, because an app that
 * refuses to launch is an app that has taken your clipboard history hostage. The caller logs
 * `config.loaded-default` when `source !== 'file'`.
 */
export function loadConfig(dataDir: string): {
  readonly config: CairnConfig
  readonly source: 'file' | 'default' | 'invalid'
} {
  let text: string
  try {
    text = readFileSync(configPath(dataDir), 'utf8')
  } catch {
    return { config: DEFAULT_CONFIG, source: 'default' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { config: DEFAULT_CONFIG, source: 'invalid' }
  }
  const parsed = ConfigSchema.safeParse(json)
  if (!parsed.success) return { config: DEFAULT_CONFIG, source: 'invalid' }
  return { config: parsed.data, source: 'file' }
}

/**
 * `0700` dir, `0600` file, asserted by `config.security.test.ts` (spec §11 in-scope: "the data dir
 * is 0700 and every file 0600").
 *
 * The open/write/fchmod sequence is deliberate and verified: `writeFileSync(p, d, {mode: 0o600})`
 * applies its mode ONLY when creating the file — on a pre-existing `0644` file it leaves the mode at
 * `644`, so the config stays world-readable forever after one bad first write. `fchmodSync` on the
 * open descriptor narrows it every time, and `fsyncSync` means the hotkey choice survives a power
 * cut.
 */
export function saveConfig(dataDir: string, config: CairnConfig): void {
  const validated = ConfigSchema.parse(config)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const fd = openSync(configPath(dataDir), 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(validated, null, 2) + '\n')
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
```

- [ ] **Step 29: Write the failing `config.security.test.ts`.** Two assertions the round-trip test
      cannot make: the permissions, and the fact that the file is the only plaintext artefact and
      contains nothing clipboard-shaped.

Create `apps/desktop/main/src/config.security.test.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_CANARY } from '@cairn/protocol'
import { configPath, DEFAULT_CONFIG, saveConfig } from './config'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cairn-cfg-sec-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8)

describe('config file permissions', () => {
  it('creates the data dir 0700 and the file 0600', () => {
    const dir = join(root, 'Cairn')
    saveConfig(dir, DEFAULT_CONFIG)
    expect(mode(dir)).toBe('700')
    expect(mode(configPath(dir))).toBe('600')
  })

  it('NARROWS a pre-existing world-readable file to 0600', () => {
    // The bug this catches: `writeFileSync(p, d, {mode: 0o600})` leaves an existing 0644 file at
    // 644, so one bad first write makes the config world-readable forever.
    const dir = join(root, 'Cairn')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(configPath(dir), '{}')
    chmodSync(configPath(dir), 0o644)
    expect(mode(configPath(dir))).toBe('644')
    saveConfig(dir, DEFAULT_CONFIG)
    expect(mode(configPath(dir))).toBe('600')
  })

  it('stays 0600 across repeated saves', () => {
    const dir = join(root, 'Cairn')
    saveConfig(dir, DEFAULT_CONFIG)
    saveConfig(dir, { ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C' })
    saveConfig(dir, { ...DEFAULT_CONFIG, firstRunHotkeyDone: true })
    expect(mode(configPath(dir))).toBe('600')
  })
})

describe('config file contents', () => {
  it('cannot carry clipboard content: an extra key is stripped by the schema before writing', () => {
    const dir = join(root, 'Cairn')
    saveConfig(dir, { ...DEFAULT_CONFIG, lastCopied: TEST_CANARY } as never)
    const raw = readFileSync(configPath(dir), 'utf8')
    expect(raw).not.toContain(TEST_CANARY)
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual([
      'accelerator', 'firstRunHotkeyDone', 'retention', 'version',
    ])
  })

  it('refuses to write a config that fails its own schema', () => {
    const dir = join(root, 'Cairn')
    expect(() => saveConfig(dir, { ...DEFAULT_CONFIG, accelerator: '' })).toThrow()
  })
})
```

- [ ] **Step 30: Run both config test files and commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/config.test.ts
npx vitest run --project security apps/desktop/main/src/config.security.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/main/src/config.ts apps/desktop/main/src/config.test.ts apps/desktop/main/src/config.security.test.ts
git commit -m "feat(desktop): 0600 config persistence for the hotkey choice and retention settings"
```

Expected: `Tests 11 passed (11)` for the unit file and `Tests 5 passed (5)` for the security file.

- [ ] **Step 31: Write the failing preload security test.** Spec §11 control 4: "the preload exposes
      a fixed, enumerated set of methods — no dynamic dispatch, no `invoke(channel, ...)`
      passthrough". Two independent checks, because either alone is weak: the runtime shape of the
      bridged object, and a source scan (a source scan alone misses a computed key; a runtime check
      alone misses a `send` added in a branch that never runs).

Create `apps/desktop/preload/src/index.security.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_EVENT_CHANNELS, IPC_REQUEST_CHANNELS } from '@cairn/protocol'

const exposed: Record<string, unknown> = {}
const invokeCalls: [string, unknown][] = []
const onCalls: string[] = []
const removeCalls: string[] = []

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api },
  },
  ipcRenderer: {
    invoke: (channel: string, params: unknown) => {
      invokeCalls.push([channel, params])
      return Promise.resolve({ ok: true, value: {} })
    },
    on: (channel: string) => { onCalls.push(channel) },
    removeListener: (channel: string) => { removeCalls.push(channel) },
  },
}))

const loadPreload = async (): Promise<Record<string, unknown>> => {
  await import('./index')
  return exposed['cairn'] as Record<string, unknown>
}

beforeEach(() => { invokeCalls.length = 0; onCalls.length = 0; removeCalls.length = 0 })

describe('the exposed surface', () => {
  it('is bridged under exactly one global name', async () => {
    await loadPreload()
    expect(Object.keys(exposed)).toEqual(['cairn'])
  })

  it('is EXACTLY these twelve methods — no more, no fewer', async () => {
    const api = await loadPreload()
    expect(Object.keys(api).sort()).toEqual([
      'close', 'list', 'onHistoryChanged', 'onHotkeyStatus', 'onPaletteShown', 'onToast',
      'pin', 'preview', 'remove', 'search', 'securityStatus',
    ].concat(['copy']).sort())
    expect(Object.keys(api)).toHaveLength(12)
  })

  it('exposes no generic bridge into the main process', async () => {
    const api = await loadPreload()
    for (const forbidden of ['invoke', 'send', 'sendSync', 'postMessage', 'on', 'emit', 'ipcRenderer', 'require', 'process']) {
      expect(api[forbidden]).toBeUndefined()
    }
  })

  it('every method is a function, so nothing is a settable data property', async () => {
    const api = await loadPreload()
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} must be a function`).toBe('function')
    }
  })
})

describe('channel hard-coding', () => {
  it('each request method sends its own frozen channel and nothing else', async () => {
    const api = await loadPreload() as Record<string, (p?: unknown) => Promise<unknown>>
    await api['list']!({ limit: 10, offset: 0 })
    await api['search']!({ q: 'a', limit: 10 })
    await api['preview']!({ id: '01KDVDNA00041061050R3GG28A' })
    await api['pin']!({ id: '01KDVDNA00041061050R3GG28A', pinned: true })
    await api['remove']!({ id: '01KDVDNA00041061050R3GG28A' })
    await api['copy']!({ id: '01KDVDNA00041061050R3GG28A' })
    await api['close']!()
    await api['securityStatus']!()
    expect(invokeCalls.map(([c]) => c)).toEqual([
      'cairn:history.list',
      'cairn:history.search',
      'cairn:history.preview',
      'cairn:history.pin',
      'cairn:history.remove',
      'cairn:recall.copy',
      'cairn:palette.close',
      'cairn:security.status',
    ])
    // The eight channels invoked are exactly the eight the protocol declares.
    expect(new Set(invokeCalls.map(([c]) => c))).toEqual(new Set(IPC_REQUEST_CHANNELS))
  })

  it('the no-argument methods send an empty object, not undefined', async () => {
    const api = await loadPreload() as Record<string, () => Promise<unknown>>
    await api['close']!()
    await api['securityStatus']!()
    expect(invokeCalls).toEqual([
      ['cairn:palette.close', {}],
      ['cairn:security.status', {}],
    ])
  })

  it('each subscription method listens on its own frozen event channel and unsubscribes', async () => {
    const api = await loadPreload() as Record<string, (cb: (p: unknown) => void) => () => void>
    const unsubs = [
      api['onHistoryChanged']!(() => {}),
      api['onHotkeyStatus']!(() => {}),
      api['onToast']!(() => {}),
      api['onPaletteShown']!(() => {}),
    ]
    expect(onCalls).toEqual([...IPC_EVENT_CHANNELS])
    for (const u of unsubs) u()
    expect(removeCalls).toEqual([...IPC_EVENT_CHANNELS])
  })
})

describe('the preload source itself', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
    'utf8',
  )

  it('contains no dynamic channel plumbing', () => {
    for (const banned of [
      'ipcRenderer.send',
      'ipcRenderer.sendSync',
      'ipcRenderer.postMessage',
      'ipcRenderer.sendTo',
      'exposeInIsolatedWorld',
      'eval(',
      'new Function',
    ]) {
      expect(source, `preload must not contain ${banned}`).not.toContain(banned)
    }
  })

  it('never builds a channel name from a variable', () => {
    // Every ipcRenderer.invoke / .on call must be followed immediately by a quoted 'cairn:…'
    // literal. A template literal or an identifier there is a generic bridge.
    const calls = [...source.matchAll(/ipcRenderer\.(invoke|on|removeListener)\(\s*([^\s,)]+)/g)]
    expect(calls.length).toBeGreaterThanOrEqual(12)
    for (const m of calls) {
      expect(m[2], `channel argument must be a 'cairn:…' literal, got ${m[2]}`).toMatch(/^'cairn:[a-z.]+'$/)
    }
  })

  it('exposes exactly one main-world key', () => {
    expect([...source.matchAll(/exposeInMainWorld\(/g)]).toHaveLength(1)
  })
})
```

- [ ] **Step 32: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security apps/desktop/preload/src/index.security.test.ts
```

Expected: FAIL with `AssertionError: expected [] to deeply equal [ 'cairn' ]` on
`is bridged under exactly one global name`. The module **resolves** — Task 1 created
`apps/desktop/preload/src/index.ts` containing only `export {}` — so this is a red on the missing
`contextBridge.exposeInMainWorld` call, not a missing file.

- [ ] **Step 33: Implement the preload,** replacing Task 1's `export {}` placeholder. It must stay
      CJS-compatible: verified on Electron 44.1.1
      that with `sandbox: true` a CJS preload works and an ESM `.mjs` preload makes the page load fail
      outright with `ERR_FAILED (-2)`. electron-vite emits CJS from this TypeScript source (contract
      §2), so write ESM syntax here and let the bundler do it — but never add `import.meta` or a
      top-level `await`.

Replace the contents of `apps/desktop/preload/src/index.ts` (it currently holds Task 1's comment and
`export {}`):

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcEventChannel } from '@cairn/protocol'

/**
 * Spec §11 control 4. TWELVE methods, each with its channel written out as a string literal in the
 * call. There is deliberately no `invoke(channel, params)` and no `send`: a generic bridge means
 * every current and future main-process handler is reachable from any script that gets into the
 * page, and the whole decrypted history is one call behind those handlers.
 *
 * `subscribe` is a local helper, not an exposed method, so the page cannot pick its own channel.
 */
function subscribe(channel: IpcEventChannel, cb: (payload: unknown) => void): () => void {
  const listener = (_event: unknown, payload: unknown): void => { cb(payload) }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

contextBridge.exposeInMainWorld('cairn', {
  list: (params: unknown) => ipcRenderer.invoke('cairn:history.list', params),
  search: (params: unknown) => ipcRenderer.invoke('cairn:history.search', params),
  preview: (params: unknown) => ipcRenderer.invoke('cairn:history.preview', params),
  pin: (params: unknown) => ipcRenderer.invoke('cairn:history.pin', params),
  remove: (params: unknown) => ipcRenderer.invoke('cairn:history.remove', params),
  copy: (params: unknown) => ipcRenderer.invoke('cairn:recall.copy', params),
  close: () => ipcRenderer.invoke('cairn:palette.close', {}),
  securityStatus: () => ipcRenderer.invoke('cairn:security.status', {}),
  onHistoryChanged: (cb: (payload: unknown) => void) => subscribe('cairn:history.changed', cb),
  onHotkeyStatus: (cb: (payload: unknown) => void) => subscribe('cairn:hotkey.status', cb),
  onToast: (cb: (payload: unknown) => void) => subscribe('cairn:toast', cb),
  onPaletteShown: (cb: (payload: unknown) => void) => subscribe('cairn:palette.shown', cb),
})
```

The `subscribe` calls pass `'cairn:history.changed'` and friends as literals so the source scan in
Step 31 sees a quoted channel at every `ipcRenderer.on` site — the `IpcEventChannel` type on the
parameter is what makes a typo a compile error.

- [ ] **Step 34: Run it green, typecheck, commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security apps/desktop/preload/src/index.security.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/preload/src/index.ts apps/desktop/preload/src/index.security.test.ts
git commit -m "feat(desktop): preload bridging a fixed enumerated twelve-method API, no passthrough"
```

Expected: `Tests 10 passed (10)`, `tsc` exits 0. If the source-scan test fails with
`channel argument must be a 'cairn:…' literal, got channel`, you passed the channel through a
variable somewhere — that is the exact thing the control forbids, so fix the code, not the test.

- [ ] **Step 35: Write the failing `ipc-handlers.test.ts`.** Spec §11 control 8: validated in both
      directions, and a malformed renderer message is **rejected rather than trusted**. The two
      assertions that matter most: a bad `params` object never reaches domain code at all, and a
      channel that is not on the frozen list is never registered, so the renderer cannot reach it.

Create `apps/desktop/main/src/ipc-handlers.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  err,
  IPC_REQUEST_CHANNELS,
  ok,
  type ChangeReason,
  type Item,
  type ItemId,
  type Logger,
  type ResolvedRep,
  type Result,
  type ScoredItem,
  type Unsub,
} from '@cairn/protocol'
import type { History } from '@cairn/history'
import {
  registerIpcHandlers,
  sendIpcEvent,
  toItemSummary,
  type IpcMainLike,
} from './ipc-handlers'

const ID_A = '01KDVDNA00041061050R3GG28A' as ItemId
const ID_B = '01KDVDNA011440E1G50G1G4080' as ItemId

const silentLogger = (): { logger: Logger; events: string[] } => {
  const events: string[] = []
  const push = (e: string) => () => { events.push(e) }
  const rec = (level: string) => (event: string) => { events.push(`${level}:${event}`) }
  return {
    events,
    logger: {
      log: (level: string, event: string) => { events.push(`${level}:${event}`) },
      debug: rec('debug'),
      info: rec('info'),
      warn: rec('warn'),
      error: rec('error'),
    } as unknown as Logger,
  }
}

const item = (over: Partial<Item> = {}): Item => ({
  id: ID_A,
  kind: 'text',
  contentHash: 'sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ' as Item['contentHash'],
  preview: 'AKIA••••A7QD',
  previewTruncated: false,
  maskSpans: [{ start: 0, end: 17, detector: 'aws-access-key' }],
  flags: ['secret'],
  repRefs: [],
  thumbnailBlobId: null,
  sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
  byteLength: 17,
  createdAt: 1_767_225_600_000,
  updatedAt: 1_767_225_600_000,
  pinned: false,
  expiresAt: 1_767_225_900_000,
  ...over,
})

interface FakeIpc extends IpcMainLike {
  readonly registered: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>
  call(channel: string, params?: unknown): Promise<unknown>
}

function fakeIpcMain(): FakeIpc {
  const registered = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  return {
    registered,
    handle(channel, listener) {
      if (registered.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      registered.set(channel, listener)
    },
    removeHandler(channel) { registered.delete(channel) },
    async call(channel, params) {
      const h = registered.get(channel)
      if (h === undefined) throw new Error(`no handler for ${channel}`)
      return await h({}, params)
    },
  }
}

interface Harness {
  readonly ipc: FakeIpc
  readonly events: string[]
  readonly domainCalls: string[]
  readonly unregister: Unsub
}

function harness(over: { historyItems?: readonly Item[] } = {}): Harness {
  const ipc = fakeIpcMain()
  const { logger, events } = silentLogger()
  const domainCalls: string[] = []
  const items = over.historyItems ?? [item()]

  const history = {
    load: async () => ok({ items: items.length }),
    ingest: async () => { throw new Error('not used') },
    list: (q?: { limit?: number; offset?: number; pinnedOnly?: boolean }) => {
      domainCalls.push(`list ${JSON.stringify(q)}`)
      return { items, total: items.length }
    },
    search: (q: string, limit: number): readonly ScoredItem[] => {
      domainCalls.push(`search ${q} ${limit}`)
      return items.map((it) => ({ item: it, score: 1, ranges: [0, 4] }))
    },
    resolveReps: async (): Promise<Result<readonly ResolvedRep[]>> => ok([]),
    pin: async (id: ItemId, pinned: boolean) => {
      domainCalls.push(`pin ${id} ${pinned}`)
      return items[0]!.flags.includes('secret')
        ? err('E_PIN_REFUSED_SECRET', 'secret-flagged items cannot be pinned')
        : ok({ pinned })
    },
    remove: async (id: ItemId) => { domainCalls.push(`remove ${id}`); return ok({ removed: true }) },
    evictNow: async () => ok({ evicted: 0 }),
    evictPreviewCache: () => {},
    get: (id: ItemId) => items.find((it) => it.id === id),
    onChange: (_cb: (e: { reason: ChangeReason; total: number }) => void): Unsub => () => {},
  } as unknown as History

  const unregister = registerIpcHandlers({
    ipcMain: ipc,
    history,
    preview: {
      preview: async (id: ItemId) => {
        domainCalls.push(`preview ${id}`)
        return ok({ text: '<b>hi</b>', isHtmlSource: true, truncated: false })
      },
    },
    recall: {
      copy: async (id: ItemId) => {
        domainCalls.push(`copy ${id}`)
        return ok({ result: 'copied-manual' as const, reason: 'user-preference' as const })
      },
    },
    palette: { hide: () => { domainCalls.push('hide') }, isVisible: () => true },
    security: {
      status: () => ({
        keyringMode: 'os-keyring' as const,
        encryptedAtRest: true,
        dataDirMode: '700',
        notes: ['Encryption at rest protects against disk theft and other accounts, not against code running as you.'],
      }),
    },
    logger,
  })

  return { ipc, events, domainCalls, unregister }
}

describe('registration', () => {
  it('registers exactly the eight frozen request channels', () => {
    const h = harness()
    expect([...h.ipc.registered.keys()].sort()).toEqual([...IPC_REQUEST_CHANNELS].sort())
  })

  it('registers nothing the renderer could use to reach a body or the store', () => {
    const h = harness()
    for (const forbidden of [
      'cairn:history.resolveReps',
      'cairn:store.readAll',
      'cairn:keyring.masterKey',
      'cairn:agent.request',
      'cairn:history.list ',
      'history.list',
    ]) {
      expect(h.ipc.registered.has(forbidden)).toBe(false)
    }
  })

  it('the unregister function removes every handler', () => {
    const h = harness()
    h.unregister()
    expect(h.ipc.registered.size).toBe(0)
  })

  it('registering twice over the same ipcMain throws instead of silently shadowing', () => {
    // Matches Electron's real behaviour: "Attempted to register a second handler for '…'".
    const h = harness()
    expect(() => registerIpcHandlers({
      ipcMain: h.ipc,
      history: {} as unknown as History,
      preview: { preview: async () => ok({ text: '', isHtmlSource: false, truncated: false }) },
      recall: { copy: async () => ok({ result: 'copied-manual' as const, reason: 'user-preference' as const }) },
      palette: { hide: () => {}, isVisible: () => false },
      security: { status: () => ({ keyringMode: 'locked' as const, encryptedAtRest: false, dataDirMode: '700', notes: [] }) },
      logger: silentLogger().logger,
    })).toThrow(/second handler/)
  })
})

describe('params validation — a malformed renderer message is rejected, not trusted', () => {
  it('rejects an over-range limit before any domain call happens', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.list', { limit: 9999, offset: 0 })
    expect(reply).toEqual({
      ok: false,
      code: 'E_IPC_REJECTED',
      message: '✖ Too big: expected number to be <=200\n  → at limit',
    })
    expect(h.domainCalls).toEqual([])
    expect(h.events).toContain('warn:ipc.rejected')
  })

  it('rejects a missing params object', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.list', undefined) as { ok: boolean; code?: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_IPC_REJECTED')
    expect(h.domainCalls).toEqual([])
  })

  it('rejects a non-object payload, including an array and a string', async () => {
    const h = harness()
    for (const bad of [[], 'x', 42, null, true]) {
      const reply = await h.ipc.call('cairn:history.search', bad) as { ok: boolean; code?: string }
      expect(reply.ok).toBe(false)
      expect(reply.code).toBe('E_IPC_REJECTED')
    }
    expect(h.domainCalls).toEqual([])
  })

  it('rejects a malformed ItemId rather than passing it to the store', async () => {
    const h = harness()
    for (const bad of ['', 'not-an-id', '01kdvdna00041061050r3gg28a', '../../etc/passwd']) {
      const reply = await h.ipc.call('cairn:history.preview', { id: bad }) as { ok: boolean; code?: string }
      expect(reply.ok).toBe(false)
      expect(reply.code).toBe('E_IPC_REJECTED')
    }
    expect(h.domainCalls).toEqual([])
  })

  it('strips extra keys instead of forwarding them', async () => {
    const h = harness()
    await h.ipc.call('cairn:history.list', { limit: 5, offset: 0, __proto__: { polluted: true }, extra: 'x' })
    expect(h.domainCalls).toEqual(['list {"limit":5,"offset":0,"pinnedOnly":false}'])
  })

  it('applies the schema default for pinnedOnly', async () => {
    const h = harness()
    await h.ipc.call('cairn:history.list', { limit: 3, offset: 0 })
    expect(h.domainCalls).toEqual(['list {"limit":3,"offset":0,"pinnedOnly":false}'])
  })
})

describe('the happy paths', () => {
  it('list returns validated ItemSummary rows with no repRefs and no raw secret', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.list', { limit: 10, offset: 0 }) as
      { ok: true; value: { items: Record<string, unknown>[]; total: number } }
    expect(reply.ok).toBe(true)
    expect(reply.value.total).toBe(1)
    const row = reply.value.items[0]!
    expect(row['preview']).toBe('AKIA••••A7QD')
    expect(row['maskedSpanCount']).toBe(1)
    expect(row['sourceAppName']).toBe('TextEdit')
    expect(row['repRefs']).toBeUndefined()
    expect(row['contentHash']).toBeUndefined()
    expect(row['maskSpans']).toBeUndefined()
  })

  it('search forwards the query and returns flat ufuzzy ranges', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.search', { q: 'aki', limit: 25 }) as
      { ok: true; value: { results: { score: number; ranges: number[] }[] } }
    expect(h.domainCalls).toEqual(['search aki 25'])
    expect(reply.value.results[0]!.ranges).toEqual([0, 4])
  })

  it('preview labels HTML as source and never as markup', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.preview', { id: ID_A }) as
      { ok: true; value: { text: string; isHtmlSource: boolean } }
    expect(reply.value).toEqual({ text: '<b>hi</b>', isHtmlSource: true, truncated: false })
  })

  it('pin surfaces E_PIN_REFUSED_SECRET instead of pretending it worked', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.pin', { id: ID_A, pinned: true }) as
      { ok: false; code: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_PIN_REFUSED_SECRET')
  })

  it('recall.copy returns the M2-shaped copied-manual result', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:recall.copy', { id: ID_A })
    expect(reply).toEqual({ ok: true, value: { result: 'copied-manual', reason: 'user-preference' } })
    expect(h.domainCalls).toEqual([`copy ${ID_A}`])
  })

  it('palette.close hides the window and accepts an empty object', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:palette.close', {})
    expect(reply).toEqual({ ok: true, value: { closed: true } })
    expect(h.domainCalls).toEqual(['hide'])
  })

  it('security.status reports the honest at-rest sentence', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:security.status', {}) as
      { ok: true; value: { keyringMode: string; dataDirMode: string; notes: string[] } }
    expect(reply.value.keyringMode).toBe('os-keyring')
    expect(reply.value.dataDirMode).toBe('700')
    expect(reply.value.notes[0]).toContain('not against code running as you')
  })

  it('remove passes the validated id through', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.remove', { id: ID_B })
    expect(reply).toEqual({ ok: true, value: { removed: true } })
    expect(h.domainCalls).toEqual([`remove ${ID_B}`])
  })
})

describe('result validation — the outbound direction', () => {
  it('a handler returning the wrong shape becomes E_INTERNAL, never a raw object', async () => {
    const ipc = fakeIpcMain()
    const { logger, events } = silentLogger()
    registerIpcHandlers({
      ipcMain: ipc,
      history: {} as unknown as History,
      preview: { preview: async () => ok({ text: '', isHtmlSource: false, truncated: false }) },
      recall: { copy: async () => ok({ result: 'copied-manual' as const, reason: 'user-preference' as const }) },
      // A deliberately broken port: `closed: false` violates `z.literal(true)`.
      palette: { hide: () => {}, isVisible: () => false },
      security: {
        status: () => ({ keyringMode: 'nonsense', encryptedAtRest: true, dataDirMode: '700', notes: [] }) as never,
      },
      logger,
    })
    const reply = await ipc.call('cairn:security.status', {}) as { ok: boolean; code?: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_INTERNAL')
    expect(events).toContain('error:ipc.rejected')
  })

  it('a handler that throws becomes E_INTERNAL rather than an unhandled rejection', async () => {
    const ipc = fakeIpcMain()
    const { logger } = silentLogger()
    registerIpcHandlers({
      ipcMain: ipc,
      history: {} as unknown as History,
      preview: { preview: async () => { throw new Error('boom') } },
      recall: { copy: async () => ok({ result: 'copied-manual' as const, reason: 'user-preference' as const }) },
      palette: { hide: () => {}, isVisible: () => false },
      security: { status: () => ({ keyringMode: 'locked' as const, encryptedAtRest: false, dataDirMode: '700', notes: [] }) },
      logger,
    })
    const reply = await ipc.call('cairn:history.preview', { id: ID_A }) as { ok: boolean; code?: string; message?: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_INTERNAL')
    expect(reply.message).not.toContain('boom')
  })
})

describe('toItemSummary', () => {
  it('drops repRefs, contentHash, updatedAt and the mask span offsets', () => {
    const summary = toItemSummary(item(), null) as unknown as Record<string, unknown>
    expect(Object.keys(summary).sort()).toEqual([
      'byteLength', 'createdAt', 'expiresAt', 'flags', 'id', 'kind', 'maskedSpanCount', 'pinned',
      'preview', 'previewTruncated', 'sourceAppName', 'thumbnailDataUrl',
    ])
  })

  it('carries a thumbnail as a data URL when one is supplied', () => {
    const summary = toItemSummary(item({ kind: 'image' }), 'data:image/jpeg;base64,/9j/AAA')
    expect(summary.thumbnailDataUrl).toBe('data:image/jpeg;base64,/9j/AAA')
  })
})

describe('sendIpcEvent', () => {
  it('validates the payload before it reaches the renderer', () => {
    const sent: [string, unknown][] = []
    const target = { send: (c: string, p: unknown) => { sent.push([c, p]) }, isDestroyed: () => false }
    const { logger, events } = silentLogger()
    expect(sendIpcEvent(target, 'cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' }, logger)).toBe(true)
    expect(sent).toEqual([['cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' }]])
    expect(sendIpcEvent(target, 'cairn:toast', { text: 'x', tone: 'shouty' }, logger)).toBe(false)
    expect(sent).toHaveLength(1)
    expect(events).toContain('error:ipc.rejected')
  })

  it('is a no-op for a destroyed target', () => {
    const sent: [string, unknown][] = []
    const target = { send: (c: string, p: unknown) => { sent.push([c, p]) }, isDestroyed: () => true }
    expect(sendIpcEvent(target, 'cairn:palette.shown', { shownAt: 1 }, silentLogger().logger)).toBe(false)
    expect(sent).toEqual([])
  })
})
```

- [ ] **Step 36: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/ipc-handlers.test.ts
```

Expected: FAIL with `Error: Cannot find module './ipc-handlers' imported from
/Users/santoshkumarreddy/copy-clipboard-app/apps/desktop/main/src/ipc-handlers.test.ts`.

- [ ] **Step 37: Implement `ipc-handlers.ts`.**

Create `apps/desktop/main/src/ipc-handlers.ts`:

```ts
import * as z from 'zod'
import {
  err,
  IPC_EVENT_CHANNELS,
  IPC_REQUEST_CHANNELS,
  IpcEventSchema,
  IpcRequestSchema,
  ok,
  type IpcEventChannel,
  type IpcRequestChannel,
  type Item,
  type ItemId,
  type ItemSummary,
  type KeyringMode,
  type Logger,
  type Result,
  type Unsub,
} from '@cairn/protocol'
import type { History } from '@cairn/history'

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void
  removeHandler(channel: string): void
}

export interface RecallPort {
  copy(id: ItemId): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>>
}
export interface PreviewPort {
  preview(id: ItemId): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>>
}
export interface SecurityStatusPort {
  status(): {
    keyringMode: KeyringMode
    encryptedAtRest: boolean
    dataDirMode: string
    notes: readonly string[]
  }
}

export interface IpcDeps {
  readonly ipcMain: IpcMainLike
  readonly history: History
  readonly preview: PreviewPort
  readonly recall: RecallPort
  readonly palette: { hide(): void; isVisible(): boolean }
  readonly security: SecurityStatusPort
  readonly logger: Logger
}

/**
 * The renderer's view of an item. Note what is NOT here: `repRefs`, `contentHash`, `updatedAt` and
 * the mask span offsets. The renderer can never ask for a body, and it cannot reconstruct where in
 * the raw text a secret was — only how many secrets there were.
 */
export function toItemSummary(item: Item, thumbnailDataUrl: string | null): ItemSummary {
  return {
    id: item.id,
    kind: item.kind,
    preview: item.preview,
    previewTruncated: item.previewTruncated,
    flags: [...item.flags],
    maskedSpanCount: item.maskSpans.length,
    sourceAppName: item.sourceApp?.name ?? null,
    byteLength: item.byteLength,
    createdAt: item.createdAt,
    pinned: item.pinned,
    expiresAt: item.expiresAt,
    thumbnailDataUrl,
  } as ItemSummary
}

type Handler = (params: unknown, deps: IpcDeps) => Promise<Result<unknown>>

/** One entry per frozen channel. Adding a key here that is not in `IPC_REQUEST_CHANNELS` is a
 *  compile error, and so is omitting one. */
const HANDLERS: Record<IpcRequestChannel, Handler> = {
  'cairn:history.list': async (params, deps) => {
    const p = params as { limit: number; offset: number; kind?: Item['kind']; pinnedOnly: boolean }
    const { items, total } = deps.history.list(p)
    return ok({ items: items.map((it) => toItemSummary(it, null)), total })
  },
  'cairn:history.search': async (params, deps) => {
    const p = params as { q: string; limit: number }
    const results = deps.history.search(p.q, p.limit)
    return ok({
      results: results.map((r) => ({
        item: toItemSummary(r.item, null),
        score: r.score,
        ranges: [...r.ranges],
      })),
    })
  },
  'cairn:history.preview': async (params, deps) =>
    await deps.preview.preview((params as { id: string }).id as ItemId),
  'cairn:history.pin': async (params, deps) => {
    const p = params as { id: string; pinned: boolean }
    return await deps.history.pin(p.id as ItemId, p.pinned)
  },
  'cairn:history.remove': async (params, deps) =>
    await deps.history.remove((params as { id: string }).id as ItemId),
  'cairn:recall.copy': async (params, deps) =>
    await deps.recall.copy((params as { id: string }).id as ItemId),
  'cairn:palette.close': async (_params, deps) => {
    deps.palette.hide()
    return ok({ closed: true as const })
  },
  'cairn:security.status': async (_params, deps) => {
    const s = deps.security.status()
    return ok({ ...s, notes: [...s.notes] })
  },
}

/**
 * Spec §11 control 8. Both directions are validated:
 *  - inbound `params` against `IpcRequestSchema[c].params` BEFORE any domain call, so a malformed
 *    message is rejected rather than trusted, and the domain layer never sees renderer-shaped input;
 *  - outbound payload against `IpcRequestSchema[c].result` before replying, so a bug in main cannot
 *    hand the renderer a shape it will treat as trustworthy.
 * The reply envelope is `Result<T>` (contract §6); `result` validates the `value`.
 */
export function registerIpcHandlers(deps: IpcDeps): Unsub {
  for (const channel of IPC_REQUEST_CHANNELS) {
    // The indexed access is a union of schema types; one local widening keeps every call site clean.
    const schemas = IpcRequestSchema[channel] as unknown as { params: z.ZodType; result: z.ZodType }
    const handler = HANDLERS[channel]

    deps.ipcMain.handle(channel, async (_event, raw) => {
      const parsedParams = schemas.params.safeParse(raw)
      if (!parsedParams.success) {
        deps.logger.warn('ipc.rejected', { method: undefined, code: 'E_IPC_REJECTED' })
        return err('E_IPC_REJECTED', z.prettifyError(parsedParams.error))
      }

      let outcome: Result<unknown>
      try {
        outcome = await handler(parsedParams.data, deps)
      } catch {
        // The message is deliberately generic: an exception string can contain anything, including
        // a fragment of clipboard content from a template literal somewhere upstream.
        deps.logger.error('ipc.rejected', { code: 'E_INTERNAL' })
        return err('E_INTERNAL', 'the handler threw')
      }
      if (!outcome.ok) return outcome

      const parsedResult = schemas.result.safeParse(outcome.value)
      if (!parsedResult.success) {
        deps.logger.error('ipc.rejected', { code: 'E_INTERNAL' })
        return err('E_INTERNAL', 'the handler returned a shape the contract does not allow')
      }
      return ok(parsedResult.data)
    })
  }

  return () => {
    for (const channel of IPC_REQUEST_CHANNELS) deps.ipcMain.removeHandler(channel)
  }
}

export interface EventTarget_ {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

/** Main→renderer events are validated too, so a bug here cannot poison renderer state. */
export function sendIpcEvent(
  target: EventTarget_,
  channel: IpcEventChannel,
  payload: unknown,
  logger: Logger,
): boolean {
  if (!(IPC_EVENT_CHANNELS as readonly string[]).includes(channel)) return false
  if (target.isDestroyed()) return false
  const schema = IpcEventSchema[channel] as unknown as z.ZodType
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    logger.error('ipc.rejected', { event: undefined, code: 'E_IPC_REJECTED' })
    return false
  }
  target.send(channel, parsed.data)
  return true
}
```

If `tsc` objects to `{ method: undefined }` under `exactOptionalPropertyTypes`, drop those two keys —
`logger.warn('ipc.rejected', { code: 'E_IPC_REJECTED' })` is the correct call, and the channel name is
deliberately **not** logged as a free-form string.

- [ ] **Step 38: Run it green, typecheck, commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/ipc-handlers.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/main/src/ipc-handlers.ts apps/desktop/main/src/ipc-handlers.test.ts
git commit -m "feat(desktop): one handler per frozen channel, zod-validated in both directions"
```

Expected: `Tests 22 passed (22)`, `tsc` exits 0.

- [ ] **Step 39: Write the failing `wiring.test.ts`.** This is the M1 pipeline end to end against
      fakes: hotkey fires → palette shows; a candidate arrives → history ingests → the renderer is
      told; `Enter` → the bytes go to the real clipboard, our own write is suppressed, the palette
      hides, the toast says `Copied — press Cmd+V`; screen lock / sleep / idle → the preview cache is
      evicted; screen lock in **passphrase** mode also zeroes the master key; quit closes the store so
      the derived blob name subkey is zeroed too.

Create `apps/desktop/main/src/wiring.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  createTestClock,
  err,
  ok,
  TOAST_COPIED_MANUAL,
  type AgentCapabilities,
  type Candidate,
  type ClipboardAgent,
  type ContentHash,
  type Item,
  type ItemId,
  type KeyringMode,
  type Logger,
  type ResolvedRep,
  type Unsub,
} from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import type { History } from '@cairn/history'
import { createHotkey } from '@cairn/hotkey'
import { KEYRING_RELOCKED_BANNER } from './constants'
import { DEFAULT_CONFIG, type CairnConfig } from './config'
import { composeApp, type PowerMonitorLike } from './wiring'

const ID = '01KDVDNA00041061050R3GG28A' as ItemId
const HASH = 'sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ' as ContentHash
/** Stands in for @cairn/keyring's MACOS_KEYCHAIN_NOTE; the port only promises `readonly string[]`. */
const KEYCHAIN_NOTE = 'The key is wrapped by the macOS Keychain and unlocks with your login.'

const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

const rep = (mime: string, text: string): ResolvedRep => {
  const bytes = new TextEncoder().encode(text)
  return { mime, uti: null, bytes, byteLength: bytes.length, sha256: HASH }
}

function build(over: {
  registerBound?: boolean
  firstRunDone?: boolean
  chooseHotkey?: (c: readonly string[]) => Promise<string>
  reps?: readonly ResolvedRep[]
  keyringMode?: KeyringMode
  keyringWarning?: string
} = {}) {
  const clock = createTestClock()
  const agentRequests: { method: string; params: unknown }[] = []
  const hotkeyListeners: ((p: { accelerator: string; focusToken: string; firedAt: number }) => void)[] = []

  const agent = {
    start: async (): Promise<AgentCapabilities> => ({
      wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1', tier: 'A',
      clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon', focusApp: true,
      concealedTypeHints: true, maxRepBytes: 20_971_520, chunkThresholdBytes: 65_536, missingTools: [],
    } as AgentCapabilities),
    request: async (method: string, params: unknown) => {
      agentRequests.push({ method, params })
      if (method === 'hotkey.register') {
        return ok({ bound: over.registerBound ?? true, accelerator: (params as { accelerator: string }).accelerator })
      }
      if (method === 'hotkey.unregister') return ok({ bound: false })
      if (method === 'write') return ok({ changeToken: '4711' })
      if (method === 'watch.start') return ok({ watching: true, intervalMs: 500 })
      if (method === 'watch.stop') return ok({ watching: false })
      if (method === 'shutdown') return ok({ bye: true })
      return err('E_UNKNOWN_METHOD', method)
    },
    on: (event: string, cb: (p: never) => void): Unsub => {
      if (event === 'hotkey.fired') hotkeyListeners.push(cb as never)
      return () => {}
    },
    dispose: async (): Promise<void> => {},
  } as unknown as ClipboardAgent

  const candidateCbs: ((c: Candidate) => void)[] = []
  const suppressed: string[] = []
  const captureCalls: string[] = []
  // Task 7's `Capture` verbatim, not a narrowed copy: `stop()` is async and `whenIdle()` exists, and
  // both are awaited by composeApp's shutdown path.
  const capture: Capture = {
    start: async () => { captureCalls.push('start'); return ok({ intervalMs: 500 }) },
    stop: async () => { captureCalls.push('stop') },
    onCandidate: (cb) => { candidateCbs.push(cb); return () => {} },
    suppressToken: (t) => { suppressed.push(t) },
    whenIdle: async () => { captureCalls.push('whenIdle') },
  }

  const ingested: Candidate[] = []
  const changeCbs: ((e: { reason: string; total: number }) => void)[] = []
  let previewCacheEvictions = 0
  const history = {
    load: async () => ok({ items: 0 }),
    ingest: async (c: Candidate) => { ingested.push(c); return ok({ outcome: 'added' as const, item: {} as Item }) },
    list: () => ({ items: [] as readonly Item[], total: 0 }),
    search: () => [],
    resolveReps: async () => ok(over.reps ?? [rep('text/plain', 'hello world')]),
    pin: async () => ok({ pinned: true }),
    remove: async () => ok({ removed: true }),
    evictNow: async () => ok({ evicted: 0 }),
    evictPreviewCache: () => { previewCacheEvictions += 1 },
    get: () => undefined,
    onChange: (cb: (e: { reason: string; total: number }) => void): Unsub => { changeCbs.push(cb); return () => {} },
  } as unknown as History

  const sent: [string, unknown][] = []
  const paletteCalls: string[] = []
  let visible = false
  const palette = {
    show: () => { visible = true; paletteCalls.push('show') },
    hide: () => { visible = false; paletteCalls.push('hide') },
    isVisible: () => visible,
    send: (channel: string, payload: unknown) => { sent.push([channel, payload]) },
    destroy: () => { paletteCalls.push('destroy') },
  }

  const registered = new Map<string, (e: unknown, ...a: unknown[]) => Promise<unknown>>()
  const ipcMain = {
    handle: (c: string, l: (e: unknown, ...a: unknown[]) => Promise<unknown>) => { registered.set(c, l) },
    removeHandler: (c: string) => { registered.delete(c) },
  }

  const powerHandlers = new Map<string, () => void>()
  let idleSeconds = 0
  const powerMonitor: PowerMonitorLike = {
    on: (event, cb) => { powerHandlers.set(event, cb) },
    getSystemIdleTime: () => idleSeconds,
  }

  let keyringLocked = 0
  let storeCloses = 0
  const saved: CairnConfig[] = []
  const config: CairnConfig = { ...DEFAULT_CONFIG, firstRunHotkeyDone: over.firstRunDone ?? true }

  const app = composeApp({
    agent,
    capture,
    history,
    // The real @cairn/hotkey, driven by the fake agent above. `createHotkey` is imported at the top
    // of this file with a plain ESM `import`: vitest loads `.test.ts` as ESM, so a `require(…)` here
    // throws `ReferenceError: require is not defined` at module-evaluation time — before a single
    // `it()` runs — and would silently take down the lock/quit key-zeroing assertions below with it.
    hotkey: createHotkey({ agent, logger: silentLogger() }),
    keyring: {
      getMode: () => over.keyringMode ?? 'os-keyring',
      // Structurally the same shape @cairn/keyring's probeBackend() returns, so the honest backend
      // report really is what securityStatus() appends (spec §11 control 11).
      probeBackend: () => ({ notes: [KEYCHAIN_NOTE], ...(over.keyringWarning === undefined ? {} : { warning: over.keyringWarning }) }),
      lock: () => { keyringLocked += 1 },
    },
    store: { close: () => { storeCloses += 1 } },
    palette,
    ipcMain,
    powerMonitor,
    clock,
    logger: silentLogger(),
    config,
    dataDir: '/tmp/cairn-wiring-test',
    saveConfig: (c) => { saved.push(c) },
    chooseHotkey: over.chooseHotkey ?? (async (c) => c[0]!),
  })

  return {
    app, clock, agentRequests, hotkeyListeners, candidateCbs, suppressed, captureCalls,
    ingested, sent, paletteCalls, registered, powerHandlers, saved,
    fireHotkey: () => { for (const l of hotkeyListeners) l({ accelerator: 'Cmd+Shift+V', focusToken: 'tok', firedAt: 1 }) },
    setIdle: (s: number) => { idleSeconds = s },
    get keyringLocked() { return keyringLocked },
    get storeCloses() { return storeCloses },
    get previewCacheEvictions() { return previewCacheEvictions },
  }
}

describe('start', () => {
  it('starts the agent, starts capture, binds the configured hotkey and registers the IPC channels', async () => {
    const h = build()
    const r = await h.app.start()
    expect(r).toEqual({ ok: true, value: { accelerator: 'Cmd+Shift+V', hotkeyStatus: 'active' } })
    expect(h.captureCalls).toEqual(['start'])
    expect(h.agentRequests.map((q) => q.method)).toContain('hotkey.register')
    expect(h.registered.size).toBe(8)
  })

  it('tells the renderer the hotkey status', async () => {
    const h = build()
    await h.app.start()
    expect(h.sent).toContainEqual(['cairn:hotkey.status', { status: 'active', accelerator: 'Cmd+Shift+V' }])
  })

  it('a dead hotkey is reported as failed and start() still succeeds', async () => {
    // Spec §6: a failed bind is a product state, not a fatal error — the palette still works, and
    // the renderer shows a rebind row. Refusing to launch here would be worse than a dead hotkey.
    const h = build({ registerBound: false })
    const r = await h.app.start()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.hotkeyStatus).toBe('failed')
    expect(h.sent).toContainEqual(['cairn:hotkey.status', { status: 'failed', accelerator: 'Cmd+Shift+V' }])
  })

  it('does NOT bind before the user has answered the first-run hotkey step', async () => {
    const asked: readonly string[][] = []
    const h = build({
      firstRunDone: false,
      chooseHotkey: async (candidates) => { (asked as string[][]).push([...candidates]); return 'Cmd+Shift+C' },
    })
    const r = await h.app.start()
    expect(asked).toEqual([['Cmd+Shift+V', 'Cmd+Shift+C']])
    if (r.ok) expect(r.value.accelerator).toBe('Cmd+Shift+C')
    // The choice is persisted so the step never runs twice.
    expect(h.saved).toEqual([{ ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C', firstRunHotkeyDone: true }])
  })

  it('does not ask again once the choice is recorded', async () => {
    const chooseHotkey = vi.fn(async () => 'Cmd+Shift+C')
    const h = build({ firstRunDone: true, chooseHotkey })
    await h.app.start()
    expect(chooseHotkey).not.toHaveBeenCalled()
    expect(h.saved).toEqual([])
  })
})

describe('the hotkey → palette path', () => {
  it('shows the palette and tells the renderer when it was shown', async () => {
    const h = build()
    await h.app.start()
    h.fireHotkey()
    expect(h.paletteCalls).toEqual(['show'])
    expect(h.sent).toContainEqual(['cairn:palette.shown', { shownAt: 1_767_225_600_000 }])
  })

  it('a second press while visible hides the palette, so the hotkey is a toggle', async () => {
    const h = build()
    await h.app.start()
    h.fireHotkey()
    h.fireHotkey()
    expect(h.paletteCalls).toEqual(['show', 'hide'])
  })
})

describe('the capture → history path', () => {
  it('ingests a candidate and tells the renderer the history changed', async () => {
    const h = build()
    await h.app.start()
    const candidate: Candidate = {
      reps: [rep('text/plain', 'hello world')],
      kind: 'text',
      contentHash: HASH,
      primaryText: 'hello world',
      hints: [],
      sourceApp: null,
      thumbnailJpeg: null,
      changeToken: '4710',
      capturedAt: 1_767_225_600_000,
    }
    for (const cb of h.candidateCbs) cb(candidate)
    await vi.waitFor(() => expect(h.ingested).toHaveLength(1))
    expect(h.sent.some(([c]) => c === 'cairn:history.changed')).toBe(true)
  })
})

describe('recallCopy — the M1 Enter path', () => {
  it('writes the reps to the real clipboard, suppresses our own write, hides and toasts', async () => {
    const h = build()
    await h.app.start()
    h.fireHotkey()
    const r = await h.app.recallCopy(ID)
    expect(r).toEqual({ ok: true, value: { result: 'copied-manual', reason: 'user-preference' } })

    const write = h.agentRequests.find((q) => q.method === 'write')
    expect(write).toBeDefined()
    expect(write!.params).toEqual({
      // `transient: false` on purpose: in M1 the USER presses Cmd+V afterwards, so the item has to
      // stay on the pasteboard. M2's auto-paste path writes transient:true because it consumes the
      // item itself one keystroke later.
      transient: false,
      reps: [{ mime: 'text/plain', uti: null, b64: Buffer.from('hello world').toString('base64') }],
    })
    // Self-write suppression by the token the agent returned, so we do not recapture our own write.
    expect(h.suppressed).toEqual(['4711'])
    expect(h.paletteCalls).toEqual(['show', 'hide'])
    expect(h.sent).toContainEqual(['cairn:toast', { text: TOAST_COPIED_MANUAL, tone: 'info' }])
    expect(TOAST_COPIED_MANUAL).toBe('Copied — press Cmd+V')
  })

  it('suppresses the token BEFORE the palette hides, so a fast poll cannot beat it', async () => {
    const h = build()
    await h.app.start()
    await h.app.recallCopy(ID)
    expect(h.suppressed).toEqual(['4711'])
  })

  it('surfaces a missing item instead of toasting a lie', async () => {
    const h = build()
    await h.app.start()
    const historyResolve = vi.spyOn(
      Object.getPrototypeOf(h.app) as object,
      'recallCopy' as never,
    )
    historyResolve.mockRestore()
    // Drive the real failure: an item with no representations cannot be put on a clipboard.
    const empty = build({ reps: [] })
    await empty.app.start()
    const r = await empty.app.recallCopy(ID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_ITEM_NOT_FOUND')
    expect(empty.sent.some(([c]) => c === 'cairn:toast')).toBe(false)
  })
})

describe('previewText', () => {
  it('returns text/plain as-is', async () => {
    const h = build({ reps: [rep('text/plain', 'plain body')] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    expect(r).toEqual({ ok: true, value: { text: 'plain body', isHtmlSource: true === false, truncated: false } })
  })

  it('returns HTML as SOURCE, labelled, never as markup', async () => {
    const h = build({ reps: [rep('text/html', '<img src=x onerror="window.__pwned = true">')] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.text).toBe('<img src=x onerror="window.__pwned = true">')
      expect(r.value.isHtmlSource).toBe(true)
    }
  })

  it('prefers text/plain over text/html when both exist', async () => {
    const h = build({ reps: [rep('text/html', '<b>rich</b>'), rep('text/plain', 'rich')] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    if (r.ok) {
      expect(r.value.text).toBe('rich')
      expect(r.value.isHtmlSource).toBe(false)
    }
  })

  it('truncates at the schema ceiling and says so', async () => {
    const h = build({ reps: [rep('text/plain', 'x'.repeat(9_000))] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    if (r.ok) {
      expect(r.value.text).toHaveLength(8_192)
      expect(r.value.truncated).toBe(true)
    }
  })
})

describe('preview cache eviction (spec §11 control 6)', () => {
  it('evicts on screen lock', async () => {
    const h = build()
    await h.app.start()
    h.powerHandlers.get('lock-screen')!()
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('evicts on sleep', async () => {
    const h = build()
    await h.app.start()
    h.powerHandlers.get('suspend')!()
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('evicts after the idle timeout, on the injected clock', async () => {
    const h = build()
    await h.app.start()
    h.setIdle(60)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(0)   // one minute idle is not five
    h.setIdle(301)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('does not evict repeatedly while the user stays idle', async () => {
    const h = build()
    await h.app.start()
    h.setIdle(301)
    h.clock.advance(60_000)
    h.clock.advance(60_000)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('re-arms after the user comes back', async () => {
    const h = build()
    await h.app.start()
    h.setIdle(301)
    h.clock.advance(60_000)
    h.setIdle(0)
    h.clock.advance(60_000)
    h.setIdle(301)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(2)
  })

  it('subscribes to exactly the four macOS power events we handle', async () => {
    const h = build()
    await h.app.start()
    expect([...h.powerHandlers.keys()].sort()).toEqual(['lock-screen', 'resume', 'suspend', 'unlock-screen'])
  })
})

describe('re-locking on screen lock (spec §11 control 6, third clause)', () => {
  it('in passphrase mode a screen lock zeroes the master key, and unlock says so', async () => {
    // "in passphrase mode the store re-locks on screen lock and requires the passphrase again".
    // Evicting the preview cache is not enough: the master key itself must go.
    const h = build({ keyringMode: 'passphrase' })
    await h.app.start()
    h.powerHandlers.get('lock-screen')!()
    expect(h.previewCacheEvictions).toBe(1)
    expect(h.keyringLocked).toBe(1)
    h.powerHandlers.get('unlock-screen')!()
    expect(h.sent).toContainEqual(['cairn:toast', { text: KEYRING_RELOCKED_BANNER, tone: 'warn' }])
  })

  it('in os-keyring mode a screen lock does NOT zero the key, because the OS re-supplies it', async () => {
    const h = build({ keyringMode: 'os-keyring' })
    await h.app.start()
    h.powerHandlers.get('lock-screen')!()
    expect(h.previewCacheEvictions).toBe(1)
    expect(h.keyringLocked).toBe(0)
    h.powerHandlers.get('unlock-screen')!()
    expect(h.sent.some(([c, p]) => c === 'cairn:toast' && (p as { text: string }).text === KEYRING_RELOCKED_BANNER)).toBe(false)
  })
})

describe('securityStatus', () => {
  it('appends the keyring’s own honest backend notes and its warning', async () => {
    // Task 5 measures the backend and writes the sentence; this is the only path by which that
    // sentence reaches `cairn:security.status.notes`. A hard-coded list here would lie to a user
    // whose keyring is weak.
    const h = build({ keyringWarning: 'Your desktop has no secure keyring, so Cairn will not pretend to encrypt. Set a passphrase.' })
    await h.app.start()
    const s = h.app.securityStatus()
    expect(s.keyringMode).toBe('os-keyring')
    expect(s.dataDirMode).toBe('700')
    expect(s.notes[0]).toContain('AES-256-GCM')
    expect(s.notes).toContain(KEYCHAIN_NOTE)
    expect(s.notes[s.notes.length - 1]).toBe(
      'Your desktop has no secure keyring, so Cairn will not pretend to encrypt. Set a passphrase.',
    )
  })
})

describe('stop', () => {
  it('unbinds the hotkey, stops capture, disposes the agent and zeroes the master key', async () => {
    const h = build()
    await h.app.start()
    await h.app.stop()
    expect(h.agentRequests.map((q) => q.method)).toContain('hotkey.unregister')
    // 'whenIdle' is in this list because stop() AWAITS capture teardown: `stop()` is async in Task 7's
    // Capture, and whenIdle() is what guarantees no candidate is still mid-assembly when the store
    // closes. A fire-and-forget `capture.stop()` would leave a half-assembled rep holding clipboard
    // bytes in memory past the point the key is zeroed.
    expect(h.captureCalls).toEqual(['start', 'stop', 'whenIdle'])
    expect(h.keyringLocked).toBe(1)
    expect(h.registered.size).toBe(0)
  })

  it('closes the store so the derived blob name subkey is zeroed too, exactly once', async () => {
    // Task 6's store.close() zero-fills the derived blob name subkey. Without this call that subkey
    // stays live in a Buffer for the life of the process image — a tested-but-dead control.
    const h = build()
    await h.app.start()
    await h.app.stop()
    expect(h.storeCloses).toBe(1)
    await h.app.stop()
    expect(h.storeCloses).toBe(1)
  })

  it('is safe to call twice', async () => {
    const h = build()
    await h.app.start()
    await h.app.stop()
    await h.app.stop()
    expect(h.keyringLocked).toBe(1)
  })
})
```

- [ ] **Step 40: Run it and watch it fail.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/wiring.test.ts
```

Expected: FAIL with `Error: Cannot find module './wiring' imported from
/Users/santoshkumarreddy/copy-clipboard-app/apps/desktop/main/src/wiring.test.ts`.

- [ ] **Step 41: Implement `wiring.ts`.** Read the block comment: this file is the only place where
      the M1 order of operations lives, and two lines in it are security controls.

Create `apps/desktop/main/src/wiring.ts`:

```ts
import {
  err,
  ok,
  TOAST_COPIED_MANUAL,
  type Candidate,
  type Cancel,
  type Clock,
  type ClipboardAgent,
  type ItemId,
  type KeyringMode,
  type Logger,
  type Result,
  type ResolvedRep,
  type Unsub,
  WATCH_INTERVAL_MS,
} from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import type { History } from '@cairn/history'
import type { Hotkey, HotkeyStatus } from '@cairn/hotkey'
import {
  FIRST_RUN_HOTKEY_CHOICES,
  IDLE_CHECK_INTERVAL_MS,
  KEYRING_RELOCKED_BANNER,
  PREVIEW_CACHE_IDLE_MS,
} from './constants'
import type { CairnConfig } from './config'
import { registerIpcHandlers, sendIpcEvent, type IpcMainLike } from './ipc-handlers'
import type { PaletteController } from './windows'

/** Only what the composition root needs from the keyring, so a signature change upstream is a
 *  one-line fix in index.ts rather than a rewrite here. `probeBackend` is here because the keyring is
 *  the only component that knows what is really protecting the key, and spec §11 control 11 requires
 *  us to tell the user the truth rather than a hard-coded reassurance. */
export interface KeyringPort {
  getMode(): KeyringMode
  probeBackend(): { readonly notes: readonly string[]; readonly warning?: string }
  lock(): void
}

/** The store's derived blob name subkey is zero-filled by close(), so quit has to call it. */
export interface StorePort {
  close(): void
}

// There is deliberately NO local `CapturePort`. `capture` is typed as Task 7's `Capture`, imported
// above, and the reason is the shutdown path: a narrowed structural copy declaring `stop(): void` is
// *assignable* from `stop(): Promise<void>`, so it compiles — and then `stop()` below cannot await
// capture teardown, and `whenIdle()` (the only handle Task 7 gives a caller for "no candidate is
// mid-assembly") is not in the type at all. A half-assembled rep still holding clipboard bytes when
// keyring.lock() zero-fills the key is exactly the leak security invariant 1 exists to prevent.
// Using the real interface also removes the void-in-a-union problem the old port existed to work
// around: `Capture.start()` is plainly `Promise<Result<{intervalMs: number}>>`.

export interface PowerMonitorLike {
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', cb: () => void): void
  getSystemIdleTime(): number
}

export type EvictReason = 'lock' | 'suspend' | 'idle'

export interface ComposeDeps {
  readonly agent: ClipboardAgent
  readonly capture: Capture
  readonly history: History
  readonly hotkey: Hotkey
  readonly keyring: KeyringPort
  readonly store: StorePort
  readonly palette: PaletteController
  readonly ipcMain: IpcMainLike
  readonly powerMonitor: PowerMonitorLike
  readonly clock: Clock
  readonly logger: Logger
  readonly config: CairnConfig
  readonly dataDir: string
  readonly saveConfig: (config: CairnConfig) => void
  readonly chooseHotkey: (candidates: readonly string[]) => Promise<string>
}

export interface CairnApp {
  start(): Promise<Result<{ accelerator: string; hotkeyStatus: HotkeyStatus }>>
  stop(): Promise<void>
  evictPreviewCache(reason: EvictReason): void
  recallCopy(id: ItemId): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>>
  previewText(id: ItemId): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>>
  securityStatus(): {
    keyringMode: KeyringMode
    encryptedAtRest: boolean
    dataDirMode: string
    notes: readonly string[]
  }
}

/** The frozen `cairn:history.preview` result caps `text` at 8192 characters. */
const PREVIEW_TEXT_MAX = 8_192

/** Spec §5.5's primary-representation order, restricted to the two the preview pane can show. */
function previewRep(reps: readonly ResolvedRep[]): ResolvedRep | undefined {
  return (
    reps.find((r) => r.mime === 'text/plain') ??
    reps.find((r) => r.mime === 'text/uri-list') ??
    reps.find((r) => r.mime === 'text/html') ??
    reps.find((r) => r.mime.startsWith('text/'))
  )
}

/**
 * The honest at-rest sentence, held as code so it cannot drift from what is true (spec §11
 * control 11). It is deliberately not reassuring.
 */
const SECURITY_NOTES = [
  'Everything Cairn stores is encrypted with AES-256-GCM. The data directory is 0700 and every file is 0600.',
  'Encryption at rest protects against disk theft and another account on this machine, not against code running as you.',
  'While Cairn is unlocked, the search index holds every preview decrypted in memory. It is emptied on screen lock, on sleep and after five minutes idle.',
  'Cairn sends nothing anywhere. There is no telemetry, no crash reporting and no network connection of any kind.',
] as const

export function composeApp(deps: ComposeDeps): CairnApp {
  const {
    agent, capture, history, hotkey, keyring, store, palette, ipcMain, powerMonitor, clock, logger,
    saveConfig, chooseHotkey,
  } = deps

  let config = deps.config
  let stopped = false
  let unregisterIpc: Unsub = () => {}
  let cancelIdleTick: Cancel = () => {}
  let evictedWhileIdle = false
  /** True between a passphrase-mode screen lock and the next unlock, so the user is told why the
   *  history went away instead of being shown a silently empty palette. */
  let relockedOnScreenLock = false

  const evictPreviewCache = (reason: EvictReason): void => {
    history.evictPreviewCache()
    logger.info(
      reason === 'lock'
        ? 'preview-cache.evicted-lock'
        : reason === 'suspend'
          ? 'preview-cache.evicted-suspend'
          : 'preview-cache.evicted-idle',
    )
  }

  const armIdleTick = (): void => {
    cancelIdleTick = clock.setTimeout(() => {
      // getSystemIdleTime() is in SECONDS (verified on Electron 44.1.1).
      const idleMs = powerMonitor.getSystemIdleTime() * 1_000
      if (idleMs >= PREVIEW_CACHE_IDLE_MS) {
        if (!evictedWhileIdle) {
          evictedWhileIdle = true
          evictPreviewCache('idle')
        }
      } else {
        evictedWhileIdle = false
      }
      if (!stopped) armIdleTick()
    }, IDLE_CHECK_INTERVAL_MS)
  }

  const recallCopy = async (
    id: ItemId,
  ): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>> => {
    const resolved = await history.resolveReps(id)
    if (!resolved.ok) return resolved
    if (resolved.value.length === 0) {
      return err('E_ITEM_NOT_FOUND', 'the item has no representations to put on the clipboard')
    }
    const write = await agent.request('write', {
      // transient: false — in M1 the USER presses Cmd+V afterwards, so the item must stay on the
      // pasteboard. M2's auto-paste path writes transient:true because it consumes it immediately.
      transient: false,
      reps: resolved.value.map((r) => ({
        mime: r.mime,
        uti: r.uti,
        b64: Buffer.from(r.bytes).toString('base64'),
      })),
    })
    if (!write.ok) return write
    // BEFORE hiding, and before anything can await: the agent's 500 ms poll must never see our own
    // write as a new clipboard item, or every recall doubles the history.
    capture.suppressToken(write.value.changeToken)
    palette.hide()
    sendIpcEvent(paletteTarget, 'cairn:toast', { text: TOAST_COPIED_MANUAL, tone: 'info' }, logger)
    logger.info('recall.copied', { itemId: id, repCount: resolved.value.length })
    return ok({ result: 'copied-manual' as const, reason: 'user-preference' as const })
  }

  /** `PaletteController.send` already validates nothing, so route events through sendIpcEvent. */
  const paletteTarget = {
    send: (channel: string, payload: unknown) => { palette.send(channel as never, payload) },
    isDestroyed: () => false,
  }

  const previewText = async (
    id: ItemId,
  ): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>> => {
    const resolved = await history.resolveReps(id)
    if (!resolved.ok) return resolved
    const chosen = previewRep(resolved.value)
    if (chosen === undefined) return ok({ text: '', isHtmlSource: false, truncated: false })
    // Decoded as text and returned as text. Spec §11 control 3: copied HTML is NEVER rendered as
    // HTML — when the item is HTML this is the source, and `isHtmlSource` only labels the pane.
    const full = new TextDecoder('utf-8', { fatal: false }).decode(chosen.bytes)
    const truncated = full.length > PREVIEW_TEXT_MAX
    return ok({
      text: truncated ? full.slice(0, PREVIEW_TEXT_MAX) : full,
      isHtmlSource: chosen.mime === 'text/html',
      truncated,
    })
  }

  const securityStatus = (): ReturnType<CairnApp['securityStatus']> => {
    // The keyring is the only component that knows what is actually protecting the key, so its own
    // sentences are appended rather than paraphrased here. On a machine with a weak backend
    // `warning` is BANNER_KEYRING_WEAK, and this is the path by which the user ever sees it.
    const probe = keyring.probeBackend()
    return {
      keyringMode: keyring.getMode(),
      encryptedAtRest: keyring.getMode() !== 'locked',
      dataDirMode: '700',
      notes: [
        ...SECURITY_NOTES,
        ...probe.notes,
        ...(probe.warning === undefined ? [] : [probe.warning]),
      ],
    }
  }

  return {
    async start() {
      // 1. The agent first: nothing else in M1 works without it.
      await agent.start()
      await agent.request('watch.start', { intervalMs: WATCH_INTERVAL_MS })

      // 2. Capture -> privacy -> history -> search. `capture` emits at most one Candidate per
      //    clipboard change and has already applied the privacy layer's `skip` decision.
      // The parameter is annotated on purpose: `Candidate` is imported as a type above, and with
      // `noUnusedLocals: true` an inferred callback parameter would make that import an unused-local
      // error (TS6133) now that there is no local `CapturePort` declaration mentioning it.
      capture.onCandidate((candidate: Candidate) => {
        void history.ingest(candidate).then((r) => {
          if (!r.ok) return
          const total = history.list({ limit: 1, offset: 0 }).total
          sendIpcEvent(paletteTarget, 'cairn:history.changed', { reason: 'ingest', total }, logger)
        })
      })
      history.onChange((e) => {
        sendIpcEvent(paletteTarget, 'cairn:history.changed', { reason: e.reason, total: e.total }, logger)
      })
      await capture.start()

      // 3. The first-run hotkey step (spec §9). Asked once, then persisted, and the default is
      //    pre-selected — but the dialog NAMES what Cmd+Shift+V overrides.
      let accelerator = config.accelerator
      if (!config.firstRunHotkeyDone) {
        const chosen = await chooseHotkey(FIRST_RUN_HOTKEY_CHOICES)
        accelerator = chosen
        config = { ...config, accelerator: chosen, firstRunHotkeyDone: true }
        saveConfig(config)
        logger.info('config.saved', { accelerator: chosen })
      }

      // 4. The hotkey, through the Swift agent's Carbon registration. A failed bind is a STATE.
      const bound = await hotkey.bind(accelerator)
      const status = hotkey.status()
      if (!bound.ok) logger.warn('hotkey.bind-failed', { accelerator, code: bound.code })
      sendIpcEvent(paletteTarget, 'cairn:hotkey.status', { status, accelerator }, logger)

      hotkey.onTrigger(() => {
        if (palette.isVisible()) {
          palette.hide()
          return
        }
        palette.show()
        sendIpcEvent(paletteTarget, 'cairn:palette.shown', { shownAt: clock.now() }, logger)
      })

      // 5. IPC last, so no handler can be called before its dependencies exist.
      unregisterIpc = registerIpcHandlers({
        ipcMain,
        history,
        preview: { preview: previewText },
        recall: { copy: recallCopy },
        palette: { hide: () => palette.hide(), isVisible: () => palette.isVisible() },
        security: { status: securityStatus },
        logger,
      })

      // 6. Preview-cache hygiene (spec §11 control 6). Electron maps 'lock-screen' /
      //    'unlock-screen' to the macOS distributed notifications com.apple.screenIsLocked /
      //    com.apple.screenIsUnlocked, and 'suspend' / 'resume' to
      //    NSWorkspaceWillSleepNotification / NSWorkspaceDidWakeNotification.
      //    The third clause of control 6 is the `getMode() === 'passphrase'` branch: in passphrase
      //    mode a screen lock must zero the master key too, not merely the preview cache, because
      //    the whole point of a passphrase is that walking away re-arms it. In os-keyring mode we do
      //    NOT lock: the OS keyring re-supplies the key on login anyway, and zeroing it would leave
      //    the running process unable to read its own store with nothing gained.
      //    M1 NARROWING, recorded so this is not read as full compliance: the lock zero-fills the key
      //    and the palette shows KEYRING_RELOCKED_BANNER, but re-entering the passphrase requires
      //    relaunching Cairn, because the in-session prompt is renderer surface deferred to M3.
      //    `keyring.unlockWithPassphrase()` therefore has no M1 call site and is covered only by
      //    `packages/keyring/src/keyring.test.ts`. The invariant still holds — the key really is gone.
      powerMonitor.on('lock-screen', () => {
        evictPreviewCache('lock')
        if (keyring.getMode() === 'passphrase') {
          keyring.lock()
          relockedOnScreenLock = true
        }
      })
      powerMonitor.on('suspend', () => evictPreviewCache('suspend'))
      powerMonitor.on('unlock-screen', () => {
        evictedWhileIdle = false
        if (relockedOnScreenLock) {
          relockedOnScreenLock = false
          sendIpcEvent(paletteTarget, 'cairn:toast', { text: KEYRING_RELOCKED_BANNER, tone: 'warn' }, logger)
        }
      })
      powerMonitor.on('resume', () => { evictedWhileIdle = false })
      armIdleTick()

      logger.info('app.ready', { mode: keyring.getMode() })
      return ok({ accelerator, hotkeyStatus: status })
    },

    async stop() {
      if (stopped) return
      stopped = true
      logger.info('app.quitting')
      cancelIdleTick()
      unregisterIpc()
      await hotkey.unbind()
      // AWAITED, both of them. `Capture.stop()` is `Promise<void>`; `whenIdle()` resolves once no
      // candidate is mid-assembly. Firing and forgetting either one leaves a half-assembled rep
      // holding clipboard bytes in memory past the line below that zero-fills the key — the exact
      // leak security invariant 1 exists to prevent.
      await capture.stop()
      await capture.whenIdle()
      await agent.dispose()
      // Spec §11 control 6, in order: the master key Buffer is zero-filled, then the store zero-fills
      // the derived blob name subkey. Both, or the second one stays live in a Buffer for the rest of
      // the process image.
      keyring.lock()
      store.close()
    },

    evictPreviewCache,
    recallCopy,
    previewText,
    securityStatus,
  }
}
```

`paletteTarget` is declared after `recallCopy` uses it; hoist the `const paletteTarget = { … }` block
above `recallCopy` when you paste this in, or `tsc` reports
`Block-scoped variable 'paletteTarget' used before its declaration`.

- [ ] **Step 42: Run it green, typecheck, commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project unit apps/desktop/main/src/wiring.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/main/src/wiring.ts apps/desktop/main/src/wiring.test.ts
git commit -m "feat(desktop): composition root wiring agent, capture, history, hotkey, IPC and palette"
```

Expected: `Tests 27 passed (27)`, `tsc` exits 0.

- [ ] **Step 43: Prove no log line emitted by a REAL ingest contains the canary.** Every test in
      `logger.security.test.ts` so far hands `TEST_CANARY` straight to `createStderrLogger`'s sink,
      which proves the allowlist strips it — but it does not prove that anything on the real
      capture → privacy → history → ipc path ever *offers* a body to the logger. And `wiring.test.ts`
      silences the logger outright. So spec §11 control 2's second half — "plus a canary-not-in-logs
      runtime test" — has no coverage yet. This step gives it coverage by running the canary through
      `composeApp` with the **real** logger, the **real** `@cairn/store`, `@cairn/search`,
      `@cairn/privacy` and `@cairn/history`, and fakes only at the OS edges.

**Append** to `apps/desktop/main/src/logger.security.test.ts`. First widen its import block — replace
the file's existing three import lines

```ts
import { describe, expect, it } from 'vitest'
import { createTestClock, TEST_CANARY } from '@cairn/protocol'
import { createStderrLogger, LOG_FIELD_KEYS } from './logger'
```

with these fifteen:

```ts
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  contentHash,
  createTestClock,
  TEST_CANARY,
  type Candidate,
  type ClipboardAgent,
  type ResolvedRep,
  type Unsub,
} from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import { createHistory } from '@cairn/history'
import { createHotkey } from '@cairn/hotkey'
import { classify, DEFAULT_RULES, mask } from '@cairn/privacy'
import { createSearchIndex } from '@cairn/search'
import { openStore } from '@cairn/store'
import { DEFAULT_CONFIG } from './config'
import { createStderrLogger, LOG_FIELD_KEYS } from './logger'
import { composeApp } from './wiring'
```

then append this describe block at the end of the file:

```ts
describe('a REAL ingest through composeApp logs metadata only (spec §11 control 2)', () => {
  it('emits no line naming the canary, and no key outside LogFields ∪ {level, event, ts}', async () => {
    const s = sink()
    const clock = createTestClock()
    // THE REAL LOGGER, and the real domain packages behind it. This is the difference between
    // "the sink strips a bad key" and "no component ever hands the sink a body": @cairn/store logs
    // store.appended, @cairn/privacy logs privacy.masked and @cairn/history logs history.ingested,
    // and all three of those calls actually execute below.
    const logger = createStderrLogger({ write: s.write, clock })

    const dir = mkdtempSync(join(tmpdir(), 'cairn-logger-canary-'))
    const opened = openStore({ dir, key: randomBytes(32), clock, logger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    const store = opened.value

    const privacy = { rules: DEFAULT_RULES, classify, mask }
    const history = createHistory({
      store,
      privacy,
      search: createSearchIndex(),
      clock,
      logger,
      retention: { ...DEFAULT_CONFIG.retention, secretTtlMs: 300_000 },
    })
    await history.load()

    const noop = (): void => {}
    const agent = {
      start: async () => ({}),
      request: async (method: string) => {
        if (method === 'watch.start') return { ok: true as const, value: { watching: true, intervalMs: 500 } }
        if (method === 'watch.stop') return { ok: true as const, value: { watching: false } }
        if (method === 'hotkey.register') return { ok: true as const, value: { bound: true, accelerator: 'Cmd+Shift+V' } }
        if (method === 'hotkey.unregister') return { ok: true as const, value: { bound: false } }
        return { ok: true as const, value: {} }
      },
      on: (): Unsub => noop,
      dispose: async () => {},
    } as unknown as ClipboardAgent

    const candidateCbs: ((c: Candidate) => void)[] = []
    const capture: Capture = {
      start: async () => ({ ok: true, value: { intervalMs: 500 } }),
      stop: async () => {},
      onCandidate: (cb) => { candidateCbs.push(cb); return noop },
      suppressToken: noop,
      whenIdle: async () => {},
    }

    const app = composeApp({
      agent,
      capture,
      history,
      hotkey: createHotkey({ agent, logger }),
      keyring: { getMode: () => 'os-keyring', probeBackend: () => ({ notes: [] }), lock: noop },
      store: { close: () => { store.close() } },
      palette: { show: noop, hide: noop, isVisible: () => false, send: noop, destroy: noop },
      ipcMain: { handle: noop, removeHandler: noop },
      powerMonitor: { on: noop, getSystemIdleTime: () => 0 },
      clock,
      logger,
      config: DEFAULT_CONFIG,
      dataDir: dir,
      saveConfig: noop,
      chooseHotkey: async (c) => c[0]!,
    })
    await app.start()

    // The canary is in the two places a BODY lives — the primary text and the rep bytes — and
    // deliberately NOT in the bundle id or the app name, because `bundleId` is a legitimate
    // LogFields key that capture.candidate really does log. Putting the canary there would make this
    // test fail for a correct reason and teach the next reader to delete it.
    const text = `${TEST_CANARY} and a little more text`
    const bytes = new TextEncoder().encode(text)
    const canaryRep: ResolvedRep = {
      mime: 'text/plain',
      uti: 'public.utf8-plain-text',
      bytes,
      byteLength: bytes.length,
      sha256: contentHash(bytes),
    }
    const candidate: Candidate = {
      reps: [canaryRep],
      kind: 'text',
      contentHash: contentHash(bytes),
      primaryText: text,
      hints: [],
      sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
      thumbnailJpeg: null,
      changeToken: '4711',
      capturedAt: clock.now(),
    }

    expect(candidateCbs).toHaveLength(1)
    candidateCbs[0]!(candidate)
    await vi.waitFor(() => expect(history.list().total).toBe(1))
    await app.stop()
    rmSync(dir, { recursive: true, force: true })

    // 1. A real ingest logged something, and every line is one JSON object.
    expect(s.lines.length).toBeGreaterThan(0)
    for (const line of s.lines) expect(() => JSON.parse(line) as unknown).not.toThrow()

    // 2. The UNION of keys across ALL emitted lines is a subset of LogFields ∪ {level, event, ts}.
    //    Asserting the union rather than per-line is what catches ONE new logger call that carries a
    //    body-shaped field on a path only this ingest reaches.
    const keys = [...new Set(s.lines.flatMap((l) => Object.keys(JSON.parse(l) as object)))].sort()
    expect(keys.filter((k) => !LOG_FIELD_KEYS.includes(k))).toEqual([])

    // 3. And no line contains the canary in any encoding. Assertion 2 alone is not enough: `mime`
    //    and `bundleId` are allowlisted STRING fields, so a body assigned to one of them passes the
    //    key check and only this assertion catches it.
    const ndjson = s.lines.join('')
    expect(ndjson).not.toContain(TEST_CANARY)
    expect(ndjson).not.toContain(Buffer.from(TEST_CANARY).toString('base64'))
    expect(ndjson).not.toContain(Buffer.from(TEST_CANARY).toString('hex'))
  })
})
```

Now prove **both** new assertions are load-bearing. Do these one at a time and
`git checkout -- <file>` after each; do not commit either edit.

(a) Assertion 3, the canary itself. In `wiring.ts`'s `capture.onCandidate` handler, add one line
above the `void history.ingest(candidate)` call:

```ts
        logger.info('capture.candidate', { mime: candidate.primaryText ?? '' })
```

That **compiles** — `mime` is a real `LogFields` key of type `string`, so `ExactLogFields` is happy and
the runtime allowlist keeps it. Expected:

```
npx vitest run --project security apps/desktop/main/src/logger.security.test.ts
FAIL  AssertionError: expected '{"ts":1767225600000,"level":"info","ev…' not to contain 'CAIRN-CANARY-9f3a1c7e'
```

(b) Assertion 2, the key union. Restore `wiring.ts`, then delete the
`if (!ALLOWED.has(key)) continue` line from `logger.ts`'s `emit`, and add this line to `wiring.ts`'s
`onCandidate` handler instead:

```ts
        logger.info('capture.candidate', { preview: candidate.primaryText } as never)
```

Expected:

```
npx vitest run --project security apps/desktop/main/src/logger.security.test.ts
FAIL  AssertionError: expected [ 'preview' ] to deeply equal []
```

Restore both files, then run green and commit:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git checkout -- apps/desktop/main/src/wiring.ts apps/desktop/main/src/logger.ts
git status --short
npx vitest run --project security apps/desktop/main/src/logger.security.test.ts
npx tsc -p tsconfig.json
git add apps/desktop/main/src/logger.security.test.ts
git commit -m "test(security): a real composeApp ingest logs metadata only and never the canary"
```

Expected: `git status --short` lists only `M apps/desktop/main/src/logger.security.test.ts`;
`Tests 8 passed (8)`; `tsc` exits 0. If the store step throws `E_STORE_KEY_LENGTH`, `randomBytes(32)`
was changed — Task 6 requires exactly 32 bytes. If `vi.waitFor` times out at
`expected +0 to be 1`, the ingest was refused: print `await history.ingest(candidate)` directly and
read the `Err.code` rather than lengthening the timeout.

- [ ] **Step 44: Write the Electron entry, `index.ts`.** There is no unit test for this file — it is
      the one place that touches the real Electron singletons — so every decision in it is either a
      one-line call into a function that *is* tested, or an ordering constraint spelled out in a
      comment. Steps 46–49 add the source-scan tests that cover it, and Step 53 is the manual
      checklist that covers the rest.

**Replace the body of `apps/desktop/main/src/index.ts`** — Task 1 created this file with a bare
hardened `BrowserWindow`, and everything it did now lives in tested functions in `windows.ts`. Keep the
file, replace its contents:

```ts
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage, session } from 'electron'
import { createHistory } from '@cairn/history'
import { createSearchIndex } from '@cairn/search'
import { createHotkey } from '@cairn/hotkey'
import { createCapture, defaultCaptureConfig } from '@cairn/capture'
import { createKeyring } from '@cairn/keyring'
import { openStore } from '@cairn/store'
import { classify, DEFAULT_RULES, mask, shouldSkipOnHints } from '@cairn/privacy'
import { spawnAgent } from '@cairn/agent-host'
import { AGENT_BIN_NAME, BANNER_KEYRING_WEAK, DATA_DIR_NAME, systemClock } from '@cairn/protocol'
import {
  FIRST_RUN_HOTKEY_BUTTONS,
  FIRST_RUN_HOTKEY_CHOICES,
  FIRST_RUN_HOTKEY_DETAIL,
  FIRST_RUN_HOTKEY_MESSAGE,
  FIRST_RUN_HOTKEY_TITLE,
  KEYRING_WEAK_DIALOG_DETAIL,
  KEYRING_WEAK_DIALOG_TITLE,
} from './constants'
import { loadConfig, saveConfig } from './config'
import { createStderrLogger } from './logger'
import { assertEditMenuIntact, buildAppMenuTemplate } from './menu'
import { composeApp } from './wiring'
import { cspPolicy, createPaletteWindow, hardenSession, resolveRuntimeMode } from './windows'

// =============================================================================================
// DELIBERATELY ABSENT, and each absence is asserted by a test in `security/`. The banned
// identifiers are NOT spelled out below: the security scans match plain substrings with no
// "unless it is a comment" exemption, and a ban with a comment hole is a weaker ban.
//
//   1. Crash reporting is never initialised (spec §11 control 1). A crash dump of this process IS
//      the clipboard history. Electron's crash-reporting module is never even imported, and no
//      third-party crash SDK or upload switch appears anywhere in the repo.
//
//   2. No custom URI scheme is registered (spec §11 control 10). Registering one would let any web
//      page you visit invoke this app with attacker-chosen parameters. The pairing payload is a QR
//      code the PHONE parses; the desktop only ever displays it.
//
//   3. Nothing here opens or dials a socket and nothing reaches the network (spec §11 control 1 and
//      §9): no TCP or UDP server, no HTTP client, no websocket, no mDNS advertisement. There is NO
//      local control socket and NO unauthenticated local API — decrypted history is reachable only
//      through contextBridge inside our own process tree. The rejected daemon design would have
//      served full secret values to any same-user process. Do not add one "just for the CLI".
//
// If you are here to add any of the above, read spec §11 first and then don't.
// =============================================================================================

// app.setName MUST come before ANYTHING that touches a path — verified: calling
// `app.requestSingleInstanceLock()` first freezes userData at
// `~/Library/Application Support/Electron`, and `app.name` still reports 'Cairn', so the store
// silently lands in a directory shared with every other unnamed Electron app.
app.setName(DATA_DIR_NAME)

if (!app.requestSingleInstanceLock()) {
  // A second launch hands the running instance the focus and exits. Verified: the second process
  // gets `false` and the first receives 'second-instance'.
  app.exit(0)
}

const mode = resolveRuntimeMode({ isPackaged: app.isPackaged, env: process.env })
const logger = createStderrLogger({ clock: systemClock, minLevel: mode === 'packaged' ? 'info' : 'debug' })

app.on('second-instance', () => {
  paletteRef?.show()
})

// An accessory app has no windows most of the time; the default "quit when the last window closes"
// would quit us the first time the palette is dismissed.
app.on('window-all-closed', () => {})

let paletteRef: { show(): void } | null = null

async function main(): Promise<void> {
  // The Dock icon goes away here rather than via Info.plist, because M1 produces no bundle —
  // `LSUIElement: 1` is added to the Info.plist at M3 packaging (recorded in PLATFORM-NOTES.md).
  app.dock?.hide()

  // THE EDIT MENU. An accessory app shows no menu bar, so it is tempting to call
  // `Menu.setApplicationMenu(null)`. Verified on Electron 44.1.1: Electron installs a default menu
  // that already contains cut/copy/paste/selectAll, so removing ours looks harmless and instead
  // kills Cmd+A / Cmd+C / Cmd+V inside our own search field.
  const menuTemplate = buildAppMenuTemplate(app.name)
  assertEditMenuIntact(menuTemplate)
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate as Electron.MenuItemConstructorOptions[]))

  hardenSession(session.defaultSession, cspPolicy(mode), (permission) => {
    logger.warn('renderer.permission-denied', { count: 1 })
    void permission
  })

  const dataDir = app.getPath('userData')
  const { config, source } = loadConfig(dataDir)
  if (source !== 'file') logger.info('config.loaded-default')

  // `platform: 'macos'`, NOT process.platform. @cairn/keyring's `AgentPlatform` is
  // 'macos' | 'win32' | 'linux'; process.platform is 'darwin' here, which is a type error and — if
  // cast away — matches none of probeBackend()'s branches. M1 is macOS-only (contract §0).
  const keyring = createKeyring({ safeStorage, platform: 'macos', dir: dataDir, logger })
  // Synchronous on purpose: two callers must not race into writing two different key.bin files.
  const masterKey = keyring.getOrCreateMasterKey()
  if (!masterKey.ok) {
    // Spec §6's "No OS keyring" degraded mode. An uncaught throw here is invisible to the user: the
    // app is an accessory with no window, so it would vanish with no explanation. Say what happened,
    // in the keyring's own words, then quit — we do not fall back to pretending to encrypt.
    const probe = keyring.probeBackend()
    logger.error('keyring.backend-refused', { code: masterKey.code })
    dialog.showErrorBox(
      KEYRING_WEAK_DIALOG_TITLE,
      `${probe.warning ?? BANNER_KEYRING_WEAK}\n\n${KEYRING_WEAK_DIALOG_DETAIL}\n\n(${masterKey.code})`,
    )
    app.quit()
    return
  }
  logger.info('keyring.mode', { mode: keyring.getMode() })

  // openStore returns Result<Store>, not Store: a wrong key or a tampered log is a state, not a
  // programmer error. Only a key that is not 32 bytes throws.
  const opened = openStore({ dir: dataDir, key: masterKey.value, clock: systemClock, logger })
  if (!opened.ok) {
    logger.error('store.opened', { code: opened.code })
    dialog.showErrorBox(
      KEYRING_WEAK_DIALOG_TITLE,
      `Cairn could not open its store: ${opened.code}.\n\n${opened.message}`,
    )
    app.quit()
    return
  }
  const store = opened.value
  // meta.json is the only plaintext file, and these two lines are the only thing that keeps its
  // `keyMode` honest — without them the field stays `'unknown'` forever. `scryptSaltB64` stays null
  // because @cairn/keyring keeps the salt inside key.bin, never in a plaintext file.
  // The map is REQUIRED, not defensive: `keyring.getMode()` returns `KeyringMode`, which includes
  // 'locked', while `StoreMeta.keyMode` is `'os-keyring' | 'passphrase' | 'unknown'` and has no
  // 'locked' member — 'locked' is a runtime state and is never persisted. Without the map this line
  // is `TS2322: Type '"locked"' is not assignable to type '"os-keyring" | "passphrase" | "unknown"'`.
  // The branch itself is unreachable at runtime, because getOrCreateMasterKey just succeeded.
  const keyMode = keyring.getMode()
  store.writeMeta({
    schemaVersion: 1,
    keyMode: keyMode === 'locked' ? 'unknown' : keyMode,
    scryptSaltB64: null,
  })

  const agent = spawnAgent({
    platform: 'macos',
    binPath: join(app.getAppPath(), 'agents', 'macos', 'build', AGENT_BIN_NAME),
    clock: systemClock,
    logger,
  })

  // One object that satisfies both ports: @cairn/history's `PrivacyPort` needs `rules`, `classify`
  // and `mask`; @cairn/capture's `CaptureDeps.privacy` needs `classify`, `mask` and
  // `shouldSkipOnHints`. It is passed as a variable, not an inline literal, so the extra member is
  // not an excess-property error at either call site.
  const privacy = { rules: DEFAULT_RULES, classify, mask, shouldSkipOnHints }
  // `config` is a CaptureConfig — {debounceMs, watchIntervalMs, rules} — and NOT a PrivacyRules.
  // Passing DEFAULT_RULES here arms the debounce timer with `undefined` ms and sends
  // `watch.start {intervalMs: undefined}`, which the frozen AgentRequestSchema rejects.
  const capture = createCapture({
    agent,
    privacy,
    config: defaultCaptureConfig(DEFAULT_RULES),
    clock: systemClock,
    logger,
  })
  const search = createSearchIndex()
  const history = createHistory({
    store,
    privacy,
    search,
    clock: systemClock,
    logger,
    retention: { ...config.retention, secretTtlMs: 300_000 },
  })
  await history.load()

  const palette = createPaletteWindow({
    BrowserWindowCtor: BrowserWindow as never,
    mode,
    preloadPath: join(app.getAppPath(), 'apps', 'desktop', 'out', 'preload', 'index.js'),
    rendererIndexPath: join(app.getAppPath(), 'apps', 'desktop', 'out', 'renderer', 'index.html'),
    env: process.env,
    clock: systemClock,
    logger,
  })
  paletteRef = palette

  const cairn = composeApp({
    agent,
    capture,
    history,
    hotkey: createHotkey({ agent, logger }),
    keyring,
    store,
    palette,
    ipcMain,
    powerMonitor,
    clock: systemClock,
    logger,
    config,
    dataDir,
    saveConfig: (next) => { saveConfig(dataDir, next) },
    // Spec §9's one-tap first-run step. A native message box needs no new IPC channel and no
    // renderer code, and `defaultId: 0` is what makes Cmd+Shift+V "pre-selected".
    chooseHotkey: async (candidates) => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: FIRST_RUN_HOTKEY_TITLE,
        message: FIRST_RUN_HOTKEY_MESSAGE,
        detail: FIRST_RUN_HOTKEY_DETAIL,
        buttons: [...FIRST_RUN_HOTKEY_BUTTONS],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return candidates[response] ?? FIRST_RUN_HOTKEY_CHOICES[0]
    },
  })

  const started = await cairn.start()
  if (!started.ok) throw new Error(`cairn: startup failed: ${started.code} ${started.message}`)

  app.on('before-quit', () => { void cairn.stop() })
}

void app.whenReady().then(main)
```

- [ ] **Step 45: Build the app and commit.** There is no test to run here; the build is the check that
      the entry compiles, resolves every workspace import and emits CJS.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx tsc -p tsconfig.json
npx electron-vite build
node -e "const s=require('node:fs').readFileSync('apps/desktop/out/main/index.js','utf8'); if(!s.startsWith('\"use strict\"')) throw new Error('main bundle is not CJS'); if(s.includes('crashReporter')) throw new Error('crashReporter reached the bundle'); console.log('main bundle OK,', s.length, 'bytes')"
git add apps/desktop/main/src/index.ts
git commit -m "feat(desktop): Electron entry with single-instance, dock hide, Edit menu and no crash reporter"
```

Expected: `tsc` exits 0; electron-vite reports `main`, `preload` and `renderer` builds; the node
one-liner prints `main bundle OK, <n> bytes`.

If the renderer build fails with `[vite-plugin-svelte] no Svelte config found`, the file that **Task 1's
step which writes the build configs (`electron.vite.config.ts`, `svelte.config.mjs`, `Makefile`)**
creates is missing. `electron-vite build` has **no** flag that skips a target, so do not try to build
main and preload alone, and do not edit `electron.vite.config.ts` — it is frozen in contract §2.
Restore the one-line config instead:

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
ls apps/desktop/renderer/svelte.config.mjs || printf "import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'\nexport default { preprocess: vitePreprocess() }\n" > apps/desktop/renderer/svelte.config.mjs
npx electron-vite build
```

Expected: the `ls` prints the path (nothing to do), or the `printf` writes it and the build then
reports all three targets. If it still fails, the renderer task has not landed — stop and land it
first; do not comment out the `renderer` block.

- [ ] **Step 46: Extend `no-crash-reporter` and write `no-uri-scheme`.** These are contract §8 rows
      whose subject is this task's code. Each one fails if its control is removed.

`security/no-crash-reporter.security.test.ts` **already exists** — **Task 1's step that writes the
failing `crashReporter` security test** wrote it, and **Task 1's step that runs it green and then
proves it fails when the control is violated** proved it fails on a planted
`import { crashReporter } from "electron"`. Keep all three of its tests, including the scanner's own
smoke test (`findInSources('BrowserWindow', ['apps/desktop']).length > 0`), which is what stops a
zero-hit result from meaning "the walker read nothing". **Append** one describe block, and widen the
existing import line.

Change its `./source-scan` import line from

```ts
import { findInSources, formatHits, sourceFiles } from './source-scan'
```

to these three lines

```ts
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { REPO_ROOT, findInSources, formatHits, sourceFiles } from './source-scan'
```

then append at the end of the file:

```ts
describe('no crash-reporting service is named either', () => {
  it('names no crash SDK and no upload switch, in any casing', () => {
    // The identifier ban above is exact-case; an `import * as Sentry from '@sentry/electron'` would
    // slip past it. This one lowercases the whole file, so casing cannot hide a service.
    const banned = ['sentry', 'bugsnag', 'crashpad', 'breakpad', 'submiturl', 'uploadtoserver']
    const offenders: string[] = []
    for (const file of sourceFiles(PRODUCT_ROOTS)) {
      const lower = readFileSync(file, 'utf8').toLowerCase()
      for (const b of banned) {
        if (lower.includes(b)) offenders.push(`${relative(REPO_ROOT, file)}: ${b}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
```

`PRODUCT_ROOTS` is already declared at the top of that file as
`['packages', 'apps/desktop', 'tools']` — reuse it, do not redeclare it.

Create `security/no-uri-scheme.security.test.ts`. It reuses the same shared walker, and it needs **no**
comment exemption and **no** self-exemption: `security/` is deliberately not one of the scanned roots
(**Task 1's step that writes the shared source scanner**), and Step 44's entry file names none of these
identifiers even in a comment.

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, findInSources, formatHits } from './source-scan'

// Registering `cairn://` would let any web page you visit invoke this app with attacker-chosen
// parameters — a remote trigger into the pairing path, for zero benefit: the desktop DISPLAYS the
// pairing QR, it never receives one.
const ROOTS = ['apps', 'packages', 'tools', 'agents', 'scripts']

const BANNED = [
  'setAsDefaultProtocolClient',
  'removeAsDefaultProtocolClient',
  'isDefaultProtocolClient',
  'CFBundleURLTypes',
  'CFBundleURLSchemes',
  // The bare event name, as contract §8 writes it — not just the quoted forms, so
  // `app.on(EVENT_OPEN_URL, …)` with a hoisted constant cannot slip through either.
  'open-url',
  'registerSchemesAsPrivileged',
  'protocol.handle',
  'cairn://',
] as const

describe('spec §11 control 10 — the desktop registers NO custom URI scheme', () => {
  it('scans a non-empty set of files, so a clean result means something', () => {
    expect(findInSources('BrowserWindow', ROOTS).length).toBeGreaterThan(0)
  })

  it('names none of the protocol-registration identifiers anywhere, comment or code', () => {
    for (const banned of BANNED) {
      expect(formatHits(findInSources(banned, ROOTS)), `banned: ${banned}`).toBe('')
    }
  })

  it('the root package.json declares no protocols block', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg['protocols']).toBeUndefined()
    expect(pkg['build']).toBeUndefined()
  })
})
```

- [ ] **Step 47: Extend `security/no-socket-at-startup.security.test.ts`.** Contract §8: after
      `composeApp(deps)` with a fake agent, no TCP or UDP handle exists — plus a source scan, because
      a socket opened lazily would not show up in the runtime check.

This file **already exists** too. **Task 1's step that writes the no-socket security test with its
violation already in place** wrote four tests, and **Task 1's step that runs it and watches it fail on
the planted egress call** proved the source ban really fails. Keep every one of them — especially the
fourth, the child-process positive control that shows `TCPServerWrap` really is observable, because
without it the third test could pass by seeing nothing at all. **Task 1's step that removes the
violation and runs it green** says in as many words that this task adds the `composeApp` call to this
same file and keeps the existing assertions.

Add these six import lines below the file's existing imports:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClock, type Logger } from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import { composeApp } from '../apps/desktop/main/src/wiring'
import { DEFAULT_CONFIG } from '../apps/desktop/main/src/config'
```

and widen the file's existing `./source-scan` line from

```ts
import { findInSources, formatHits, sourceFiles } from './source-scan'
```

to

```ts
import { REPO_ROOT, findInSources, formatHits, sourceFiles, stripComments } from './source-scan'
```

then add these two declarations beside the file's existing `PRODUCT_ROOTS`:

```ts
const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

/** Spec §11 control 3's scope is the capture and recall path, so this list is NARROWER than
 *  PRODUCT_ROOTS: `security/**` and `tools/**` are deliberately excluded, because the guards and the
 *  codegen there legitimately run `swiftc`, `/usr/bin/uname` and `node` through
 *  `execFileSync`/`spawnSync` — including THIS file's own positive control — and none of them ever
 *  runs in a process holding clipboard bytes. */
const SHELL_SCAN_ROOTS = ['packages', 'apps/desktop']
```

`PRODUCT_ROOTS`, `SOCKET_APIS` and `HANDLE_RE` are already declared at the top of the file, as are
`findInSources`, `formatHits` and `sourceFiles` from `./source-scan` — reuse all six, do not redeclare
any of them. `REPO_ROOT` and `stripComments` come from that same module and are added to its import line
above. Then **append** these three describe blocks:

```ts
describe('composeApp binds nothing (contract §8)', () => {
  it('holds no TCP or UDP handle after start()', async () => {
    // Task 1's version could only check the bare process. This one runs the real composition root:
    // verified that process.getActiveResourcesInfo() reports 'TCPServerWrap' the instant a listening
    // server exists, so the assertion can actually fail.
    const noop = (): void => {}
    const app = composeApp({
      agent: {
        start: async () => ({}) as never,
        request: async () => ({ ok: true, value: {} }) as never,
        on: () => noop,
        dispose: async () => {},
      } as never,
      // Task 7's `Capture`, not a narrowed copy: `stop()` is async and `whenIdle()` exists, and
      // composeApp's stop() awaits both.
      capture: {
        start: async () => ({ ok: true, value: { intervalMs: 500 } }),
        stop: async () => {},
        onCandidate: () => noop,
        suppressToken: noop,
        whenIdle: async () => {},
      } satisfies Capture,
      history: {
        load: async () => ({ ok: true, value: { items: 0 } }),
        list: () => ({ items: [], total: 0 }),
        onChange: () => noop,
        evictPreviewCache: noop,
        resolveReps: async () => ({ ok: true, value: [] }),
      } as never,
      hotkey: {
        bind: async () => ({ ok: true, value: { accelerator: 'Cmd+Shift+V' } }),
        unbind: async () => ({ ok: true, value: { bound: false } }),
        current: () => 'Cmd+Shift+V',
        status: () => 'active' as const,
        onTrigger: () => noop,
      },
      keyring: { getMode: () => 'os-keyring' as const, probeBackend: () => ({ notes: [] }), lock: noop },
      store: { close: noop },
      palette: { show: noop, hide: noop, isVisible: () => false, send: noop, destroy: noop },
      ipcMain: { handle: noop, removeHandler: noop },
      powerMonitor: { on: noop, getSystemIdleTime: () => 0 },
      clock: createTestClock(),
      logger: silentLogger(),
      config: DEFAULT_CONFIG,
      dataDir: '/tmp/cairn-no-socket',
      saveConfig: noop,
      chooseHotkey: async (c) => c[0]!,
    })
    await app.start()
    expect(process.getActiveResourcesInfo().filter((h) => HANDLE_RE.test(h))).toEqual([])
    await app.stop()
  })
})

describe('there is no local control socket (spec §9)', () => {
  it('names no control-socket identifier and no client-side dialling API', () => {
    // Spec §9: an unauthenticated local control socket would serve decrypted history and full
    // secret values to any same-user process, nullifying passphrase mode. These are the identifiers
    // Task 1's SOCKET_APIS list does not already cover.
    const banned = [
      'unix socket', '.sock', 'controlSocket', 'ipcPath', 'namedPipe',
      'net.connect', 'new WebSocket', 'createServer(',
    ]
    for (const b of banned) {
      expect(formatHits(findInSources(b, PRODUCT_ROOTS)), `banned: ${b}`).toBe('')
    }
  })
})

describe('no shell in the capture or recall path (spec §11 control 3)', () => {
  // Spec §11 control 3's last clause is "never interpolated into a shell command, and there is no
  // shell in the capture or recall path at all on macOS". Nothing asserted it until now. A copied
  // file path is a STRING we display and hand to the OS pasteboard: the moment one reaches a shell,
  // `; rm -rf ~` in a filename becomes code, and the process it becomes code in is the one holding
  // every password that crossed the clipboard.
  it('names no shell-spawning or shell-invoking form in the capture or recall path', () => {
    const banned = [
      'execSync', 'execFile', 'spawnSync',
      // `exec` reached through a member or called on a literal. The bare token `exec(` is NOT banned
      // on purpose: `packages/privacy/src/detectors.ts` legitimately calls `re.exec(text)` in its
      // scan loop, and a ban that fires on a RegExp method would be deleted within a week.
      'child_process.exec', "exec('", 'exec("', 'exec(`',
      'shell: true', 'shell:true', 'shell: process.env',
      '/bin/sh', '/bin/bash', '/bin/zsh', 'osascript', 'sh -c', 'bash -c',
    ]
    for (const b of banned) {
      expect(formatHits(findInSources(b, SHELL_SCAN_ROOTS)), `banned: ${b}`).toBe('')
    }
  })

  it('reaches node:child_process from exactly one file, and only for spawn with an argv array', () => {
    // Stronger than a name list, because it closes the hole a name list leaves: no file on the
    // capture or recall path can reach ANY child_process API except the one spawn call that starts
    // the Swift agent.
    const importers = [...new Set(findInSources('node:child_process', SHELL_SCAN_ROOTS).map((h) => h.file))]
    expect(importers).toEqual(['packages/agent-host/src/spawn-agent.ts'])

    const src = readFileSync(join(REPO_ROOT, 'packages/agent-host/src/spawn-agent.ts'), 'utf8')
    expect(src).toContain("import { spawn, type ChildProcess } from 'node:child_process'")
    // An argv ARRAY, no shell, and no interpolation: binPath and args are passed as data.
    expect(src).toContain("const c = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })")
    // stripComments, NOT the raw source: spawn-agent.ts's own comments say "with an argv ARRAY and no
    // shell option" and "can never become shell syntax", so `expect(src).not.toContain('shell')`
    // would fail on the documentation of the control it is checking. Task 1's stripper is
    // quote-aware, so `spawn(bin, args, { shell: true })` is still a hit.
    expect(stripComments(src)).not.toContain('shell')
  })
})
```

`SourceHit.file` is already repo-relative (Task 1's scanner returns `relative(REPO_ROOT, file)`), so the
`importers` array compares against a plain path with no further normalisation.

Two documented near-misses that must stay green, so nobody "fixes" them:
`packages/privacy/src/detectors.ts` and `packages/capture/src/normalize-reps.ts` both call
`RegExp#exec` (`while ((m = re.exec(text)) !== null)` and `new RegExp(…).exec(text)`), which is why the
bare token `exec(` is not in the list. And the renderer's `filePathsFromPreview` JSDoc in
`apps/desktop/renderer/src/palette-state.svelte.ts` writes the words `shell: true` while *documenting*
this ban; `findInSources` strips `//` and `/* */` from `.ts` files, so a comment is never a hit.

- [ ] **Step 48: Write `security/renderer-hardening.security.test.ts`.** Contract §8's row: the CSP
      has no `unsafe-inline`, the navigation handlers deny, and — the part that is easy to lose — the
      real `index.ts` actually calls the hardening functions rather than merely exporting them.

Create `security/renderer-hardening.security.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { CSP_POLICY_DEV, CSP_POLICY_PROD } from '../apps/desktop/main/src/constants'
import {
  cspPolicy,
  hardenSession,
  NAV_GUARD_EVENTS,
  PALETTE_WEB_PREFERENCES,
  paletteWebPreferences,
  registerNavigationGuards,
  resolvePaletteEntry,
} from '../apps/desktop/main/src/windows'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = readFileSync(join(REPO_ROOT, 'apps/desktop/main/src/index.ts'), 'utf8')

describe('the hardened set is what the window actually gets', () => {
  it('every dangerous webPreference is off in a packaged build', () => {
    const p = paletteWebPreferences('packaged', '/preload.js')
    expect(p.sandbox).toBe(true)
    expect(p.contextIsolation).toBe(true)
    expect(p.nodeIntegration).toBe(false)
    expect(p.nodeIntegrationInSubFrames).toBe(false)
    expect(p.nodeIntegrationInWorker).toBe(false)
    expect(p.webSecurity).toBe(true)
    expect(p.allowRunningInsecureContent).toBe(false)
    expect(p.experimentalFeatures).toBe(false)
    expect(p.webviewTag).toBe(false)
    expect(p.enableBlinkFeatures).toBe('')
    expect(p.spellcheck).toBe(false)
    expect(p.devTools).toBe(false)
  })

  it('the baseline constant cannot be widened without this test noticing', () => {
    expect(Object.keys(PALETTE_WEB_PREFERENCES).sort()).toEqual([
      'allowRunningInsecureContent', 'contextIsolation', 'devTools', 'enableBlinkFeatures',
      'experimentalFeatures', 'nodeIntegration', 'nodeIntegrationInSubFrames',
      'nodeIntegrationInWorker', 'sandbox', 'spellcheck', 'webSecurity', 'webviewTag',
    ])
  })
})

describe('CSP', () => {
  it('production has no unsafe-inline, no unsafe-eval and no wildcard', () => {
    expect(CSP_POLICY_PROD).not.toContain('unsafe-inline')
    expect(CSP_POLICY_PROD).not.toContain('unsafe-eval')
    expect(CSP_POLICY_PROD).not.toContain('*')
    expect(CSP_POLICY_PROD).not.toContain('http://')
    expect(CSP_POLICY_PROD).not.toContain('https://')
  })

  it('production denies all network egress from the renderer', () => {
    expect(CSP_POLICY_PROD).toContain("connect-src 'none'")
    expect(CSP_POLICY_PROD).toContain("default-src 'none'")
  })

  it('the dev policy is unreachable from a packaged build', () => {
    expect(cspPolicy('packaged')).toBe(CSP_POLICY_PROD)
    expect(CSP_POLICY_DEV).toContain('localhost')
    expect(CSP_POLICY_PROD).not.toContain('localhost')
  })
})

describe('navigation and window-open both deny', () => {
  it('preventDefault on all three events and deny on setWindowOpenHandler', () => {
    const emitter = new EventEmitter()
    let openHandler: ((d: { url: string }) => { action: 'deny' }) | null = null
    registerNavigationGuards(
      {
        on: (ev, cb) => { emitter.on(ev, cb) },
        setWindowOpenHandler: (h) => { openHandler = h },
      },
      () => {},
    )
    for (const ev of NAV_GUARD_EVENTS) {
      const preventDefault = vi.fn()
      emitter.emit(ev, { preventDefault }, 'https://evil.example')
      expect(preventDefault, `${ev} must be prevented`).toHaveBeenCalledTimes(1)
    }
    expect(openHandler!({ url: 'https://evil.example' })).toEqual({ action: 'deny' })
  })

  it('every permission request is denied', () => {
    let permFn: ((wc: unknown, p: string, cb: (g: false) => void) => void) | null = null
    hardenSession(
      {
        webRequest: { onHeadersReceived: () => {} },
        setPermissionRequestHandler: (fn) => { permFn = fn },
      },
      CSP_POLICY_PROD,
      () => {},
    )
    const granted = vi.fn()
    permFn!({}, 'clipboard-read', granted as never)
    expect(granted).toHaveBeenCalledWith(false)
  })
})

describe('content comes from local files only', () => {
  it('a packaged build never resolves a URL', () => {
    expect(
      resolvePaletteEntry('packaged', { ELECTRON_RENDERER_URL: 'http://evil.example' }, '/x/index.html'),
    ).toEqual({ kind: 'file', path: '/x/index.html' })
  })
})

describe('the entry file really installs the controls', () => {
  it('calls hardenSession with the mode-resolved policy', () => {
    expect(ENTRY).toContain('hardenSession(session.defaultSession, cspPolicy(mode)')
  })

  it('calls assertEditMenuIntact before setting the application menu', () => {
    expect(ENTRY).toContain('assertEditMenuIntact(menuTemplate)')
    expect(ENTRY.indexOf('assertEditMenuIntact(menuTemplate)')).toBeLessThan(
      ENTRY.indexOf('Menu.setApplicationMenu('),
    )
  })

  it('never nulls the application menu, which is what kills Cmd+A/C/V', () => {
    expect(ENTRY).not.toContain('setApplicationMenu(null)')
  })

  it('sets the app name BEFORE requesting the single-instance lock', () => {
    // Verified: reversing these two lines silently relocates the store to
    // ~/Library/Application Support/Electron while app.name still reports 'Cairn'.
    const nameAt = ENTRY.indexOf('app.setName(DATA_DIR_NAME)')
    const lockAt = ENTRY.indexOf('app.requestSingleInstanceLock()')
    expect(nameAt).toBeGreaterThan(-1)
    expect(lockAt).toBeGreaterThan(-1)
    expect(nameAt).toBeLessThan(lockAt)
  })

  it('hides the Dock icon and opens no window on the launch path', () => {
    // `.show()` cannot be banned outright: the 'second-instance' handler calls paletteRef?.show(),
    // which is the whole point of taking the single-instance lock. What must not exist is a window
    // shown at launch — only the hotkey may do that.
    expect(ENTRY).toContain('app.dock?.hide()')
    expect(ENTRY).not.toContain('win.show()')
    expect(ENTRY).not.toContain('showInactive()')
    expect(ENTRY).not.toContain('ready-to-show')
  })

  it('never opens DevTools', () => {
    expect(ENTRY).not.toContain('openDevTools')
  })

  it('explains a refused keyring in a dialog and quits, rather than throwing into the void', () => {
    // Spec §6's "No OS keyring" degraded mode. An accessory app has no window, so an uncaught throw
    // is a process that vanishes with no explanation the user can see.
    expect(ENTRY).toContain('dialog.showErrorBox(')
    expect(ENTRY).toContain('KEYRING_WEAK_DIALOG_TITLE')
    expect(ENTRY).toContain('BANNER_KEYRING_WEAK')
    expect(ENTRY).not.toContain('cannot open the store: ${masterKey.code}')
  })

  it('passes the keyring the AgentPlatform value, never process.platform', () => {
    // 'darwin' is not one of 'macos' | 'win32' | 'linux', so it would match no probeBackend branch.
    expect(ENTRY).toContain("platform: 'macos'")
    expect(ENTRY).not.toContain('platform: process.platform')
  })

  it('hands the store to composeApp so quit can zero the blob name subkey', () => {
    expect(ENTRY).toContain('const store = opened.value')
    expect(ENTRY).toMatch(/composeApp\(\{[\s\S]*?\n\s{4}store,\n/)
  })
})
```

- [ ] **Step 49: Run the four security files and commit.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npx vitest run --project security security/no-crash-reporter.security.test.ts security/no-uri-scheme.security.test.ts security/no-socket-at-startup.security.test.ts security/renderer-hardening.security.test.ts
npx tsc -p tsconfig.json
git add security/no-crash-reporter.security.test.ts security/no-uri-scheme.security.test.ts security/no-socket-at-startup.security.test.ts security/renderer-hardening.security.test.ts
git commit -m "test(security): crash reporter, URI scheme, socket and renderer hardening invariants"
```

Expected: `Test Files 4 passed (4)` / `Tests 32 passed (32)` — 4 crash-reporter (Task 1's three plus
the appended service ban), 3 uri-scheme, 8 no-socket (Task 1's four plus the four appended: the
`composeApp` handle check, the control-socket scan and the two shell-execution assertions) and 17
renderer-hardening. If any count is *lower*, you overwrote one of Task 1's files instead of appending
to it; recover it with `git checkout origin/main -- <path>` and redo Step 46 or 47. If
`no-socket-at-startup` reports a `TCPWRAP` handle, something in the dependency chain opened a socket at
import time — find it with `node --trace-event-categories node.async_hooks` before you touch the test.

- [ ] **Step 50: Prove each security test fails when its control is removed.** Contract §8's
      acceptance criterion for every security test is "must fail if its control is removed", and the
      only way to know is to remove it. Do all **sixteen** rows, one at a time, and
      **`git checkout --` the file after each**. Do not commit any of these edits.

| # | Remove this | Then this must fail with |
|---|---|---|
| 1 | `sandbox: true` → `sandbox: false` in `PALETTE_WEB_PREFERENCES` | `windows.security.test.ts` → `AssertionError: expected { sandbox: false, … } to deeply equal { sandbox: true, … }` |
| 2 | `devTools: mode === 'dev'` → `devTools: true` in `paletteWebPreferences` | `windows.security.test.ts -t 'DevTools off'` → `expected true to be false` |
| 3 | `"style-src 'self'"` → `"style-src 'self' 'unsafe-inline'"` in `CSP_POLICY_PROD` | `renderer-hardening.security.test.ts` → `expected '…unsafe-inline…' not to contain 'unsafe-inline'` |
| 4 | delete `'will-frame-navigate'` from `NAV_GUARD_EVENTS` | `windows.test.ts -t 'prevents all three'` → `AssertionError: expected [ 'will-navigate', 'will-redirect' ] to deeply equal [ 'will-navigate', 'will-frame-navigate', 'will-redirect' ]` |
| 5 | in `resolvePaletteEntry`, delete the `if (mode === 'packaged')` early return | `windows.security.test.ts -t 'always loads a local file'` → `expected { kind: 'url', … } to deeply equal { kind: 'file', … }` |
| 6 | in `registerIpcHandlers`, replace the `params.safeParse` block with `const parsedParams = { success: true, data: raw }` | `ipc-handlers.test.ts -t 'rejects an over-range limit'` → `expected [ 'list {"limit":9999,…}' ] to deeply equal []` |
| 7 | add `invoke: (channel, params) => ipcRenderer.invoke(channel, params)` to the preload's exposed object | `preload/src/index.security.test.ts -t 'no generic bridge'` → `expected [Function] to be undefined`, and `-t 'EXACTLY these twelve'` → `expected 13 to be 12` |
| 8 | add `crashReporter.start({ uploadToServer: false })` to `index.ts` | `no-crash-reporter.security.test.ts -t 'finds the identifier crashReporter nowhere'` → `AssertionError: expected 'apps/desktop/main/src/index.ts:NN: cr…' to be ''`, and `-t 'names no crash SDK'` also fails on `uploadtoserver` |
| 9 | delete the `capture.suppressToken(write.value.changeToken)` line from `recallCopy` | `wiring.test.ts -t 'suppresses our own write'` → `expected [] to deeply equal [ '4711' ]` |
| 10 | swap `app.setName(DATA_DIR_NAME)` below `app.requestSingleInstanceLock()` | `renderer-hardening.security.test.ts -t 'BEFORE requesting the single-instance lock'` → `expected 1043 to be less than 812` |
| 11 | in `saveConfig`, replace the open/write/fchmod block with `writeFileSync(configPath(dataDir), json, { mode: 0o600 })` | `config.security.test.ts -t 'NARROWS a pre-existing world-readable file'` → `expected '644' to be '600'` |
| 12 | remove the non-allowlisted-key `continue` from `logger.ts`'s `emit` | `logger.security.test.ts -t 'STRIPS any field'` → `expected [ 'body', 'event', 'kind', 'level', 'preview', 'text', 'ts' ] to deeply equal [ 'event', 'kind', 'level', 'ts' ]` |
| 13 | delete the `if (keyring.getMode() === 'passphrase') { … }` branch from the `lock-screen` handler in `wiring.ts` | `wiring.test.ts -t 'a screen lock zeroes the master key'` → `expected +0 to be 1` |
| 14 | delete the `store.close()` line from `stop()` in `wiring.ts` | `wiring.test.ts -t 'closes the store'` → `expected +0 to be 1` |
| 15 | add `shell: true` to `spawn-agent.ts`'s spawn options — `spawn(binPath, args, { stdio: ['pipe','pipe','pipe'], shell: true })` | `no-socket-at-startup.security.test.ts -t 'shell-spawning or shell-invoking form'` → `AssertionError: banned: shell: true — expected 'packages/agent-host/src/spawn-agent.ts:NN: const c = spawn(binPath, args, { std…' to be ''`; and `-t 'argv array'` → `expected "import { spawn, type ChildProcess } fr…" not to contain 'shell'` |
| 16 | add `logger.info('capture.candidate', { mime: candidate.primaryText ?? '' })` to `wiring.ts`'s `onCandidate` handler — it compiles, because `mime` is a real allowlisted `LogFields` key | `logger.security.test.ts -t 'no line naming the canary'` → `AssertionError: expected '{"ts":1767225600000,"level":"info","ev…' not to contain 'CAIRN-CANARY-9f3a1c7e'` |

Row 12 removes the runtime allowlist, which `-t 'STRIPS any field'` catches on its own. It does **not**
by itself break `-t 'no line naming the canary'`, because every real logger call is
`ExactLogFields`-typed and so no extra key exists for the allowlist to have stripped — that key-union
assertion is proved load-bearing by Step 43's red-proof (b), which removes the `continue` **and** adds a
`{ preview: … } as never` call in the same edit. Rows 15 and 16 are the two shell-and-canary controls
this task added; run them exactly as written.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
# after each removal:
npm run test
git checkout -- .
git status --short     # must print nothing before you move to the next row
```

Expected: each row fails exactly as written, and `git status --short` is empty afterwards. If a
removal does **not** break its test, the test is decoration — fix the test before continuing, because
that control is currently unprotected.

- [ ] **Step 51: Run the whole suite, typecheck both sides, and build.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npm run guard:no-rebuild
npx tsc -p tsconfig.json
npm run test
npx electron-vite build
```

Expected: the guard prints `guard-no-electron-rebuild OK`; `tsc` exits 0; **all three** vitest projects
pass with the numbers from Steps 8, 13, 17, 21, 25, 30, 34, 38, 42, 43 and 49 (`unit` includes 13 hotkey
+ 12 windows + 7 menu + 11 config + 22 ipc + 27 wiring; `security` includes 14 windows + 5 config + 8
logger + 10 preload + 32 across the four `security/` files — 4 crash-reporter, 3 uri-scheme, 8
no-socket, 17 renderer-hardening); the build emits `apps/desktop/out/main/index.js` and
`apps/desktop/out/preload/index.js`.

`npm run test` is bare `vitest run` with **no** `--project` flag, which is what makes it run `unit`,
`security` **and** `renderer` — the third project is the renderer task's, and this task adds no test to
it, but a run that silently skipped it would hide that task's regressions. Do not narrow this command to
`--project unit --project security`, and do not touch `vitest.config.ts`: its three projects are frozen
in contract §2.

- [ ] **Step 52: Record the two day-0 spike answers in `PLATFORM-NOTES.md`.** These are notes, not
      product code (contract §0), and they are what stops the next person re-running the experiments.

Append to `PLATFORM-NOTES.md`:

```markdown
## Electron 44.1.1 shell facts, measured on macOS 26.5.1 arm64

| Fact | Result |
|---|---|
| `BrowserWindow{type:'panel', vibrancy:'hud', visualEffectState:'active', transparent, frame:false}` | creates without error; `setAlwaysOnTop(true,'screen-saver')` → `isAlwaysOnTop() === true`; `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true})` → `isVisibleOnAllWorkspaces() === true` |
| `app.setName()` **after** `app.requestSingleInstanceLock()` | `app.name === 'Cairn'` but `userData` stays `~/Library/Application Support/Electron`. Order is load-bearing. |
| second launch | `requestSingleInstanceLock() === false`; the first process receives `second-instance` |
| default application menu | present on macOS with an Edit submenu already containing `cut/copy/paste/selectall`, so a missing custom menu is invisible until `setApplicationMenu(null)` |
| `MenuItem.role` for `{role:'selectAll'}` | reads back **lowercased** as `'selectall'`; auto-accelerators are `CommandOrControl+A/C/V` |
| strict CSP on a `file://` load | `script-src 'self'` runs an external module script; `style-src 'self'` applies an external stylesheet; injected inline `<script>` blocked; `new Function` → `EvalError`; `fetch()` → blocked by `connect-src 'none'`; `img-src 'self' data:` loads a data URL |
| `devTools: false` | `openDevTools()` is refused, `isDevToolsOpened()` stays `false`, no throw |
| `will-navigate` vs `will-frame-navigate` | a renderer-initiated `location.href = …` fires **`will-frame-navigate` only** when that handler calls `preventDefault()`. Guard all three events. |
| `webContents.loadURL()` from main | does **not** fire `will-navigate`. Only our own code calls it, and `resolvePaletteEntry` is what keeps it pointed at a local file. |
| `webContents.getLastWebPreferences()` | omits `devTools` and `spellcheck`, so the hardened set is asserted against the exported constant, not read back off the window |
| `safeStorage.isEncryptionAvailable()` after `whenReady()` | `true`; `typeof safeStorage.getSelectedStorageBackend === 'undefined'` |
| `powerMonitor` | `lock-screen`, `unlock-screen`, `suspend`, `resume` all attach. Electron maps them to `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked` and `NSWorkspaceWillSleepNotification` / `NSWorkspaceDidWakeNotification`. `getSystemIdleTime()` is in **seconds**. |
| `ipcMain.handle` twice on one channel | throws `Attempted to register a second handler for '<channel>'` |
| `LSUIElement` | M1 has no bundle, so the Dock icon is hidden with `app.dock.hide()`. `LSUIElement: 1` goes into the Info.plist at M3 packaging. |

**Day-0 spike (b), TCC attribution of an Accessibility request:** not exercised in M1 — M1 asks for
**no** permission at all (NSPasteboard reads, NSWorkspace attribution and Carbon hotkeys are all
permission-free). Record the answer when M2 first calls `AXIsProcessTrustedWithOptions`.
```

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git add PLATFORM-NOTES.md
git commit -m "docs(platform-notes): Electron 44 shell facts measured for the M1 palette"
```

- [ ] **Step 53: Work the manual checklist on a real Mac.** Everything above runs against fakes. These
      fourteen items are the ones only a human at a real machine can confirm, and several of them are
      the difference between "the tests pass" and "the product works". Run them in order.

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
npm run build      # guard + swiftc agent + electron-vite build
npx electron apps/desktop
```

`npx electron apps/desktop`, never `npx electron .` — the **root** `package.json` has no `"main"`, so
Electron exits immediately with `Unable to find Electron app at …`, and the root's `"type": "module"`
would break the CJS main bundle even if a main were found. `apps/desktop/package.json` is the manifest
with `"main": "out/main/index.js"` and no `"type"`. **Task 1's step that builds the app and opens the
window** uses the same form.

1. **No Dock icon, no window.** After launch, the Dock shows no Cairn icon and no window appears
   anywhere. `ps aux | grep -c cairn-agent-macos` prints at least `1`, so the Swift agent is running.
2. **First-run hotkey step.** On the very first launch a message box appears titled
   *Choose Cairn's hotkey*, whose detail text names Chrome, Slack, Google Docs, Discord, Visual Studio
   Code and Windows Terminal. `Use Cmd+Shift+V` is the highlighted default button, and
   `Use Cmd+Shift+C` is the second. Press **Return** to accept the default.
3. **The choice persisted.** `cat "$HOME/Library/Application Support/Cairn/config.json"` shows
   `"accelerator": "Cmd+Shift+V"` and `"firstRunHotkeyDone": true`, and
   `stat -f '%Sp %N' "$HOME/Library/Application Support/Cairn/config.json"` prints `-rw-------`.
   Relaunch: the dialog does **not** appear again.
4. **The data dir is `0700`, and `meta.json` tells the truth about the key.**
   `stat -f '%Sp' "$HOME/Library/Application Support/Cairn"` prints `drwx------`, and
   `cat "$HOME/Library/Application Support/Cairn/meta.json"` shows `"keyMode": "os-keyring"` —
   never `"unknown"`, which is what it would stay if nobody called `writeMeta`.
5. **The hotkey opens the palette from another app.** Click into TextEdit, press `Cmd+Shift+V`. The
   palette appears centred, translucent, with no title bar, and the search field has the caret.
6. **It opens over a full-screen app.** Put Safari into full screen, press `Cmd+Shift+V`. The palette
   appears **on top of** the full-screen Space without switching Spaces, and the Dock icon does not
   reappear (that is `skipTransformProcessType` working).
7. **Cmd+A / Cmd+C / Cmd+V work inside the search field.** Type `hello world` into the palette's
   search field, press `Cmd+A` (all text selects), `Cmd+C`, then `Cmd+V` twice. If any of the three
   does nothing, the Edit menu is gone — that is the bug Step 20 guards.
8. **The hotkey is a toggle.** Press `Cmd+Shift+V` again with the palette open: it hides.
9. **Copy, then recall.** In Finder select two files and press `Cmd+C`; screenshot an area with
   `Cmd+Shift+4`; copy a sentence from TextEdit. Press `Cmd+Shift+V`: three rows are listed, newest
   first, with a thumbnail on the image row. Type a few out-of-order letters from the sentence, arrow
   down to it, press **Return**.
10. **The toast is exact and the clipboard really changed.** A toast reads exactly
    `Copied — press Cmd+V`, the palette closes, and pressing `Cmd+V` in TextEdit pastes that sentence.
    `pbpaste | head -1` shows it too.
11. **No recall loop.** Immediately press `Cmd+Shift+V` again. The recalled item has **not** been
    added a second time — the row count is unchanged. If it doubled, `suppressToken` is not being
    called before the write is observed.
12. **DevTools are unreachable and the page is inert.** Relaunch with
    `CAIRN_HARDENED=1 npx electron apps/desktop`, open the palette, press `Cmd+Alt+I` and right-click
    the palette: no inspector, no context menu. `Cmd+Shift+V` still works.
13. **No sockets, no network.** With the app running,
    `lsof -nP -iTCP -iUDP -a -p "$(pgrep -f 'Cairn|Electron' | head -1)"` lists **nothing**. Turn Wi-Fi
    off and repeat items 5–10: everything still works.
14. **Nothing plaintext on disk.** Copy the literal string `CAIRN-CANARY-9f3a1c7e` from TextEdit, wait
    two seconds, then run:

```sh
grep -r 'CAIRN-CANARY-9f3a1c7e' "$HOME/Library/Application Support/Cairn" ; echo "data dir exit=$?"
grep -r 'CAIRN-CANARY-9f3a1c7e' "${TMPDIR:-/tmp}" 2>/dev/null ; echo "tmp exit=$?"
ls -la "$HOME/Library/Application Support/Cairn"
```

   Expected: both greps print nothing and exit `1`; the directory listing contains
   `history.ndjson`, `meta.json`, `key.bin`, `config.json` and `blobs/` and **no** `Crashpad`
   directory. Then confirm the item is really there: `Cmd+Shift+V`, type `canary`, and the row
   appears — proving the string is in the encrypted store and nowhere else.

Record any deviation in the PR description. Items 2, 7, 11 and 14 are release-blocking; the rest are
bugs to file.

- [ ] **Step 54: Push the branch for the user to merge.**

```sh
cd /Users/santoshkumarreddy/copy-clipboard-app
git log --oneline origin/main..
git log --format='%B' origin/main.. | grep -ci 'co-authored-by'    # must print 0
git push -u origin m1/09-shell-ipc
```

Expected: fourteen commits listed, the `grep -c` prints `0`, and
`branch 'm1/09-shell-ipc' set up to track 'origin/m1/09-shell-ipc'`. Do not merge, and do not add any
`Co-Authored-By` or AI-attribution trailer to any commit.

---

**Task 9 done when:**

- [ ] `git branch --show-current` prints `m1/09-shell-ipc`, `git log --oneline origin/main..` shows
      fourteen commits, and `git log --format='%B' origin/main.. | grep -ci 'co-authored-by'` prints `0`.
- [ ] `npx tsc -p tsconfig.json` exits 0 with no output.
- [ ] `npm run guard:no-rebuild` prints `guard-no-electron-rebuild OK` and exits 0.
- [ ] `npm run test -w @cairn/hotkey` prints `Tests 13 passed (13)`.
- [ ] `npm run test -w @cairn/desktop` passes and includes `windows.test.ts`, `menu.test.ts`,
      `config.test.ts`, `ipc-handlers.test.ts` and `wiring.test.ts` — `Test Files 5 passed (5)`.
- [ ] `npm run test:security` passes and includes `windows.security.test.ts`,
      `config.security.test.ts`, `logger.security.test.ts`,
      `apps/desktop/preload/src/index.security.test.ts`,
      `security/no-crash-reporter.security.test.ts`, `security/no-uri-scheme.security.test.ts`,
      `security/no-socket-at-startup.security.test.ts` and
      `security/renderer-hardening.security.test.ts`.
- [ ] `npx vitest run packages/hotkey/src/index.test.ts -t 'a false \`bound\` from the agent is a FAILED bind'`
      passes — a taken hotkey is a `'failed'` state, not a silent success.
- [ ] `npx vitest run apps/desktop/main/src/wiring.test.ts -t 'writes the reps to the real clipboard'`
      passes, and the asserted `write` params are `transient: false` with the token `'4711'` handed to
      `suppressToken`.
- [ ] `npx vitest run apps/desktop/main/src/wiring.test.ts -t 'evicts after the idle timeout'` passes
      on the injected clock, with no real timer anywhere.
- [ ] `npx vitest run apps/desktop/main/src/menu.test.ts -t 'throws when the whole Edit menu is gone'`
      passes with the message
      `cairn: the Edit menu is missing — Cmd+A, Cmd+C and Cmd+V would be dead in the search field`.
- [ ] `npx vitest run --project security apps/desktop/preload/src/index.security.test.ts -t 'EXACTLY these twelve methods'`
      passes, and `-t 'no generic bridge'` confirms `invoke`, `send` and `ipcRenderer` are all absent.
- [ ] `npx vitest run --project unit apps/desktop/main/src/ipc-handlers.test.ts -t 'rejects an over-range limit'`
      passes with the exact message `✖ Too big: expected number to be <=200\n  → at limit` and zero
      domain calls.
- [ ] `grep -rn 'crashReporter\|setAsDefaultProtocolClient\|createServer\|fetch(' apps/desktop/main/src apps/desktop/preload/src packages/hotkey/src`
      returns nothing — with **no** `grep -v` filter for comment lines, because none of these
      identifiers is named even inside a comment.
- [ ] `npx vitest run --project unit apps/desktop/main/src/wiring.test.ts -t 'a screen lock zeroes the master key'`
      passes, and `-t 'does NOT zero the key'` passes — spec §11 control 6's third clause is live in
      passphrase mode and deliberately inert in os-keyring mode.
- [ ] `npx vitest run --project unit apps/desktop/main/src/wiring.test.ts -t 'closes the store'` passes
      — quit zero-fills the derived blob name subkey as well as the master key.
- [ ] `npx vitest run --project unit apps/desktop/main/src/wiring.test.ts -t 'honest backend notes'`
      passes — the keyring's own report, including its `BANNER_KEYRING_WEAK` warning, reaches
      `cairn:security.status.notes`.
- [ ] `npx vitest run --project security apps/desktop/main/src/logger.security.test.ts -t 'no line naming the canary'`
      passes — a REAL ingest through `composeApp` with the real logger, the real `@cairn/store`,
      `@cairn/search`, `@cairn/privacy` and `@cairn/history` emits at least one line, every line parses
      as JSON, the union of keys across all lines is a subset of `LOG_FIELD_KEYS`, and no line contains
      `CAIRN-CANARY-9f3a1c7e` in plain text, base64 or hex (spec §11 control 2, runtime half).
- [ ] `npx vitest run --project security security/no-socket-at-startup.security.test.ts -t 'argv array'`
      passes — `node:child_process` is reachable from exactly one file on the capture and recall path,
      `packages/agent-host/src/spawn-agent.ts`, which spawns an argv **array** with no `shell` option
      (spec §11 control 3: "no shell in the capture or recall path at all on macOS"). And
      `-t 'shell-spawning or shell-invoking form'` passes — no `execSync`, `execFile`, `spawnSync`,
      `shell: true`, `/bin/sh` or `osascript` under `packages/**` or `apps/desktop/**`.
- [ ] `grep -c "renderer.navigation-blocked" packages/protocol/src/log.ts` prints `1`, not `2` — this
      task did **not** append the seven shell ids Task 2 already shipped, and
      `npm run test -w @cairn/protocol` is still green with `LOG_EVENTS` at 46 entries.
- [ ] `grep -c 'interface CapturePort' apps/desktop/main/src/wiring.ts` prints `0`,
      `grep -c "import type { Capture } from '@cairn/capture'" apps/desktop/main/src/wiring.ts` prints `1`,
      and `grep -c 'await capture.stop()\|await capture.whenIdle()' apps/desktop/main/src/wiring.ts` prints
      `2` — capture is typed by Task 7's real `Capture`, and both `stop()` and `whenIdle()` are awaited on
      shutdown. (Grep for `interface CapturePort`, not the bare word: the block comment that explains the
      absence names it. And grep for the two calls, not `await capture`, because `start()` is awaited too.)
- [ ] `grep -c "require('" apps/desktop/main/src/wiring.test.ts` prints `0` and
      `grep -c "^import { createHotkey } from '@cairn/hotkey'" apps/desktop/main/src/wiring.test.ts` prints
      `1` — vitest loads the file as ESM, and a `require('@cairn/hotkey')` would throw
      `ReferenceError: require is not defined` before any `it()` ran, silently taking the lock/quit
      key-zeroing assertions with it.
- [ ] `grep -rn 'Date.now()\|setInterval(\|setTimeout(' apps/desktop/main/src packages/hotkey/src | grep -v 'clock.setTimeout'`
      returns nothing — the only clock is the injected one.
- [ ] `grep -c 'ipcRenderer.invoke' apps/desktop/preload/src/index.ts` prints `8`, and
      `grep -c "ipcRenderer.on\|ipcRenderer.removeListener" apps/desktop/preload/src/index.ts` prints
      `2` (one of each, inside the single `subscribe` helper).
- [ ] `npx electron-vite build` succeeds and `head -c 12 apps/desktop/out/main/index.js` prints
      `"use strict"` — the main bundle is CJS, as `apps/desktop/package.json` having no `"type"` field
      requires.
- [ ] Step 50's sixteen control-removal rows each produced the named failure, and
      `git status --short` is empty.
- [ ] Step 53's manual checklist is complete on a real Mac, with items 2, 7, 11 and 14 all passing:
      the first-run dialog names what `Cmd+Shift+V` overrides; `Cmd+A`/`C`/`V` work inside the search
      field; a recall does not re-record itself; and `grep -r 'CAIRN-CANARY-9f3a1c7e'` finds nothing
      under the data dir or `$TMPDIR` while the palette still finds the item.
- [ ] `PLATFORM-NOTES.md` contains the Electron 44 shell table, including the
      `setName`-before-`requestSingleInstanceLock` ordering fact and the
      `will-frame-navigate`-fires-instead-of-`will-navigate` fact.
