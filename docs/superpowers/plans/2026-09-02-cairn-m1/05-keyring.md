### Task 5: @cairn/keyring — the master key, honest backend reporting, and key hygiene

**Files:**

Create:

```
packages/keyring/src/index.ts                  createKeyring({safeStorage, platform, dir, logger})
packages/keyring/src/backend.ts                probeBackend(): the basic_text refusal policy
packages/keyring/src/passphrase.ts             scrypt N=2^17 r=8 p=1 with the mandatory maxmem
packages/keyring/src/keyring.ts                getMode, getOrCreateMasterKey, unlockWithPassphrase, lock
packages/keyring/src/testing.ts                createFakeSafeStorage() + createCapturingLogger() — no Electron
```

Test:

```
packages/keyring/src/backend.test.ts           refuses basic_text on linux; tolerates a missing API
packages/keyring/src/passphrase.test.ts        same passphrase+salt -> same key; wrong passphrase fails
packages/keyring/src/keyring.test.ts           key.bin wrap/unwrap; decrypt failure returns a re-key path
packages/keyring/src/keyring.security.test.ts  the master key Buffer is zero-filled on lock and quit
```

Verify, do **not** write:

```
packages/keyring/package.json                  @cairn/keyring manifest — created by Task 1
```

Modify: **nothing.** This task touches no file outside `packages/keyring/src/`. It does not add a
dependency to the root `package.json` (there is none to add — `node:crypto` and `node:fs` are
built in), and it does **not** import `electron`.

Four notes on files the contract owns, because Task 5 writes none of them:

1. **`packages/keyring/package.json` already exists on `origin/main`.** Task 1's step that writes the
   ten workspace manifests creates every `packages/*/package.json` — "here and only here. No later
   task creates a workspace manifest" — and `guard-no-electron-rebuild` counts **11** manifests
   *including* this one from Task 1 onwards. Writing it again here would be a second author of one
   dependency list, which is how two lists start disagreeing, and would push the manifest count to
   12. Step 3 therefore verifies it byte-for-byte against contract §2's per-package `dependencies`
   table (`{ "@cairn/protocol": "0.1.0" }` — **one** dependency, no `electron`) and leaves it alone.
2. `packages/keyring/src/testing.ts` **is already in the frozen §1 file tree**, one line after
   `packages/keyring/src/keyring.test.ts`, reading
   `packages/keyring/src/testing.ts            createFakeSafeStorage() + createCapturingLogger() — no Electron`.
   It mirrors `packages/store/src/testing.ts`, which the tree lists as
   `tempStoreDir() and randomTestKey() for every test`. Nothing has to be added to contract §1 for
   this task: every file Task 5 creates is named there.
3. `security/no-plaintext-on-disk.security.test.ts` is created by **Task 6**, in its step that writes
   contract §8's repo-wide no-plaintext-on-disk test — not by this task and not by Task 9. Its source
   scan covers `packages/**` and `apps/desktop/**`, `.ts` files only, **with comments stripped
   first**, and bans seven identifiers: `mkdtemp`, `tmpdir(`, `os.tmpdir`, `spool`,
   `writeFileSync(`, `appendFileSync(` and `createWriteStream(`. It already exempts **every path
   ending `.test.ts`** — which is what lets `keyring.test.ts` and `keyring.security.test.ts` build
   their own `mkdtempSync(join(tmpdir(), 'cairn-keyring-'))` directory and plant a hostile 0644
   `key.bin` with `writeFileSync` — plus `packages/store/` for the three
   write identifiers and the single file `packages/store/src/testing.ts` for the temp-dir ones.
   Keyring's **product** code (`backend.ts`, `passphrase.ts`, `keyring.ts`, `testing.ts`,
   `index.ts`) contains none of the seven in code: it writes `key.bin` through
   `openSync`/`writeSync`/`fsyncSync` and creates no temp file at all. The two places those words do
   appear in `keyring.ts` are inside `/** … */` blocks, which the scan strips before matching — that
   is the design point, not a loophole, and it is why the ban is on code rather than prose.
4. Task 9's security suite adds a repo-wide **shell-execution** ban — no `exec(`, `execSync`,
   `execFile` or `shell: true` anywhere in `packages/**` or `apps/desktop/**`, which is spec §11
   control 3's "no shell in the capture or recall path at all on macOS" finally asserted. `packages/keyring/`
   is inside that scope and is clean by construction: this package's only side effects are
   `mkdirSync`, `chmodSync`, `openSync`/`writeSync`/`fsyncSync`/`closeSync`, `readFileSync`,
   `readSync`, `existsSync` and `rmSync`. It never spawns anything, and `dir` — an
   attacker-influenceable path in the sense that it comes from Electron — is only ever passed to
   `node:path.join` and to `node:fs`, never interpolated into a command string.

**Interfaces:**

`Consumes:` — every one of these is from `@cairn/protocol` (contract §5, §10), imported by package
name, never by a deep path:

```ts
import {
  err, ok,
  BANNER_KEYRING_WEAK, SCRYPT_PARAMS, STORE_BLOB_DIR, STORE_KEY_FILE, STORE_LOG_FILE,
  type AgentPlatform, type KeyringMode, type LogEvent, type LogFields, type Logger,
  type LogLevel, type Result,
} from '@cairn/protocol'

// The exact shapes relied on:
const STORE_KEY_FILE = 'key.bin'
const STORE_LOG_FILE = 'history.ndjson'
const STORE_BLOB_DIR = 'blobs'
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 192 * 1024 * 1024 } as const
const BANNER_KEYRING_WEAK =
  'Your desktop has no secure keyring, so Cairn will not pretend to encrypt. Set a passphrase.'
type AgentPlatform = 'macos' | 'win32' | 'linux'
type KeyringMode = 'os-keyring' | 'passphrase' | 'locked'
type Result<T> = { readonly ok: true; readonly value: T }
                | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly detail?: LogFields }
const ok: <T>(value: T) => Ok<T>
const err: (code: ErrorCode, message: string, detail?: LogFields) => Err
interface Logger {
  log<T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>): void
  debug<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  info<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  warn<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
}
```

Error codes used, and no others: `E_KEYRING_UNAVAILABLE`, `E_KEYRING_WEAK_BACKEND`,
`E_KEYRING_BAD_PASSPHRASE`, `E_KEYRING_LOCKED`.
`LogEvent` ids used, and no others: `keyring.mode`, `keyring.backend-refused`,
`keyring.unlock-failed`, `keyring.zeroed`.

`Produces:` — everything later tasks may import from `@cairn/keyring`:

```ts
// from ./backend
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?: () => string
}
export type KeyringBackend =
  | 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown' | 'unavailable'
export type BackendStrength = 'os-keychain' | 'os-keyring' | 'dpapi' | 'none'
export interface BackendReport {
  readonly backend: KeyringBackend
  readonly strength: BackendStrength
  readonly notes: readonly string[]
  readonly warning?: string
}
export function probeBackend(safeStorage: SafeStorageLike, platform: AgentPlatform): BackendReport
export const WINDOWS_DPAPI_WARNING: string
export const MACOS_KEYCHAIN_NOTE: string
export const LINUX_KEYRING_NOTE: string

// from ./passphrase
export const MASTER_KEY_BYTES = 32
export const PASSPHRASE_SALT_BYTES = 16
export const MIN_PASSPHRASE_CHARS = 8
export const KEYRING_VERIFY_INFO = 'cairn/keyring/verify/v1'
export function newSalt(): Buffer
export function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer
export function keyVerifier(masterKey: Buffer): Buffer
export function verifierMatches(masterKey: Buffer, expected: Buffer): boolean

// from ./keyring
export const KEY_FILE_VERSION = 1
export function ensureDir0700(dir: string): void
// Signature-identical to `packages/store/src/paths.ts`'s `writeFile0600` (Task 6), on purpose:
// two exported helpers with the same name must accept the same inputs, or moving a call site
// between the packages silently changes what "data" means.
export function writeFile0600(filePath: string, bytes: string | Uint8Array): void
export interface KeyringOptions {
  readonly safeStorage: SafeStorageLike
  readonly platform: AgentPlatform
  readonly dir: string
  readonly logger: Logger
}
export interface Keyring {
  getMode(): KeyringMode
  probeBackend(): BackendReport
  getOrCreateMasterKey(): Result<Buffer>
  unlockWithPassphrase(passphrase: string): Result<Buffer>
  rekeyAfterCorruption(): Result<{ lostItems: number }>
  lock(): void
}
export function createKeyring(opts: KeyringOptions): Keyring

// from ./testing
export interface FakeSafeStorageOptions {
  readonly available?: boolean
  readonly backend?: string | 'missing-api'
  readonly failDecrypt?: boolean
}
export interface FakeSafeStorage extends SafeStorageLike { readonly calls: readonly string[] }
export function createFakeSafeStorage(options?: FakeSafeStorageOptions): FakeSafeStorage
export interface CapturedLine { readonly level: LogLevel; readonly event: LogEvent; readonly fields: LogFields }
export interface CapturingLogger extends Logger { readonly lines: readonly CapturedLine[] }
export function createCapturingLogger(): CapturingLogger
```

Notes later tasks need, because they see only their own section plus the contract:

- **The whole API is synchronous.** It is called once at startup; `safeStorage`, `scryptSync` and the
  two tiny file reads are all synchronous, and being synchronous means two callers cannot race into
  writing two different `key.bin` files. **No method returns a `Promise`**, so the composition root —
  `main()` in `apps/desktop/main/src/index.ts`, Task 9 — must write
  `const masterKey = keyring.getOrCreateMasterKey()` with **no `await`**. `await` on
  a `Result<Buffer>` is not a type error and not a runtime error — it just resolves to the same object
  — so it will look like it works while claiming a Promise where there is none. Drop it.
- **`platform` is an `AgentPlatform`, which is `'macos' | 'win32' | 'linux'` — it is NOT
  `process.platform`.** Node reports `'darwin'` on macOS, and `'darwin'` is not in the union, so
  `createKeyring({ ..., platform: process.platform, ... })` fails to compile. `[verified]` with
  `@types/node@24.9.2` and `typescript@5.9.3` the exact output is
  `error TS2322: Type 'Platform' is not assignable to type 'AgentPlatform'.` followed by
  `Type '"aix"' is not assignable to type 'AgentPlatform'.` The composition root must map it, and
  mapping is not cosmetic: on a `'darwin'` value `probeBackend` would fall through to the Linux arm and attach
  `LINUX_KEYRING_NOTE` instead of `MACOS_KEYCHAIN_NOTE`, so the Security pane would tell a macOS
  user a lie about what holds their key. M1 ships macOS only, so the correct call site is a literal:

  ```ts
  const keyring = createKeyring({ safeStorage, platform: 'macos', dir: dataDir, logger })
  const masterKey = keyring.getOrCreateMasterKey()
  if (!masterKey.ok) throw new Error(`cairn: cannot open the store: ${masterKey.code}`)
  ```

- **The composition root must construct the keyring after `app.whenReady()`** and pass Electron's
  real `safeStorage` as `safeStorage`, `'macos'` as `platform`, and `app.getPath('userData')` as
  `dir` (after `app.setName(DATA_DIR_NAME)`). `probeBackend()` calls `isEncryptionAvailable()` before
  it touches anything else, so a too-early construction reports `strength: 'none'` and demands a
  passphrase instead of crashing — but it will be wrong, so sequence it correctly.
- **`getMode()` returns a runtime `KeyringMode`, which is NOT `StoreMeta.keyMode`.** `KeyringMode` is
  `'os-keyring' | 'passphrase' | 'locked'`; `@cairn/store`'s persisted `StoreMeta.keyMode` is
  `'os-keyring' | 'passphrase' | 'unknown'`. `'locked'` means "a key exists but is not in memory right
  now" — a property of *this process*, not of the store on disk — so it is **not persistable**, and
  `writeMeta` takes the narrower union precisely so that handing it `'locked'` is a COMPILE error
  rather than a meta file the next cold start cannot interpret. Anything writing meta must map it:

  ```ts
  const runtimeMode = keyring.getMode()                       // KeyringMode
  const keyMode = runtimeMode === 'locked' ? 'unknown' : runtimeMode  // StoreMeta['keyMode']
  ```

  Keyring itself never writes `meta.json` and never imports `StoreMeta`; it owns only `key.bin`, whose
  own `mode` field is the narrower `'os-keyring' | 'passphrase'` because a locked keyring has, by
  definition, nothing new to record.
- **There is no `createLogger` in `@cairn/protocol`.** `log.ts` exports `LogLevel`, `LOG_EVENTS`,
  `LogEvent`, `LogFields`, `ExactLogFields` and the `Logger` *interface* and nothing else; the one
  concrete NDJSON-to-stderr implementation is `apps/desktop/main/src/logger.ts`, which this package
  must not reach for — a second logger inside a library is a second place clipboard content could
  reach a sink. Every keyring test therefore injects `createCapturingLogger()` from
  `packages/keyring/src/testing.ts`.
- **`lock()` is what the app calls on `before-quit`.** There is no separate `zeroOnQuit()`.
- **`getOrCreateMasterKey()` returns the *same* `Buffer` object every time**, and `lock()` zero-fills
  it. Whoever holds that buffer (i.e. `@cairn/store`) sees it become 32 zero bytes at lock. That is
  the intent of spec §11 control 6 — do not defensively copy it, because a copy is a second live
  plaintext key nobody zeroes.

**Branch:** `m1/05-keyring`

**What and why, in five lines:** `safeStorage` is Electron's OS-keyring wrapper: it encrypts a
string with a key held by the macOS Keychain / Windows DPAPI / a Linux desktop keyring. We use it to
wrap one random 32-byte master key into `key.bin`, and everything else at rest is encrypted with that
key. `safeStorage` is a **main-process-only** API, so this package must never `import 'electron'` —
it takes a narrow injected surface (`SafeStorageLike`) and every test runs in plain Node against a
fake. The two things this package exists to be honest about: Chromium's `basic_text` backend
"encrypts" with a hardcoded password, so we refuse it; and on Windows DPAPI protects against another
account, not against code running as you, and we say so in the app's own words.

---

- [ ] **Step 1: Cut the branch.**

```sh
git fetch origin && git checkout -b m1/05-keyring origin/main
```

Expected: `Switched to a new branch 'm1/05-keyring'`. Never commit to `main`.

- [ ] **Step 2: Confirm you are on Node 24 before anything else.**

```sh
nvm use && node -v
```

Expected: `v24.20.0`, matching `.nvmrc`. This is not ceremony: the `security` vitest project uses
`environment: 'jsdom'`, and on Node 20 `jsdom@30.0.1` dies at load with
`Error [ERR_REQUIRE_ESM]: require() of ES Module .../@exodus/bytes/encoding-lite.js from
.../html-encoding-sniffer/lib/html-encoding-sniffer.js not supported.` — Node 24's `require(esm)`
support is what makes it work. If you see that error later, you are on the wrong Node.

- [ ] **Step 3: VERIFY the workspace manifest Task 1 already wrote. Do not rewrite it.**

`packages/keyring/package.json` came from Task 1's step that writes the ten workspace manifests and is
already on `origin/main`. Read it and confirm it is exactly this:

```sh
cat packages/keyring/package.json
```

Expected, character for character:

```json
{
  "name": "@cairn/keyring",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "master key + honest backend reporting",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run --root ../.. --project unit packages/keyring",
    "test:security": "vitest run --root ../.. --project security packages/keyring"
  },
  "dependencies": { "@cairn/protocol": "0.1.0" }
}
```

Then assert the dependency set mechanically, so "verified" is not a reading exercise:

```sh
node -e "const p=require('./packages/keyring/package.json');const d=p.dependencies;const k=Object.keys(d);if(k.length!==1||d['@cairn/protocol']!=='0.1.0')throw new Error('expected exactly 1 dep @cairn/protocol@0.1.0, got '+JSON.stringify(d));if(JSON.stringify(p).includes('electron'))throw new Error('electron must never appear in this manifest');console.log('keyring deps ok: 1 dependency, no electron')"
```

Expected: `keyring deps ok: 1 dependency, no electron`, matching contract §2's per-package
`dependencies` table. There is deliberately no `electron`: `safeStorage` arrives as an argument, which
is what lets every test in this package run in plain Node.

`require` is correct **here and only here**: `[verified]` `node -e` runs its argument as CommonJS even
though the root `package.json` sets `"type": "module"`, which is why Task 1's own manifest done-when
uses the same form. Do not carry that habit into a `.test.ts` file — vitest loads those as ESM, where
`require` throws `ReferenceError: require is not defined` before a single test runs. In a test, write
`await import(...)`.

If the file is missing or differs, **stop and fix Task 1's branch** — do not patch it from here. A
second author of one dependency list is how two lists start disagreeing, and re-creating it would make
`npm run guard:no-rebuild` count 12 manifests where every other task expects 11.

- [ ] **Step 4: Confirm the workspace resolves and that this package has no `src/` yet.**

```sh
npm install && ls -l node_modules/@cairn/keyring && ls packages/keyring
```

Expected: `npm install` prints `up to date` (Task 5 adds no dependency, so `package-lock.json` must
not change), the `ls -l` prints a symlink `node_modules/@cairn/keyring -> ../../packages/keyring`, and
the last `ls` prints only `package.json` — Task 1 created the manifest and nothing else, so every
`src/` file below is genuinely new.

- [ ] **Step 5: See both of the package's test scripts run, and find nothing.**

```sh
npm run test -w @cairn/keyring; echo "unit exit=$?"
npm run test:security -w @cairn/keyring; echo "security exit=$?"
```

Expected: each prints `No test files found, exiting with code 1`, then `filter: packages/keyring` and
`projects: unit` (resp. `projects: security`), then npm's own `npm error code 1` /
`npm error command failed` noise, then `exit=1`. `[verified]` on `vitest@4.1.11`: that is the exact
message and the exit code really is `1`. That is the honest starting point and it proves two things
before a line of code exists: the `unit` and `security` vitest projects both resolve from this
workspace with `--root ../..`, and neither is silently matching some other package's files. From here
every red-to-green transition below is real.

---

#### Cycle A — `probeBackend()` tells the truth about what is protecting the key

- [ ] **Step 6: Write the failing test for `probeBackend`.**

`packages/keyring/src/backend.test.ts`:

```ts
import { BANNER_KEYRING_WEAK } from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { LINUX_KEYRING_NOTE, MACOS_KEYCHAIN_NOTE, probeBackend, WINDOWS_DPAPI_WARNING } from './backend'
import { createFakeSafeStorage } from './testing'

describe('probeBackend', () => {
  it('reports os-keychain on macOS when getSelectedStorageBackend does not exist', () => {
    const safeStorage = createFakeSafeStorage({ backend: 'missing-api' })
    expect(probeBackend(safeStorage, 'macos')).toEqual({
      backend: 'unknown',
      strength: 'os-keychain',
      notes: [MACOS_KEYCHAIN_NOTE],
    })
    expect(safeStorage.calls).toEqual(['isEncryptionAvailable'])
  })

  it('refuses basic_text on linux with the weak-backend banner', () => {
    const report = probeBackend(createFakeSafeStorage({ backend: 'basic_text' }), 'linux')
    expect(report).toEqual({
      backend: 'basic_text',
      strength: 'none',
      notes: [],
      warning: BANNER_KEYRING_WEAK,
    })
  })

  it('accepts gnome_libsecret on linux', () => {
    const report = probeBackend(createFakeSafeStorage({ backend: 'gnome_libsecret' }), 'linux')
    expect(report).toEqual({
      backend: 'gnome_libsecret',
      strength: 'os-keyring',
      notes: [LINUX_KEYRING_NOTE],
    })
  })

  it('maps an unrecognised backend string to unknown rather than trusting it', () => {
    const report = probeBackend(createFakeSafeStorage({ backend: 'future_wallet' }), 'linux')
    expect(report.backend).toBe('unknown')
    expect(report.strength).toBe('os-keyring')
  })

  it('reports dpapi on win32 and carries the DPAPI sentence', () => {
    const report = probeBackend(createFakeSafeStorage({ backend: 'unknown' }), 'win32')
    expect(report.strength).toBe('dpapi')
    expect(report.notes).toEqual([WINDOWS_DPAPI_WARNING])
  })

  it('checks isEncryptionAvailable BEFORE touching the encryption surface', () => {
    const safeStorage = createFakeSafeStorage({ available: false, backend: 'gnome_libsecret' })
    const report = probeBackend(safeStorage, 'linux')
    expect(report).toEqual({
      backend: 'unavailable',
      strength: 'none',
      notes: [],
      warning: BANNER_KEYRING_WEAK,
    })
    expect(safeStorage.calls).toEqual(['isEncryptionAvailable'])
  })
})

describe('WINDOWS_DPAPI_WARNING', () => {
  it('is spec §4 verbatim, character for character', () => {
    expect(WINDOWS_DPAPI_WARNING).toBe(
      'DPAPI is per-user, so any process running as you can decrypt this store with no prompt. ' +
        'It protects against disk theft and other accounts, not local malware.',
    )
    expect(
      WINDOWS_DPAPI_WARNING.startsWith(
        'DPAPI is per-user, so any process running as you can decrypt this store with no prompt.',
      ),
    ).toBe(true)
  })
})
```

The last `describe` is the point of spec §11 control 11: that sentence is a promise to the user, so
it is a tested constant and cannot drift when someone edits the Security pane.

- [ ] **Step 7: Run it and watch it fail for the right reason.**

```sh
npx vitest run packages/keyring/src/backend.test.ts
```

Expected: **FAIL** with
`Error: Cannot find module './backend' imported from .../packages/keyring/src/backend.test.ts`
and `Tests  no tests`.

- [ ] **Step 8: Write `backend.ts`.**

`packages/keyring/src/backend.ts`:

```ts
import { BANNER_KEYRING_WEAK, type AgentPlatform } from '@cairn/protocol'

/**
 * The narrow slice of Electron's `safeStorage` this package uses. `@cairn/keyring` must never
 * `import 'electron'`: safeStorage is a main-process-only API, so importing it would make every
 * test in this package require a running Electron. The app injects the real object; tests inject
 * `createFakeSafeStorage()`.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Optional on purpose: it does not exist at runtime on macOS in Electron 44.1.1. */
  getSelectedStorageBackend?: () => string
}

export type KeyringBackend =
  | 'basic_text'
  | 'gnome_libsecret'
  | 'kwallet'
  | 'kwallet5'
  | 'kwallet6'
  | 'unknown'
  | 'unavailable'

export type BackendStrength = 'os-keychain' | 'os-keyring' | 'dpapi' | 'none'

export interface BackendReport {
  readonly backend: KeyringBackend
  readonly strength: BackendStrength
  /** Sentences for Settings -> Security, verbatim. Feeds `cairn:security.status`.`notes`. */
  readonly notes: readonly string[]
  readonly warning?: string
}

const KNOWN_BACKENDS: readonly KeyringBackend[] = [
  'basic_text',
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
  'unknown',
  'unavailable',
]

/**
 * Spec §4, verbatim, and spec §11 control 11: this sentence is a promise to the user, so it is a
 * tested constant rather than a string typed into a Svelte file. Do not reword it.
 */
export const WINDOWS_DPAPI_WARNING =
  'DPAPI is per-user, so any process running as you can decrypt this store with no prompt. ' +
  'It protects against disk theft and other accounts, not local malware.'

export const MACOS_KEYCHAIN_NOTE =
  "The macOS Keychain ACL is bound to this build's code signature. Re-signing or replacing the " +
  'app can lock the store until you re-key.'

export const LINUX_KEYRING_NOTE =
  'Your desktop keyring holds the key. It is unlocked with your login session, so anything running ' +
  'as you can ask for it.'

/**
 * Reports what is *actually* protecting the key. Nothing else in the app guesses at encryption
 * availability (spec §4).
 */
export function probeBackend(safeStorage: SafeStorageLike, platform: AgentPlatform): BackendReport {
  // Sequenced first, deliberately. `isEncryptionAvailable()` is only meaningful after Electron's
  // `ready` event on Linux (spec §4), and calling encryptString before then throws — so this is
  // both the honesty check and the guard that keeps us off the crypto surface too early.
  if (!safeStorage.isEncryptionAvailable()) {
    return { backend: 'unavailable', strength: 'none', notes: [], warning: BANNER_KEYRING_WEAK }
  }

  // electron.d.ts declares getSelectedStorageBackend unconditionally, but it does not exist at
  // runtime on macOS in Electron 44.1.1. A missing API is NOT a weak backend.
  const probe = safeStorage.getSelectedStorageBackend
  const raw = typeof probe === 'function' ? probe.call(safeStorage) : 'unknown'
  const backend: KeyringBackend = KNOWN_BACKENDS.includes(raw as KeyringBackend)
    ? (raw as KeyringBackend)
    : 'unknown'

  // The whole point of this function: Chromium's basic_text backend "encrypts" with a hardcoded
  // password and nothing warns you (spec §6). Refuse it.
  if (backend === 'basic_text') {
    return { backend, strength: 'none', notes: [], warning: BANNER_KEYRING_WEAK }
  }

  if (platform === 'macos') return { backend, strength: 'os-keychain', notes: [MACOS_KEYCHAIN_NOTE] }
  if (platform === 'win32') return { backend, strength: 'dpapi', notes: [WINDOWS_DPAPI_WARNING] }
  return { backend, strength: 'os-keyring', notes: [LINUX_KEYRING_NOTE] }
}
```

Note `warning?: string` is never assigned `undefined`: `exactOptionalPropertyTypes: true` forbids
that, which is why each branch builds its own complete object literal.

- [ ] **Step 9: Write `testing.ts`, the injected fake.**

Running the test now would fail with `Cannot find module './testing'`. Create
`packages/keyring/src/testing.ts`:

```ts
import type { LogEvent, LogFields, Logger, LogLevel } from '@cairn/protocol'
import type { SafeStorageLike } from './backend'

export interface FakeSafeStorageOptions {
  /**
   * What isEncryptionAvailable() returns, and whether the encryption surface works at all.
   * Electron on Linux returns false before app `ready` and its encryptString throws there too —
   * the two are the same condition, so one flag drives both.
   */
  readonly available?: boolean
  /** 'missing-api' omits getSelectedStorageBackend entirely, as Electron 44.1.1 does on macOS. */
  readonly backend?: string | 'missing-api'
  /** Makes decryptString throw, as a broken macOS Keychain ACL does after a re-sign. */
  readonly failDecrypt?: boolean
}

export interface FakeSafeStorage extends SafeStorageLike {
  /** Method names in call order, so a test can assert the availability check came first. */
  readonly calls: readonly string[]
}

const PREFIX = 'fake-safe-storage:v1:'

/**
 * A stand-in for Electron's safeStorage that models the two behaviours that matter: the encryption
 * surface throws whenever encryption is unavailable (Linux before app `ready`), and
 * getSelectedStorageBackend may not exist at all (macOS, Electron 44.1.1).
 *
 * The throw is gated on `available`, NOT on "did you call isEncryptionAvailable() first" — that is
 * how Electron behaves, and a fake that punished callers for not asking would make every test in
 * Cycle C fail before the sequencing guard even exists. Ordering is proved by `calls`, not by a
 * throw.
 */
export function createFakeSafeStorage(options: FakeSafeStorageOptions = {}): FakeSafeStorage {
  const available = options.available ?? true
  const backend = options.backend ?? 'missing-api'
  const failDecrypt = options.failDecrypt ?? false
  const calls: string[] = []

  const fake: FakeSafeStorage = {
    calls,
    isEncryptionAvailable() {
      calls.push('isEncryptionAvailable')
      return available
    },
    encryptString(plainText: string): Buffer {
      calls.push('encryptString')
      if (!available) throw new Error('safeStorage: encryption is not available yet')
      return Buffer.from(PREFIX + Buffer.from(plainText, 'utf8').toString('base64'), 'utf8')
    },
    decryptString(encrypted: Buffer): string {
      calls.push('decryptString')
      if (!available) throw new Error('safeStorage: encryption is not available yet')
      if (failDecrypt) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      }
      const text = encrypted.toString('utf8')
      if (!text.startsWith(PREFIX)) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      }
      return Buffer.from(text.slice(PREFIX.length), 'base64').toString('utf8')
    },
  }

  if (backend !== 'missing-api') {
    return {
      ...fake,
      getSelectedStorageBackend() {
        calls.push('getSelectedStorageBackend')
        return backend
      },
    }
  }
  return fake
}

export interface CapturedLine {
  readonly level: LogLevel
  readonly event: LogEvent
  readonly fields: LogFields
}

export interface CapturingLogger extends Logger {
  readonly lines: readonly CapturedLine[]
}

/** A Logger that keeps every line, so a test can assert what was and was not emitted. */
export function createCapturingLogger(): CapturingLogger {
  const lines: CapturedLine[] = []
  const log = (level: LogLevel, event: LogEvent, fields?: LogFields): void => {
    lines.push({ level, event, fields: fields ?? {} })
  }
  return {
    lines,
    log: (level, event, fields) => log(level, event, fields),
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  }
}
```

- [ ] **Step 10: Run the test and watch it pass.**

```sh
npx vitest run packages/keyring/src/backend.test.ts
```

Expected: **PASS**, `Tests  7 passed (7)`.

- [ ] **Step 11: Prove the DPAPI test can fail — mutate, run, restore.**

In `backend.ts`, change `'DPAPI is per-user, so any'` to `'DPAPI is per user, so any'`, then:

```sh
npx vitest run packages/keyring/src/backend.test.ts -t 'is spec §4 verbatim, character for character'
```

Expected: **FAIL**, and `[verified]` the exact line is `Tests  1 failed | 6 skipped (7)` — `-t` skips
the other six rather than deselecting them, so do not expect `(1)`. The diff is on the hyphen:
`AssertionError: expected 'DPAPI is per user, so any process run…' to be 'DPAPI is per-user, so any
process run…' // Object.is equality`. Undo the edit and re-run; expected
`Tests  1 passed | 6 skipped (7)`.

- [ ] **Step 12: Commit.**

```sh
git add packages/keyring/src
git commit -m "feat(keyring): probeBackend reports strength honestly and refuses basic_text"
```

---

#### Cycle B — the scrypt passphrase path

- [ ] **Step 13: Write the failing test for the passphrase derivation.**

`packages/keyring/src/passphrase.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  deriveKeyFromPassphrase,
  keyVerifier,
  MASTER_KEY_BYTES,
  newSalt,
  PASSPHRASE_SALT_BYTES,
  verifierMatches,
} from './passphrase'

const SALT = Buffer.from('0123456789abcdef', 'utf8')

describe('deriveKeyFromPassphrase', () => {
  it('derives 32 deterministic bytes for the same passphrase and salt', () => {
    const a = deriveKeyFromPassphrase('correct horse battery staple', SALT)
    const b = deriveKeyFromPassphrase('correct horse battery staple', SALT)
    expect(a.length).toBe(MASTER_KEY_BYTES)
    expect(a.equals(b)).toBe(true)
  })

  it('derives a different key for a different passphrase', () => {
    const a = deriveKeyFromPassphrase('correct horse battery staple', SALT)
    const b = deriveKeyFromPassphrase('correct horse battery stapl', SALT)
    expect(a.equals(b)).toBe(false)
  })

  it('derives a different key for a different salt', () => {
    const a = deriveKeyFromPassphrase('correct horse battery staple', SALT)
    const b = deriveKeyFromPassphrase('correct horse battery staple', Buffer.from('fedcba9876543210', 'utf8'))
    expect(a.equals(b)).toBe(false)
  })

  it('NFKC-normalises, so a combining accent and a precomposed character agree', () => {
    const precomposed: string = 'p\u00e4ssphrase' // a-with-diaeresis as ONE code point
    const combining: string = 'pa\u0308ssphrase'  // 'a' followed by COMBINING DIAERESIS
    expect(precomposed === combining).toBe(false)
    expect(precomposed.length).toBe(10)
    expect(combining.length).toBe(11)
    expect(
      deriveKeyFromPassphrase(precomposed, SALT).equals(deriveKeyFromPassphrase(combining, SALT)),
    ).toBe(true)
  })
})

describe('newSalt', () => {
  it('is 16 random bytes and differs every call', () => {
    const a = newSalt()
    const b = newSalt()
    expect(a.length).toBe(PASSPHRASE_SALT_BYTES)
    expect(a.equals(b)).toBe(false)
  })
})

describe('verifierMatches', () => {
  it('accepts the key it was built from and rejects any other', () => {
    const right = deriveKeyFromPassphrase('correct horse battery staple', SALT)
    const wrong = deriveKeyFromPassphrase('incorrect horse battery staple', SALT)
    const verifier = keyVerifier(right)
    expect(verifier.length).toBe(32)
    expect(verifierMatches(right, verifier)).toBe(true)
    expect(verifierMatches(wrong, verifier)).toBe(false)
  })

  it('returns false instead of throwing on a truncated verifier', () => {
    const key = deriveKeyFromPassphrase('correct horse battery staple', SALT)
    expect(verifierMatches(key, keyVerifier(key).subarray(0, 16))).toBe(false)
  })

  it('does not contain the key it verifies', () => {
    const key = deriveKeyFromPassphrase('correct horse battery staple', SALT)
    expect(keyVerifier(key).includes(key)).toBe(false)
  })
})
```

The two `: string` annotations in the NFKC test are load-bearing: without them TypeScript narrows
both to distinct string-literal types and `tsc` rejects the comparison with
`TS2367: This comparison appears to be unintentional because the types '"pässphrase"' and
'"pässphrase"' have no overlap`.

- [ ] **Step 14: Run it and watch it fail.**

```sh
npx vitest run packages/keyring/src/passphrase.test.ts
```

Expected: **FAIL** with `Error: Cannot find module './passphrase' imported from
.../packages/keyring/src/passphrase.test.ts`.

- [ ] **Step 15: Write `passphrase.ts`.**

`packages/keyring/src/passphrase.ts`:

```ts
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { SCRYPT_PARAMS } from '@cairn/protocol'

export const MASTER_KEY_BYTES = 32
export const PASSPHRASE_SALT_BYTES = 16
export const MIN_PASSPHRASE_CHARS = 8

/** Domain separation for the key-check value. Changing it invalidates every existing key.bin. */
export const KEYRING_VERIFY_INFO = 'cairn/keyring/verify/v1'

export function newSalt(): Buffer {
  return randomBytes(PASSPHRASE_SALT_BYTES)
}

/**
 * scrypt N=2^17 r=8 p=1 (spec §4). `maxmem` is NOT optional: N=2^17 r=8 needs 128 MiB and Node's
 * default cap is 32 MiB, so omitting it throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS. The passphrase is
 * NFKC-normalised so the same characters typed as precomposed or combining forms derive one key.
 */
export function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, MASTER_KEY_BYTES, SCRYPT_PARAMS)
}

/**
 * A 32-byte key-check value stored beside the salt. Without it a wrong passphrase would silently
 * produce a wrong key and surface much later as an unexplained store decrypt failure. It is an HMAC
 * over a fixed label, so it reveals nothing about the key it checks.
 */
export function keyVerifier(masterKey: Buffer): Buffer {
  return createHmac('sha256', masterKey).update(KEYRING_VERIFY_INFO).digest()
}

/** Constant-time compare. `timingSafeEqual` throws on a length mismatch, so length is checked first. */
export function verifierMatches(masterKey: Buffer, expected: Buffer): boolean {
  const actual = keyVerifier(masterKey)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
```

- [ ] **Step 16: Run it and watch it pass.**

```sh
npx vitest run packages/keyring/src/passphrase.test.ts
```

Expected: **PASS**, `Tests  8 passed (8)`. `[verified]` by running exactly this test file against
exactly this `passphrase.ts`: `Duration 3.50s (… tests 3.37s)`. Twelve scrypt derivations at ~280 ms
each is the cost of N=2¹⁷, and that cost is the point. If it finishes in well under a second, someone
has lowered `N` — check `SCRYPT_PARAMS` in `packages/protocol/src/constants.ts` before believing the
green.

- [ ] **Step 17: Prove the `maxmem` line is load-bearing.**

Temporarily replace `SCRYPT_PARAMS` in `deriveKeyFromPassphrase` with `{ N: 2 ** 17, r: 8, p: 1 }`
and run the same command. Expected: **FAIL** with
`RangeError: Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded`
and `code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS'`. Restore `SCRYPT_PARAMS` and re-run; expected
`Tests  8 passed (8)`.

- [ ] **Step 18: Commit.**

```sh
git add packages/keyring/src/passphrase.ts packages/keyring/src/passphrase.test.ts
git commit -m "feat(keyring): scrypt N=2^17 passphrase derivation with an HMAC key-check value"
```

---

#### Cycle C — a fresh install generates, wraps and re-reads one master key, with `0700` / `0600`

- [ ] **Step 19: Write the failing test for the key lifecycle and the permissions.**

`packages/keyring/src/keyring.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE_KEY_FILE } from '@cairn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKeyring, ensureDir0700, writeFile0600 } from './keyring'
import { createCapturingLogger, createFakeSafeStorage, type CapturingLogger } from './testing'

const PASSPHRASE = 'correct horse battery staple'

let dir: string
let logger: CapturingLogger

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-keyring-'))
  logger = createCapturingLogger()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('getOrCreateMasterKey', () => {
  it('generates a random 32-byte key, wraps it into key.bin, and returns the same key twice', () => {
    const keyring = createKeyring({ safeStorage: createFakeSafeStorage(), platform: 'macos', dir, logger })
    expect(keyring.getMode()).toBe('locked')

    const first = keyring.getOrCreateMasterKey()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.length).toBe(32)
    expect(keyring.getMode()).toBe('os-keyring')
    expect(existsSync(join(dir, STORE_KEY_FILE))).toBe(true)

    const second = keyring.getOrCreateMasterKey()
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value).toBe(first.value)
  })

  it('returns the same key after a relaunch, by unwrapping key.bin', () => {
    const safeStorage = createFakeSafeStorage()
    const first = createKeyring({ safeStorage, platform: 'macos', dir, logger }).getOrCreateMasterKey()
    const relaunched = createKeyring({ safeStorage, platform: 'macos', dir, logger })
    const second = relaunched.getOrCreateMasterKey()
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.equals(first.value)).toBe(true)
    expect(relaunched.getMode()).toBe('os-keyring')
  })

  it('never writes the raw key into key.bin', () => {
    const keyring = createKeyring({ safeStorage: createFakeSafeStorage(), platform: 'macos', dir, logger })
    const created = keyring.getOrCreateMasterKey()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const bytes = readFileSync(join(dir, STORE_KEY_FILE))
    expect(bytes.includes(created.value)).toBe(false)
    expect(bytes.toString('utf8').includes(created.value.toString('base64'))).toBe(false)
  })
})

describe('ensureDir0700 / writeFile0600', () => {
  it('creates a 0700 directory and tightens one that already exists at 0755', () => {
    const fresh = join(dir, 'fresh', 'nested')
    ensureDir0700(fresh)
    expect(statSync(fresh).mode & 0o777).toBe(0o700)

    const wide = join(dir, 'wide')
    mkdirSync(wide, { mode: 0o755 })
    expect(statSync(wide).mode & 0o777).toBe(0o755)
    ensureDir0700(wide)
    expect(statSync(wide).mode & 0o777).toBe(0o700)
  })

  it('creates a 0600 file and re-tightens one that already exists at 0644', () => {
    const fresh = join(dir, 'fresh.bin')
    writeFile0600(fresh, 'a')
    expect(statSync(fresh).mode & 0o777).toBe(0o600)

    const wide = join(dir, 'wide.bin')
    writeFileSync(wide, 'a', { mode: 0o644 })
    expect(statSync(wide).mode & 0o777).toBe(0o644)
    // node's `mode` option is ignored for a file that already exists, so the chmod is the control.
    writeFile0600(wide, 'b')
    expect(statSync(wide).mode & 0o777).toBe(0o600)
    expect(readFileSync(wide, 'utf8')).toBe('b')

    // Same signature as `@cairn/store`'s writeFile0600, so the Uint8Array branch is covered too.
    const raw = join(dir, 'raw.bin')
    writeFile0600(raw, new Uint8Array([0x63, 0x61, 0x69, 0x72, 0x6e]))
    expect(statSync(raw).mode & 0o777).toBe(0o600)
    expect(readFileSync(raw, 'utf8')).toBe('cairn')
  })
})

describe('data directory and file permissions', () => {
  it('forces the data dir to 0700 even when it already exists at 0755', () => {
    const nested = join(dir, 'Cairn')
    mkdirSync(nested, { mode: 0o755 })
    expect(statSync(nested).mode & 0o777).toBe(0o755)

    const keyring = createKeyring({
      safeStorage: createFakeSafeStorage(),
      platform: 'macos',
      dir: nested,
      logger,
    })
    expect(keyring.getOrCreateMasterKey().ok).toBe(true)
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })
})
```

`PASSPHRASE` is unused until Cycle E; leave it, it is used three cycles from now.
The "already exists at 0755" cases are the ones that matter: Electron creates `userData` with
`0755`, and `mkdirSync(..., {mode})` and `writeFileSync(..., {mode})` are both **ignored for a path
that already exists** — so an unconditional `chmod` is the actual control, not the `mode` argument.

- [ ] **Step 20: Run it and watch it fail.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **FAIL** with `Error: Cannot find module './keyring' imported from
.../packages/keyring/src/keyring.test.ts`.

- [ ] **Step 21: Write `keyring.ts` — the file layout, the helpers and the OS-keyring path.**

`packages/keyring/src/keyring.ts`. This is the first of five increments; later cycles add methods to
the `Keyring` interface, the returned object, and the import lists.

```ts
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  err,
  ok,
  STORE_KEY_FILE,
  type AgentPlatform,
  type KeyringMode,
  type Logger,
  type Result,
} from '@cairn/protocol'
import { probeBackend, type BackendReport, type SafeStorageLike } from './backend'
import { MASTER_KEY_BYTES } from './passphrase'

export const KEY_FILE_VERSION = 1

/** The on-disk shape of `key.bin`. Exactly one of `wrapped` / (`salt` + `verifier`) is populated. */
interface KeyFile {
  readonly v: number
  readonly mode: 'os-keyring' | 'passphrase'
  readonly salt: string | null
  readonly wrapped: string | null
  readonly verifier: string | null
}

type KeyFileRead =
  | { readonly state: 'absent' }
  | { readonly state: 'malformed' }
  | { readonly state: 'ok'; readonly file: KeyFile }

export interface KeyringOptions {
  readonly safeStorage: SafeStorageLike
  readonly platform: AgentPlatform
  readonly dir: string
  readonly logger: Logger
}

export interface Keyring {
  getMode(): KeyringMode
  probeBackend(): BackendReport
  getOrCreateMasterKey(): Result<Buffer>
}

const REKEY_HINT =
  'Call rekeyAfterCorruption() to start a new store; the old history cannot be recovered.'

function serialiseKeyFile(file: KeyFile): string {
  return JSON.stringify(file) + '\n'
}

/**
 * Hand-rolled because `@cairn/keyring` declares only `@cairn/protocol` as a dependency and must not
 * import a zod it does not declare. `rawMode` is read into a const first so TypeScript narrows it.
 */
function parseKeyFile(text: string): KeyFile | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null) return null
  const o = json as Record<string, unknown>
  if (o['v'] !== KEY_FILE_VERSION) return null
  const rawMode = o['mode']
  if (rawMode !== 'os-keyring' && rawMode !== 'passphrase') return null
  const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null)
  return { v: KEY_FILE_VERSION, mode: rawMode, salt: str('salt'), wrapped: str('wrapped'), verifier: str('verifier') }
}

/**
 * `mkdirSync` does NOT change the mode of a directory that already exists, and Electron creates
 * `userData` with 0755 — so chmod unconditionally on every launch (spec §11 control 6).
 */
export function ensureDir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/**
 * `mode` is ignored when the file already exists, so chmod unconditionally. fsync before close
 * because a key we cannot read back is a lost store.
 *
 * The parameter list is deliberately identical to `writeFile0600` in `packages/store/src/paths.ts`
 * (Task 6): `(filePath: string, bytes: string | Uint8Array)`. Two exported helpers that share a
 * name must accept the same inputs, otherwise moving a call site from one package to the other
 * either fails to compile or quietly changes the encoding assumption. Only the *body* differs —
 * store uses `writeFileSync`, and keyring must not, because `key.bin` has to be fsynced and
 * because `grep writeFileSync( packages/keyring/src` is a done-when check on this task.
 *
 * The `Buffer.from` normalisation is load-bearing: `writeSync` is overloaded on `ArrayBufferView`
 * and on `string`, and TypeScript resolves overloads against the *union*, so passing
 * `string | Uint8Array` straight through fails with
 * `TS2769: No overload matches this call. ... Type 'string' is not assignable to parameter of type
 * 'ArrayBufferView<ArrayBufferLike>'`.
 */
export function writeFile0600(filePath: string, bytes: string | Uint8Array): void {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  const fd = openSync(filePath, 'w', 0o600)
  try {
    writeSync(fd, buf)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(filePath, 0o600)
}

export function createKeyring(opts: KeyringOptions): Keyring {
  const { safeStorage, platform, dir, logger } = opts
  const keyPath = join(dir, STORE_KEY_FILE)

  /** INVARIANT: at most one live master-key Buffer per keyring, so lock() zeroes all of it. */
  let masterKey: Buffer | null = null
  let mode: KeyringMode = 'locked'

  function readKeyFile(): KeyFileRead {
    if (!existsSync(keyPath)) return { state: 'absent' }
    const file = parseKeyFile(readFileSync(keyPath, 'utf8'))
    return file === null ? { state: 'malformed' } : { state: 'ok', file }
  }

  function getOrCreateMasterKey(): Result<Buffer> {
    if (masterKey !== null) return ok(masterKey)

    ensureDir0700(dir)
    const read = readKeyFile()

    if (read.state === 'malformed') {
      logger.error('keyring.unlock-failed', { ok: false })
      return err('E_KEYRING_UNAVAILABLE', `${STORE_KEY_FILE} is not a Cairn key file. ${REKEY_HINT}`)
    }

    if (read.state === 'ok') {
      const wrapped = read.file.wrapped
      if (wrapped === null) {
        logger.error('keyring.unlock-failed', { ok: false })
        return err('E_KEYRING_UNAVAILABLE', `${STORE_KEY_FILE} has no wrapped key. ${REKEY_HINT}`)
      }
      const key = Buffer.from(safeStorage.decryptString(Buffer.from(wrapped, 'base64')), 'base64')
      if (key.length !== MASTER_KEY_BYTES) {
        key.fill(0)
        logger.error('keyring.unlock-failed', { ok: false })
        return err(
          'E_KEYRING_UNAVAILABLE',
          `${STORE_KEY_FILE} unwrapped to ${key.length} bytes, expected ${MASTER_KEY_BYTES}. ${REKEY_HINT}`,
        )
      }
      masterKey = key
      mode = 'os-keyring'
      logger.info('keyring.mode', { mode })
      return ok(key)
    }

    const key = randomBytes(MASTER_KEY_BYTES)
    const wrapped = safeStorage.encryptString(key.toString('base64')).toString('base64')
    writeFile0600(
      keyPath,
      serialiseKeyFile({ v: KEY_FILE_VERSION, mode: 'os-keyring', salt: null, wrapped, verifier: null }),
    )
    masterKey = key
    mode = 'os-keyring'
    logger.info('keyring.mode', { mode })
    return ok(key)
  }

  return {
    getMode: () => mode,
    probeBackend: () => probeBackend(safeStorage, platform),
    getOrCreateMasterKey,
  }
}
```

The key is base64'd on the way into `encryptString` because `safeStorage` has no `encryptBuffer` —
its API is string-in, `Buffer`-out for encrypt and `Buffer`-in, string-out for decrypt.

- [ ] **Step 22: Run it and watch it pass.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **PASS**, `Tests  6 passed (6)`.

- [ ] **Step 23: Prove the `0700` control can fail — mutate, run, restore.**

Delete the line `chmodSync(dir, 0o700)` from `ensureDir0700`, then:

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **FAIL**, `Tests  2 failed | 4 passed (6)`, with
`AssertionError: expected 493 to be 448` — `493` is `0o755`, `448` is `0o700`. Restore the line and
re-run; expected `Tests  6 passed (6)`.

- [ ] **Step 24: Prove the `0600` control can fail — mutate, run, restore.**

Delete the line `chmodSync(filePath, 0o600)` from `writeFile0600`, then run the same command. Expected:
**FAIL** on `creates a 0600 file and re-tightens one that already exists at 0644` with
`AssertionError: expected 420 to be 384` (`420` is `0o644`, `384` is `0o600`). Restore and re-run;
expected `Tests  6 passed (6)`.

- [ ] **Step 25: Commit.**

```sh
git add packages/keyring/src/keyring.ts packages/keyring/src/keyring.test.ts
git commit -m "feat(keyring): wrap a random 32-byte master key into a 0600 key.bin in a 0700 dir"
```

---

#### Cycle D — `basic_text` is refused, and the app falls to `locked`

- [ ] **Step 26: Add the failing refusal tests.**

Append these two `it` blocks **inside** the existing `describe('getOrCreateMasterKey')` in
`packages/keyring/src/keyring.test.ts`:

```ts
  it('refuses os-keyring mode when the backend is basic_text and stays locked', () => {
    const keyring = createKeyring({
      safeStorage: createFakeSafeStorage({ backend: 'basic_text' }),
      platform: 'linux',
      dir,
      logger,
    })
    const result = keyring.getOrCreateMasterKey()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_KEYRING_WEAK_BACKEND')
    expect(result.message).toContain('hardcoded password')
    expect(keyring.getMode()).toBe('locked')
    expect(existsSync(join(dir, STORE_KEY_FILE))).toBe(false)
    expect(logger.lines.some((l) => l.event === 'keyring.backend-refused')).toBe(true)
  })

  it('refuses when encryption is unavailable and never touches the encryption surface', () => {
    const safeStorage = createFakeSafeStorage({ available: false, backend: 'gnome_libsecret' })
    const keyring = createKeyring({ safeStorage, platform: 'linux', dir, logger })
    const result = keyring.getOrCreateMasterKey()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_KEYRING_UNAVAILABLE')
    expect(keyring.getMode()).toBe('locked')
    expect(safeStorage.calls).toEqual(['isEncryptionAvailable'])
  })
```

The second test is the "sequenced check" guard from spec §4 written as an assertion: the fake's
`encryptString`/`decryptString` throw whenever `available` is `false`, exactly as Electron behaves on
Linux before `ready`, and `expect(safeStorage.calls).toEqual(['isEncryptionAvailable'])` proves we
never got as far as the encryption surface.

- [ ] **Step 27: Run it and watch it fail.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **FAIL**, `Tests  2 failed | 6 passed (8)`. The two failures are **different**, and both
are the bug:

- `refuses os-keyring mode when the backend is basic_text and stays locked` fails with
  `AssertionError: expected true to be false` on `expect(result.ok).toBe(false)`. Without the refusal
  branch we happily "encrypt" with Chromium's hardcoded password and report success, which is
  precisely the bug spec §6 names.
- `refuses when encryption is unavailable and never touches the encryption surface` fails with
  `Error: safeStorage: encryption is not available yet` thrown out of
  `getOrCreateMasterKey`, not with an assertion diff. That is not you breaking something: with no
  refusal branch, `getOrCreateMasterKey` reaches `safeStorage.encryptString(...)` **at all**, and the
  fake throws there because `available` is `false`. Reaching that line is the defect; Step 28 stops
  us before it.

If instead you see `Tests  6 failed | 2 passed (8)`, with that same thrown error on the Cycle C tests
that were green at Step 22, your `createFakeSafeStorage` is gating the throw on "was
`isEncryptionAvailable()` called first" rather than on `available`. Fix the fake, not the keyring:
Electron's `encryptString` throws because encryption is unavailable, not because you forgot to ask.

- [ ] **Step 28: Add the refusal branch.**

In `keyring.ts`, insert this block at the top of `getOrCreateMasterKey`, immediately after
`if (masterKey !== null) return ok(masterKey)` and **before** `ensureDir0700(dir)`:

```ts
    const report = probeBackend(safeStorage, platform)
    if (report.strength === 'none') {
      logger.warn('keyring.backend-refused', { mode: 'locked' })
      return report.backend === 'basic_text'
        ? err(
            'E_KEYRING_WEAK_BACKEND',
            'refusing os-keyring mode: safeStorage selected the basic_text backend, which encrypts with a hardcoded password. Set a passphrase instead.',
          )
        : err(
            'E_KEYRING_UNAVAILABLE',
            'safeStorage reports encryption is unavailable. Set a passphrase instead.',
          )
    }
```

It goes before `ensureDir0700` on purpose: a refused launch creates no directory and writes nothing.

- [ ] **Step 29: Run it and watch it pass.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **PASS**, `Tests  8 passed (8)`.

- [ ] **Step 30: Commit.**

```sh
git add packages/keyring/src/keyring.ts packages/keyring/src/keyring.test.ts
git commit -m "feat(keyring): refuse the basic_text backend and stay locked pending a passphrase"
```

---

#### Cycle E — `unlockWithPassphrase`, and a wrong passphrase that destroys nothing

- [ ] **Step 31: Add the failing passphrase tests.**

First, one more `it` **inside** `describe('getOrCreateMasterKey')`:

```ts
  it('reports E_KEYRING_LOCKED rather than overwriting a passphrase key.bin', () => {
    const safeStorage = createFakeSafeStorage()
    const first = createKeyring({ safeStorage, platform: 'macos', dir, logger })
    expect(first.unlockWithPassphrase(PASSPHRASE).ok).toBe(true)
    const before = readFileSync(join(dir, STORE_KEY_FILE))

    const relaunched = createKeyring({ safeStorage, platform: 'macos', dir, logger })
    const result = relaunched.getOrCreateMasterKey()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_KEYRING_LOCKED')
    expect(relaunched.getMode()).toBe('locked')
    expect(readFileSync(join(dir, STORE_KEY_FILE)).equals(before)).toBe(true)
  })
```

Then this whole `describe` at the **end** of the file:

```ts
describe('unlockWithPassphrase', () => {
  it('creates a passphrase key.bin with a salt and no wrapped key', () => {
    const keyring = createKeyring({
      safeStorage: createFakeSafeStorage({ backend: 'basic_text' }),
      platform: 'linux',
      dir,
      logger,
    })
    const result = keyring.unlockWithPassphrase(PASSPHRASE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBe(32)
    expect(keyring.getMode()).toBe('passphrase')

    const file = JSON.parse(readFileSync(join(dir, STORE_KEY_FILE), 'utf8')) as Record<string, unknown>
    expect(file['mode']).toBe('passphrase')
    expect(file['wrapped']).toBe(null)
    expect(typeof file['salt']).toBe('string')
    expect(typeof file['verifier']).toBe('string')
  })

  it('derives the same key from the same passphrase after a relaunch', () => {
    const safeStorage = createFakeSafeStorage({ backend: 'basic_text' })
    const first = createKeyring({ safeStorage, platform: 'linux', dir, logger }).unlockWithPassphrase(PASSPHRASE)
    const second = createKeyring({ safeStorage, platform: 'linux', dir, logger }).unlockWithPassphrase(PASSPHRASE)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.equals(first.value)).toBe(true)
  })

  it('rejects a wrong passphrase without destroying key.bin', () => {
    const safeStorage = createFakeSafeStorage({ backend: 'basic_text' })
    expect(createKeyring({ safeStorage, platform: 'linux', dir, logger }).unlockWithPassphrase(PASSPHRASE).ok).toBe(true)
    const before = readFileSync(join(dir, STORE_KEY_FILE))

    const keyring = createKeyring({ safeStorage, platform: 'linux', dir, logger })
    const result = keyring.unlockWithPassphrase('wrong horse battery staple')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_KEYRING_BAD_PASSPHRASE')
    expect(keyring.getMode()).toBe('locked')
    expect(readFileSync(join(dir, STORE_KEY_FILE)).equals(before)).toBe(true)
    expect(keyring.unlockWithPassphrase(PASSPHRASE).ok).toBe(true)
  })

  it('rejects a passphrase under 8 characters before touching the disk', () => {
    const keyring = createKeyring({
      safeStorage: createFakeSafeStorage({ backend: 'basic_text' }),
      platform: 'linux',
      dir,
      logger,
    })
    const result = keyring.unlockWithPassphrase('short')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_KEYRING_BAD_PASSPHRASE')
    expect(existsSync(join(dir, STORE_KEY_FILE))).toBe(false)
  })

  it('refuses to convert an os-keyring key.bin into a passphrase one', () => {
    const safeStorage = createFakeSafeStorage()
    expect(createKeyring({ safeStorage, platform: 'macos', dir, logger }).getOrCreateMasterKey().ok).toBe(true)
    const before = readFileSync(join(dir, STORE_KEY_FILE))

    const keyring = createKeyring({ safeStorage, platform: 'macos', dir, logger })
    const result = keyring.unlockWithPassphrase(PASSPHRASE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('E_KEYRING_UNAVAILABLE')
    expect(readFileSync(join(dir, STORE_KEY_FILE)).equals(before)).toBe(true)
  })
})
```

Three of these five assert the same thing from different angles: **nothing in this package ever
overwrites or deletes a `key.bin` it cannot read.** Losing `key.bin` loses the entire history, so
every ambiguous case returns an error and leaves the bytes alone.

- [ ] **Step 32: Run it and watch it fail.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **FAIL**, `Tests  6 failed | 8 passed (14)`, with
`TypeError: keyring.unlockWithPassphrase is not a function` (and `first.unlockWithPassphrase is not
a function`) — the method does not exist yet.

- [ ] **Step 33: Implement `unlockWithPassphrase`.**

Three edits to `keyring.ts`.

**(a)** Extend the imports:

```ts
import {
  deriveKeyFromPassphrase,
  keyVerifier,
  MASTER_KEY_BYTES,
  MIN_PASSPHRASE_CHARS,
  newSalt,
  verifierMatches,
} from './passphrase'
```

**(b)** Add the method to the `Keyring` interface:

```ts
export interface Keyring {
  getMode(): KeyringMode
  probeBackend(): BackendReport
  getOrCreateMasterKey(): Result<Buffer>
  unlockWithPassphrase(passphrase: string): Result<Buffer>
}
```

**(c)** Add this function inside `createKeyring`, after `getOrCreateMasterKey`, and add
`unlockWithPassphrase,` to the returned object. Also add this guard to `getOrCreateMasterKey`,
immediately after the `read.state === 'malformed'` block, so a passphrase store is never clobbered:

```ts
    if (read.state === 'ok' && read.file.mode === 'passphrase') {
      return err(
        'E_KEYRING_LOCKED',
        `${STORE_KEY_FILE} is passphrase-wrapped. Call unlockWithPassphrase() instead.`,
      )
    }
```

```ts
  function unlockWithPassphrase(passphrase: string): Result<Buffer> {
    if (masterKey !== null) {
      return mode === 'passphrase'
        ? ok(masterKey)
        : err('E_KEYRING_UNAVAILABLE', 'already unlocked in os-keyring mode; call lock() first')
    }
    if (passphrase.normalize('NFKC').length < MIN_PASSPHRASE_CHARS) {
      return err(
        'E_KEYRING_BAD_PASSPHRASE',
        `passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters`,
      )
    }

    ensureDir0700(dir)
    const read = readKeyFile()

    if (read.state === 'malformed') {
      logger.error('keyring.unlock-failed', { ok: false })
      return err('E_KEYRING_UNAVAILABLE', `${STORE_KEY_FILE} is not a Cairn key file. ${REKEY_HINT}`)
    }

    if (read.state === 'ok' && read.file.mode !== 'passphrase') {
      return err(
        'E_KEYRING_UNAVAILABLE',
        `${STORE_KEY_FILE} is wrapped by the OS keyring, not a passphrase. Call getOrCreateMasterKey() instead.`,
      )
    }

    if (read.state === 'ok') {
      const { salt, verifier } = read.file
      if (salt === null || verifier === null) {
        logger.error('keyring.unlock-failed', { ok: false })
        return err('E_KEYRING_UNAVAILABLE', `${STORE_KEY_FILE} has no salt or verifier. ${REKEY_HINT}`)
      }
      const candidate = deriveKeyFromPassphrase(passphrase, Buffer.from(salt, 'base64'))
      if (!verifierMatches(candidate, Buffer.from(verifier, 'base64'))) {
        candidate.fill(0) // never leave a wrong derivation lying in memory
        logger.warn('keyring.unlock-failed', { ok: false })
        return err('E_KEYRING_BAD_PASSPHRASE', `passphrase does not match ${STORE_KEY_FILE}`)
      }
      masterKey = candidate
      mode = 'passphrase'
      logger.info('keyring.mode', { mode })
      return ok(candidate)
    }

    const salt = newSalt()
    const key = deriveKeyFromPassphrase(passphrase, salt)
    writeFile0600(
      keyPath,
      serialiseKeyFile({
        v: KEY_FILE_VERSION,
        mode: 'passphrase',
        salt: salt.toString('base64'),
        wrapped: null,
        verifier: keyVerifier(key).toString('base64'),
      }),
    )
    masterKey = key
    mode = 'passphrase'
    logger.info('keyring.mode', { mode })
    return ok(key)
  }
```

The `masterKey !== null` short-circuit at the top is not a convenience: without it, a second unlock
would derive a **second** live 32-byte plaintext key and only the newest would ever be zero-filled.
One keyring, one key Buffer.

- [ ] **Step 34: Run it and watch it pass.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **PASS**, `Tests  14 passed (14)`.

- [ ] **Step 35: Commit.**

```sh
git add packages/keyring/src/keyring.ts packages/keyring/src/keyring.test.ts
git commit -m "feat(keyring): passphrase mode, held in memory only, with a clean wrong-passphrase path"
```

---

#### Cycle F — `lock()` zero-fills the key (spec §11 control 6)

- [ ] **Step 36: Write the failing security test.**

`packages/keyring/src/keyring.security.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE_KEY_FILE } from '@cairn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKeyring } from './keyring'
import { createCapturingLogger, createFakeSafeStorage, type CapturingLogger } from './testing'

const PASSPHRASE = 'correct horse battery staple'

let dir: string
let logger: CapturingLogger

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-keyring-sec-'))
  logger = createCapturingLogger()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('spec §11 control 6 — the master key is zero-filled', () => {
  it('zero-fills the os-keyring key Buffer on lock', () => {
    const keyring = createKeyring({ safeStorage: createFakeSafeStorage(), platform: 'macos', dir, logger })
    const created = keyring.getOrCreateMasterKey()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const held = created.value
    expect(held.some((b) => b !== 0)).toBe(true)

    keyring.lock()

    expect(held.every((b) => b === 0)).toBe(true)
    expect(keyring.getMode()).toBe('locked')
  })

  it('zero-fills the passphrase key Buffer on the quit path and cannot recover it', () => {
    const keyring = createKeyring({
      safeStorage: createFakeSafeStorage({ backend: 'basic_text' }),
      platform: 'linux',
      dir,
      logger,
    })
    const unlocked = keyring.unlockWithPassphrase(PASSPHRASE)
    expect(unlocked.ok).toBe(true)
    if (!unlocked.ok) return
    const held = unlocked.value

    keyring.lock() // exactly what app-shell calls on 'before-quit'

    expect(held.every((b) => b === 0)).toBe(true)
    expect(keyring.getMode()).toBe('locked')
    const afterQuit = keyring.getOrCreateMasterKey()
    expect(afterQuit.ok).toBe(false)
    if (afterQuit.ok) return
    expect(afterQuit.code).toBe('E_KEYRING_WEAK_BACKEND')
  })

  it('hands out a fresh Buffer after lock, so the zeroed one is never reused', () => {
    const safeStorage = createFakeSafeStorage()
    const keyring = createKeyring({ safeStorage, platform: 'macos', dir, logger })
    const first = keyring.getOrCreateMasterKey()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const zeroed = first.value
    keyring.lock()

    const second = keyring.getOrCreateMasterKey()
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value).not.toBe(zeroed)
    expect(second.value.every((b) => b === 0)).toBe(false)
    expect(zeroed.every((b) => b === 0)).toBe(true)
  })

  it('is idempotent, so a lock during quit after a lock on sleep cannot throw', () => {
    const keyring = createKeyring({ safeStorage: createFakeSafeStorage(), platform: 'macos', dir, logger })
    expect(keyring.getOrCreateMasterKey().ok).toBe(true)
    keyring.lock()
    keyring.lock()
    expect(keyring.getMode()).toBe('locked')
  })
})
```

These assert the **bytes**, not a flag: `held.every((b) => b === 0)` on the buffer the caller is
still holding. A `locked = true` boolean with the plaintext key still in the heap would pass a
flag-based test and fail this one. The second test is the passphrase quit path, where the key exists
**only** in memory — after `lock()` it is genuinely unrecoverable without the passphrase, which is
what the mode is for.

- [ ] **Step 37: Run it and watch it fail.**

```sh
npm run test:security -w @cairn/keyring
```

Expected: **FAIL**, `Tests  4 failed (4)`, with `TypeError: keyring.lock is not a function`.

- [ ] **Step 38: Implement `lock()`.**

Add `lock(): void` to the `Keyring` interface, add `lock,` to the returned object, and add this
function inside `createKeyring` (place it above `getOrCreateMasterKey`, because the next cycle calls
it):

```ts
  function lock(): void {
    if (masterKey !== null) {
      masterKey.fill(0)
      masterKey = null
      logger.info('keyring.zeroed', { mode: 'locked' })
    }
    mode = 'locked'
  }
```

- [ ] **Step 39: Run it and watch it pass.**

```sh
npm run test:security -w @cairn/keyring
```

Expected: **PASS**, `Tests  4 passed (4)`.

- [ ] **Step 40: Prove the zero-fill can fail — mutate, run, restore.**

Delete the line `masterKey.fill(0)` (keeping `masterKey = null`, i.e. the "just drop the reference"
version a reviewer might wave through) and re-run. Expected: **FAIL**,
`Tests  3 failed | 1 passed (4)`, with `AssertionError: expected false to be true` on
`held.every((b) => b === 0)`. Restore the line and re-run; expected `Tests  4 passed (4)`.

- [ ] **Step 41: Commit.**

```sh
git add packages/keyring/src/keyring.ts packages/keyring/src/keyring.security.test.ts
git commit -m "feat(keyring): lock() zero-fills the master key Buffer on lock and on quit"
```

---

#### Cycle G — a decrypt failure returns a re-key path and never crash-loops

- [ ] **Step 42: Add the failing decrypt-failure and re-key tests.**

Append to `packages/keyring/src/keyring.test.ts`:

```ts
describe('rekeyAfterCorruption', () => {
  it('returns E_KEYRING_UNAVAILABLE on a decrypt failure and does not crash-loop', () => {
    const good = createFakeSafeStorage()
    expect(createKeyring({ safeStorage: good, platform: 'macos', dir, logger }).getOrCreateMasterKey().ok).toBe(true)
    const before = readFileSync(join(dir, STORE_KEY_FILE))

    const broken = createFakeSafeStorage({ failDecrypt: true })
    const keyring = createKeyring({ safeStorage: broken, platform: 'macos', dir, logger })
    for (const attempt of [1, 2, 3]) {
      const result = keyring.getOrCreateMasterKey()
      expect(result.ok, `attempt ${attempt}`).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('E_KEYRING_UNAVAILABLE')
      expect(result.message).toContain('rekeyAfterCorruption()')
      expect(keyring.getMode()).toBe('locked')
    }
    expect(readFileSync(join(dir, STORE_KEY_FILE)).equals(before)).toBe(true)
  })

  it('reports the lost line count, clears the store and installs a fresh key', () => {
    const good = createFakeSafeStorage()
    const original = createKeyring({ safeStorage: good, platform: 'macos', dir, logger }).getOrCreateMasterKey()
    expect(original.ok).toBe(true)
    if (!original.ok) return
    writeFileSync(join(dir, STORE_LOG_FILE), 'line1\nline2\nline3\n', { mode: 0o600 })
    mkdirSync(join(dir, STORE_BLOB_DIR), { mode: 0o700 })
    writeFileSync(join(dir, STORE_BLOB_DIR, 'sha256-x'), 'sealed', { mode: 0o600 })

    const keyring = createKeyring({ safeStorage: good, platform: 'macos', dir, logger })
    const result = keyring.rekeyAfterCorruption()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lostItems).toBe(3)
    expect(existsSync(join(dir, STORE_LOG_FILE))).toBe(false)
    expect(existsSync(join(dir, STORE_BLOB_DIR))).toBe(false)
    expect(keyring.getMode()).toBe('os-keyring')

    const fresh = keyring.getOrCreateMasterKey()
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect(fresh.value.equals(original.value)).toBe(false)
  })

  it('reports lostItems 0 when there is no log yet', () => {
    const keyring = createKeyring({ safeStorage: createFakeSafeStorage(), platform: 'macos', dir, logger })
    const result = keyring.rekeyAfterCorruption()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lostItems).toBe(0)
  })

  it('leaves the keyring locked for a passphrase re-key when no backend is usable', () => {
    const safeStorage = createFakeSafeStorage({ backend: 'basic_text' })
    const keyring = createKeyring({ safeStorage, platform: 'linux', dir, logger })
    expect(keyring.unlockWithPassphrase(PASSPHRASE).ok).toBe(true)
    writeFileSync(join(dir, STORE_LOG_FILE), 'a\nb\n', { mode: 0o600 })

    const result = keyring.rekeyAfterCorruption()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lostItems).toBe(2)
    expect(keyring.getMode()).toBe('locked')
    expect(existsSync(join(dir, STORE_KEY_FILE))).toBe(false)
    expect(keyring.unlockWithPassphrase('a brand new passphrase').ok).toBe(true)
  })
})
```

Also add this `it` **inside** the existing `describe('data directory and file permissions')`:

```ts
  it('writes key.bin 0600, and re-tightens a pre-existing wide-open key.bin', () => {
    const keyPath = join(dir, STORE_KEY_FILE)
    writeFileSync(keyPath, 'not a key file', { mode: 0o644 })
    expect(statSync(keyPath).mode & 0o777).toBe(0o644)

    const keyring = createKeyring({ safeStorage: createFakeSafeStorage(), platform: 'macos', dir, logger })
    // A malformed key.bin is a re-key path, not an overwrite.
    const refused = keyring.getOrCreateMasterKey()
    expect(refused.ok).toBe(false)
    expect(keyring.rekeyAfterCorruption().ok).toBe(true)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
  })
```

And extend the file's import from `@cairn/protocol` to:

```ts
import { STORE_BLOB_DIR, STORE_KEY_FILE, STORE_LOG_FILE } from '@cairn/protocol'
```

The "does not crash-loop" test is the whole behaviour: three identical calls, three identical
errors, and `key.bin` byte-identical afterwards. Nothing destructive happens until the caller
explicitly asks for it. That is what stops the "relaunch, crash, relaunch, crash" loop a
Keychain-ACL break would otherwise cause after the app is re-signed.

- [ ] **Step 43: Run it and watch it fail.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **FAIL**, `Tests  5 failed | 14 passed (19)`. The first failure is
`Error: Error while decrypting the ciphertext provided to safeStorage.decryptString.` — the throw
escapes `getOrCreateMasterKey` instead of becoming a `Result`. The rest are
`TypeError: keyring.rekeyAfterCorruption is not a function`.

- [ ] **Step 44: Implement the decrypt guard and `rekeyAfterCorruption`.**

Four edits to `keyring.ts`.

**(a)** Extend the `node:fs` and `@cairn/protocol` imports:

```ts
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs'
import {
  err,
  ok,
  STORE_BLOB_DIR,
  STORE_KEY_FILE,
  STORE_LOG_FILE,
  type AgentPlatform,
  type KeyringMode,
  type Logger,
  type Result,
} from '@cairn/protocol'
```

**(b)** Add `rekeyAfterCorruption(): Result<{ lostItems: number }>` to the `Keyring` interface and
`rekeyAfterCorruption,` to the returned object.

**(c)** Replace the single unwrap line in `getOrCreateMasterKey` —

```ts
      const key = Buffer.from(safeStorage.decryptString(Buffer.from(wrapped, 'base64')), 'base64')
```

— with the guarded version:

```ts
      let plain: string
      try {
        plain = safeStorage.decryptString(Buffer.from(wrapped, 'base64'))
      } catch {
        // macOS re-signing invalidates the Keychain ACL. Report it; never retry, never crash-loop.
        logger.error('keyring.unlock-failed', { ok: false })
        return err(
          'E_KEYRING_UNAVAILABLE',
          `${STORE_KEY_FILE} could not be unwrapped by the OS keyring. ${REKEY_HINT}`,
        )
      }
      const key = Buffer.from(plain, 'base64')
```

**(d)** Add the line counter at module scope, next to `writeFile0600`:

```ts
/** Counts `\n` in a 64 KiB streaming loop, so a 512 MiB log is never read into memory. */
function countLines(path: string): number {
  if (!existsSync(path)) return 0
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(65_536)
    let lines = 0
    let read = 0
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) if (buf[i] === 0x0a) lines++
    }
    return lines
  } finally {
    closeSync(fd)
  }
}
```

and this function inside `createKeyring`, after `unlockWithPassphrase`:

```ts
  function rekeyAfterCorruption(): Result<{ lostItems: number }> {
    lock()
    const lostItems = countLines(join(dir, STORE_LOG_FILE))
    rmSync(join(dir, STORE_LOG_FILE), { force: true })
    rmSync(join(dir, STORE_BLOB_DIR), { recursive: true, force: true })
    rmSync(keyPath, { force: true })
    logger.warn('keyring.mode', { mode: 'locked', count: lostItems })

    if (probeBackend(safeStorage, platform).strength === 'none') {
      return ok({ lostItems }) // caller must now call unlockWithPassphrase() to set a new one
    }
    const created = getOrCreateMasterKey()
    if (!created.ok) return created
    return ok({ lostItems })
  }
```

Two things worth knowing here. First, `lostItems` is a **line count of an opaque encrypted file** —
keyring never parses a store record, it only counts `0x0A` bytes, so it needs no dependency on
`@cairn/store` (and contract §2's per-package `dependencies` table gives it none — one dependency,
`@cairn/protocol`; contract §9 adds no external package for keyring either). Second, deleting the log and the
blob directory is correct rather than lazy: the key that could read them is already gone, so spec §11
control 7's "deletion relies on key destruction" has already happened — the files are noise that
would otherwise make every future read fail.

- [ ] **Step 45: Run it and watch it pass.**

```sh
npx vitest run packages/keyring/src/keyring.test.ts
```

Expected: **PASS**, `Tests  19 passed (19)`.

- [ ] **Step 46: Commit.**

```sh
git add packages/keyring/src/keyring.ts packages/keyring/src/keyring.test.ts
git commit -m "feat(keyring): rekeyAfterCorruption reports lostItems and never crash-loops"
```

---

#### Cycle H — the key never reaches a log line or `key.bin` in the clear

- [ ] **Step 47: Add the failing log-canary and key.bin-content security tests.**

Append to `packages/keyring/src/keyring.security.test.ts`:

```ts
describe('spec §11 control 2 — no key material reaches the logger', () => {
  it('logs only metadata across the whole keyring lifecycle', () => {
    const safeStorage = createFakeSafeStorage()
    const osKeyring = createKeyring({ safeStorage, platform: 'macos', dir, logger })
    const created = osKeyring.getOrCreateMasterKey()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const keyBase64 = created.value.toString('base64')
    const keyHex = created.value.toString('hex')
    osKeyring.lock()

    // Relaunch, so the unwrap path is logged too and not only the create path.
    const relaunched = createKeyring({ safeStorage, platform: 'macos', dir, logger })
    expect(relaunched.getOrCreateMasterKey().ok).toBe(true)
    relaunched.lock()

    const passphraseDir = mkdtempSync(join(tmpdir(), 'cairn-keyring-sec2-'))
    try {
      const pw = createKeyring({
        safeStorage: createFakeSafeStorage({ backend: 'basic_text' }),
        platform: 'linux',
        dir: passphraseDir,
        logger,
      })
      expect(pw.getOrCreateMasterKey().ok).toBe(false)
      const unlocked = pw.unlockWithPassphrase(PASSPHRASE)
      expect(unlocked.ok).toBe(true)
      if (!unlocked.ok) return
      const derivedBase64 = unlocked.value.toString('base64')
      pw.lock()
      expect(pw.unlockWithPassphrase('wrong horse battery staple').ok).toBe(false)

      const dump = JSON.stringify(logger.lines)
      expect(dump).not.toContain(keyBase64)
      expect(dump).not.toContain(keyHex)
      expect(dump).not.toContain(derivedBase64)
      expect(dump).not.toContain(PASSPHRASE)
      expect(dump).not.toContain('horse')

      const allowed = new Set(['mode', 'code', 'ok', 'count'])
      for (const line of logger.lines) {
        for (const key of Object.keys(line.fields)) {
          expect(allowed.has(key), `unexpected log field ${key} on ${line.event}`).toBe(true)
        }
      }
      expect(logger.lines.map((l) => l.event)).toContain('keyring.zeroed')
      expect(logger.lines.map((l) => l.event)).toContain('keyring.unlock-failed')
    } finally {
      rmSync(passphraseDir, { recursive: true, force: true })
    }
  })
})

describe('spec §11 control 6 — key.bin never holds the raw key', () => {
  it('keeps key.bin at 0600 and free of the master key in both modes', () => {
    const osDir = mkdtempSync(join(tmpdir(), 'cairn-keyring-sec3-'))
    try {
      const osKeyring = createKeyring({
        safeStorage: createFakeSafeStorage(),
        platform: 'macos',
        dir: osDir,
        logger,
      })
      const created = osKeyring.getOrCreateMasterKey()
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const osBytes = readFileSync(join(osDir, STORE_KEY_FILE))
      expect(statSync(join(osDir, STORE_KEY_FILE)).mode & 0o777).toBe(0o600)
      expect(osBytes.includes(created.value)).toBe(false)
      expect(osBytes.toString('utf8')).not.toContain(created.value.toString('base64'))

      const pw = createKeyring({
        safeStorage: createFakeSafeStorage({ backend: 'basic_text' }),
        platform: 'linux',
        dir,
        logger,
      })
      const unlocked = pw.unlockWithPassphrase(PASSPHRASE)
      expect(unlocked.ok).toBe(true)
      if (!unlocked.ok) return
      const pwBytes = readFileSync(join(dir, STORE_KEY_FILE))
      expect(statSync(join(dir, STORE_KEY_FILE)).mode & 0o777).toBe(0o600)
      expect(pwBytes.includes(unlocked.value)).toBe(false)
      expect(pwBytes.toString('utf8')).not.toContain(unlocked.value.toString('base64'))
      expect(pwBytes.toString('utf8')).not.toContain(PASSPHRASE)
    } finally {
      rmSync(osDir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 48: Run it. These two pass immediately — that is expected, and the next step proves
      they are not vacuous.**

```sh
npm run test:security -w @cairn/keyring
```

Expected: **PASS**, `Tests  6 passed (6)`. The controls these test (the `LogFields` type and the
`safeStorage`-wrapped `key.bin`) were built in earlier cycles, so there is nothing to turn green.
They exist as the regression net, which is worth nothing unless it can catch a regression — hence
Step 49.

- [ ] **Step 49: Prove the log-canary test can fail — smuggle the key past the type system, run,
      restore.**

`LogFields` has no field that accepts a key, so the only way to regress is a cast. In `keyring.ts`,
in the **create** branch of `getOrCreateMasterKey` (the last of the two
`logger.info('keyring.mode', { mode })` calls), write:

```ts
    logger.info('keyring.mode', { mode: key.toString('base64') as KeyringMode })
```

Run `npm run test:security -w @cairn/keyring`. Expected: **FAIL**, `Tests  1 failed | 5 passed (6)`,
on `expect(dump).not.toContain(keyBase64)`. Repeat the same edit on the **unwrap** branch and confirm
it fails there too — the relaunch in the test is what covers that path. Restore both lines and
re-run; expected `Tests  6 passed (6)`.

- [ ] **Step 50: Commit.**

```sh
git add packages/keyring/src/keyring.security.test.ts
git commit -m "test(keyring): assert no key material reaches a log line or key.bin"
```

---

#### Finish — the barrel, the compile-time proof, and the whole suite

- [ ] **Step 51: Write the barrel.**

`packages/keyring/src/index.ts`:

```ts
export * from './backend'
export * from './keyring'
export * from './passphrase'
export * from './testing'
```

`./testing` is exported because the manifest declares exactly **one** entry point (`"." ->
"./src/index.ts"`) and contract §10 forbids deep paths — so the barrel is the only way anything outside
`packages/keyring/` could ever reach `createFakeSafeStorage`. Be honest about the M1 situation: no
other workspace imports it today. Three of keyring's four test files — `backend.test.ts`,
`keyring.test.ts` and `keyring.security.test.ts` — import `./testing` **relatively**
(`passphrase.test.ts` needs no fake at all), and
`apps/desktop/main/src/wiring.test.ts` does **not** use this fake — Task 9's `wiring.ts` narrows the
keyring to a local `KeyringPort` (`getMode`, `probeBackend`, `lock`) and its test builds an inline
object for it, so it never constructs a real keyring. The export exists so that the day something does
need the fake, the answer is `import { createFakeSafeStorage } from '@cairn/keyring'` rather than a
deep path or a duplicated fake.

`testing.ts` is safe to ship in the barrel: it holds no secret, no real key material, and — unlike
`packages/store/src/testing.ts` — no `tmpdir`/`mkdtemp` at all, so it does not need the
`packages/store/src/testing.ts` exemption in Task 6's repo-wide no-plaintext-on-disk scan.

- [ ] **Step 52: Add the compile-time proof that a key cannot be logged.**

Append to `packages/keyring/src/keyring.security.test.ts`. This function is **never called** — the
`@ts-expect-error` directives are the assertion and `npm run typecheck` is the runner, exactly as
`packages/protocol/src/types.test.ts` does it:

```ts
/**
 * Compile-time half of spec §11 control 2. Never called at runtime: `tsc` is the assertion. If
 * `LogFields` ever grows an index signature, every directive below becomes
 * `TS2578: Unused '@ts-expect-error' directive` and `npm run typecheck` fails.
 */
export function logFieldsProof(log: Logger, masterKey: Buffer, passphrase: string): void {
  log.info('keyring.mode', { mode: 'os-keyring' })
  // @ts-expect-error the master key is not a LogFields key
  log.info('keyring.mode', { mode: 'os-keyring', key: masterKey.toString('base64') })
  // @ts-expect-error a passphrase is not a LogFields key
  log.warn('keyring.unlock-failed', { passphrase })
  // @ts-expect-error mode is a KeyringMode, not a free-form string
  log.info('keyring.mode', { mode: masterKey.toString('hex') })
  // @ts-expect-error the event name is a closed union: no ad-hoc message can carry the key
  log.info('keyring: master key is ' + masterKey.toString('base64'))
}
```

Extend that file's `@cairn/protocol` import to:

```ts
import { STORE_KEY_FILE, type Logger } from '@cairn/protocol'
```

- [ ] **Step 53: Type-check the whole repo.**

```sh
npx tsc -p tsconfig.json
```

Expected: exit `0`, no output. If you see `TS6133: 'PASSPHRASE' is declared but its value is never
read`, you skipped a cycle-E test.

- [ ] **Step 54: Prove the compile-time proof is load-bearing.**

Delete the line `// @ts-expect-error the master key is not a LogFields key` and run
`npx tsc -p tsconfig.json`. Expected: **exit 2** with
`error TS2353: Object literal may only specify known properties, and 'key' does not exist in type
'ExactLogFields<LogFields>'`. Restore the line and re-run; expected exit `0`.

- [ ] **Step 55: Run both of the package's suites together.**

```sh
npm run test -w @cairn/keyring && npm run test:security -w @cairn/keyring
```

Expected: `Tests  34 passed (34)` across 3 files for the unit project, then `Tests  6 passed (6)`
for the security project.

- [ ] **Step 56: Run the repo-wide verification, to be sure nothing else moved.**

```sh
npm run verify
```

`npm run verify` is `guard:no-rebuild && typecheck && test && scan:transcripts`. Expected, in that
order: the guard prints `guard-no-electron-rebuild OK — scanned N lockfile entries and 11 manifests`
(**11**, not 12 — Task 5 adds no manifest); `tsc -p tsconfig.json` and
`svelte-check --tsconfig apps/desktop/renderer/tsconfig.json --threshold error` are both silent; then
`vitest run` with no `--project` runs **all three** projects — `unit`, `renderer` and `security` — and
all three are green; then the transcript scan passes.

Three projects, not two: `unit` collects `packages/*/src/**/*.test.ts` (keyring's three unit files),
`security` collects `packages/*/src/**/*.security.test.ts` (keyring's one), and `renderer` collects
`apps/desktop/renderer/src/**/*.test.ts` — nothing of keyring's, which is exactly why it must still be
run rather than skipped: `npm run test:unit` alone would leave both of the other two uncollected.
`@cairn/keyring` adds no dependency, so the supply-chain security test stays green too, and
`git diff origin/main -- package-lock.json packages/keyring/package.json` must be empty.

- [ ] **Step 57: Commit and push the branch for review.**

```sh
git add packages/keyring
git commit -m "feat(keyring): export the public surface and pin the log-safety proof to tsc"
git push -u origin m1/05-keyring
```

Expected: `branch 'm1/05-keyring' set up to track 'origin/m1/05-keyring'`. Do not merge it
yourself; do not add a `Co-Authored-By` trailer to any of these commits.

---

**Task 5 done when:**

- [ ] `npm run test -w @cairn/keyring` prints `Tests  34 passed (34)` over
      `backend.test.ts` (7), `passphrase.test.ts` (8) and `keyring.test.ts` (19).
- [ ] `npm run test:security -w @cairn/keyring` prints `Tests  6 passed (6)`.
- [ ] `npx tsc -p tsconfig.json` exits `0`.
- [ ] This exits `1` with no output — no `electron` import, no `electron` dependency anywhere in the
      package. `safeStorage` only ever arrives as `KeyringOptions.safeStorage`:

      ```sh
      grep -rnE "from '[^']*electron|require\(['\"][^'\"]*electron|\"electron\"" packages/keyring/
      ```

      Do **not** simplify this to `grep -rn "electron" packages/keyring/`: `[verified]` that form
      returns two hits and would fail, because `backend.ts` says in prose "`@cairn/keyring` must never
      `import 'electron'`" and "electron.d.ts declares getSelectedStorageBackend unconditionally". Those
      comments are the reason the rule exists; they are not violations of it. The pattern above is
      `[verified]` to stay silent on the real files and to fire on both a planted
      `import { safeStorage } from 'electron'` and a planted `"electron": "44.1.1"` dependency.
- [ ] This exits `1` with no output (`[verified]` on a fixture: it prints the offending line when a
      `writeFileSync(` call is planted in `packages/keyring/src/`, and nothing when it is removed):

      ```sh
      grep -rnE "mkdtemp|tmpdir\(|os\.tmpdir|spool|writeFileSync\(|appendFileSync\(|createWriteStream\(" packages/keyring/src/*.ts \
        | grep -v "\.test\.ts" \
        | grep -vE ":[[:space:]]*(\*|//|/\*)"
      ```

      Those are exactly the seven identifiers Task 6's
      `security/no-plaintext-on-disk.security.test.ts` bans across `packages/**` and
      `apps/desktop/**`. The product code creates no temp file and writes only `key.bin`, through
      `openSync`/`writeSync`/`fsyncSync`. The final `grep -v` drops the ` * ` doc-comment lines in
      `keyring.ts` that *name* `writeFileSync` in order to explain why it is not used — that scan
      strips comments before matching, so those lines are not offenders there either.
- [ ] `git diff origin/main -- packages/keyring/package.json package-lock.json` is **empty** — the
      manifest is Task 1's and Task 5 only read it, and no dependency was added.
- [ ] `npm run guard:no-rebuild` still prints `… and 11 manifests`, not 12.
- [ ] `npm run verify` is green, which means **all three** vitest projects ran: `unit`, `security` and
      `renderer` (the last collects none of keyring's files and must still run).
- [ ] Deleting `chmodSync(dir, 0o700)` makes `keyring.test.ts` fail with
      `expected 493 to be 448`; deleting `chmodSync(filePath, 0o600)` makes it fail with
      `expected 420 to be 384`.
- [ ] Deleting `masterKey.fill(0)` makes `keyring.security.test.ts` fail 3 tests on
      `held.every((b) => b === 0)`.
- [ ] Rewording `WINDOWS_DPAPI_WARNING` by one character makes `backend.test.ts` fail.
- [ ] Casting the master key into a `keyring.mode` log field makes `keyring.security.test.ts` fail;
      passing it without a cast fails `npx tsc` with `TS2353`.
- [ ] With a `basic_text` fake, `getOrCreateMasterKey()` returns
      `{ok: false, code: 'E_KEYRING_WEAK_BACKEND'}`, `getMode()` is `'locked'`, and no `key.bin`
      exists on disk.
- [ ] With a `failDecrypt` fake, three consecutive `getOrCreateMasterKey()` calls all return
      `E_KEYRING_UNAVAILABLE` with `rekeyAfterCorruption()` in the message, and `key.bin` is
      byte-identical to before the first call.
- [ ] `keyring.getMode()` is never handed straight to `@cairn/store`'s `writeMeta`: `KeyringMode`'s
      `'locked'` is not a member of `StoreMeta['keyMode']` (`'os-keyring' | 'passphrase' | 'unknown'`),
      so any call site that persists it maps `'locked'` to `'unknown'` first, and omitting the map is a
      compile error rather than a corrupt `meta.json`.
- [ ] `git log --oneline origin/main..m1/05-keyring` shows **9** commits (Steps 12, 18, 25, 30, 35, 41,
      46, 50 and 57 — there is no manifest commit, because Task 1 already committed the manifest), none
      of them containing `Co-Authored-By`, and `git push` has published the branch.
