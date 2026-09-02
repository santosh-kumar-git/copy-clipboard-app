import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  contentHash,
  createTestClock,
  TEST_CANARY,
  type Candidate,
  type ClipboardAgent,
  type ResolvedRep,
  type Unsub,
} from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import { createHistory } from '@cairn/history'
import { createHotkey } from '@cairn/hotkey'
import { classify, DEFAULT_RULES, mask } from '@cairn/privacy'
import { createSearchIndex } from '@cairn/search'
import { openStore } from '@cairn/store'
import { DEFAULT_CONFIG } from './config'
import { createStderrLogger, LOG_FIELD_KEYS } from './logger'
import { composeApp } from './wiring'

const sink = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

describe('createStderrLogger', () => {
  it('emits one JSON object per line with ts, level and event', () => {
    const s = sink()
    const clock = createTestClock()
    const log = createStderrLogger({ write: s.write, clock })
    log.info('app.ready', { count: 3 })
    expect(s.lines).toHaveLength(1)
    expect(JSON.parse(s.lines[0]!)).toEqual({
      ts: 1_767_225_600_000,
      level: 'info',
      event: 'app.ready',
      count: 3,
    })
  })

  it('ends every line with a newline so NDJSON on stderr is really NDJSON', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.warn('ipc.rejected', { code: 'E_IPC_REJECTED' })
    expect(s.lines[0]!.endsWith('\n')).toBe(true)
  })

  it('the allowlist is the LogFields key set plus the three envelope keys', () => {
    expect([...LOG_FIELD_KEYS].sort()).toEqual([
      'accelerator', 'agent', 'attempt', 'bundleId', 'byteLength', 'code', 'count', 'detectors',
      'durationMs', 'event', 'flags', 'hashPrefix', 'itemId', 'kind', 'level', 'method', 'mime',
      'mode', 'ok', 'repCount', 'seq', 'ts',
    ])
  })

  it('STRIPS any field outside the allowlist, so a canary cannot reach a log line', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    // A JS caller, a `@ts-expect-error`, or a future refactor can all produce this object. The
    // compile-time guard in @cairn/protocol is the first line of defence; this is the second.
    const smuggled = { kind: 'text', text: TEST_CANARY, body: TEST_CANARY, preview: TEST_CANARY }
    log.info('history.ingested', smuggled as never)
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['event', 'kind', 'level', 'ts'])
    expect(JSON.stringify(s.lines)).not.toContain(TEST_CANARY)
  })

  it('drops a non-primitive value even when its key IS on the allowlist', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.info('history.ingested', { mime: new Uint8Array([67, 65, 73]) } as never)
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(parsed['mime']).toBeUndefined()
  })

  it('honours minLevel so debug output cannot leak from a shipped build', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock(), minLevel: 'info' })
    log.debug('app.ready')
    log.info('app.ready')
    expect(s.lines).toHaveLength(1)
    expect(JSON.parse(s.lines[0]!).level).toBe('info')
  })

  it('an array field is kept only if every element is a string', () => {
    const s = sink()
    const log = createStderrLogger({ write: s.write, clock: createTestClock() })
    log.info('privacy.masked', { flags: ['secret'], detectors: ['aws-access-key'] })
    const parsed = JSON.parse(s.lines[0]!) as Record<string, unknown>
    expect(parsed['flags']).toEqual(['secret'])
    expect(parsed['detectors']).toEqual(['aws-access-key'])
  })
})

describe('a REAL ingest through composeApp logs metadata only (spec §11 control 2)', () => {
  it('emits no line naming the canary, and no key outside LogFields ∪ {level, event, ts}', async () => {
    const s = sink()
    const clock = createTestClock()
    // THE REAL LOGGER, and the real domain packages behind it. This is the difference between
    // "the sink strips a bad key" and "no component ever hands the sink a body": @cairn/store logs
    // store.appended, @cairn/privacy logs privacy.masked and @cairn/history logs history.ingested,
    // and all three of those calls actually execute below.
    const logger = createStderrLogger({ write: s.write, clock })

    const dir = mkdtempSync(join(tmpdir(), 'cairn-logger-canary-'))
    const opened = openStore({ dir, key: randomBytes(32), clock, logger })
    if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
    const store = opened.value

    const privacy = { rules: DEFAULT_RULES, classify, mask }
    const history = createHistory({
      store,
      privacy,
      search: createSearchIndex(),
      clock,
      logger,
      retention: { ...DEFAULT_CONFIG.retention, secretTtlMs: 300_000 },
    })
    await history.load()

    const noop = (): void => {}
    const agent = {
      start: async () => ({}),
      request: async (method: string) => {
        if (method === 'watch.start') return { ok: true as const, value: { watching: true, intervalMs: 500 } }
        if (method === 'watch.stop') return { ok: true as const, value: { watching: false } }
        if (method === 'hotkey.register') return { ok: true as const, value: { bound: true, accelerator: 'Cmd+Shift+V' } }
        if (method === 'hotkey.unregister') return { ok: true as const, value: { bound: false } }
        return { ok: true as const, value: {} }
      },
      on: (): Unsub => noop,
      dispose: async () => {},
    } as unknown as ClipboardAgent

    const candidateCbs: ((c: Candidate) => void)[] = []
    const capture: Capture = {
      start: async () => ({ ok: true, value: { intervalMs: 500 } }),
      stop: async () => {},
      onCandidate: (cb) => { candidateCbs.push(cb); return noop },
      suppressToken: noop,
      whenIdle: async () => {},
    }

    const app = composeApp({
      agent,
      capture,
      history,
      hotkey: createHotkey({ agent, logger }),
      keyring: { getMode: () => 'os-keyring', probeBackend: () => ({ notes: [] }), lock: noop },
      store: { close: () => { store.close() } },
      palette: { show: noop, hide: noop, isVisible: () => false, send: noop, destroy: noop },
      ipcMain: { handle: noop, removeHandler: noop },
      powerMonitor: { on: noop, getSystemIdleTime: () => 0 },
      clock,
      logger,
      config: DEFAULT_CONFIG,
      dataDir: dir,
      saveConfig: noop,
      chooseHotkey: async (c) => c[0]!,
    })
    await app.start()

    // The canary is in the two places a BODY lives — the primary text and the rep bytes — and
    // deliberately NOT in the bundle id or the app name, because `bundleId` is a legitimate
    // LogFields key that capture.candidate really does log. Putting the canary there would make this
    // test fail for a correct reason and teach the next reader to delete it.
    const text = `${TEST_CANARY} and a little more text`
    const bytes = new TextEncoder().encode(text)
    const canaryRep: ResolvedRep = {
      mime: 'text/plain',
      uti: 'public.utf8-plain-text',
      bytes,
      byteLength: bytes.length,
      sha256: contentHash(bytes),
    }
    const candidate: Candidate = {
      reps: [canaryRep],
      kind: 'text',
      contentHash: contentHash(bytes),
      primaryText: text,
      hints: [],
      sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
      thumbnailJpeg: null,
      changeToken: '4711',
      capturedAt: clock.now(),
    }

    expect(candidateCbs).toHaveLength(1)
    candidateCbs[0]!(candidate)
    await vi.waitFor(() => expect(history.list().total).toBe(1))
    await app.stop()
    rmSync(dir, { recursive: true, force: true })

    // 1. A real ingest logged something, and every line is one JSON object.
    expect(s.lines.length).toBeGreaterThan(0)
    for (const line of s.lines) expect(() => JSON.parse(line) as unknown).not.toThrow()

    // 2. The UNION of keys across ALL emitted lines is a subset of LogFields ∪ {level, event, ts}.
    //    Asserting the union rather than per-line is what catches ONE new logger call that carries a
    //    body-shaped field on a path only this ingest reaches.
    const keys = [...new Set(s.lines.flatMap((l) => Object.keys(JSON.parse(l) as object)))].sort()
    expect(keys.filter((k) => !LOG_FIELD_KEYS.includes(k))).toEqual([])

    // 3. And no line contains the canary in any encoding. Assertion 2 alone is not enough: `mime`
    //    and `bundleId` are allowlisted STRING fields, so a body assigned to one of them passes the
    //    key check and only this assertion catches it.
    const ndjson = s.lines.join('')
    expect(ndjson).not.toContain(TEST_CANARY)
    expect(ndjson).not.toContain(Buffer.from(TEST_CANARY).toString('base64'))
    expect(ndjson).not.toContain(Buffer.from(TEST_CANARY).toString('hex'))
  })
})
