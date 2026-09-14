import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Logger } from '@cairn/protocol'
import { registerShutdown } from './shutdown'

function harness(stop: () => Promise<void>) {
  const events = new EventEmitter()
  const attempts: { prevented: boolean }[] = []
  const errors: unknown[] = []
  const app = {
    on: events.on.bind(events),
    quit: () => {
      const attempt = { prevented: false }
      attempts.push(attempt)
      events.emit('before-quit', { preventDefault: () => { attempt.prevented = true } })
    },
  }
  registerShutdown(app, stop, { error: (...args: unknown[]) => { errors.push(args) } } as Logger)
  return { app, attempts, errors }
}

describe('shutdown', () => {
  it('prevents every quit attempt until one shared teardown finishes', async () => {
    let finish!: () => void
    const drain = new Promise<void>((resolve) => { finish = resolve })
    let stops = 0
    const h = harness(async () => { stops += 1; await drain })
    h.app.quit()
    h.app.quit()
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(h.attempts).toEqual([{ prevented: true }, { prevented: true }])
      expect(stops).toBe(1)
    } finally {
      finish()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(h.attempts).toEqual([{ prevented: true }, { prevented: true }, { prevented: false }])
    expect(h.errors).toEqual([])
  })

  it('logs teardown failure without its message and releases the deferred quit', async () => {
    const h = harness(async () => { throw new Error('synthetic private clipboard text') })
    h.app.quit()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(h.attempts).toEqual([{ prevented: true }, { prevented: false }])
    expect(h.errors).toEqual([['app.quitting', { ok: false, code: 'E_INTERNAL' }]])
  })
})
