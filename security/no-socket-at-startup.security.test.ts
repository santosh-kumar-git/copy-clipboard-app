import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, findInSources, formatHits, sourceFiles, stripComments } from './source-scan'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestClock, type Logger } from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import { composeApp } from '../apps/desktop/main/src/wiring'
import { DEFAULT_CONFIG } from '../apps/desktop/main/src/config'

// Spec §11 control 1: no telemetry, no analytics and no network egress of any kind before the
// user opens the Pair screen — which does not exist until M6. Nothing may bind or dial a socket.
const PRODUCT_ROOTS = ['packages', 'apps/desktop', 'tools']
const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

/** Spec §11 control 3's scope is the capture and recall path, so this list is NARROWER than
 *  PRODUCT_ROOTS: `security/**` and `tools/**` are deliberately excluded, because the guards and the
 *  codegen there legitimately run `swiftc`, `/usr/bin/uname` and `node` through
 *  `execFileSync`/`spawnSync` — including THIS file's own positive control — and none of them ever
 *  runs in a process holding clipboard bytes. */
const SHELL_SCAN_ROOTS = ['packages', 'apps/desktop']
const SOCKET_APIS = [
  'net.createServer',
  'http.createServer',
  'https.createServer',
  'dgram.createSocket',
  'tls.createServer',
  'WebSocketServer',
  'bonjour',
  'fetch(',
  'https.request',
  'http.request',
  'XMLHttpRequest',
]
const HANDLE_RE = /TCPSERVERWRAP|TCPWRAP|UDPWRAP/i

describe('no socket at startup', () => {
  it('scans a non-empty set of product source files', () => {
    expect(sourceFiles(PRODUCT_ROOTS).length).toBeGreaterThan(0)
  })

  it('names no socket-creating API on any non-comment line of product source', () => {
    for (const api of SOCKET_APIS) {
      expect(formatHits(findInSources(api, PRODUCT_ROOTS)), `banned API: ${api}`).toBe('')
    }
  })

  it('holds no TCP or UDP handle in this process', () => {
    expect(process.getActiveResourcesInfo().filter((h) => HANDLE_RE.test(h))).toEqual([])
  })

  it('would notice a listening socket if one appeared', () => {
    // The positive control runs in a CHILD process: a closed server handle lingers in
    // getActiveResourcesInfo() for the rest of the tick, which would poison the assertion above.
    const src =
      "const net=require('node:net');const s=net.createServer();" +
      "s.listen(0,'127.0.0.1',()=>{console.log(JSON.stringify(process.getActiveResourcesInfo()));s.close();});"
    const out = execFileSync(process.execPath, ['-e', src], { encoding: 'utf8' })
    expect((JSON.parse(out) as string[]).some((h) => HANDLE_RE.test(h))).toBe(true)
  })
})

describe('composeApp binds nothing (contract §8)', () => {
  it('holds no TCP or UDP handle after start()', async () => {
    // Task 1's version could only check the bare process. This one runs the real composition root:
    // verified that process.getActiveResourcesInfo() reports 'TCPServerWrap' the instant a listening
    // server exists, so the assertion can actually fail.
    const noop = (): void => {}
    const app = composeApp({
      agent: {
        start: async () => ({}) as never,
        request: async () => ({ ok: true, value: {} }) as never,
        on: () => noop,
        dispose: async () => {},
      } as never,
      // Task 7's `Capture`, not a narrowed copy: `stop()` is async and `whenIdle()` exists, and
      // composeApp's stop() awaits both.
      capture: {
        start: async () => ({ ok: true, value: { intervalMs: 500 } }),
        stop: async () => {},
        onCandidate: () => noop,
        suppressToken: noop,
        whenIdle: async () => {},
      } satisfies Capture,
      history: {
        load: async () => ({ ok: true, value: { items: 0 } }),
        list: () => ({ items: [], total: 0 }),
        onChange: () => noop,
        evictPreviewCache: noop,
        resolveReps: async () => ({ ok: true, value: [] }),
      } as never,
      hotkey: {
        bind: async () => ({ ok: true, value: { accelerator: 'Cmd+Shift+V' } }),
        unbind: async () => ({ ok: true, value: { bound: false } }),
        current: () => 'Cmd+Shift+V',
        status: () => 'active' as const,
        onTrigger: () => noop,
      },
      keyring: { getMode: () => 'os-keyring' as const, probeBackend: () => ({ notes: [] }), lock: noop },
      store: { close: noop },
      palette: { show: noop, hide: noop, isVisible: () => false, send: noop, destroy: noop },
      ipcMain: { handle: noop, removeHandler: noop },
      powerMonitor: { on: noop, getSystemIdleTime: () => 0 },
      clock: createTestClock(),
      logger: silentLogger(),
      config: DEFAULT_CONFIG,
      dataDir: '/tmp/cairn-no-socket',
      saveConfig: noop,
      chooseHotkey: async (c) => c[0]!,
    })
    await app.start()
    expect(process.getActiveResourcesInfo().filter((h) => HANDLE_RE.test(h))).toEqual([])
    await app.stop()
  })
})

describe('there is no local control socket (spec §9)', () => {
  it('names no control-socket identifier and no client-side dialling API', () => {
    // Spec §9: an unauthenticated local control socket would serve decrypted history and full
    // secret values to any same-user process, nullifying passphrase mode. These are the identifiers
    // Task 1's SOCKET_APIS list does not already cover.
    const banned = [
      'unix socket', '.sock', 'controlSocket', 'ipcPath', 'namedPipe',
      'net.connect', 'new WebSocket', 'createServer(',
    ]
    for (const b of banned) {
      expect(formatHits(findInSources(b, PRODUCT_ROOTS)), `banned: ${b}`).toBe('')
    }
  })
})

describe('no shell in the capture or recall path (spec §11 control 3)', () => {
  // Spec §11 control 3's last clause is "never interpolated into a shell command, and there is no
  // shell in the capture or recall path at all on macOS". Nothing asserted it until now. A copied
  // file path is a STRING we display and hand to the OS pasteboard: the moment one reaches a shell,
  // `; rm -rf ~` in a filename becomes code, and the process it becomes code in is the one holding
  // every password that crossed the clipboard.
  it('names no shell-spawning or shell-invoking form in the capture or recall path', () => {
    const banned = [
      'execSync', 'execFile', 'spawnSync',
      // `exec` reached through a member or called on a literal. The bare token `exec(` is NOT banned
      // on purpose: `packages/privacy/src/detectors.ts` legitimately calls `re.exec(text)` in its
      // scan loop, and a ban that fires on a RegExp method would be deleted within a week.
      'child_process.exec', "exec('", 'exec("', 'exec(`',
      'shell: true', 'shell:true', 'shell: process.env',
      '/bin/sh', '/bin/bash', '/bin/zsh', 'osascript', 'sh -c', 'bash -c',
    ]
    for (const b of banned) {
      expect(formatHits(findInSources(b, SHELL_SCAN_ROOTS)), `banned: ${b}`).toBe('')
    }
  })

  it('reaches node:child_process from exactly one file, and only for spawn with an argv array', () => {
    // Stronger than a name list, because it closes the hole a name list leaves: no file on the
    // capture or recall path can reach ANY child_process API except the one spawn call that starts
    // the Swift agent.
    const importers = [...new Set(findInSources('node:child_process', SHELL_SCAN_ROOTS).map((h) => h.file))]
    expect(importers).toEqual(['packages/agent-host/src/spawn-agent.ts'])

    const src = readFileSync(join(REPO_ROOT, 'packages/agent-host/src/spawn-agent.ts'), 'utf8')
    expect(src).toContain("import { spawn, type ChildProcess } from 'node:child_process'")
    // An argv ARRAY, no shell, and no interpolation: binPath and args are passed as data.
    expect(src).toContain("const c = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })")
    // stripComments, NOT the raw source: spawn-agent.ts's own comments say "with an argv ARRAY and no
    // shell option" and "can never become shell syntax", so `expect(src).not.toContain('shell')`
    // would fail on the documentation of the control it is checking. Task 1's stripper is
    // quote-aware, so `spawn(bin, args, { shell: true })` is still a hit.
    expect(stripComments(src)).not.toContain('shell')
  })
})
