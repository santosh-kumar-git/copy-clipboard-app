import { describe, expect, it } from 'vitest'
import { highEntropyRuns, shannonBits } from './entropy'

describe('shannonBits', () => {
  it('scores uniform lowercase hex at EXACTLY 4.0, which is why git SHAs cannot trip a > 4.0 rule', () => {
    expect(shannonBits('0123456789abcdef')).toBe(4)
  })
  it('scores a 64-char uniform base64 alphabet run at 6.0, the base64url maximum', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    expect(shannonBits(alphabet)).toBe(6)
  })
  it('scores a single repeated character at 0', () => {
    expect(shannonBits('aaaaaaaaaaaaaaaaaaaa')).toBe(0)
  })
  it('puts a real git SHA and a UUID below the cut point', () => {
    expect(shannonBits('e3b0c44298fc1c149afbf4c8996fb92427ae41e4')).toBeCloseTo(3.565, 3)
    expect(shannonBits('550e8400-e29b-41d4-a716-446655440000')).toBeCloseTo(3.391, 3)
  })
})

describe('highEntropyRuns', () => {
  it('ignores a run shorter than 20 chars even at high entropy', () => {
    expect(highEntropyRuns('aB3dE5fG7hJ9kL1mN3p')).toEqual([])
  })
  it('ignores a run longer than 512 chars, which is what saves a raw base64 image body', () => {
    expect(highEntropyRuns('aB3dE5fG7h'.repeat(52))).toEqual([])
  })
  it('ignores anything with a scheme prefix, which is what saves URLs and data: URLs', () => {
    expect(highEntropyRuns('https://x.example/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toEqual([])
  })
  it('ignores anything containing a code character, which is what saves minified JS', () => {
    expect(highEntropyRuns('a(bC3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY)')).toEqual([])
  })
  it('ignores absolute and relative filesystem paths', () => {
    expect(highEntropyRuns('/aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toEqual([])
    expect(highEntropyRuns('./aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY')).toEqual([])
  })
  it('reports the offsets of a bare high-entropy token inside a sentence', () => {
    expect(highEntropyRuns('token is aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY ok')).toEqual([{ start: 9, end: 41 }])
  })
  it('strips trailing sentence punctuation before measuring', () => {
    expect(highEntropyRuns('key: aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY.')).toEqual([{ start: 5, end: 37 }])
  })
})
