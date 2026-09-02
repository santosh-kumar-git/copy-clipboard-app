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
