import { describe, expect, it } from 'vitest'
import { createLineSplitter } from './framing'

function collect(maxLineBytes?: number) {
  const lines: string[] = []
  const overflows: number[] = []
  const splitter = createLineSplitter(
    maxLineBytes === undefined
      ? { onLine: (l) => lines.push(l), onOverflow: (n) => overflows.push(n) }
      : { onLine: (l) => lines.push(l), onOverflow: (n) => overflows.push(n), maxLineBytes },
  )
  return { lines, overflows, splitter }
}

describe('createLineSplitter', () => {
  it('emits two lines from one chunk that contains two objects', () => {
    const { lines, splitter } = collect()
    splitter.push(Buffer.from('{"a":1}\n{"b":2}\n', 'utf8'))
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.bufferedBytes).toBe(0)
  })

  it('reassembles one object split across three chunks', () => {
    const { lines, splitter } = collect()
    splitter.push(Buffer.from('{"v":1,', 'utf8'))
    expect(lines).toEqual([])
    splitter.push(Buffer.from('"t":"ev"', 'utf8'))
    expect(lines).toEqual([])
    splitter.push(Buffer.from('}\n', 'utf8'))
    expect(lines).toEqual(['{"v":1,"t":"ev"}'])
  })

  it('does not split a multi-byte UTF-8 character', () => {
    const { lines, splitter } = collect()
    const bytes = Buffer.from('{"emoji":"🪨"}\n', 'utf8')
    // The rock emoji is 4 bytes; cut two bytes into it.
    const cut = bytes.indexOf(0xf0) + 2
    splitter.push(bytes.subarray(0, cut))
    expect(lines).toEqual([])
    splitter.push(bytes.subarray(cut))
    expect(lines).toEqual(['{"emoji":"🪨"}'])
  })

  it('drops a line over the cap instead of buffering it forever, and resumes on the next line', () => {
    const { lines, overflows, splitter } = collect(64)
    splitter.push(Buffer.from('x'.repeat(200), 'utf8'))
    expect(overflows).toEqual([200])
    expect(splitter.bufferedBytes).toBe(0)
    splitter.push(Buffer.from('yyy', 'utf8'))
    expect(splitter.bufferedBytes).toBe(0)
    splitter.push(Buffer.from('\n{"ok":true}\n', 'utf8'))
    expect(overflows).toEqual([200])
    expect(lines).toEqual(['{"ok":true}'])
  })

  it('reports an oversized line exactly once when its newline is in the same chunk', () => {
    const { lines, overflows, splitter } = collect(64)
    splitter.push(Buffer.from('z'.repeat(100) + '\n{"ok":true}\n', 'utf8'))
    expect(overflows).toEqual([100])
    expect(lines).toEqual(['{"ok":true}'])
  })

  it('ignores empty lines and defaults the cap to MAX_LINE_BYTES', () => {
    const { lines, overflows, splitter } = collect()
    splitter.push(Buffer.from('\n\n{"a":1}\n', 'utf8'))
    expect(lines).toEqual(['{"a":1}'])
    splitter.push(Buffer.from('q'.repeat(700_000), 'utf8'))
    expect(overflows).toEqual([])
    expect(splitter.bufferedBytes).toBe(700_000)
    splitter.reset()
    expect(splitter.bufferedBytes).toBe(0)
  })
})
