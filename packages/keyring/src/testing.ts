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
