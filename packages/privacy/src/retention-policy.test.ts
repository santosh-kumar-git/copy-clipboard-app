import { describe, expect, it } from 'vitest'
import { SECRET_TTL_MS, createTestClock } from '@cairn/protocol'
import { isPinnable, secretExpiresAt } from './retention-policy'

describe('secret retention policy', () => {
  it('gives a secret exactly a 5-minute TTL from createdAt', () => {
    expect(SECRET_TTL_MS).toBe(300_000)
    const clock = createTestClock()
    const t = clock.now()
    expect(secretExpiresAt(t, ['secret'])).toBe(t + 300_000)
  })
  it('gives everything else no TTL at all', () => {
    const clock = createTestClock()
    for (const flags of [[], ['transient'], ['auto-generated'], ['concealed'], ['cut']] as const) {
      expect(secretExpiresAt(clock.now(), [...flags])).toBeNull()
    }
  })
  it('refuses to pin a secret and allows pinning everything else', () => {
    expect(isPinnable(['secret'])).toBe(false)
    expect(isPinnable(['secret', 'transient'])).toBe(false)
    expect(isPinnable([])).toBe(true)
    expect(isPinnable(['transient', 'auto-generated', 'cut', 'no-sync'])).toBe(true)
  })
})
