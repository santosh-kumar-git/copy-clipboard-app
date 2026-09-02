import {
  AGENT_REQUEST_TIMEOUT_MS,
  CHUNK_PAYLOAD_BYTES,
  contentHash,
  createTestClock,
  type ClipboardChangedPayload,
  type LogEvent,
  type LogFields,
  type Logger,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { RESTART_BACKOFF_MS, spawnAgent } from './spawn-agent'

// ---------------------------------------------------------------------------------------------
// The stand-in agent. A Node script handed to `node -e`, NOT a file on disk.
// `process.argv[1]` is the mode, because with `node -e SRC mode` argv is [execPath, 'mode'].
// ---------------------------------------------------------------------------------------------
const STUB_AGENT_SRC = `
const { createHash } = require('node:crypto')
const MODE = process.argv[1] || 'normal'
const CAPS = { wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1',
  tier: 'A', clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon', focusApp: true,
  concealedTypeHints: true, maxRepBytes: 20971520, chunkThresholdBytes: 65536, missingTools: [] }
function out(o) { process.stdout.write(JSON.stringify(o) + '\\n') }
function log(name) { out({ v: 1, t: 'ev', event: 'log', data: { level: 'info', event: name, fields: {} } }) }
function filler(n) {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251
  b.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0)
  return b
}
function hash(b) { return 'sha256-' + createHash('sha256').update(b).digest('base64url') }
function emitChunkedImage() {
  const text = Buffer.from('hello world', 'utf8')
  const img = filler(200000)
  out({ v: 1, t: 'ev', event: 'clipboard.changed', data: { changeCount: 364, hints: [], reps: [
    { mime: 'text/plain', uti: 'public.utf8-plain-text', byteLength: text.length, sha256: hash(text), inline: text.toString('base64') },
    { mime: 'image/tiff', uti: 'public.tiff', byteLength: img.length, sha256: hash(img), repId: 'rep-1' },
  ], frontmostBundleId: 'com.apple.Preview', frontmostName: 'Preview', attributionConfidence: 'heuristic' } })
  const CH = 32768
  const total = Math.ceil(img.length / CH)
  for (let s = 0; s < total; s++) {
    out({ v: 1, t: 'ev', event: 'rep.chunk', data: { repId: 'rep-1', seq: s, final: s === total - 1,
      b64: img.subarray(s * CH, (s + 1) * CH).toString('base64') } })
  }
}
function handle(req) {
  const id = req.id
  const m = req.method
  if (m === 'hello') {
    const caps = MODE === 'wrong-wire' ? Object.assign({}, CAPS, { wireMajor: 2 }) : CAPS
    return out({ v: 1, t: 'res', id: id, ok: true, result: caps })
  }
  if (m === 'watch.start') {
    out({ v: 1, t: 'res', id: id, ok: true, result: { watching: true, intervalMs: req.params.intervalMs } })
    log('stub.watch-start')
    if (MODE === 'chunked-image') emitChunkedImage()
    if (MODE === 'two-in-one-write') process.stdout.write(
      JSON.stringify({ v: 1, t: 'ev', event: 'log', data: { level: 'info', event: 'first', fields: {} } }) + '\\n' +
      JSON.stringify({ v: 1, t: 'ev', event: 'log', data: { level: 'info', event: 'second', fields: {} } }) + '\\n')
    if (MODE === 'garbage') { for (let i = 0; i < 12; i++) process.stdout.write('this is not json ' + i + '\\n') }
    if (MODE === 'huge-line') process.stdout.write('{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"' + 'x'.repeat(1100000) + '","fields":{}}}\\n')
    return
  }
  if (m === 'read') {
    if (MODE === 'silent-read') return
    if (MODE === 'crash-on-read') return process.exit(3)
    return out({ v: 1, t: 'res', id: id, ok: true, result: { changeCount: req.params.changeCount, hints: [], reps: [] } })
  }
  if (m === 'write') return out({ v: 1, t: 'res', id: id, ok: true, result: { changeToken: '365' } })
  if (m === 'hotkey.register') return out({ v: 1, t: 'res', id: id, ok: true, result: { bound: true, accelerator: req.params.accelerator } })
  if (m === 'shutdown') { out({ v: 1, t: 'res', id: id, ok: true, result: { bye: true } }); return process.exit(0) }
  out({ v: 1, t: 'res', id: id, ok: false, error: { code: 'E_UNKNOWN_METHOD', message: m } })
}
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString('utf8')
  for (;;) {
    const i = buf.indexOf('\\n')
    if (i === -1) break
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line.length > 0) handle(JSON.parse(line))
  }
})
log('stub.started')
`

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

function stub(mode: string, maxRestarts?: number) {
  const clock = createTestClock()
  const { logger, lines } = recordingLogger()
  const stubEvents: string[] = []
  const agent = spawnAgent({
    platform: 'macos',
    binPath: process.execPath,
    args: ['-e', STUB_AGENT_SRC, mode],
    clock,
    logger,
    ...(maxRestarts === undefined ? {} : { maxRestarts }),
  })
  agent.on('log', (p) => stubEvents.push(p.event))
  return { agent, clock, lines, stubEvents }
}

/** Polls with REAL timers — allowed in a test; product code only ever uses the injected Clock. */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** The one payload rule, shared with the committed transcript: filler plus a TIFF magic prefix. */
function fillerBytes(n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251
  b.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0)
  return b
}

describe('spawnAgent', () => {
  it('starts the child, sends hello and returns its capabilities', async () => {
    const { agent, lines } = stub('normal')
    try {
      const caps = await agent.start()
      expect(caps.agent).toBe('macos')
      expect(caps.tier).toBe('A')
      expect(caps.chunkThresholdBytes).toBe(65_536)
      expect(lines.map((l) => l.event)).toEqual(['agent.spawning', 'agent.started'])
    } finally {
      await agent.dispose()
    }
  })

  it('correlates two in-flight requests to the right callers', async () => {
    const { agent } = stub('normal')
    try {
      await agent.start()
      const a = agent.request('read', { changeCount: 363 })
      const b = agent.request('write', { reps: [{ mime: 'text/plain', uti: null, b64: 'aGk=' }], transient: false })
      const [ra, rb] = await Promise.all([a, b])
      expect(ra).toEqual({ ok: true, value: { changeCount: 363, hints: [], reps: [] } })
      expect(rb).toEqual({ ok: true, value: { changeToken: '365' } })
    } finally {
      await agent.dispose()
    }
  })

  it('rejects start with E_AGENT_SPAWN when the binary does not exist', async () => {
    const clock = createTestClock()
    const { logger } = recordingLogger()
    const agent = spawnAgent({
      platform: 'macos',
      binPath: '/definitely/not/a/binary/cairn-agent-macos',
      clock,
      logger,
    })
    await expect(agent.start()).rejects.toThrow(/hello failed \(E_AGENT_SPAWN\)/)
    await agent.dispose()
  })

  it('fails a request the agent never answers after timeoutMs, leaking no pending entry', async () => {
    const { agent, clock, lines } = stub('silent-read')
    try {
      await agent.start()
      const p = agent.request('read', { changeCount: 1 }, AGENT_REQUEST_TIMEOUT_MS)
      clock.advance(AGENT_REQUEST_TIMEOUT_MS)
      await expect(p).resolves.toEqual({
        ok: false,
        code: 'E_TIMEOUT',
        message: 'agent request read timed out after 2000ms',
      })
      expect(clock.pending).toBe(0)
      expect(lines.some((l) => l.event === 'agent.request-timeout')).toBe(true)
    } finally {
      await agent.dispose()
    }
  })

  it('stops the child on dispose and fails every later request with E_AGENT_DISPOSED', async () => {
    const { agent } = stub('normal')
    await agent.start()
    await agent.dispose()
    await expect(agent.request('read', { changeCount: 1 })).resolves.toEqual({
      ok: false,
      code: 'E_AGENT_DISPOSED',
      message: 'agent has been disposed',
    })
    // dispose() is idempotent.
    await agent.dispose()
  })

it('parses two events that arrive in one stdout write as two events', async () => {
  const { agent, stubEvents } = stub('two-in-one-write')
  try {
    await agent.start()
    await agent.request('watch.start', { intervalMs: 500 })
    await waitFor(() => stubEvents.includes('second'), 'both events')
    expect(stubEvents).toEqual(['stub.started', 'stub.watch-start', 'first', 'second'])
  } finally {
    await agent.dispose()
  }
})

it('reassembles a >64 KiB representation off the real pipe and emits chunk progress with no bytes', async () => {
  const { agent, stubEvents } = stub('chunked-image')
  const changes: ClipboardChangedPayload[] = []
  const chunks: { repId: string; seq: number; final: boolean }[] = []
  agent.on('clipboard.changed', (p) => changes.push(p))
  agent.on('rep.chunk', (p) => chunks.push(p))
  try {
    await agent.start()
    await agent.request('watch.start', { intervalMs: 500 })
    await waitFor(() => changes.length === 1, 'the reassembled clipboard.changed')
    expect(stubEvents).toContain('stub.watch-start')

    const payload = fillerBytes(200_000)
    const change = changes[0]!
    expect(change.changeCount).toBe(364)
    expect(change.changeToken).toBe('364')
    expect(change.droppedReps).toEqual([])
    expect(change.reps.map((r) => r.mime)).toEqual(['text/plain', 'image/tiff'])
    expect(Buffer.from(change.reps[0]!.bytes).toString('utf8')).toBe('hello world')
    expect(Buffer.from(change.reps[1]!.bytes).equals(payload)).toBe(true)
    expect(change.reps[1]!.sha256).toBe(contentHash(payload))
    expect(change.sourceApp).toEqual({
      bundleId: 'com.apple.Preview',
      name: 'Preview',
      confidence: 'heuristic',
    })

    expect(chunks).toHaveLength(Math.ceil(200_000 / CHUNK_PAYLOAD_BYTES))
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(chunks[6]).toEqual({ repId: 'rep-1', seq: 6, final: true })
    // The progress payload carries NO bytes. If a `b64` or `bytes` key ever appears here, the
    // renderer could be handed raw clipboard content through a progress indicator.
    expect(Object.keys(chunks[0]!)).toEqual(['repId', 'seq', 'final'])
  } finally {
    await agent.dispose()
  }
})

it('refuses to start an agent whose hello reports a different wire major', async () => {
  const { agent, lines } = stub('wrong-wire')
  await expect(agent.start()).rejects.toThrow(
    /refusing to start the macos agent — hello failed \(E_WIRE_MAJOR\): agent reports wire major 2, host speaks 1/,
  )
  expect(lines.map((l) => l.event)).toContain('agent.wire-major-mismatch')
  // A refused agent is never restarted: it will be just as wrong next time.
  await expect(agent.request('read', { changeCount: 1 })).resolves.toMatchObject({
    ok: false,
    code: 'E_AGENT_EXIT',
  })
  await agent.dispose()
})

it('restarts a crashed child with growing backoff, fails the in-flight caller, and re-arms the watch', async () => {
  const { agent, clock, lines, stubEvents } = stub('crash-on-read')
  try {
    await agent.start()
    await agent.request('watch.start', { intervalMs: 500 })
    await waitFor(() => stubEvents.includes('stub.watch-start'), 'first watch.start')

    const inFlight = agent.request('read', { changeCount: 1 })
    // A caller mid-request gets a definite failure rather than hanging forever.
    await expect(inFlight).resolves.toMatchObject({ ok: false, code: 'E_AGENT_EXIT' })

    const scheduled = () => lines.filter((l) => l.event === 'agent.restart-scheduled')
    expect(scheduled()).toHaveLength(1)
    expect(scheduled()[0]!.fields).toEqual({ attempt: 1, durationMs: RESTART_BACKOFF_MS[0] })

    clock.advance(RESTART_BACKOFF_MS[0])
    await waitFor(() => stubEvents.filter((e) => e === 'stub.started').length === 2, 'second spawn')
    // The restart re-sends watch.start, so a crash cannot silently stop the clipboard watch.
    await waitFor(() => stubEvents.filter((e) => e === 'stub.watch-start').length === 2, 'watch re-armed')

    await expect(agent.request('read', { changeCount: 2 })).resolves.toMatchObject({
      ok: false,
      code: 'E_AGENT_EXIT',
    })
    expect(scheduled()).toHaveLength(2)
    expect(scheduled()[1]!.fields).toEqual({ attempt: 2, durationMs: RESTART_BACKOFF_MS[1] })
  } finally {
    await agent.dispose()
  }
})

it('gives up after maxRestarts and answers every later request with E_AGENT_EXIT', async () => {
  const { agent, clock, stubEvents } = stub('crash-on-read', 1)
  try {
    await agent.start()
    await expect(agent.request('read', { changeCount: 1 })).resolves.toMatchObject({ ok: false, code: 'E_AGENT_EXIT' })
    clock.advance(RESTART_BACKOFF_MS[0])
    await waitFor(() => stubEvents.filter((e) => e === 'stub.started').length === 2, 'second spawn')
    await expect(agent.request('read', { changeCount: 2 })).resolves.toMatchObject({ ok: false, code: 'E_AGENT_EXIT' })
    // No third spawn: the host has given up, and says so instead of pretending.
    clock.advance(60_000)
    await expect(agent.request('read', { changeCount: 3 })).resolves.toEqual({
      ok: false,
      code: 'E_AGENT_EXIT',
      message: 'agent gave up after 1 restarts',
    })
    expect(stubEvents.filter((e) => e === 'stub.started')).toHaveLength(2)
  } finally {
    await agent.dispose()
  }
})

it('drops a line over MAX_LINE_BYTES and replaces the child instead of buffering it', async () => {
  const { agent, lines } = stub('huge-line')
  try {
    await agent.start()
    await agent.request('watch.start', { intervalMs: 500 })
    await waitFor(
      () => lines.some((l) => l.fields.code === 'E_LINE_TOO_LONG'),
      'the oversized line to be rejected',
    )
    const tooLong = lines.find((l) => l.fields.code === 'E_LINE_TOO_LONG')!
    expect(tooLong.event).toBe('agent.line-unparseable')
    expect(tooLong.fields.byteLength).toBeGreaterThan(1_048_576)
    await waitFor(() => lines.some((l) => l.event === 'agent.restart-scheduled'), 'a restart')
  } finally {
    await agent.dispose()
  }
})

it('replaces the child after 10 unparseable lines in a row', async () => {
  const { agent, lines } = stub('garbage')
  try {
    await agent.start()
    await agent.request('watch.start', { intervalMs: 500 })
    await waitFor(
      () => lines.filter((l) => l.event === 'agent.line-unparseable').length >= 10,
      'ten unparseable lines',
    )
    await waitFor(() => lines.some((l) => l.event === 'agent.restart-scheduled'), 'a restart')
    const first = lines.find((l) => l.event === 'agent.line-unparseable')!
    expect(first.fields.code).toBe('E_PARSE')
    expect(first.fields.count).toBe(1)
  } finally {
    await agent.dispose()
  }
})
})
