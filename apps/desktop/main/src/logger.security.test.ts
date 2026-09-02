import { describe, expect, it } from 'vitest'
import { createTestClock, TEST_CANARY } from '@cairn/protocol'
import { createStderrLogger, LOG_FIELD_KEYS } from './logger'

const sink = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

describe('createStderrLogger', () => {
  it('emits one JSON object per line with ts, level and event', () => {
    const s = sink()
    const clock = createTestClock()
    const log = createStderrLogger({ write: s.write, clock })
    log.info('app.ready', { count: 3 })
    expect(s.lines).toHaveLength(1)
    expect(JSON.parse(s.lines[0]!)).toEqual({
      ts: 1_767_225_600_000,
      level: 'info',
      event: 'app.ready',
      count: 3,
    })
  })

  it('ends every line with a newline so NDJSON on stderr is really NDJSON', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.warn('ipc.rejected', { code: 'E_IPC_REJECTED' })
    expect(s.lines[0]!.endsWith('\n')).toBe(true)
  })

  it('the allowlist is the LogFields key set plus the three envelope keys', () => {
    expect([...LOG_FIELD_KEYS].sort()).toEqual([
      'accelerator', 'agent', 'attempt', 'bundleId', 'byteLength', 'code', 'count', 'detectors',
      'durationMs', 'event', 'flags', 'hashPrefix', 'itemId', 'kind', 'level', 'method', 'mime',
      'mode', 'ok', 'repCount', 'seq', 'ts',
    ])
  })

  it('STRIPS any field outside the allowlist, so a canary cannot reach a log line', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    // A JS caller, a `@ts-expect-error`, or a future refactor can all produce this object. The
    // compile-time guard in @cairn/protocol is the first line of defence; this is the second.
    const smuggled = { kind: 'text', text: TEST_CANARY, body: TEST_CANARY, preview: TEST_CANARY }
    log.info('history.ingested', smuggled as never)
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['event', 'kind', 'level', 'ts'])
    expect(JSON.stringify(s.lines)).not.toContain(TEST_CANARY)
  })

  it('drops a non-primitive value even when its key IS on the allowlist', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.info('history.ingested', { mime: new Uint8Array([67, 65, 73]) } as never)
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(parsed['mime']).toBeUndefined()
  })

  it('honours minLevel so debug output cannot leak from a shipped build', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock(), minLevel: 'info' })
    log.debug('app.ready')
    log.info('app.ready')
    expect(s.lines).toHaveLength(1)
    expect(JSON.parse(s.lines[0]!).level).toBe('info')
  })

  it('an array field is kept only if every element is a string', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.info('privacy.masked', { flags: ['secret'], detectors: ['aws-access-key'] })
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(parsed['flags']).toEqual(['secret'])
    expect(parsed['detectors']).toEqual(['aws-access-key'])
  })
})
