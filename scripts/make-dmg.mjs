#!/usr/bin/env node
/**
 * Wraps `dist/Cairn.app` in `dist/Cairn-<version>.dmg` — the normal way a Mac app is handed to
 * someone.
 *
 * `hdiutil` ships with macOS, so this adds no dependency. That matters here for the same reason the
 * packager is hand-rolled: every DMG library in the ecosystem arrives via app-builder-lib, which
 * depends on @electron/rebuild, which `npm run guard:no-rebuild` fails the build over.
 *
 * The staging folder holds the app plus a symlink to /Applications, which is what makes the mounted
 * window a drag-and-drop target instead of a puzzle.
 *
 * STILL UNSIGNED. A DMG changes how the app is delivered, not whether Gatekeeper trusts it: the
 * first launch is still right-click -> Open. Signing and notarization need a Developer ID.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const DIST = join(REPO, 'dist')
const APP = join(DIST, 'Cairn.app')
const STAGING = join(DIST, 'dmg-staging')

const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const DMG = join(DIST, `Cairn-${version}.dmg`)

if (!existsSync(APP)) {
  console.error('make-dmg: dist/Cairn.app is missing — run `npm run package:mac` first')
  process.exit(1)
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })

rmSync(STAGING, { recursive: true, force: true })
rmSync(DMG, { force: true })
mkdirSync(STAGING, { recursive: true })

// Copied with `cp -R` rather than fs.cpSync: `-R` preserves the framework symlinks inside the
// bundle, and a bundle whose Versions/Current symlink was flattened into a copy will not launch.
run('/bin/cp', ['-R', APP, join(STAGING, 'Cairn.app')])
symlinkSync('/Applications', join(STAGING, 'Applications'))

// UDZO is the compressed read-only format every macOS release since forever can mount.
run('/usr/bin/hdiutil', [
  'create',
  '-volname', 'Cairn',
  '-srcfolder', STAGING,
  '-ov',
  '-format', 'UDZO',
  DMG,
])

rmSync(STAGING, { recursive: true, force: true })

// Prove it mounts and that the app inside it is intact, rather than trusting that hdiutil exiting 0
// means the image is usable. A DMG that builds but will not mount is a bad way to find out later.
const attached = run('/usr/bin/hdiutil', ['attach', DMG, '-nobrowse', '-readonly'])
const mountPoint = attached.trim().split('\n').pop()?.split('\t').pop()?.trim()
try {
  if (mountPoint === undefined || !existsSync(join(mountPoint, 'Cairn.app', 'Contents', 'MacOS', 'Cairn'))) {
    throw new Error(`the mounted image has no launchable Cairn.app (mounted at ${mountPoint})`)
  }
  console.log(`make-dmg: verified — mounted at ${mountPoint} with a launchable bundle`)
} finally {
  if (mountPoint !== undefined) run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet'])
}

console.log(`make-dmg: built ${DMG}`)
console.log('  UNSIGNED — the first launch is still right-click -> Open.')
