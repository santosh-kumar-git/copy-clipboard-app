import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, resolved from this file, so a test's cwd never matters. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.svelte', '.html', '.swift', '.json', '.plist',
])
/** Only these have C-style comments. `.svelte`, `.html`, `.json` and `.plist` are matched raw. */
const CODE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.swift'])
const SKIP_DIRS = new Set(['node_modules', 'out', 'build', 'coverage', '.git', '.vitest-reports'])

/** Every source file under `roots` (repo-relative, or absolute). A missing root is skipped. */
export function sourceFiles(roots: readonly string[]): string[] {
  const files: string[] = []
  for (const root of roots) {
    const abs = isAbsolute(root) ? root : join(REPO_ROOT, root)
    let entries: string[]
    try {
      statSync(abs)
      entries = readdirSync(abs, { recursive: true }) as string[]
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.split('/').some((p) => SKIP_DIRS.has(p))) continue
      if (!SOURCE_EXTENSIONS.has(extname(entry))) continue
      const full = join(abs, entry)
      if (!statSync(full).isFile()) continue
      files.push(full)
    }
  }
  return files.sort()
}

/**
 * `text` with `//` and block comments removed and every newline preserved, so line numbers still
 * match the file on disk. Quote-aware on purpose: `const s = "//"; crashReporter.start()` must stay
 * a hit, and a backslash escape is consumed as a pair so `/^https?:\/\//` is not read as a comment.
 * This is the whole reason a ban can be defined as "no non-comment line names it".
 */
export function stripComments(text: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'quote' | 'line' | 'block' = 'code'
  let quote = ''
  while (i < text.length) {
    const c = text[i] ?? ''
    const next = text[i + 1] ?? ''
    if (state === 'code') {
      if (c === '\\') { out += c + next; i += 2; continue }
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { state = 'quote'; quote = c; out += c; i += 1; continue }
      out += c
      i += 1
      continue
    }
    if (state === 'quote') {
      if (c === '\\') { out += c + next; i += 2; continue }
      if (c === quote) { state = 'code'; quote = '' }
      out += c
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      i += 1
      continue
    }
    if (c === '*' && next === '/') { state = 'code'; i += 2; continue }
    if (c === '\n') out += c
    i += 1
  }
  return out
}

/** A file's literal bytes as UTF-8, with no stripping. */
export function readSource(file: string): string {
  return readFileSync(file, 'utf8')
}

export interface SourceHit {
  readonly file: string
  readonly line: number
  readonly text: string
}

function scan(needle: string, roots: readonly string[], strip: boolean): SourceHit[] {
  const hits: SourceHit[] = []
  for (const file of sourceFiles(roots)) {
    const raw = readSource(file)
    const stripped = strip && CODE_EXTENSIONS.has(extname(file)) ? stripComments(raw) : raw
    const rawLines = raw.split('\n')
    stripped.split('\n').forEach((text, i) => {
      if (text.includes(needle)) {
        hits.push({ file: relative(REPO_ROOT, file), line: i + 1, text: (rawLines[i] ?? text).trim() })
      }
    })
  }
  return hits
}

/**
 * Every NON-COMMENT line under `roots` containing `needle`, as a plain substring. This is the
 * function every source ban uses: `apps/desktop/main/src/index.ts` documents the absence of
 * `crashReporter`, `net.createServer` and `setAsDefaultProtocolClient` in a comment block on
 * purpose, and a ban that tripped on its own documentation would be deleted within a week.
 * The reported `text` is the RAW line, so a failure message shows what is actually in the file.
 */
export function findInSources(needle: string, roots: readonly string[]): SourceHit[] {
  return scan(needle, roots, true)
}

/** Every line, comments included — for the CSP meta tag and any other assertion about literal text. */
export function findRawInSources(needle: string, roots: readonly string[]): SourceHit[] {
  return scan(needle, roots, false)
}

/** A one-line message a failing assertion can print without a debugger. */
export function formatHits(hits: readonly SourceHit[]): string {
  return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n')
}
