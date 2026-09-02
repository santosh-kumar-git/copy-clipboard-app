import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './source-scan'

// Spec §11 control 9. A clipboard manager is an attractive place to hide a dependency, so the
// version set is exact, the lockfile is committed, install scripts are off, and the one banned
// build path (@electron/rebuild / node-gyp) is checked by a script CI runs before install.
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/
const GUARD = join(REPO_ROOT, 'scripts', 'guard-no-electron-rebuild.mjs')
const readJson = (...p: string[]): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, ...p), 'utf8')) as Record<string, unknown>

describe('supply chain', () => {
  it('commits a lockfile at version 3 or later', () => {
    const lock = readJson('package-lock.json') as { lockfileVersion: number }
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3)
  })

  it('pins every root devDependency to an exact version', () => {
    const root = readJson('package.json') as { devDependencies: Record<string, string> }
    for (const [name, version] of Object.entries(root.devDependencies)) {
      expect(version, `${name} must be exact, not a range`).toMatch(EXACT_SEMVER)
    }
    expect(root.devDependencies['electron']).toBe('44.1.1')
  })

  it('pins every workspace dependency to an exact version', () => {
    const workspaces = [
      'packages/protocol', 'packages/agent-host', 'packages/capture', 'packages/privacy',
      'packages/store', 'packages/keyring', 'packages/history', 'packages/search',
      'packages/hotkey', 'apps/desktop',
    ]
    for (const ws of workspaces) {
      const pkg = readJson(ws, 'package.json') as { dependencies?: Record<string, string> }
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        expect(version, `${ws} -> ${name} must be exact`).toMatch(EXACT_SEMVER)
      }
    }
  })

  it('disables install scripts in .npmrc', () => {
    expect(readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8')).toContain('ignore-scripts=true')
  })

  it('passes the no-electron-rebuild guard on this repo', () => {
    const run = spawnSync(process.execPath, [GUARD], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(run.stdout.trim()).toMatch(/^guard-no-electron-rebuild OK/)
    expect(run.status).toBe(0)
  })

  it('FAILS the guard on a transitive @electron/rebuild in a lockfile', () => {
    const cwd = join(REPO_ROOT, 'fixtures', 'guard', 'banned-lockfile')
    const run = spawnSync(process.execPath, [GUARD], { cwd, encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('node_modules/app-builder-lib/node_modules/@electron/rebuild')
  })

  it('FAILS the guard on a workspace manifest declaring node-gyp', () => {
    const cwd = join(REPO_ROOT, 'fixtures', 'guard', 'banned-manifest')
    const run = spawnSync(process.execPath, [GUARD], { cwd, encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('packages/thumbs/package.json: devDependencies.node-gyp')
  })

  it('exits 2 when the lockfile is missing, so a fresh clone cannot pass by accident', () => {
    const cwd = join(REPO_ROOT, 'fixtures')
    const run = spawnSync(process.execPath, [GUARD], { cwd, encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('package-lock.json is missing')
  })
})
