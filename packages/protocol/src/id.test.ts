import { describe, expect, it } from 'vitest'
import { newItemId } from './id'

const T = 1_767_225_600_000                          // 2026-01-01T00:00:00Z
const SEQ = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
const ZERO = new Uint8Array(10)
const MAX = new Uint8Array(10).fill(0xff)

describe('newItemId', () => {
  it('is 26 Crockford base32 chars: 10 of timestamp then 16 of randomness', () => {
    const id = newItemId(T, SEQ)
    expect(id).toBe('01KDVDNA00000G40R40M30E209')
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)   // no I, L, O or U — Crockford's alphabet
  })

  it('splits exactly 10 + 16, which the two extreme random inputs prove', () => {
    expect(newItemId(T, ZERO)).toBe('01KDVDNA000000000000000000')
    expect(newItemId(T, MAX)).toBe('01KDVDNA00ZZZZZZZZZZZZZZZZ')
    expect(newItemId(T, ZERO).slice(0, 10)).toBe(newItemId(T, MAX).slice(0, 10))
  })

  it('is deterministic given the same (nowMs, rnd)', () => {
    expect(newItemId(T, SEQ)).toBe(newItemId(T, SEQ))
  })

  it('sorts lexicographically by time, even against a maximal random half', () => {
    expect(newItemId(T, MAX) < newItemId(T + 1, ZERO)).toBe(true)
    expect(newItemId(0, ZERO)).toBe('0'.repeat(26))
    const ids = [newItemId(T + 2, ZERO), newItemId(T, ZERO), newItemId(T + 1, ZERO)]
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]])
  })

  it('THROWS for anything but exactly 10 random bytes — a bad argument shape is a bug, not a state', () => {
    expect(() => newItemId(T, new Uint8Array(9))).toThrow(
      'newItemId needs exactly 10 random bytes, got 9',
    )
    expect(() => newItemId(T, new Uint8Array(11))).toThrow(
      'newItemId needs exactly 10 random bytes, got 11',
    )
  })
})
