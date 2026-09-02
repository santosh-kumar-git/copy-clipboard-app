import { describe, expect, it } from 'vitest'
import { contentHash } from '@cairn/protocol'
import { CHAIN_GENESIS, chainNext, chainTip, createChainVerifier } from './chain'

describe('chain primitives', () => {
  it('has a fixed, domain-separated genesis hash', () => {
    expect(CHAIN_GENESIS).toBe('sha256-65kkf25TFtOBWoOISYgGREW0uYOzKyXTZbpV_niBLM4')
    expect(CHAIN_GENESIS).toBe(contentHash(Buffer.from('cairn/store/v1/genesis', 'utf8')))
  })

  it('folds the SEALED line into the running hash', () => {
    const first = chainNext(CHAIN_GENESIS, 'AAAA')
    expect(first).toBe(
      contentHash(Buffer.concat([Buffer.from(CHAIN_GENESIS, 'utf8'), Buffer.from('AAAA', 'utf8')])),
    )
    expect(first).not.toBe(chainNext(CHAIN_GENESIS, 'AAAB'))
    expect(chainNext(first, 'BBBB')).not.toBe(chainNext(CHAIN_GENESIS, 'BBBB'))
  })

  it('chainTip is order-sensitive', () => {
    expect(chainTip(['A', 'B', 'C'])).toBe(chainNext(chainNext(chainNext(CHAIN_GENESIS, 'A'), 'B'), 'C'))
    expect(chainTip(['A', 'B', 'C'])).not.toBe(chainTip(['A', 'C', 'B']))
    expect(chainTip([])).toBe(CHAIN_GENESIS)
  })

  it('accepts a well-formed chain and advances the tip', () => {
    const verifier = createChainVerifier()
    const first = verifier.check(0, 'AAAA', CHAIN_GENESIS)
    expect(first.ok).toBe(true)
    expect(verifier.tip()).toBe(chainNext(CHAIN_GENESIS, 'AAAA'))
    expect(verifier.check(1, 'BBBB', chainNext(CHAIN_GENESIS, 'AAAA')).ok).toBe(true)
    expect(verifier.tip()).toBe(chainTip(['AAAA', 'BBBB']))
  })

  it('rejects a record whose declared prev is not the running hash', () => {
    const verifier = createChainVerifier()
    expect(verifier.check(0, 'AAAA', CHAIN_GENESIS).ok).toBe(true)
    const broken = verifier.check(1, 'BBBB', CHAIN_GENESIS)
    expect(broken.ok).toBe(false)
    if (broken.ok) throw new Error('unreachable')
    expect(broken.code).toBe('E_STORE_CHAIN_BROKEN')
    expect(broken.message).toContain('chain broken at line 1')
  })
})
