#!/usr/bin/env node
// Fails the build if @electron/rebuild or node-gyp appear anywhere: a direct dependency, a
// transitive one, or a lockfile entry. Spec §2 makes this a CI-enforced invariant, because it is
// the only thing that would drag V8-ABI rebuilds back into a repo whose native artefacts are all
// either Node-API (sharp) or standalone processes (the agents).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BANNED = ['@electron/rebuild', 'electron-rebuild', 'node-gyp', '@electron/node-gyp']
const hits = []

if (!existsSync('package-lock.json')) {
  console.error('guard: package-lock.json is missing — run `npm install` and commit the lockfile')
  process.exit(2)
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const lockEntries = Object.keys(lock.packages ?? {})
for (const p of lockEntries) {
  for (const b of BANNED) {
    if (p === `node_modules/${b}` || p.endsWith(`/node_modules/${b}`)) hits.push(`package-lock.json: ${p}`)
  }
}

const manifests = ['package.json']
for (const group of ['packages', 'apps', 'agents']) {
  if (!existsSync(group)) continue
  for (const d of readdirSync(group)) {
    const m = join(group, d, 'package.json')
    if (existsSync(m)) manifests.push(m)
  }
}
for (const m of manifests) {
  const pkg = JSON.parse(readFileSync(m, 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (BANNED.includes(name)) hits.push(`${m}: ${field}.${name}`)
    }
  }
}

if (hits.length > 0) {
  console.error('guard-no-electron-rebuild FAILED. Banned packages found:')
  for (const h of hits) console.error('  - ' + h)
  console.error('\nEvery native artefact must be Node-API (sharp) or a standalone process (the agents).')
  process.exit(1)
}
console.log(`guard-no-electron-rebuild OK — scanned ${lockEntries.length} lockfile entries and ${manifests.length} manifests`)
