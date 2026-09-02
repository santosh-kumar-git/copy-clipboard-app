import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, findInSources, formatHits } from './source-scan'

// Registering `cairn://` would let any web page you visit invoke this app with attacker-chosen
// parameters — a remote trigger into the pairing path, for zero benefit: the desktop DISPLAYS the
// pairing QR, it never receives one.
const ROOTS = ['apps', 'packages', 'tools', 'agents', 'scripts']

const BANNED = [
  'setAsDefaultProtocolClient',
  'removeAsDefaultProtocolClient',
  'isDefaultProtocolClient',
  'CFBundleURLTypes',
  'CFBundleURLSchemes',
  // The bare event name, as contract §8 writes it — not just the quoted forms, so
  // `app.on(EVENT_OPEN_URL, …)` with a hoisted constant cannot slip through either.
  'open-url',
  'registerSchemesAsPrivileged',
  'protocol.handle',
  'cairn://',
] as const

describe('spec §11 control 10 — the desktop registers NO custom URI scheme', () => {
  it('scans a non-empty set of files, so a clean result means something', () => {
    expect(findInSources('BrowserWindow', ROOTS).length).toBeGreaterThan(0)
  })

  it('names none of the protocol-registration identifiers anywhere, comment or code', () => {
    for (const banned of BANNED) {
      expect(formatHits(findInSources(banned, ROOTS)), `banned: ${banned}`).toBe('')
    }
  })

  it('the root package.json declares no protocols block', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg['protocols']).toBeUndefined()
    expect(pkg['build']).toBeUndefined()
  })
})
