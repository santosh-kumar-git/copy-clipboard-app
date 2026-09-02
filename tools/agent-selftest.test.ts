import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_REQUEST_TIMEOUT_MS,
  CHUNK_PAYLOAD_BYTES,
  CHUNK_THRESHOLD_BYTES,
  MAX_LINE_BYTES,
  MAX_REP_BYTES,
  WATCH_INTERVAL_MS,
} from '@cairn/protocol'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES_DIR = join(REPO_ROOT, 'agents', 'macos', 'Sources')
const BUILD_DIR = join(REPO_ROOT, 'agents', 'macos', 'build')
const SELFTEST_SRC = join(REPO_ROOT, 'agents', 'macos', 'Tests', 'SelfTest.swift')
const SELFTEST_BIN = join(BUILD_DIR, 'cairn-agent-selftest')

/**
 * The Swift agent's pure logic is compiled and asserted here rather than by `swift test`, which
 * cannot run without full Xcode. Every source except main.swift is linked in, because main.swift is
 * the only file with top-level code and SelfTest.swift supplies the entry point instead.
 */
describe.runIf(process.platform === 'darwin')('macOS agent Swift self-test', () => {
  it('compiles the pure parts of the agent and every assertion passes', () => {
    expect(existsSync(SELFTEST_SRC)).toBe(true)
    mkdirSync(BUILD_DIR, { recursive: true })
    const arch = execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim()
    const sources = readdirSync(SOURCES_DIR)
      .filter((f) => f.endsWith('.swift') && f !== 'main.swift')
      .map((f) => join(SOURCES_DIR, f))
    expect(sources.length).toBeGreaterThan(0)

    execFileSync(
      'swiftc',
      [
        '-O',
        '-target', `${arch}-apple-macos13.0`,
        '-framework', 'AppKit',
        '-framework', 'Carbon',
        '-o', SELFTEST_BIN,
        ...sources,
        SELFTEST_SRC,
      ],
      { stdio: 'pipe' },
    )

    const output = execFileSync(SELFTEST_BIN, [], { encoding: 'utf8' })
    const failed = output.split('\n').filter((line) => line.startsWith('FAIL'))
    expect(failed, output).toEqual([])
    expect(output.trimEnd().endsWith('ALL PASS')).toBe(true)
  }, 60_000)
})

/**
 * AgentProtocol.generated.swift carries `protocolVersion` and the wire TYPES and nothing else — a zod
 * schema has nowhere to hang a bare number — so Wire.swift declares the six numeric limits it needs as
 * top-level `let`s. This is the guard that stops that duplication rotting: it reads the frozen
 * TypeScript constants and asserts the Swift literal for each one is present, spelled with Swift
 * underscore digit separators. It needs no compiler and no pasteboard, so it runs on every platform.
 */
it('the Swift agent declares the same numeric limits as @cairn/protocol', () => {
  const wire = readFileSync(join(SOURCES_DIR, 'Wire.swift'), 'utf8')
  const swiftLiteral = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_')
  const expected: ReadonlyArray<readonly [string, number]> = [
    ['CHUNK_THRESHOLD_BYTES', CHUNK_THRESHOLD_BYTES],
    ['CHUNK_PAYLOAD_BYTES', CHUNK_PAYLOAD_BYTES],
    ['MAX_REP_BYTES', MAX_REP_BYTES],
    ['MAX_LINE_BYTES', MAX_LINE_BYTES],
    ['AGENT_REQUEST_TIMEOUT_MS', AGENT_REQUEST_TIMEOUT_MS],
    ['WATCH_INTERVAL_MS', WATCH_INTERVAL_MS],
  ]
  const wrong = expected
    .filter(([name, value]) => !wire.includes(`let ${name} = ${swiftLiteral(value)}\n`))
    .map(([name, value]) => `${name} should be declared as ${swiftLiteral(value)}`)
  expect(wrong).toEqual([])
  // The wire major is NOT duplicated: it comes from the generated file as `protocolVersion`.
  expect(wire).not.toContain('WIRE_MAJOR')
})
