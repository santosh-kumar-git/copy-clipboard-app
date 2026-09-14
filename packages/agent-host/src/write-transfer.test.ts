import { describe, expect, it } from 'vitest'
import { contentHash, createTestClock, MAX_LINE_BYTES, ok, type Logger } from '@cairn/protocol'
import { createAgentCore } from './spawn-agent'

const logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} } as Logger
const caps = {
  wireMajor: 1, agent: 'macos', agentVersion: 'test', platformVersion: 'test', tier: 'A',
  clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon', focusApp: true,
  concealedTypeHints: true, maxRepBytes: 20_971_520, chunkThresholdBytes: 65_536, missingTools: [],
}

function peer(options: { chunkedWrite?: boolean; failChunk?: boolean; silentChunk?: boolean; chunkDelay?: number } = {}) {
  const clock = createTestClock()
  const lines: { method: string; bytes: number; params: Record<string, unknown> }[] = []
  const received: Buffer[] = []
  const core = createAgentCore({
    clock, logger, onFatal() {},
    send(line) {
      const request = JSON.parse(line)
      lines.push({ method: request.method, bytes: Buffer.byteLength(line) - 1, params: request.params })
      // The real native line reader discards requests over this cap.
      if (Buffer.byteLength(line) - 1 > MAX_LINE_BYTES) return ok(undefined)
      let result: unknown = {}
      if (request.method === 'hello') result = { ...caps, chunkedWrite: options.chunkedWrite ?? true }
      if (request.method === 'write') result = { changeToken: 'inline' }
      if (request.method === 'write.begin') result = { accepted: true }
      if (request.method === 'write.chunk') {
        if (options.chunkDelay) clock.advance(options.chunkDelay)
        if (options.silentChunk) return ok(undefined)
        if (options.failChunk) {
          core.handleLine(JSON.stringify({ v: 1, t: 'res', id: request.id, ok: false,
            error: { code: 'E_REP_SEQ_GAP', message: 'synthetic failure' } }))
          return ok(undefined)
        }
        received.push(Buffer.from(request.params.b64, 'base64'))
        result = { accepted: true }
      }
      if (request.method === 'write.commit') result = { changeToken: 'streamed' }
      if (request.method === 'write.abort') result = { aborted: true }
      core.handleLine(JSON.stringify({ v: 1, t: 'res', id: request.id, ok: true, result }))
      return ok(undefined)
    },
  })
  return { core, clock, lines, received }
}

const params = (bytes: Buffer) => ({
  reps: [{ mime: 'image/png', uti: 'public.png', b64: bytes.toString('base64') }], transient: false,
})

describe('bounded large writes', () => {
  it('recalls a synthetic 1 MiB representation over capped lines without changing its bytes', async () => {
    const h = peer()
    await h.core.hello()
    const bytes = Buffer.alloc(1_048_576, 0x5a)
    let result: unknown
    const writing = h.core.request('write', params(bytes)).then((r) => { result = r })
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (result === undefined) h.clock.advance(2_000)
    await writing
    expect(result).toEqual(ok({ changeToken: 'streamed' }))
    expect(h.lines.every((line) => line.bytes <= MAX_LINE_BYTES)).toBe(true)
    expect(h.lines.find((line) => line.method === 'write.begin')?.params.reps).toEqual([
      { mime: 'image/png', uti: 'public.png', byteLength: 1_048_576, sha256: contentHash(bytes) },
    ])
    expect(h.received.every((chunk) => chunk.length <= 32_768)).toBe(true)
    expect(Buffer.concat(h.received)).toEqual(bytes)
    expect(h.lines.at(-1)?.method).toBe('write.commit')
    expect(h.clock.pending).toBe(0)
  })

  it('preserves the small-write protocol for older agents', async () => {
    const h = peer({ chunkedWrite: false })
    await h.core.hello()
    expect(await h.core.request('write', params(Buffer.from('small')))).toEqual(ok({ changeToken: 'inline' }))
    expect(h.lines.map((line) => line.method)).toEqual(['hello', 'write'])
  })

  it('rejects large writes to older agents before sending an oversized line', async () => {
    const h = peer({ chunkedWrite: false })
    await h.core.hello()
    const writing = h.core.request('write', params(Buffer.alloc(1_048_576)))
    h.clock.advance(2_000)
    expect(await writing).toMatchObject({ ok: false, code: 'E_LINE_TOO_LONG' })
    expect(h.lines.map((line) => line.method)).toEqual(['hello'])
  })

  it('aborts failed chunks without committing a partial clipboard item', async () => {
    const h = peer({ failChunk: true })
    await h.core.hello()
    const writing = h.core.request('write', params(Buffer.alloc(1_048_576)))
    await new Promise<void>((resolve) => setImmediate(resolve))
    h.clock.advance(2_000)
    expect(await writing).toMatchObject({ ok: false, code: 'E_REP_SEQ_GAP' })
    expect(h.lines.at(-1)?.method).toBe('write.abort')
    expect(h.lines.some((line) => line.method === 'write.commit')).toBe(false)
  })

  it('bounds concurrent writes and releases the upload slot after timeout', async () => {
    const h = peer({ silentChunk: true })
    await h.core.hello()
    const writing = h.core.request('write', params(Buffer.alloc(1_048_576)))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(await h.core.request('write', params(Buffer.from('second'))))
      .toMatchObject({ ok: false, code: 'E_REP_TOO_MANY' })
    h.clock.advance(2_000)
    expect(await writing).toMatchObject({ ok: false, code: 'E_TIMEOUT' })
    expect(h.lines.at(-1)?.method).toBe('write.abort')
    expect(await h.core.request('write', params(Buffer.from('after timeout'))))
      .toEqual(ok({ changeToken: 'inline' }))
    expect(h.clock.pending).toBe(0)
  })

  it('bounds the total transfer duration even while chunks keep receiving acknowledgements', async () => {
    const h = peer({ chunkDelay: 1_000 })
    await h.core.hello()
    expect(await h.core.request('write', params(Buffer.alloc(1_048_576))))
      .toMatchObject({ ok: false, code: 'E_TIMEOUT' })
    expect(h.lines.filter((line) => line.method === 'write.chunk').length).toBeLessThanOrEqual(30)
    expect(h.lines.some((line) => line.method === 'write.commit')).toBe(false)
    expect(h.lines.at(-1)?.method).toBe('write.abort')
    expect(h.clock.pending).toBe(0)
  })

  it('rejects size and representation-count excesses before allocating a transfer', async () => {
    const h = peer()
    await h.core.hello()
    const tooLarge = params(Buffer.alloc(20_971_521))
    expect(await h.core.request('write', tooLarge)).toMatchObject({ ok: false, code: 'E_REP_OVERFLOW' })
    const tooMany = { ...params(Buffer.from('x')), reps: Array.from({ length: 9 }, () => params(Buffer.from('x')).reps[0]!) }
    expect(await h.core.request('write', tooMany)).toMatchObject({ ok: false, code: 'E_REP_TOO_MANY' })
    const largeRep = params(Buffer.alloc(20_971_520)).reps[0]!
    expect(await h.core.request('write', { reps: [largeRep, largeRep, largeRep, largeRep], transient: false }))
      .toMatchObject({ ok: false, code: 'E_REP_OVERFLOW' })
    expect(h.lines.map((line) => line.method)).toEqual(['hello'])
  })

  it('streams the aggregate of medium reps when their combined inline request exceeds the cap', async () => {
    const h = peer()
    await h.core.hello()
    const reps = [Buffer.alloc(450_000, 1), Buffer.alloc(450_000, 2)]
    expect(await h.core.request('write', {
      reps: reps.map((bytes) => params(bytes).reps[0]!), transient: true,
    })).toEqual(ok({ changeToken: 'streamed' }))
    const chunks = h.lines.filter((line) => line.method === 'write.chunk')
    for (const [index, bytes] of reps.entries()) {
      expect(Buffer.concat(chunks.filter((chunk) => chunk.params.repIndex === index)
        .map((chunk) => Buffer.from(chunk.params.b64 as string, 'base64')))).toEqual(bytes)
    }
    expect(h.lines.every((line) => line.bytes <= MAX_LINE_BYTES)).toBe(true)
    expect(h.lines.find((line) => line.method === 'write.begin')?.params.transient).toBe(true)
  })
})
