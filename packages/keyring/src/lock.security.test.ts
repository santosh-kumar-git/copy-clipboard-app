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
