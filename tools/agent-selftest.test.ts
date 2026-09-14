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
  MAX_WRITE_BYTES,
  MAX_WRITE_REPS,
  REP_STREAM_TIMEOUT_MS,
  WRITE_TRANSFER_TIMEOUT_MS,
  WATCH_INTERVAL_MS,
  contentHash,
  systemClock,
  type Logger,
} from '@cairn/protocol'
import { spawnAgent } from '@cairn/agent-host'
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

    // Both calls carry an explicit `timeout`. execFileSync BLOCKS the worker thread, so vitest's
    // own test timeout cannot interrupt it — without this, a swiftc that never returns is
    // indistinguishable from a hung CI job, with no output to say which test it died in. The
    // budget is deliberately generous: a cold runner builds the AppKit and Carbon modules from
    // scratch, which is minutes of work the local module cache normally hides (8s warm here).
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
      { stdio: 'pipe', timeout: 240_000 },
    )

    const output = execFileSync(SELFTEST_BIN, [], { encoding: 'utf8', timeout: 60_000 })
    const failed = output.split('\n').filter((line) => line.startsWith('FAIL'))
    expect(failed, output).toEqual([])
    expect(output.trimEnd().endsWith('ALL PASS')).toBe(true)
  }, 330_000)

  it('streams multiple large reps through the native request handler with a synthetic clipboard writer', async () => {
    const logger = { log() {}, debug() {}, info() {}, warn() {}, error() {} } as Logger
    const agent = spawnAgent({ platform: 'macos', binPath: SELFTEST_BIN, args: ['--write-agent'],
      clock: systemClock, logger, maxRestarts: 0 })
    try {
      const caps = await agent.start()
      expect(caps.chunkedWrite).toBe(true)
      const png = Buffer.alloc(1_048_576, 0x5a)
      const text = Buffer.alloc(900_000, 0x41)
      expect(await agent.request('write', { transient: false, reps: [
        { mime: 'image/png', uti: 'public.png', b64: png.toString('base64') },
        { mime: 'text/plain', uti: null, b64: text.toString('base64') },
      ] })).toEqual({ ok: true, value: {
        changeToken: `image/png|public.png|${contentHash(png)},text/plain||${contentHash(text)}|false`,
      } })
      expect(await agent.request('read', { changeCount: 0 })).toMatchObject({ ok: true, value: { changeCount: 1 } })
      expect(await agent.request('write.begin', {
        transferId: 'corrupt', transient: false,
        reps: [{ mime: 'text/plain', uti: null, byteLength: 1, sha256: contentHash(Buffer.from('x')) }],
      })).toMatchObject({ ok: true })
      await agent.request('write.chunk', { transferId: 'corrupt', repIndex: 0, seq: 0, b64: 'eQ==' })
      expect(await agent.request('write.commit', { transferId: 'corrupt' }))
        .toMatchObject({ ok: false, code: 'E_REP_HASH_MISMATCH' })
      expect(await agent.request('read', { changeCount: 0 })).toMatchObject({ ok: true, value: { changeCount: 1 } })
    } finally {
      await agent.dispose()
    }
  }, 30_000)
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
    ['MAX_WRITE_BYTES', MAX_WRITE_BYTES],
    ['MAX_WRITE_REPS', MAX_WRITE_REPS],
    ['REP_STREAM_TIMEOUT_MS', REP_STREAM_TIMEOUT_MS],
    ['WRITE_TRANSFER_TIMEOUT_MS', WRITE_TRANSFER_TIMEOUT_MS],
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
