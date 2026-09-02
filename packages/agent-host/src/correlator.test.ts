import {
  AGENT_REQUEST_TIMEOUT_MS,
  createTestClock,
  type AgentCapabilities,
  type AgentResponse,
  type LogEvent,
  type LogFields,
  type Logger,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { createCorrelator } from './correlator'

interface RecordedLog { level: string; event: LogEvent; fields: LogFields }

/** A Logger that keeps what it was given, so a test can assert on metadata-only log output. */
function recordingLogger(): { logger: Logger; lines: RecordedLog[] } {
  const lines: RecordedLog[] = []
  const at = (level: string) => (event: LogEvent, fields?: LogFields) => {
    lines.push({ level, event, fields: fields ?? {} })
  }
  const logger = {
    log: (level: string, event: LogEvent, fields?: LogFields) => at(level)(event, fields),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger
  return { logger, lines }
}

const CAPS = {
  wireMajor: 1,
  agent: 'macos',
  agentVersion: '0.1.0',
  platformVersion: '26.5.1',
  tier: 'A',
  clipboardWatch: 'changecount-poll',
  paste: 'none',
  hotkey: 'carbon',
  focusApp: true,
  concealedTypeHints: true,
  maxRepBytes: 20_971_520,
  chunkThresholdBytes: 65_536,
  missingTools: [],
} as const

const res = (id: string, result: Record<string, unknown>): AgentResponse =>
  ({ v: 1, t: 'res', id, ok: true, result }) as AgentResponse

describe('createCorrelator', () => {
  it('allocates decimal ids starting at "1"', () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    expect([c.nextId(), c.nextId(), c.nextId()]).toEqual(['1', '2', '3'])
  })

  it('resolves two in-flight requests to the right callers out of order', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const a = c.register<{ watching: true; intervalMs: number }>('1', 'watch.start', 2_000)
    const b = c.register<{ changeToken: string }>('2', 'write', 2_000)
    expect(c.pending).toBe(2)
    c.settle(res('2', { changeToken: '365' }))
    c.settle(res('1', { watching: true, intervalMs: 500 }))
    await expect(a).resolves.toEqual({ ok: true, value: { watching: true, intervalMs: 500 } })
    await expect(b).resolves.toEqual({ ok: true, value: { changeToken: '365' } })
    expect(c.pending).toBe(0)
  })

  it('validates the result against the per-method schema', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register<AgentCapabilities>('1', 'hello', 2_000)
    c.settle(res('1', { ...CAPS, tier: 'Z' }))
    const r = await p
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('E_PARSE')
    expect(r.message).toContain('result for hello failed validation')
  })

  it('accepts a valid hello result', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register<AgentCapabilities>('1', 'hello', 2_000)
    c.settle(res('1', { ...CAPS }))
    const r = await p
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.value.agent).toBe('macos')
    expect(r.value.chunkThresholdBytes).toBe(65_536)
  })

  it('maps an unknown agent error code to E_INTERNAL and keeps a known one', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const known = c.register('1', 'read', 2_000)
    const unknown = c.register('2', 'read', 2_000)
    c.settle({ v: 1, t: 'res', id: '1', ok: false, error: { code: 'E_TIMEOUT', message: 'promised read timed out' } })
    c.settle({ v: 1, t: 'res', id: '2', ok: false, error: { code: 'E_SOMETHING_NEW', message: 'from the future' } })
    await expect(known).resolves.toEqual({ ok: false, code: 'E_TIMEOUT', message: 'promised read timed out' })
    await expect(unknown).resolves.toEqual({ ok: false, code: 'E_INTERNAL', message: 'from the future' })
  })

  it('fails a request after timeoutMs and leaks no pending entry', async () => {
    const clock = createTestClock()
    const { logger, lines } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register('1', 'read', AGENT_REQUEST_TIMEOUT_MS)
    clock.advance(AGENT_REQUEST_TIMEOUT_MS - 1)
    expect(c.pending).toBe(1)
    clock.advance(1)
    await expect(p).resolves.toEqual({
      ok: false,
      code: 'E_TIMEOUT',
      message: 'agent request read timed out after 2000ms',
    })
    expect(c.pending).toBe(0)
    expect(clock.pending).toBe(0)
    expect(lines).toEqual([
      { level: 'warn', event: 'agent.request-timeout', fields: { method: 'read', durationMs: 2_000 } },
    ])
  })

  it('ignores a response that arrives after its request timed out', async () => {
    const clock = createTestClock()
    const { logger, lines } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const p = c.register('1', 'read', 2_000)
    clock.advance(2_000)
    await expect(p).resolves.toMatchObject({ ok: false, code: 'E_TIMEOUT' })
    c.settle(res('1', { changeCount: 1, hints: [], reps: [] }))
    expect(c.pending).toBe(0)
    expect(lines.map((l) => l.event)).toEqual(['agent.request-timeout', 'agent.line-unparseable'])
  })

  it('drops a response for an id it never issued', () => {
    const clock = createTestClock()
    const { logger, lines } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    c.settle(res('99', { bye: true }))
    expect(c.pending).toBe(0)
    expect(lines.map((l) => l.event)).toEqual(['agent.line-unparseable'])
  })

  it('failAll settles every pending caller and cancels their timers', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const a = c.register('1', 'read', 2_000)
    const b = c.register('2', 'write', 2_000)
    c.failAll('E_AGENT_EXIT', 'agent exited with code 3')
    await expect(a).resolves.toEqual({ ok: false, code: 'E_AGENT_EXIT', message: 'agent exited with code 3' })
    await expect(b).resolves.toEqual({ ok: false, code: 'E_AGENT_EXIT', message: 'agent exited with code 3' })
    expect(c.pending).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('fail settles exactly one id', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const c = createCorrelator({ clock, logger })
    const a = c.register('1', 'hello', 2_000)
    const b = c.register('2', 'read', 2_000)
    c.fail('1', 'E_WIRE_MAJOR', 'agent speaks wire major 2, host speaks 1')
    await expect(a).resolves.toEqual({
      ok: false,
      code: 'E_WIRE_MAJOR',
      message: 'agent speaks wire major 2, host speaks 1',
    })
    expect(c.pending).toBe(1)
    c.failAll('E_AGENT_DISPOSED', 'disposed')
    await expect(b).resolves.toMatchObject({ ok: false, code: 'E_AGENT_DISPOSED' })
  })
})
