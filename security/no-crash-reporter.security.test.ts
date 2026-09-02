import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { REPO_ROOT, findInSources, formatHits, sourceFiles } from './source-scan'

// A crash dump of this process IS the clipboard history, so crashReporter is never initialised
// (spec §11 control 1). A runtime check cannot prove this: with start() never called,
// crashReporter.getUploadToServer() returns false and getLastCrashReport() returns null — but both
// are also true after start({uploadToServer:false}), so only banning the identifier in source
// proves the control. findInSources() matches comment-stripped text, so the rule is precisely
// "no NON-COMMENT line names it".
const PRODUCT_ROOTS = ['packages', 'apps/desktop', 'tools']

describe('crashReporter is never initialised', () => {
  it('scans a non-empty set of product source files', () => {
    expect(sourceFiles(PRODUCT_ROOTS).length).toBeGreaterThan(0)
  })

  it('can find an identifier that is really there, so a zero-hit result means something', () => {
    expect(findInSources('BrowserWindow', ['apps/desktop']).length).toBeGreaterThan(0)
  })

  it('names the identifier crashReporter on no non-comment line of product source', () => {
    expect(formatHits(findInSources('crashReporter', PRODUCT_ROOTS))).toBe('')
  })
})

describe('no crash-reporting service is named either', () => {
  it('names no crash SDK and no upload switch, in any casing', () => {
    // The identifier ban above is exact-case; an `import * as Sentry from '@sentry/electron'` would
    // slip past it. This one lowercases the whole file, so casing cannot hide a service.
    //
    // The needles are WORD-BOUNDED, not bare substrings. A bare `includes('sentry')` matches any
    // identifier that merely ends in "…sEntry" — `CorpusEntry` and `isEntryPoint` both trip it — and
    // a control that cries wolf on ordinary names is a control someone deletes. A real crash SDK
    // always appears as its own word: an import specifier, a namespace, or a config key.
    const banned = ['sentry', 'bugsnag', 'crashpad', 'breakpad', 'submiturl', 'uploadtoserver']
    const offenders: string[] = []
    for (const file of sourceFiles(PRODUCT_ROOTS)) {
      const lower = readFileSync(file, 'utf8').toLowerCase()
      for (const b of banned) {
        // \b alone would still match inside camelCase, so require a non-letter (or start/end of
        // input) on both sides: `@sentry/electron` and `Sentry.init` hit, `CorpusEntry` does not.
        if (new RegExp(`(^|[^a-z])${b}([^a-z]|$)`).test(lower)) {
          offenders.push(`${relative(REPO_ROOT, file)}: ${b}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
