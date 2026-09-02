import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, findInSources, formatHits, sourceFiles } from './source-scan'

// Spec §11 control 3, enforced statically. Svelte's raw-HTML directive is the only HTML-injection
// sink the language offers, so banning its token is the whole control: the component tests prove
// today's code escapes, this proves nobody reintroduces the sink tomorrow. The needle appears exactly
// once below, as a string literal, and nowhere in a comment — `.svelte` files are matched RAW by
// source-scan.ts (comment stripping would be a hole in this ban), so a renderer comment that spelled
// the token would fail this test. Describe it in prose there; spell it only here.
const RENDERER = 'apps/desktop/renderer'
const DOM_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'new Function', 'eval(']

const productFiles = (): string[] => sourceFiles([RENDERER]).filter((f) => !f.endsWith('.test.ts'))

describe('the renderer has no HTML sink', () => {
  it('scans a non-empty set of renderer files, so a zero-hit result means something', () => {
    expect(productFiles().length).toBeGreaterThan(4)
    expect(findInSources('$props(', [RENDERER]).length).toBeGreaterThan(0)
  })

  it('contains no {@html anywhere under the renderer', () => {
    expect(formatHits(findInSources('{@html', [RENDERER]))).toBe('')
  })

  it('contains no direct DOM HTML sink in renderer product code', () => {
    // Test files are excluded on purpose: Preview.security.test.ts asserts on `pre.innerHTML`,
    // which is how it proves the payload was escaped.
    const hits: string[] = []
    for (const file of productFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const sink of DOM_SINKS) {
        if (text.includes(sink)) hits.push(`${file}: ${sink}`)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('the renderer bundle stays browser-safe', () => {
  it('imports @cairn/protocol only as types, because the barrel pulls node:crypto', () => {
    // `import { x } from '@cairn/protocol'` passes under vitest and then fails the real build with
    // `"createHash" is not exported by "__vite-browser-external"`.
    const offenders: string[] = []
    const statement = /import\s+(type\s+)?\{[^}]*\}\s+from '@cairn\/protocol'/g
    for (const file of productFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(statement)) {
        if (m[1] === undefined) offenders.push(`${file}: ${m[0].replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the index.html CSP free of unsafe-inline and of any remote origin', () => {
    const html = readFileSync(join(REPO_ROOT, RENDERER, 'index.html'), 'utf8')
    // Only the policy itself, never the surrounding comment — otherwise the comment explaining the
    // ban is what trips the assertion.
    const policy = /Content-Security-Policy"[\s\S]*?content="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain('unsafe-inline')
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toContain('http://')
    expect(policy).not.toContain('https://')
    expect(html).toContain('<script type="module" src="/src/main.ts"></script>')
  })

  it('loads no remote font or stylesheet from app.css', () => {
    const css = readFileSync(join(REPO_ROOT, RENDERER, 'src', 'app.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).not.toContain('@import')
    expect(css).not.toContain('url(http')
    expect(css).not.toContain('//fonts.')
  })
})
