import { describe, expect, it } from 'vitest'
import { loadTranscript, parseTranscript } from './transcript'

const META =
  '{"v":1,"t":"meta","transcript":"t","recordedOn":"macos 26.5.1 arm64","synthetic":true,"note":"x"}'
const IN_HELLO = '{"dir":"in","line":{"v":1,"t":"req","id":"*","method":"hello","params":{"hostVersion":"*"}}}'

/** Resolved from this file, so a test's cwd never matters. */
function fixture(name: string): string {
  return new URL(`../../../fixtures/agent-transcripts/${name}`, import.meta.url).pathname
}

describe('parseTranscript', () => {
  it('reads the meta line and numbers the frames by file line', () => {
    const t = parseTranscript([META, IN_HELLO].join('\n') + '\n', 'x.ndjson')
    expect(t.meta.transcript).toBe('t')
    expect(t.meta.synthetic).toBe(true)
    expect(t.meta.note).toBe('x')
    expect(t.frames).toHaveLength(1)
    expect(t.frames[0]!.fileLine).toBe(2)
    expect(t.frames[0]!.dir).toBe('in')
    expect(t.frames[0]!.delayMs).toBe(0)
  })

  it('defaults delayMs to 0 and keeps it when given', () => {
    const t = parseTranscript(
      [META, '{"dir":"out","delayMs":500,"line":{"v":1,"t":"ev"}}', '{"dir":"out","line":{"v":1}}'].join('\n'),
      'x.ndjson',
    )
    expect(t.frames.map((f) => f.delayMs)).toEqual([500, 0])
  })

  it('rejects a transcript whose first line is not a meta line', () => {
    expect(() => parseTranscript([IN_HELLO, META].join('\n'), 'x.ndjson')).toThrow(
      /line 1 must be the meta line/,
    )
  })

  it('rejects a transcript with no lines at all', () => {
    expect(() => parseTranscript('\n\n', 'x.ndjson')).toThrow(
      /x.ndjson is empty: line 1 must be the meta line/,
    )
  })

  it('rejects synthetic:false, because committed transcripts are never real clipboard data', () => {
    const real = META.replace('"synthetic":true', '"synthetic":false')
    expect(() => parseTranscript(real, 'x.ndjson')).toThrow(/must be the meta line/)
  })

  it('rejects a frame with an unknown dir', () => {
    expect(() => parseTranscript([META, '{"dir":"sideways","line":{}}'].join('\n'), 'x.ndjson')).toThrow(
      /line 2 is not a frame/,
    )
  })

  it('rejects a line that is not JSON, naming the line number', () => {
    expect(() => parseTranscript([META, 'not json'].join('\n'), 'x.ndjson')).toThrow(
      /line 2 is not valid JSON/,
    )
  })

  it('loads the committed hello-watch-text fixture', () => {
    const t = loadTranscript(fixture('hello-watch-text.ndjson'))
    expect(t.meta.transcript).toBe('hello-watch-text')
    expect(t.frames.map((f) => f.dir)).toEqual(['in', 'out', 'in', 'out', 'out'])
    expect(t.frames[4]!.delayMs).toBe(500)
  })

  it('loads the committed image-tiff-chunked fixture with 7 chunk frames', () => {
    const t = loadTranscript(fixture('image-tiff-chunked.ndjson'))
    const chunks = t.frames.filter((f) => f.line['event'] === 'rep.chunk')
    expect(chunks).toHaveLength(7)
    expect(t.frames).toHaveLength(12)
  })
})
