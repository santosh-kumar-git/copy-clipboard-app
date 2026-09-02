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
