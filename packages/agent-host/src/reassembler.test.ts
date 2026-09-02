import {
  CHUNK_PAYLOAD_BYTES,
  contentHash,
  createTestClock,
  MAX_REP_BYTES,
  REP_STREAM_TIMEOUT_MS,
  type LogEvent,
  type LogFields,
  type Logger,
  type Rep,
  type ResolvedRep,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'
import { createReassembler, type RepAbort } from './reassembler'

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

/**
 * The one payload rule, shared with the committed transcript fixture: deterministic filler with a
 * little-endian TIFF magic prefix. Deterministic so a test can compare byte-for-byte; filler rather
 * than a real screenshot so nothing real is ever committed or logged.
 */
function fillerBytes(n: number): Buffer {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 7 + 13) % 251
  b.set([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00], 0)
  return b
}

function chunksOf(bytes: Buffer, size = CHUNK_PAYLOAD_BYTES): string[] {
  const out: string[] = []
  for (let o = 0; o < bytes.length; o += size) out.push(bytes.subarray(o, o + size).toString('base64'))
  return out
}

function wireRep(bytes: Buffer, repId: string, mime = 'image/tiff'): Rep & { repId: string } {
  return {
    mime,
    uti: 'public.tiff',
    byteLength: bytes.length,
    sha256: contentHash(bytes),
    repId,
  } as Rep & { repId: string }
}

function harness() {
  const clock = createTestClock()
  const { logger, lines } = recordingLogger()
  const completed: { repId: string; rep: ResolvedRep }[] = []
  const aborted: RepAbort[] = []
  const r = createReassembler({
    clock,
    logger,
    onComplete: (repId, rep) => completed.push({ repId, rep }),
    onAbort: (a) => aborted.push(a),
  })
  return { clock, lines, completed, aborted, r }
}

describe('createReassembler', () => {
  it('reassembles a 200 000-byte payload from 7 chunks byte-for-byte', () => {
    const { completed, r, clock } = harness()
    const payload = fillerBytes(200_000)
    const parts = chunksOf(payload)
    expect(parts).toHaveLength(7)
    r.declare(wireRep(payload, 'r1'))
    parts.forEach((b64, seq) => r.chunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }))
    expect(completed).toHaveLength(1)
    expect(Buffer.from(completed[0]!.rep.bytes).equals(payload)).toBe(true)
    expect(completed[0]!.rep.sha256).toBe(contentHash(payload))
    expect(completed[0]!.rep.byteLength).toBe(200_000)
    expect(completed[0]!.rep.mime).toBe('image/tiff')
    expect(completed[0]!.rep.uti).toBe('public.tiff')
    expect(r.openStreams).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('reassembles two interleaved repIds independently', () => {
    const { completed, aborted, r } = harness()
    const a = fillerBytes(70_000)
    const b = Buffer.from(fillerBytes(70_000).reverse())
    expect(contentHash(a)).not.toBe(contentHash(b))
    r.declare(wireRep(a, 'rA', 'image/png'))
    r.declare(wireRep(b, 'rB', 'image/tiff'))
    const pa = chunksOf(a)
    const pb = chunksOf(b)
    // Interleave: A0 B0 B1 A1 A2 B2
    r.chunk({ repId: 'rA', seq: 0, final: false, b64: pa[0]! })
    r.chunk({ repId: 'rB', seq: 0, final: false, b64: pb[0]! })
    r.chunk({ repId: 'rB', seq: 1, final: false, b64: pb[1]! })
    r.chunk({ repId: 'rA', seq: 1, final: false, b64: pa[1]! })
    r.chunk({ repId: 'rA', seq: 2, final: true, b64: pa[2]! })
    r.chunk({ repId: 'rB', seq: 2, final: true, b64: pb[2]! })
    expect(aborted).toEqual([])
    expect(completed.map((c) => c.repId)).toEqual(['rA', 'rB'])
    expect(Buffer.from(completed[0]!.rep.bytes).equals(a)).toBe(true)
    expect(Buffer.from(completed[1]!.rep.bytes).equals(b)).toBe(true)
    expect(completed[0]!.rep.mime).toBe('image/png')
    expect(completed[1]!.rep.mime).toBe('image/tiff')
  })

it('discards the whole representation on a sha256 mismatch', () => {
  const { completed, aborted, r } = harness()
  const payload = fillerBytes(70_000)
  const lying = { ...wireRep(payload, 'r1'), sha256: contentHash(Buffer.from('something else')) }
  r.declare(lying as Rep & { repId: string })
  chunksOf(payload).forEach((b64, seq, all) =>
    r.chunk({ repId: 'r1', seq, final: seq === all.length - 1, b64 }),
  )
  expect(completed).toEqual([])
  expect(aborted).toEqual([{ repId: 'r1', mime: 'image/tiff', code: 'E_REP_HASH_MISMATCH' }])
  expect(r.openStreams).toBe(0)
  expect(r.bufferedBytes).toBe(0)
})

it('discards the representation on a gap in seq', () => {
  const { completed, aborted, r } = harness()
  const payload = fillerBytes(70_000)
  const parts = chunksOf(payload)
  r.declare(wireRep(payload, 'r1'))
  r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
  r.chunk({ repId: 'r1', seq: 2, final: true, b64: parts[2]! })
  expect(aborted.map((a) => a.code)).toEqual(['E_REP_SEQ_GAP'])
  expect(completed).toEqual([])
})

it('discards the representation on a duplicated seq', () => {
  const { completed, aborted, r } = harness()
  const payload = fillerBytes(70_000)
  const parts = chunksOf(payload)
  r.declare(wireRep(payload, 'r1'))
  r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
  r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
  expect(aborted.map((a) => a.code)).toEqual(['E_REP_SEQ_DUPLICATE'])
  expect(completed).toEqual([])
})

it('aborts with E_REP_SHORT when final arrives with fewer bytes than declared', () => {
  const { aborted, r } = harness()
  const payload = fillerBytes(70_000)
  const parts = chunksOf(payload)
  r.declare({ ...wireRep(payload, 'r1'), byteLength: 70_000 + 3 } as Rep & { repId: string })
  parts.forEach((b64, seq) => r.chunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }))
  expect(aborted.map((a) => a.code)).toEqual(['E_REP_SHORT'])
})

it('aborts on undecodable base64', () => {
  const { aborted, r } = harness()
  const payload = fillerBytes(70_000)
  r.declare(wireRep(payload, 'r1'))
  r.chunk({ repId: 'r1', seq: 0, final: false, b64: 'not!valid!base64' })
  expect(aborted.map((a) => a.code)).toEqual(['E_REP_BAD_BASE64'])
})

it('aborts when the accumulated bytes exceed the declared byteLength', () => {
  const { aborted, r } = harness()
  const payload = fillerBytes(70_000)
  // Declare it 100 bytes shorter than it is: chunk 2 then overflows.
  const short = { ...wireRep(payload, 'r1'), byteLength: 70_000 - 100 }
  r.declare(short as Rep & { repId: string })
  const parts = chunksOf(payload)
  r.chunk({ repId: 'r1', seq: 0, final: false, b64: parts[0]! })
  r.chunk({ repId: 'r1', seq: 1, final: false, b64: parts[1]! })
  r.chunk({ repId: 'r1', seq: 2, final: true, b64: parts[2]! })
  expect(aborted.map((a) => a.code)).toEqual(['E_REP_OVERFLOW'])
})

it('logs E_REP_UNKNOWN_ID and drops a chunk for an undeclared repId', () => {
  const { aborted, r, lines } = harness()
  r.chunk({ repId: 'nope', seq: 0, final: true, b64: 'aGk=' })
  expect(aborted).toEqual([])
  expect(lines).toEqual([
    { level: 'warn', event: 'rep.stream-aborted', fields: { code: 'E_REP_UNKNOWN_ID', repCount: 0 } },
  ])
})

it('aborts every open stream on abortAll', () => {
  const { aborted, r, clock } = harness()
  const payload = fillerBytes(200_000)
  r.declare(wireRep(payload, 'r1'))
  r.chunk({ repId: 'r1', seq: 0, final: false, b64: chunksOf(payload)[0]! })
  r.abortAll('E_REP_TIMEOUT')
  expect(aborted.map((a) => a.code)).toEqual(['E_REP_TIMEOUT'])
  expect(r.openStreams).toBe(0)
  expect(r.bufferedBytes).toBe(0)
  expect(clock.pending).toBe(0)
})

it('evicts a stream that never sends final, and leaks no buffer', () => {
  const { completed, aborted, r, clock, lines } = harness()
  const payload = fillerBytes(200_000)
  r.declare(wireRep(payload, 'r1'))
  r.chunk({ repId: 'r1', seq: 0, final: false, b64: chunksOf(payload)[0]! })
  expect(r.bufferedBytes).toBe(CHUNK_PAYLOAD_BYTES)
  clock.advance(REP_STREAM_TIMEOUT_MS - 1)
  expect(r.openStreams).toBe(1)
  clock.advance(1)
  expect(aborted.map((a) => a.code)).toEqual(['E_REP_TIMEOUT'])
  expect(completed).toEqual([])
  expect(r.openStreams).toBe(0)
  expect(r.bufferedBytes).toBe(0)
  expect(clock.pending).toBe(0)
  expect(lines.filter((l) => l.event === 'rep.stream-aborted')).toHaveLength(1)
})

it('aborts a representation that declares more than MAX_REP_BYTES without allocating', () => {
  const { aborted, r, clock } = harness()
  const huge = {
    mime: 'image/tiff',
    uti: null,
    byteLength: MAX_REP_BYTES + 1,
    sha256: contentHash(Buffer.alloc(0)),
    repId: 'r1',
  } as Rep & { repId: string }
  r.declare(huge)
  expect(aborted).toEqual([{ repId: 'r1', mime: 'image/tiff', code: 'E_REP_OVERFLOW' }])
  expect(r.openStreams).toBe(0)
  expect(clock.pending).toBe(0)
})

it('refuses a ninth concurrent stream with E_REP_TOO_MANY', () => {
  const { aborted, r } = harness()
  const payload = fillerBytes(70_000)
  for (let i = 0; i < 8; i++) r.declare(wireRep(payload, `r${i}`))
  expect(r.openStreams).toBe(8)
  r.declare(wireRep(payload, 'r8'))
  expect(aborted).toEqual([{ repId: 'r8', mime: 'image/tiff', code: 'E_REP_TOO_MANY' }])
  expect(r.openStreams).toBe(8)
})

it('reports E_REP_AFTER_FINAL for a chunk that arrives after the final one', () => {
  const { aborted, r, lines } = harness()
  const payload = fillerBytes(70_000)
  const parts = chunksOf(payload)
  r.declare(wireRep(payload, 'r1'))
  parts.forEach((b64, seq) => r.chunk({ repId: 'r1', seq, final: seq === parts.length - 1, b64 }))
  r.chunk({ repId: 'r1', seq: 3, final: true, b64: 'aGk=' })
  expect(aborted).toEqual([])
  expect(lines.filter((l) => l.event === 'rep.stream-aborted').map((l) => l.fields.code)).toEqual([
    'E_REP_AFTER_FINAL',
  ])
})
})
