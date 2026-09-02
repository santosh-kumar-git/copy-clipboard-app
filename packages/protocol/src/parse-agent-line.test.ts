import { describe, expect, it } from 'vitest'
import { MAX_LINE_BYTES, WIRE_MAJOR } from './constants'
import { parseAgentLine } from './parse-agent-line'

const helloRes = JSON.stringify({
  v: WIRE_MAJOR, t: 'res', id: '1', ok: true,
  result: {
    wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1', tier: 'A',
    clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon',
    focusApp: true, concealedTypeHints: true,
    maxRepBytes: 20971520, chunkThresholdBytes: 65536, missingTools: [],
  },
})

describe('parseAgentLine — happy path', () => {
  it('parses each of the three envelope shapes and narrows on Result.ok', () => {
    const req = parseAgentLine('{"v":1,"t":"req","id":"7","method":"read","params":{"changeCount":363}}')
    expect(req.ok).toBe(true)
    if (!req.ok) throw new Error(req.message)
    expect(req.value.t).toBe('req')

    const res = parseAgentLine(helloRes)
    expect(res.ok).toBe(true)

    const ev = parseAgentLine(
      '{"v":1,"t":"ev","event":"hotkey.fired","data":{"accelerator":"Cmd+Shift+V","focusToken":"tok-1","firedAt":1767225600000}}',
    )
    expect(ev.ok).toBe(true)
    if (!ev.ok) throw new Error(ev.message)
    expect(ev.value).toMatchObject({ t: 'ev', event: 'hotkey.fired' })
  })
})

describe('parseAgentLine — unknown keys are ignored, never an error (spec §4)', () => {
  const line =
    '{"v":1,"t":"ev","event":"clipboard.changed","alsoNew":true,"data":{"changeCount":364,"hints":[],"reps":[],"frontmostBundleId":null,"frontmostName":null,"attributionConfidence":"heuristic","futureField":"whatever"}}'

  it('does not throw and does not return an error', () => {
    expect(() => parseAgentLine(line)).not.toThrow()
    expect(parseAgentLine(line).ok).toBe(true)
  })

  it('strips the unknown keys from the parsed value', () => {
    const r = parseAgentLine(line)
    if (!r.ok) throw new Error(r.message)
    expect(JSON.stringify(r.value)).not.toContain('alsoNew')
    expect(JSON.stringify(r.value)).not.toContain('futureField')
  })
})

describe('parseAgentLine — malformed input returns a typed error, never a crash', () => {
  it('returns E_PARSE for a torn half-line rather than throwing', () => {
    const torn = '{"v":1,"t":"ev","event":"clipboard.chan'
    expect(() => parseAgentLine(torn)).not.toThrow()
    const r = parseAgentLine(torn)
    expect(r).toMatchObject({ ok: false, code: 'E_PARSE', message: 'line is not valid JSON' })
  })

  it('returns E_PARSE for a human-readable line that leaked onto stdout', () => {
    const r = parseAgentLine('cairn-agent: starting up')
    expect(r).toMatchObject({ ok: false, code: 'E_PARSE' })
  })

  it('returns E_PARSE with a prettified reason for a valid-JSON line of the wrong shape', () => {
    const r = parseAgentLine('{"v":1,"t":"req","id":"1","method":"teleport","params":{}}')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected a failure')
    expect(r.code).toBe('E_PARSE')
    expect(r.message.length).toBeGreaterThan(0)
    expect(r.message).toContain('✖')
  })

  it('returns E_PARSE for a JSON scalar, an array and null', () => {
    for (const line of ['42', '"hello"', '[]', 'null', 'true']) {
      expect(parseAgentLine(line)).toMatchObject({ ok: false, code: 'E_PARSE' })
    }
  })

  it('returns E_PARSE for the empty string', () => {
    expect(parseAgentLine('')).toMatchObject({ ok: false, code: 'E_PARSE' })
  })
})

describe('parseAgentLine — wire major', () => {
  it('returns E_WIRE_MAJOR, not E_PARSE, for a future wire version', () => {
    const r = parseAgentLine('{"v":2,"t":"req","id":"1","method":"read","params":{"changeCount":1}}')
    expect(r).toMatchObject({ ok: false, code: 'E_WIRE_MAJOR' })
    if (r.ok) throw new Error('expected a failure')
    expect(r.message).toBe('unsupported wire major 2')
  })

  it('returns E_WIRE_MAJOR for a non-numeric v', () => {
    const r = parseAgentLine('{"v":"1","t":"req","id":"1","method":"read","params":{"changeCount":1}}')
    expect(r).toMatchObject({ ok: false, code: 'E_WIRE_MAJOR', message: 'unsupported wire major 1' })
  })
})

describe('parseAgentLine — the line-length cap is checked BEFORE JSON.parse', () => {
  it('returns E_LINE_TOO_LONG for a line one byte over the cap instead of buffering it', () => {
    // The guard exists because an unbounded line is a memory attack: a wedged or hostile agent
    // could stream a gigabyte with no newline. We must refuse without parsing.
    const padding = 'A'.repeat(MAX_LINE_BYTES)
    const line = `{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"x","fields":{"pad":"${padding}"}}}`
    expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(MAX_LINE_BYTES)
    const r = parseAgentLine(line)
    expect(r).toMatchObject({
      ok: false, code: 'E_LINE_TOO_LONG', message: `line exceeds ${MAX_LINE_BYTES} bytes`,
    })
  })

  it('accepts a line of exactly MAX_LINE_BYTES — the guard is > not >=', () => {
    const prefix = '{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"x","fields":{"p":"'
    const suffix = '"}}}'
    const pad = 'A'.repeat(MAX_LINE_BYTES - prefix.length - suffix.length)
    const line = prefix + pad + suffix
    expect(Buffer.byteLength(line, 'utf8')).toBe(MAX_LINE_BYTES)
    expect(parseAgentLine(line).ok).toBe(true)
  })

  it('measures BYTES not characters, so a multi-byte line cannot sneak past the cap', () => {
    // '€' is 3 UTF-8 bytes. A char-based guard would accept this; a byte-based guard must not.
    const prefix = '{"v":1,"t":"ev","event":"log","data":{"level":"info","event":"x","fields":{"p":"'
    const suffix = '"}}}'
    const euros = '€'.repeat(Math.ceil((MAX_LINE_BYTES - prefix.length - suffix.length) / 3) + 1)
    const line = prefix + euros + suffix
    expect(line.length).toBeLessThan(MAX_LINE_BYTES)
    expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(MAX_LINE_BYTES)
    expect(parseAgentLine(line)).toMatchObject({ ok: false, code: 'E_LINE_TOO_LONG' })
  })
})
