import {
  createTestClock,
  type ClipboardChangedPayload,
  type LogEvent,
  type LogFields,
  type Logger,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { createFakeAgent, matchesPattern } from './fake-agent'

function fixture(name: string): string {
  return new URL(`../../../fixtures/agent-transcripts/${name}`, import.meta.url).pathname
}

interface RecordedLog { level: string; event: LogEvent; fields: LogFields }

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

describe('matchesPattern', () => {
  it('treats "*" as any value and requires an exact key set otherwise', () => {
    expect(matchesPattern({ id: '*', method: 'hello' }, { id: '7', method: 'hello' })).toBe(true)
    expect(matchesPattern({ id: '*', method: 'hello' }, { id: '7', method: 'read' })).toBe(false)
    // An extra or missing key is a mismatch: a host that quietly adds a param must fail the script.
    expect(matchesPattern({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(matchesPattern({ a: 1, b: 2 }, { a: 1 })).toBe(false)
    expect(matchesPattern([1, '*'], [1, 9])).toBe(true)
    expect(matchesPattern([1], [1, 9])).toBe(false)
    expect(matchesPattern({ p: { q: '*' } }, { p: { q: [1, 2] } })).toBe(true)
  })
})

describe('createFakeAgent', () => {
  it('replays hello, watch.start and a delayed text copy', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('hello-watch-text.ndjson'), clock, logger })
    const changes: ClipboardChangedPayload[] = []
    agent.on('clipboard.changed', (p) => changes.push(p))

    const caps = await agent.start()
    expect(caps.agent).toBe('macos')
    expect(caps.hotkey).toBe('carbon')

    await expect(agent.request('watch.start', { intervalMs: 500 })).resolves.toEqual({
      ok: true,
      value: { watching: true, intervalMs: 500 },
    })

    // The event is scheduled on the injected clock, so nothing has arrived yet.
    expect(changes).toEqual([])
    clock.advance(499)
    expect(changes).toEqual([])
    clock.advance(1)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.changeCount).toBe(364)
    expect(changes[0]!.changeToken).toBe('364')
    expect(Buffer.from(changes[0]!.reps[0]!.bytes).toString('utf8')).toBe('hello world')
    expect(changes[0]!.sourceApp).toEqual({
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      confidence: 'heuristic',
    })
    expect(agent.framesPlayed).toBe(5)
    await agent.dispose()
  })

  it('answers requests with E_AGENT_DISPOSED after dispose', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = createFakeAgent({ transcriptPath: fixture('hello-watch-text.ndjson'), clock, logger })
    await agent.start()
    await agent.dispose()
    await expect(agent.request('watch.start', { intervalMs: 500 })).resolves.toEqual({
      ok: false,
      code: 'E_AGENT_DISPOSED',
      message: 'fake agent has been disposed',
    })
  })
})
