import { describe, expect, it } from 'vitest'
import { LOG_EVENTS, type LogEvent, type Logger } from './log'

describe('LOG_EVENTS is the closed set of log message ids', () => {
  it('holds 53 ids with no duplicates', () => {
    expect(LOG_EVENTS).toHaveLength(53)
    expect(new Set(LOG_EVENTS).size).toBe(53)
  })

  it('every id is a dotted lowercase-kebab pair, so no sentence can ever be one', () => {
    for (const e of LOG_EVENTS) expect(e).toMatch(/^[a-z][a-z-]*\.[a-z][a-z-]*$/)
    expect(LOG_EVENTS).not.toContain('the user copied CANARY-SECRET')
  })

  it('covers exactly the fifteen subsystems that log in M1', () => {
    const prefixes = [...new Set(LOG_EVENTS.map((e) => e.split('.')[0]!))].sort()
    expect(prefixes).toEqual([
      'agent', 'app', 'capture', 'config', 'history', 'hotkey', 'ipc', 'keyring',
      'preview-cache', 'privacy', 'recall', 'renderer', 'rep', 'store', 'tray',
    ])
  })

  it('already carries the seven desktop-shell ids, so no later task appends them again', () => {
    // `satisfies` is the assertion: if one of these is not in the union, this line fails tsc.
    const shellIds = [
      'renderer.navigation-blocked',
      'renderer.permission-denied',
      'preview-cache.evicted-lock',
      'preview-cache.evicted-suspend',
      'preview-cache.evicted-idle',
      'config.loaded-default',
      'config.saved',
    ] satisfies readonly LogEvent[]
    for (const e of shellIds) expect(LOG_EVENTS).toContain(e)
  })

  it('a Logger accepts every id, and the fields bag stays metadata-only', () => {
    const seen: { event: string; keys: string[] }[] = []
    const spy: Logger = {
      log: (_l, e, f) => seen.push({ event: e, keys: Object.keys(f ?? {}) }),
      debug: (e, f) => spy.log('debug', e, f),
      info: (e, f) => spy.log('info', e, f),
      warn: (e, f) => spy.log('warn', e, f),
      error: (e, f) => spy.log('error', e, f),
    }
    for (const e of LOG_EVENTS) spy.info(e, { ok: true })
    expect(seen).toHaveLength(53)
    expect(new Set(seen.flatMap((s) => s.keys))).toEqual(new Set(['ok']))
  })
})
