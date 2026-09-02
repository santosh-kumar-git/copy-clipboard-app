import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, fixturePath } from './testing'

describe('fixture paths', () => {
  it('resolves REPO_ROOT to the directory holding the root package.json', () => {
    expect(isAbsolute(REPO_ROOT)).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true)
    const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { name: string }
    expect(root.name).toBe('cairn')
  })

  it('joins under the repo-root fixtures directory', () => {
    expect(fixturePath('formats', 'plain-utf8.txt')).toBe(
      join(REPO_ROOT, 'fixtures', 'formats', 'plain-utf8.txt'),
    )
  })

  it('is exactly three levels up — not two, not four', () => {
    // Resolved from import.meta.url, never from cwd. Two `..` would leave REPO_ROOT at
    // packages/protocol and four would leave it above the repo; both are caught here.
    expect(existsSync(join(REPO_ROOT, 'packages', 'protocol', 'src', 'testing.ts'))).toBe(true)
    expect(REPO_ROOT.endsWith(join('packages', 'protocol'))).toBe(false)
  })
})
