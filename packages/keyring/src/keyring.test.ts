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
})
