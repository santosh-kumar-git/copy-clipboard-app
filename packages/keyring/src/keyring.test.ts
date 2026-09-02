import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE_BLOB_DIR, STORE_KEY_FILE, STORE_LOG_FILE } from '@cairn/protocol'
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
})

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
