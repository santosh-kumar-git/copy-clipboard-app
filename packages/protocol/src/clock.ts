export type Cancel = () => void

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): Cancel
}

export interface TestClock extends Clock {
  advance(ms: number): void
  readonly pending: number
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
}

/** 2026-01-01T00:00:00Z by default, so every test's timestamps are recognisable. */
export function createTestClock(startMs = 1_767_225_600_000): TestClock {
  let now = startMs
  let nextId = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return () => { timers.delete(id) }
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)
        const first = due[0]
        if (first === undefined) break
        timers.delete(first[0])
        now = first[1].at        // time is at the deadline while the callback runs
        first[1].fn()
      }
      now = target
    },
    get pending() { return timers.size },
  }
}
