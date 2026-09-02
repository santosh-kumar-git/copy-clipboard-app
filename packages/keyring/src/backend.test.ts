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
