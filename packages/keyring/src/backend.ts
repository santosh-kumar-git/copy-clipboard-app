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
