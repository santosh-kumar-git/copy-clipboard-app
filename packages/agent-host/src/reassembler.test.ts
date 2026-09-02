import {
  CHUNK_PAYLOAD_BYTES,
  contentHash,
  createTestClock,
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
})
