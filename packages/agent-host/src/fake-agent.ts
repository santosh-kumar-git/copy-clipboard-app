import { basename } from 'node:path'
import {
  err,
  ok,
  type AgentCapabilities,
  type ClipboardAgent,
  type Clock,
  type Logger,
  type Result,
} from '@cairn/protocol'
import { createAgentCore } from './spawn-agent'
import { loadTranscript, type TranscriptFrame } from './transcript'

export interface FakeAgent extends ClipboardAgent {
  /** Throws if the transcript was not played to the end, or if a mismatch was recorded. */
  assertDrained(): void
  readonly framesPlayed: number
}

/** `"*"` in an `in` frame means "any value here". Key sets must otherwise match exactly. */
export function matchesPattern(pattern: unknown, actual: unknown): boolean {
  if (pattern === '*') return true
  if (Array.isArray(pattern)) {
    return (
      Array.isArray(actual) &&
      pattern.length === actual.length &&
      pattern.every((p, i) => matchesPattern(p, actual[i]))
    )
  }
  if (pattern !== null && typeof pattern === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
    const p = pattern as Record<string, unknown>
    const a = actual as Record<string, unknown>
    const pk = Object.keys(p).sort()
    const ak = Object.keys(a).sort()
    if (pk.length !== ak.length) return false
    if (pk.some((k, i) => k !== ak[i])) return false
    return pk.every((k) => matchesPattern(p[k], a[k]))
  }
  return pattern === actual
}

export function createFakeAgent(opts: {
  transcriptPath: string
  clock: Clock
  logger: Logger
}): FakeAgent {
  const { clock, logger } = opts
  const transcript = loadTranscript(opts.transcriptPath)
  const where = basename(transcript.path)
  let cursor = 0
  let outboundCount = 0
  let lastMatchedId: string | null = null
  let failure: Error | null = null
  let disposed = false

  const record = (message: string): Error => {
    const e = new Error(message)
    if (failure === null) failure = e
    return e
  }

  const deliver = (frame: TranscriptFrame): void => {
    let line = frame.line
    if (line['t'] === 'res' && line['id'] === '*') {
      if (lastMatchedId === null) throw record('FakeAgent: id "*" before any matched request')
      line = { ...line, id: lastMatchedId }
    }
    core.handleLine(JSON.stringify(line))
  }

  /** Plays every `out` frame up to the next `in` frame. */
  const pump = (): void => {
    for (;;) {
      const frame = transcript.frames[cursor]
      if (frame === undefined || frame.dir !== 'out') return
      cursor += 1
      if (frame.delayMs > 0) {
        // Scheduled on the injected clock, never on a real timer: the test decides when time moves.
        clock.setTimeout(() => {
          deliver(frame)
          pump()
        }, frame.delayMs)
        return
      }
      deliver(frame)
    }
  }

  const send = (line: string): Result<void> => {
    if (disposed) return err('E_AGENT_DISPOSED', 'fake agent has been disposed')
    const actual = JSON.parse(line) as Record<string, unknown>
    outboundCount += 1
    const frame = transcript.frames[cursor]
    if (frame === undefined || frame.dir !== 'in') {
      throw record(
        `FakeAgent: unexpected outbound request \`${String(actual['method'])}\` — ` +
          `the transcript scripts no further requests.`,
      )
    }
    if (!matchesPattern(frame.line, actual)) {
      throw record(
        `FakeAgent: outbound request #${outboundCount} did not match the transcript script.\n` +
          `  transcript: ${JSON.stringify({ method: frame.line['method'], params: frame.line['params'] })}\n` +
          `  actual:     ${JSON.stringify({ method: actual['method'], params: actual['params'] })}\n` +
          `  transcript: ${where} line ${frame.fileLine}`,
      )
    }
    lastMatchedId = String(actual['id'])
    cursor += 1
    pump()
    return ok(undefined)
  }

  const core = createAgentCore({ clock, logger, send, onFatal: () => {} })

  return {
    async start(): Promise<AgentCapabilities> {
      // Leading `out` frames (an event before the host says anything) are played here, so listeners
      // must be attached before start() — exactly as with a real agent.
      pump()
      const r = await core.hello()
      if (!r.ok) throw record(`FakeAgent: ${where} hello failed (${r.code}): ${r.message}`)
      return r.value
    },

    request(method, params, timeoutMs) {
      return core.request(method, params, timeoutMs)
    },

    on(event, cb) {
      return core.on(event, cb)
    },

    async dispose(): Promise<void> {
      disposed = true
      core.abortStreams('E_REP_TIMEOUT')
      core.failAllPending('E_AGENT_DISPOSED', 'fake agent disposed')
      await Promise.resolve()
    },

    assertDrained(): void {
      if (failure !== null) throw failure
      const remaining = transcript.frames.length - cursor
      if (remaining > 0) {
        const next = transcript.frames[cursor]!
        const label = String(next.line['method'] ?? next.line['event'] ?? 'unknown')
        throw new Error(
          `FakeAgent: transcript not fully consumed — ${remaining} of ${transcript.frames.length} ` +
            `frames unplayed (next: ${next.dir} ${label}).`,
        )
      }
    },

    get framesPlayed(): number {
      return cursor
    },
  }
}
