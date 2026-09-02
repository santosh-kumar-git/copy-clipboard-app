import { describe, expect, it, vi } from 'vitest'
import { createTestClock, systemClock, type Cancel } from './clock'

describe('systemClock', () => {
  it('reads the real clock, and its Cancel closure clears the timer', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
      expect(systemClock.now()).toBe(Date.parse('2026-09-02T00:00:00.000Z'))

      const fired: string[] = []
      const cancel: Cancel = systemClock.setTimeout(() => fired.push('cancelled'), 50)
      cancel()
      vi.advanceTimersByTime(100)
      expect(fired).toEqual([])

      systemClock.setTimeout(() => fired.push('kept'), 50)
      vi.advanceTimersByTime(50)
      expect(fired).toEqual(['kept'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createTestClock', () => {
  it('starts at 2026-01-01T00:00:00Z, so every test timestamp is recognisable', () => {
    const clock = createTestClock()
    expect(clock.now()).toBe(1_767_225_600_000)
    expect(new Date(clock.now()).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(clock.pending).toBe(0)
  })

  it('fires only the timers inside the window, in deadline order, leaving now at the target', () => {
    const clock = createTestClock(1_000)
    const fired: string[] = []
    clock.setTimeout(() => fired.push('a'), 100)
    clock.setTimeout(() => fired.push('b'), 200)
    const cancelC = clock.setTimeout(() => fired.push('c'), 150)
    expect(clock.pending).toBe(3)

    cancelC()
    expect(clock.pending).toBe(2)

    clock.advance(150)
    expect(fired).toEqual(['a'])
    expect(clock.now()).toBe(1_150)
    expect(clock.pending).toBe(1)

    clock.advance(100)
    expect(fired).toEqual(['a', 'b'])
    expect(clock.now()).toBe(1_250)
    expect(clock.pending).toBe(0)
  })

  it('orders by deadline, not by scheduling order', () => {
    const clock = createTestClock(0)
    const fired: string[] = []
    clock.setTimeout(() => fired.push('late'), 300)
    clock.setTimeout(() => fired.push('early'), 100)
    clock.setTimeout(() => fired.push('middle'), 200)
    clock.advance(300)
    expect(fired).toEqual(['early', 'middle', 'late'])
  })

  it('runs a callback with `now` sitting on its own deadline, not on the sweep target', () => {
    const clock = createTestClock(0)
    const seen: number[] = []
    clock.setTimeout(() => seen.push(clock.now()), 10)
    clock.setTimeout(() => seen.push(clock.now()), 40)
    clock.advance(100)
    expect(seen).toEqual([10, 40])
    expect(clock.now()).toBe(100)
  })

  it('fires a re-entrant timer in the same sweep when it lands inside the window', () => {
    // This is what makes the agent host's restart backoff testable in one advance() call.
    const clock = createTestClock(0)
    const seen: string[] = []
    clock.setTimeout(() => {
      seen.push('outer')
      clock.setTimeout(() => seen.push('inner'), 10)
    }, 10)
    clock.advance(25)
    expect(seen).toEqual(['outer', 'inner'])
    expect(clock.now()).toBe(25)
    expect(clock.pending).toBe(0)
  })

  it('a cancel closure is idempotent and touches only its own timer', () => {
    const clock = createTestClock(0)
    const fired: string[] = []
    const cancelA = clock.setTimeout(() => fired.push('a'), 10)
    clock.setTimeout(() => fired.push('b'), 10)
    cancelA()
    cancelA()
    expect(clock.pending).toBe(1)
    clock.advance(10)
    expect(fired).toEqual(['b'])
  })
})
