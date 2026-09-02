import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { contentHash } from './hash'

describe('contentHash', () => {
  it('is the known-answer vector for "hello", 43 base64url chars after the prefix', () => {
    const h = contentHash(Buffer.from('hello', 'utf8'))
    expect(h).toBe('sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
    expect(h.slice('sha256-'.length)).toHaveLength(43)
    expect(h).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/)
  })

  it('is the known-answer vector for the empty input', () => {
    expect(contentHash(new Uint8Array(0))).toBe(
      'sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
    )
  })

  it('uses base64url, never standard base64 (no +, /, or = ever appears)', () => {
    const h = contentHash(Buffer.from([0x00, 0x01, 0x02, 0x03]))
    expect(h).not.toContain('+')
    expect(h).not.toContain('/')
    expect(h).not.toContain('=')
    expect(h).toBe(
      'sha256-' + createHash('sha256').update(Buffer.from([0, 1, 2, 3])).digest('base64url'),
    )
  })

  it('is stable across repeated calls and independent of the Uint8Array backing', () => {
    const bytes = Buffer.from('AKIA2E0PQIN4XA7QD', 'utf8')
    const viaBuffer = contentHash(bytes)
    const viaCopy = contentHash(new Uint8Array(bytes))
    const oversized = new Uint8Array(64)
    oversized.set(bytes, 8)
    const viaSubarray = contentHash(oversized.subarray(8, 8 + bytes.length))
    expect(viaCopy).toBe(viaBuffer)
    expect(viaSubarray).toBe(viaBuffer)
  })

  it('hashes RAW bytes, so two different JSON encodings of the same rep hash identically', () => {
    // Spec §4 keeps canonical encoding out of the security TCB: nothing is ever hashed over
    // JSON, only over raw representation bytes. If someone "helpfully" hashed the envelope
    // instead, these two lines — same bytes, different key order and whitespace — would diverge.
    const raw = Buffer.from('the primary representation bytes', 'utf8')
    const b64 = raw.toString('base64')
    const encodingA = `{"mime":"text/plain","byteLength":${raw.length},"inline":"${b64}"}`
    const encodingB = `{ "inline": "${b64}",\n  "byteLength": ${raw.length}, "mime": "text/plain" }`
    expect(encodingA).not.toBe(encodingB)

    const bytesFromA = Buffer.from(JSON.parse(encodingA).inline as string, 'base64')
    const bytesFromB = Buffer.from(JSON.parse(encodingB).inline as string, 'base64')

    expect(contentHash(bytesFromA)).toBe(contentHash(bytesFromB))
    expect(contentHash(bytesFromA)).toBe(contentHash(raw))
    // And hashing the JSON text itself is a DIFFERENT value — the thing we must never do.
    expect(contentHash(Buffer.from(encodingA, 'utf8'))).not.toBe(contentHash(raw))
  })

  it('is order-sensitive: swapping two bytes changes the hash', () => {
    expect(contentHash(Buffer.from([1, 2]))).not.toBe(contentHash(Buffer.from([2, 1])))
  })
})
