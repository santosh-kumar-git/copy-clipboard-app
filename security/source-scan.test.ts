import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findInSources, findRawInSources, formatHits, sourceFiles, stripComments } from './source-scan'

describe('stripComments', () => {
  it('drops a whole-line // comment, so a documented absence is not a hit', () => {
    const src = '//   crashReporter.start(...)             — spec §11 control 1.'
    expect(stripComments(src).includes('crashReporter')).toBe(false)
  })

  it('drops a trailing // comment but keeps the code before it', () => {
    expect(stripComments('void fetch("https://x") // banned').trim()).toBe('void fetch("https://x")')
  })

  it('cannot be fooled by // inside a string literal', () => {
    const src = 'const s = "//"; crashReporter.start()'
    expect(stripComments(src)).toBe(src)
  })

  it('keeps a URL in a string literal intact', () => {
    const src = "const u = 'https://example.com/telemetry'"
    expect(stripComments(src)).toBe(src)
  })

  it('cannot be fooled by an escaped slash in a regex literal', () => {
    const src = 'const re = /^https?:\\/\\//; void fetch("x")'
    expect(stripComments(src)).toBe(src)
  })

  it('drops block comments, including doc blocks, and keeps the line count', () => {
    const src = '/**\n * net.createServer\n */\nlet q = 1'
    const out = stripComments(src)
    expect(out.includes('net.createServer')).toBe(false)
    expect(out.split('\n')).toHaveLength(4)
    expect(out.split('\n')[3]).toBe('let q = 1')
  })

  it('reports the real line number after stripping, so a hit is findable', () => {
    // a\n// b crashReporter\nc  ->  the surviving lines keep their positions
    expect(stripComments('a\n// b crashReporter\nc')).toBe('a\n\nc')
  })
})

describe('the two readers', () => {
  let root = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cairn-scan-'))
    writeFileSync(
      join(root, 'code.ts'),
      '// crashReporter.start() — documented absence, not a call\nconst s = "//"; void fetch("x")\n',
      'utf8',
    )
    writeFileSync(
      join(root, 'page.html'),
      '<!-- this comment names unsafe-inline on purpose -->\n<meta content="default-src \'none\'" />\n',
      'utf8',
    )
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'dep.ts'), 'void fetch("y")\n', 'utf8')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists source files and skips node_modules', () => {
    const files = sourceFiles([root]).map((f) => f.slice(root.length + 1))
    expect(files).toEqual(['code.ts', 'page.html'])
  })

  it('skips a root that does not exist instead of throwing', () => {
    expect(sourceFiles([join(root, 'nope')])).toEqual([])
  })

  it('findInSources ignores a banned identifier that only appears in a comment', () => {
    expect(formatHits(findInSources('crashReporter', [root]))).toBe('')
  })

  it('findInSources still hits real code on the line after that comment', () => {
    const hits = findInSources('fetch(', [root])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.line).toBe(2)
    expect(hits[0]?.text).toBe('const s = "//"; void fetch("x")')
  })

  it('findRawInSources sees the comment, which is what CSP and HTML assertions need', () => {
    expect(findRawInSources('crashReporter', [root])).toHaveLength(1)
    expect(findRawInSources("default-src 'none'", [root]).map((h) => h.line)).toEqual([2])
  })

  it('never comment-strips .html, so a raw ban over markup is honest', () => {
    // .html is not in CODE_EXTENSIONS: an HTML comment is content to this scanner, and quotes in
    // markup are not string syntax. Both readers therefore see the same thing in a .html file.
    expect(findInSources('unsafe-inline', [root])).toHaveLength(1)
    expect(findRawInSources('unsafe-inline', [root])).toHaveLength(1)
  })
})
