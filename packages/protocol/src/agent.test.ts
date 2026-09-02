import { describe, expect, it } from 'vitest'
import {
  AgentCapabilitiesSchema,
  AgentEventSchema,
  AgentLineSchema,
  AgentRequestSchema,
  AgentResponseSchema,
  AgentResultSchema,
  RepSchema,
} from './agent'
import { CHUNK_PAYLOAD_BYTES, CHUNK_THRESHOLD_BYTES, MAX_REP_BYTES, WIRE_MAJOR } from './constants'

const inlineRep = {
  mime: 'text/plain',
  uti: 'public.utf8-plain-text',
  byteLength: 11,
  sha256: 'sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek',
  inline: 'aGVsbG8gd29ybGQ=',
}

describe('the envelope', () => {
  it('round-trips a request unchanged', () => {
    const line = { v: WIRE_MAJOR, t: 'req', id: '7', method: 'read', params: { changeCount: 363 } }
    const parsed = AgentLineSchema.parse(line)
    expect(parsed).toEqual(line)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(line)
  })

  it('round-trips an ok response and an error response, discriminated by `ok`', () => {
    const okLine = { v: 1, t: 'res', id: '7', ok: true, result: { changeToken: '364' } }
    const errLine = {
      v: 1, t: 'res', id: '7', ok: false,
      error: { code: 'E_TIMEOUT', message: 'promised read timed out' },
    }
    expect(AgentResponseSchema.parse(okLine)).toEqual(okLine)
    expect(AgentResponseSchema.parse(errLine)).toEqual(errLine)
  })

  it('rejects a response carrying both result and error, by dropping the unknown one', () => {
    // `ok: true` selects the first union option, whose shape has no `error` key, so `error` is
    // stripped rather than accepted. The invariant is "there is never both" on the output side.
    const parsed = AgentResponseSchema.parse({
      v: 1, t: 'res', id: '9', ok: true, result: { bye: true },
      error: { code: 'E_INTERNAL', message: 'nope' },
    })
    expect(parsed).not.toHaveProperty('error')
  })

  it('rejects an unknown outer discriminator with issue code invalid_union', () => {
    const r = AgentLineSchema.safeParse({ v: 1, t: 'nope', id: '1' })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.code).toBe('invalid_union')
  })

  it('rejects an M2-reserved method name — an M1 host has no business sending it', () => {
    for (const method of ['paste', 'focus.capture', 'permission.request', 'capture.now']) {
      const r = AgentRequestSchema.safeParse({ v: 1, t: 'req', id: '1', method, params: {} })
      expect(r.success, `${method} must not parse in M1`).toBe(false)
    }
  })
})

describe('unknown keys are IGNORED, never an error (spec §4)', () => {
  const line = {
    v: 1, t: 'ev', event: 'clipboard.changed',
    alsoNew: 'top-level key from a future agent',
    data: {
      changeCount: 364, hints: [], reps: [inlineRep],
      frontmostBundleId: 'com.apple.TextEdit', frontmostName: 'TextEdit',
      attributionConfidence: 'heuristic',
      futureField: { nested: true },
    },
  }

  it('parses successfully', () => {
    expect(AgentLineSchema.safeParse(line).success).toBe(true)
  })

  it('strips both the top-level and the nested unknown key from the output', () => {
    const parsed = AgentLineSchema.parse(line)
    expect(parsed).not.toHaveProperty('alsoNew')
    expect(JSON.stringify(parsed)).not.toContain('futureField')
    expect(JSON.stringify(parsed)).not.toContain('alsoNew')
  })

  it('still parses when a wholly unknown key appears inside a Rep', () => {
    const r = RepSchema.safeParse({ ...inlineRep, tomorrowsField: 42 })
    expect(r.success).toBe(true)
    expect(r.data).not.toHaveProperty('tomorrowsField')
  })
})

describe('Rep transport rules', () => {
  it('accepts an inline rep under the chunk threshold', () => {
    expect(RepSchema.safeParse(inlineRep).success).toBe(true)
  })

  it('defaults a missing uti to null rather than leaving it undefined', () => {
    const { uti: _drop, ...withoutUti } = inlineRep
    expect(RepSchema.parse(withoutUti).uti).toBeNull()
  })

  it('rejects a rep carrying both inline and repId', () => {
    const r = RepSchema.safeParse({ ...inlineRep, repId: 'r1' })
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.message.includes('exactly one of inline | repId'))).toBe(true)
  })

  it('rejects a rep carrying neither inline nor repId', () => {
    const { inline: _drop, ...naked } = inlineRep
    expect(RepSchema.safeParse(naked).success).toBe(false)
  })

  it('requires repId at or over the chunk threshold, and inline below it', () => {
    const big = {
      mime: 'image/png', uti: 'public.png', byteLength: CHUNK_THRESHOLD_BYTES,
      sha256: 'sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
    }
    expect(RepSchema.safeParse({ ...big, repId: 'r1' }).success).toBe(true)
    expect(RepSchema.safeParse({ ...big, inline: 'AAAA' }).success).toBe(false)
    const small = { ...big, byteLength: CHUNK_THRESHOLD_BYTES - 1 }
    expect(RepSchema.safeParse({ ...small, repId: 'r1' }).success).toBe(false)
    expect(RepSchema.safeParse({ ...small, inline: 'AAAA' }).success).toBe(true)
  })

  it('rejects a byteLength over MAX_REP_BYTES so the reassembler never allocates it', () => {
    const r = RepSchema.safeParse({ ...inlineRep, byteLength: MAX_REP_BYTES + 1, inline: undefined, repId: 'r1' })
    expect(r.success).toBe(false)
  })

  it('rejects a malformed sha256 that is not sha256-<43 base64url chars>', () => {
    for (const bad of ['sha256-tooshort', 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ', 'sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmC=']) {
      expect(RepSchema.safeParse({ ...inlineRep, sha256: bad }).success, bad).toBe(false)
    }
  })
})

describe('rep.chunk events', () => {
  const chunk = (seq: number, final: boolean) => ({
    v: 1, t: 'ev', event: 'rep.chunk',
    data: { repId: 'r1', seq, final, b64: Buffer.alloc(CHUNK_PAYLOAD_BYTES, 7).toString('base64') },
  })

  it('validates a real 7-chunk sequence for a 200 000-byte payload', () => {
    // 200000 / 32768 = 6 full chunks + a 3 392-byte remainder = 7 chunks, seq 0..6.
    const total = 200_000
    const chunkCount = Math.ceil(total / CHUNK_PAYLOAD_BYTES)
    expect(chunkCount).toBe(7)
    for (let seq = 0; seq < chunkCount; seq++) {
      const ev = chunk(seq, seq === chunkCount - 1)
      const parsed = AgentEventSchema.parse(ev)
      expect(parsed).toMatchObject({ event: 'rep.chunk', data: { repId: 'r1', seq } })
    }
  })

  it('rejects a negative seq', () => {
    const r = AgentEventSchema.safeParse(chunk(-1, false))
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.code).toBe('too_small')
  })

  it('rejects a non-integer seq', () => {
    const r = AgentEventSchema.safeParse(chunk(1.5, false))
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.code).toBe('invalid_type')
  })

  it('rejects a b64 payload that is not base64 at all', () => {
    const bad = { v: 1, t: 'ev', event: 'rep.chunk', data: { repId: 'r1', seq: 0, final: true, b64: 'not base64!!' } }
    expect(AgentEventSchema.safeParse(bad).success).toBe(false)
  })
})

describe('AgentResultSchema', () => {
  it('is keyed by every method AgentRequestSchema accepts, and by nothing else', () => {
    const methods = AgentRequestSchema.options.map((o) => o.shape.method.value as string).sort()
    expect(Object.keys(AgentResultSchema).sort()).toEqual(methods)
    expect(methods).toEqual([
      'hello', 'hotkey.register', 'hotkey.unregister', 'read', 'shutdown',
      'watch.start', 'watch.stop', 'write',
    ])
  })

  it('hello returns the capability block with wireMajor pinned to WIRE_MAJOR', () => {
    const caps = {
      wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1', tier: 'A',
      clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon',
      focusApp: true, concealedTypeHints: true,
      maxRepBytes: MAX_REP_BYTES, chunkThresholdBytes: CHUNK_THRESHOLD_BYTES, missingTools: [],
    }
    expect(AgentCapabilitiesSchema.parse(caps)).toEqual(caps)
    expect(AgentCapabilitiesSchema.safeParse({ ...caps, wireMajor: 2 }).success).toBe(false)
    expect(AgentResultSchema.hello).toBe(AgentCapabilitiesSchema)
  })

  it('hotkey.register returns a boolean `bound`, never an error — a dead hotkey is a state', () => {
    expect(AgentResultSchema['hotkey.register'].parse({ bound: false, accelerator: 'Cmd+Shift+V' }))
      .toEqual({ bound: false, accelerator: 'Cmd+Shift+V' })
  })
})
