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
const NODE_GUARD = join(REPO_ROOT, 'scripts', 'check-node.mjs')
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

  // The Node floor. `engines` + engine-strict only gate `npm install`; `npm run <script>` ignores
  // both, and on an older Node the failure is a raw ERR_REQUIRE_ESM from inside node_modules
  // (@electron/get is ESM-only, and require(esm) landed in 22.12) that never mentions Node.
  it('declares the same Node floor in .nvmrc and engines.node', () => {
    const nvmrc = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim()
    expect(nvmrc).toMatch(EXACT_SEMVER)
    const root = readJson('package.json') as { engines: { node: string } }
    expect(root.engines.node).toBe(`>=${nvmrc}`)
  })

  it('gates every entry point that breaks on an old Node, inline rather than via a pre hook', () => {
    const { scripts } = readJson('package.json') as { scripts: Record<string, string> }
    for (const entry of ['app', 'bootstrap', 'build', 'dev', 'start', 'test', 'typecheck']) {
      expect(scripts[entry], `${entry} must exist to be gated`).toBeDefined()
      expect(scripts[entry], `${entry} must run the Node guard first`)
        .toMatch(/^node scripts\/check-node\.mjs &&/)
    }
    // Why inline: .npmrc sets ignore-scripts=true, which also suppresses pre/post hooks for
    // `npm run`. A `prebuild` here would silently never execute — measured, not assumed. Any
    // pre* script in this manifest is therefore dead code and a false sense of a guard.
    const dead = Object.keys(scripts).filter((k) => /^(pre|post)/.test(k))
    expect(dead, 'pre/post hooks never run under ignore-scripts=true').toEqual([])
  })

  it('keeps ignore-scripts on, which is what forces the guard to be inline', () => {
    const npmrc = readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8')
    expect(npmrc).toMatch(/^ignore-scripts=true$/m)
  })

  it('passes the Node guard on the version this suite is running on', () => {
    const run = spawnSync(process.execPath, [NODE_GUARD], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('FAILS the Node guard on the version that broke `npm run bootstrap`', () => {
    const run = spawnSync(process.execPath, [NODE_GUARD, '20.16.0'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(run.status).toBe(1)
    // The whole point is that the message names the fix, not the crashing dependency.
    expect(run.stderr).toContain('Cairn needs Node 24.20.0 or newer. This is Node 20.16.0.')
    expect(run.stderr).toContain('nvm use')
  })

  it('accepts a newer Node than the pin, and rejects one patch below it', () => {
    const pass = spawnSync(process.execPath, [NODE_GUARD, '25.0.0'], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(pass.status).toBe(0)
    const fail = spawnSync(process.execPath, [NODE_GUARD, '24.19.9'], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(fail.status).toBe(1)
  })

  it('exits 2 — not 1 — on a version string it cannot parse, so a bug is not a floor breach', () => {
    const run = spawnSync(process.execPath, [NODE_GUARD, 'not-a-version'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('could not parse')
  })

  it('exits 2 when the lockfile is missing, so a fresh clone cannot pass by accident', () => {
    const cwd = join(REPO_ROOT, 'fixtures')
    const run = spawnSync(process.execPath, [GUARD], { cwd, encoding: 'utf8' })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('package-lock.json is missing')
  })
})
