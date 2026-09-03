#!/usr/bin/env node
/**
 * Builds `dist/Cairn.app` — an unsigned, local-install macOS bundle.
 *
 * Hand-rolled rather than electron-builder or @electron/packager, for one hard reason: both pull
 * `app-builder-lib`, which depends on `@electron/rebuild`, and `npm run guard:no-rebuild` fails the
 * build the moment that appears in the lockfile. That guard is a deliberate invariant (spec §2), so
 * the packager bends, not the guard. The whole job is copying a directory and writing a plist, which
 * is not worth a dependency tree that also runs install scripts.
 *
 * NOT signed and NOT notarized. Gatekeeper will refuse the first launch from Finder; right-click →
 * Open, once, is the documented path. Signing is M3 proper, and needs a Developer ID.
 *
 * Layout, which `apps/desktop/main/src/index.ts` resolves against `app.getAppPath()`:
 *
 *   Cairn.app/Contents/
 *     Info.plist                      LSUIElement 1, so no Dock icon and no menu bar entry
 *     MacOS/Cairn                     the renamed Electron launcher
 *     Resources/
 *       app/                          <- app.getAppPath()
 *         package.json                `main` points at out/main/index.js
 *         out/{main,preload,renderer}
 *         node_modules/               only sharp's closure; everything else is bundled by vite
 *       agents/macos/build/cairn-agent-macos
 *       trayTemplate.png, trayTemplate@2x.png
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const OUT = join(REPO, 'dist')
const APP = join(OUT, 'Cairn.app')
const CONTENTS = join(APP, 'Contents')
const RES = join(CONTENTS, 'Resources')
const APP_ROOT = join(RES, 'app')

const BUNDLE_ID = 'app.cairn.desktop'
const NAME = 'Cairn'

const die = (msg) => {
  console.error(`package-macos: ${msg}`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version

// ---- preconditions, each with the command that fixes it -------------------------------------
const ELECTRON_APP = join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app')
if (!existsSync(ELECTRON_APP)) die('node_modules/electron/dist is missing — run `npm run bootstrap`')
for (const [p, fix] of [
  [join(REPO, 'apps/desktop/out/main/index.js'), 'npm run build'],
  [join(REPO, 'apps/desktop/out/preload/index.js'), 'npm run build'],
  [join(REPO, 'apps/desktop/out/renderer/index.html'), 'npm run build'],
  [join(REPO, 'agents/macos/build/cairn-agent-macos'), 'npm run agent:macos'],
  [join(REPO, 'apps/desktop/resources/trayTemplate.png'), 'node scripts/gen-tray-icon.mjs'],
]) {
  if (!existsSync(p)) die(`${p} is missing — run \`${fix}\``)
}

// ---- the bundle ------------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// `dereference: false` keeps Electron's framework symlinks as symlinks. Copying through them
// produces a bundle several hundred MB larger that also fails to launch, because the frameworks
// expect the Versions/A/Current layout.
cpSync(ELECTRON_APP, APP, { recursive: true, dereference: false, verbatimSymlinks: true })

renameSync(join(CONTENTS, 'MacOS', 'Electron'), join(CONTENTS, 'MacOS', NAME))
rmSync(join(RES, 'default_app.asar'), { force: true })

writeFileSync(
  join(CONTENTS, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundleDisplayName</key><string>${NAME}</string>
  <key>CFBundleExecutable</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- The whole point of an accessory app: no Dock icon, no app-switcher entry. index.ts also
       calls app.dock.hide(), which covers the unpackaged case; this covers the bundle. -->
  <key>LSUIElement</key><true/>
  <!-- Cairn reads the clipboard, which is not a TCC-gated capability, and nothing here talks to the
       network. No NSAppleEventsUsageDescription: M1 synthesises no keystrokes. -->
</dict>
</plist>
`,
)

// ---- the app itself --------------------------------------------------------------------------
mkdirSync(APP_ROOT, { recursive: true })
cpSync(join(REPO, 'apps/desktop/out'), join(APP_ROOT, 'out'), { recursive: true })

// A minimal manifest. The workspace manifest's `dependencies` list @cairn/* by version, which npm
// cannot resolve outside the repo — and it does not need to, because vite bundled all of them in.
writeFileSync(
  join(APP_ROOT, 'package.json'),
  `${JSON.stringify({ name: 'cairn-desktop', version, private: true, main: 'out/main/index.js' }, null, 2)}\n`,
)

cpSync(join(REPO, 'agents/macos/build/cairn-agent-macos'), join(RES, 'agents/macos/build/cairn-agent-macos'), {
  recursive: true,
})
for (const icon of ['trayTemplate.png', 'trayTemplate@2x.png']) {
  cpSync(join(REPO, 'apps/desktop/resources', icon), join(RES, icon))
}

// ---- sharp, the one external dependency ------------------------------------------------------
// electron.vite.config.ts externalises exactly `electron` and `sharp`. Electron supplies the first.
// The second is a Node-API binary, so its closure has to be copied in. Walked rather than
// hard-coded: sharp's dependency set changes between minor versions, and a missing transitive
// dependency is a crash at first thumbnail rather than at build time.
const seen = new Set()
const queue = ['sharp']
while (queue.length > 0) {
  const name = queue.shift()
  if (seen.has(name)) continue
  const from = join(REPO, 'node_modules', name)
  if (!existsSync(from)) continue
  seen.add(name)
  cpSync(from, join(APP_ROOT, 'node_modules', name), { recursive: true, dereference: false })
  const manifestPath = join(from, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push(dep)
  // Only the optional deps that are actually installed, i.e. this platform's prebuilt binaries.
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    if (existsSync(join(REPO, 'node_modules', dep))) queue.push(dep)
  }
}

console.log(`package-macos: built ${APP}`)
console.log(`  bundled ${seen.size} runtime package(s): ${[...seen].sort().join(', ')}`)
console.log('  UNSIGNED — first launch must be right-click -> Open, or macOS will refuse it.')
