#!/usr/bin/env node
// Refuses to run on a Node older than .nvmrc. `engines.node` + engine-strict only gate `npm
// install`; `npm run <script>` skips the check entirely, so the first sign of a wrong Node was a
// raw ERR_REQUIRE_ESM from inside node_modules — `bootstrap` dies in electron/install.js because
// @electron/get is ESM-only and require(esm) landed in Node 22.12, and `test` dies in
// html-encoding-sniffer. Neither message mentions Node, so the fix is not guessable from it.
//
// .nvmrc is the single source of truth; package.json's engines.node is asserted to agree with it
// by security/supply-chain.security.test.ts, so the two cannot drift.
//
// Runs on whatever Node the user has, including the old one being rejected: no imports beyond
// node:fs, no dependencies, no syntax newer than Node 18.
import { readFileSync } from 'node:fs'

/** [major, minor, patch]; missing parts are 0, so "24" parses as 24.0.0. */
function parse(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim())
  if (m === null) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** Negative if a < b, 0 if equal, positive if a > b. */
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

// argv[2] lets the test suite check a version other than the one it is running on.
const current = process.argv[2] ?? process.versions.node
const required = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8')

const have = parse(current)
const want = parse(required)
if (want === null) {
  console.error(`check-node: .nvmrc does not contain a version: ${JSON.stringify(required)}`)
  process.exit(2)
}
if (have === null) {
  console.error(`check-node: could not parse the Node version ${JSON.stringify(current)}`)
  process.exit(2)
}

if (cmp(have, want) < 0) {
  const w = want.join('.')
  console.error(`
Cairn needs Node ${w} or newer. This is Node ${have.join('.')}.

  nvm use          # reads .nvmrc, which pins ${w}

If \`nvm use\` reports the version is not installed:

  nvm install      # also reads .nvmrc

Why this is fatal rather than a warning: on an older Node the failure surfaces as
ERR_REQUIRE_ESM from inside node_modules, which names a file in electron/ or
html-encoding-sniffer/ and never mentions Node at all.
`.trim())
  process.exit(1)
}
