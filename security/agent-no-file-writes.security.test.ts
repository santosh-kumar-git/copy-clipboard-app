import { basename } from 'node:path'
import { expect, it } from 'vitest'
import { findInSources, formatHits, sourceFiles } from './source-scan'

/**
 * Spec §11 control 1: clipboard bytes never touch the disk unencrypted, at any point, and nothing
 * egresses. The agent is the process that holds them first, so it must have no filesystem write path
 * and no network API at all — its only sinks are stdout (protocol) and stderr (human text). An earlier
 * revision of this design spooled oversized representations to $TMPDIR; this file is what stops that
 * coming back.
 *
 * `security/no-plaintext-on-disk.security.test.ts` (Task 6) scans packages/** and apps/desktop/**, and
 * Task 9's `security/no-socket-at-startup.security.test.ts` scans packages/**, apps/desktop/** and
 * tools/**. The Swift agent is outside both sets of roots, which is why this file exists.
 *
 * `agents/macos/Tests/` is deliberately NOT a root: `--mark files` legitimately builds
 * `URL(fileURLWithPath:)` for /bin/ls, and SelfTest.swift is a test binary that never ships.
 */
const AGENT_SOURCES = ['agents/macos/Sources']

/** Every way a byte could reach the disk from Swift, including the two read forms. */
const BANNED_FS = [
  'FileManager',
  'createFile',
  'write(toFile',
  'writeToFile',
  'NSTemporaryDirectory',
  'mkstemp',
  'mkdtemp',
  'fopen(',
  'fwrite(',
  'FileHandle(forWritingAtPath',
  'FileHandle(forUpdatingAtPath',
  'URL(fileURLWithPath',
  'Data(contentsOf',
  'String(contentsOf',
  'UserDefaults',
  'CFPreferences',
]

/**
 * Spec §11 control 1's other half: no telemetry, no egress, in any form. Every entry is a way bytes
 * could leave this process other than stdout/stderr — a URL load, a raw socket, an XPC peer, or a
 * child process (a `Process` running `/usr/bin/curl` is egress with extra steps, and spec §11
 * control 3 wants no shell in the capture path on macOS at all). Bare `Network` catches
 * `import Network` before `NWConnection` is ever spelled.
 */
const BANNED_EGRESS = [
  'URLSession',
  'URLRequest',
  'NSURLConnection',
  'NWConnection',
  'NWListener',
  'NWBrowser',
  'Network',
  'NetService',
  'CFSocket',
  'CFStream',
  'socket(',
  'getaddrinfo',
  'NSXPCConnection',
  'Process(',
  'posix_spawn',
  'popen(',
  'system(',
]

it('scans a non-empty set of agent sources, so a zero-hit result means something', () => {
  const files = sourceFiles(AGENT_SOURCES).map((f) => basename(f))
  expect(files).toContain('main.swift')
  expect(files).toContain('Wire.swift')
  expect(files).not.toContain('SelfTest.swift')
})

it('the macOS agent has no filesystem write path for clipboard bytes', () => {
  for (const banned of BANNED_FS) {
    expect(formatHits(findInSources(banned, AGENT_SOURCES)), `banned: ${banned}`).toBe('')
  }
})

/**
 * `NSFileHandle.writeData:` raises an OBJECTIVE-C exception when its descriptor is gone, and Swift
 * cannot catch that: it goes straight to abort(). Since the agent's stdout and stderr both close when
 * the host exits, the "stdin closed; exiting" breadcrumb turned every normal quit into SIGABRT and a
 * crash report in DiagnosticReports. Raw write(2) returns -1 instead, which is a value we can handle.
 *
 * This is a reliability ban rather than a security one, but it lives here because this is the file
 * that already scans the Swift sources, and the failure mode — an abort on shutdown — looks exactly
 * like a crash worth investigating.
 */
it('the macOS agent writes to its own pipes with write(2), never a raising FileHandle API', () => {
  for (const banned of ['FileHandle.standardError.write', 'FileHandle.standardOutput.write']) {
    expect(formatHits(findInSources(banned, AGENT_SOURCES)), `banned: ${banned}`).toBe('')
  }
  // And the safe form is genuinely present, so the ban above is not passing because the writer was
  // deleted entirely.
  expect(findInSources('Darwin.write(', AGENT_SOURCES).length).toBeGreaterThan(0)
})

it('the macOS agent has no network egress path and spawns no child process', () => {
  for (const banned of BANNED_EGRESS) {
    expect(formatHits(findInSources(banned, AGENT_SOURCES)), `banned: ${banned}`).toBe('')
  }
})
