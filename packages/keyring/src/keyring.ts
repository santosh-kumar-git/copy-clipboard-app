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
import {
  deriveKeyFromPassphrase,
  keyVerifier,
  MASTER_KEY_BYTES,
  MIN_PASSPHRASE_CHARS,
  newSalt,
  verifierMatches,
} from './passphrase'

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
  unlockWithPassphrase(passphrase: string): Result<Buffer>
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

    ensureDir0700(dir)
    const read = readKeyFile()

    if (read.state === 'malformed') {
      logger.error('keyring.unlock-failed', { ok: false })
      return err('E_KEYRING_UNAVAILABLE', `${STORE_KEY_FILE} is not a Cairn key file. ${REKEY_HINT}`)
    }

    if (read.state === 'ok' && read.file.mode === 'passphrase') {
      return err(
        'E_KEYRING_LOCKED',
        `${STORE_KEY_FILE} is passphrase-wrapped. Call unlockWithPassphrase() instead.`,
      )
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

  return {
    getMode: () => mode,
    probeBackend: () => probeBackend(safeStorage, platform),
    getOrCreateMasterKey,
    unlockWithPassphrase,
  }
}
