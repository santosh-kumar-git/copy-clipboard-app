import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import {
  contentHash,
  createTestClock,
  err,
  fixturePath,
  ok,
  TOAST_COPIED_MANUAL,
  type AgentCapabilities,
  type Candidate,
  type ClipboardAgent,
  type ContentHash,
  type Item,
  type ItemId,
  type KeyringMode,
  type Logger,
  type ResolvedRep,
  type Unsub,
} from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import type { History } from '@cairn/history'
import { createHotkey } from '@cairn/hotkey'
import { KEYRING_RELOCKED_BANNER } from './constants'
import { DEFAULT_CONFIG, type CairnConfig } from './config'
import { composeApp, type PowerMonitorLike } from './wiring'

const ID = '01KDVDNA00041061050R3GG28A' as ItemId
const HASH = 'sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ' as ContentHash
/** Stands in for @cairn/keyring's MACOS_KEYCHAIN_NOTE; the port only promises `readonly string[]`. */
const KEYCHAIN_NOTE = 'The key is wrapped by the macOS Keychain and unlocks with your login.'

const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

const rep = (mime: string, body: string | Uint8Array): ResolvedRep => {
  const bytes = Buffer.from(body)
  return { mime, uti: null, bytes, byteLength: bytes.length, sha256: contentHash(bytes) }
}

function build(over: {
  registerBound?: boolean
  firstRunDone?: boolean
  chooseHotkey?: (c: readonly string[]) => Promise<string>
  reps?: readonly ResolvedRep[]
  keyringMode?: KeyringMode
  keyringWarning?: string
  evictedPerSweep?: number
  failEviction?: boolean
  previewsEvicted?: boolean
  reloadedItems?: number
  writeResult?: Promise<ReturnType<typeof ok<{ changeToken: string }>>>
} = {}) {
  const clock = createTestClock()
  const agentRequests: { method: string; params: unknown }[] = []
  const hotkeyListeners: ((p: { accelerator: string; focusToken: string; firedAt: number }) => void)[] = []

  const agent = {
    start: async (): Promise<AgentCapabilities> => ({
      wireMajor: 1, agent: 'macos', agentVersion: '0.1.0', platformVersion: '26.5.1', tier: 'A',
      clipboardWatch: 'changecount-poll', paste: 'none', hotkey: 'carbon', focusApp: true,
      concealedTypeHints: true, maxRepBytes: 20_971_520, chunkThresholdBytes: 65_536, missingTools: [],
    } as AgentCapabilities),
    request: async (method: string, params: unknown) => {
      agentRequests.push({ method, params })
      if (method === 'hotkey.register') {
        return ok({ bound: over.registerBound ?? true, accelerator: (params as { accelerator: string }).accelerator })
      }
      if (method === 'hotkey.unregister') return ok({ bound: false })
      if (method === 'write') return over.writeResult ?? ok({ changeToken: '4711' })
      if (method === 'watch.start') return ok({ watching: true, intervalMs: 500 })
      if (method === 'watch.stop') return ok({ watching: false })
      if (method === 'shutdown') return ok({ bye: true })
      return err('E_UNKNOWN_METHOD', method)
    },
    on: (event: string, cb: (p: never) => void): Unsub => {
      if (event === 'hotkey.fired') hotkeyListeners.push(cb as never)
      return () => {}
    },
    dispose: async (): Promise<void> => {},
  } as unknown as ClipboardAgent

  const candidateCbs: ((c: Candidate) => void)[] = []
  const suppressed: string[] = []
  const captureCalls: string[] = []
  // Task 7's `Capture` verbatim, not a narrowed copy: `stop()` is async and `whenIdle()` exists, and
  // both are awaited by composeApp's shutdown path.
  const capture: Capture = {
    start: async () => { captureCalls.push('start'); return ok({ intervalMs: 500 }) },
    stop: async () => { captureCalls.push('stop') },
    onCandidate: (cb) => { candidateCbs.push(cb); return () => {} },
    suppressToken: (t) => { suppressed.push(t) },
    whenIdle: async () => { captureCalls.push('whenIdle') },
  }

  const ingested: Candidate[] = []
  const changeCbs: ((e: { reason: string; total: number }) => void)[] = []
  let previewCacheEvictions = 0
  let evictNowCalls = 0
  let maxItemsSet: number[] = []
  // Mirrors the real history: eviction blanks previews and only load() brings them back. The fake
  // has to model that, because the palette-open path now depends on it.
  let previewsEvicted = over.previewsEvicted ?? false
  let loads = 0
  const history = {
    load: async () => { loads += 1; previewsEvicted = false; return ok({ items: over.reloadedItems ?? 0 }) },
    ingest: async (c: Candidate) => { ingested.push(c); return ok({ outcome: 'added' as const, item: {} as Item }) },
    list: () => ({ items: [] as readonly Item[], total: 0 }),
    search: () => [],
    resolveReps: async () => ok(over.reps ?? [rep('text/plain', 'hello world')]),
    pin: async () => ok({ pinned: true }),
    remove: async () => ok({ removed: true }),
    evictNow: async () => {
      evictNowCalls += 1
      return over.failEviction === true
        ? err('E_STORE_IO', 'disk full')
        : ok({ evicted: over.evictedPerSweep ?? 0 })
    },
    evictPreviewCache: () => { previewCacheEvictions += 1; previewsEvicted = true },
    setMaxItems: (n: number) => { maxItemsSet.push(n) },
    previewsEvicted: () => previewsEvicted,
    get: () => undefined,
    onChange: (cb: (e: { reason: string; total: number }) => void): Unsub => { changeCbs.push(cb); return () => {} },
  } as unknown as History

  const sent: [string, unknown][] = []
  const paletteCalls: string[] = []
  let visible = false
  const palette = {
    ready: () => true,
    show: () => { visible = true; paletteCalls.push('show') },
    hide: () => { visible = false; paletteCalls.push('hide') },
    isVisible: () => visible,
    send: (channel: string, payload: unknown) => { sent.push([channel, payload]) },
    destroy: () => { paletteCalls.push('destroy') },
  }

  const registered = new Map<string, (e: unknown, ...a: unknown[]) => Promise<unknown>>()
  const ipcMain = {
    handle: (c: string, l: (e: unknown, ...a: unknown[]) => Promise<unknown>) => { registered.set(c, l) },
    removeHandler: (c: string) => { registered.delete(c) },
  }

  const powerHandlers = new Map<string, () => void>()
  let idleSeconds = 0
  const powerMonitor: PowerMonitorLike = {
    on: (event, cb) => { powerHandlers.set(event, cb) },
    getSystemIdleTime: () => idleSeconds,
  }

  let keyringLocked = 0
  let storeCloses = 0
  const saved: CairnConfig[] = []
  const config: CairnConfig = { ...DEFAULT_CONFIG, firstRunHotkeyDone: over.firstRunDone ?? true }

  const app = composeApp({
    agent,
    capture,
    history,
    // The real @cairn/hotkey, driven by the fake agent above. `createHotkey` is imported at the top
    // of this file with a plain ESM `import`: vitest loads `.test.ts` as ESM, so a `require(…)` here
    // throws `ReferenceError: require is not defined` at module-evaluation time — before a single
    // `it()` runs — and would silently take down the lock/quit key-zeroing assertions below with it.
    hotkey: createHotkey({ agent, logger: silentLogger() }),
    keyring: {
      getMode: () => over.keyringMode ?? 'os-keyring',
      // Structurally the same shape @cairn/keyring's probeBackend() returns, so the honest backend
      // report really is what securityStatus() appends (spec §11 control 11).
      probeBackend: () => ({ notes: [KEYCHAIN_NOTE], ...(over.keyringWarning === undefined ? {} : { warning: over.keyringWarning }) }),
      lock: () => { keyringLocked += 1 },
    },
    store: { close: () => { storeCloses += 1 } },
    palette,
    ipcMain,
    powerMonitor,
    clock,
    logger: silentLogger(),
    config,
    dataDir: '/tmp/cairn-wiring-test',
    saveConfig: (c) => { saved.push(c) },
    chooseHotkey: over.chooseHotkey ?? (async (c) => c[0]!),
  })

  return {
    app, clock, agent, capture, history, palette, agentRequests, hotkeyListeners, candidateCbs, suppressed, captureCalls,
    ingested, sent, paletteCalls, registered, powerHandlers, saved,
    fireHotkey: () => { for (const l of hotkeyListeners) l({ accelerator: 'Cmd+Shift+V', focusToken: 'tok', firedAt: 1 }) },
    setIdle: (s: number) => { idleSeconds = s },
    get keyringLocked() { return keyringLocked },
    get historyLoads() { return loads },
    get evictNowCalls() { return evictNowCalls },
    get maxItemsSet() { return maxItemsSet },
    get previewsEvicted() { return previewsEvicted },
    get storeCloses() { return storeCloses },
    get previewCacheEvictions() { return previewCacheEvictions },
  }
}

describe('start', () => {
  it('returns a watch failure instead of reporting the app ready', async () => {
    const h = build()
    vi.spyOn(h.capture, 'start').mockResolvedValue(err('E_AGENT_EXIT', 'watch failed'))
    const result = await h.app.start()
    expect(result).toEqual(err('E_AGENT_EXIT', 'watch failed'))
    expect(h.agentRequests.some((r) => r.method === 'hotkey.register')).toBe(false)
    await h.app.stop()
  })

  it('lets capture subscribe before the only watch.start request', async () => {
    const h = build()
    const captureStart = vi.spyOn(h.capture, 'start').mockImplementation(async () => {
      expect(h.agentRequests.filter((r) => r.method === 'watch.start')).toHaveLength(0)
      await h.agent.request('watch.start', { intervalMs: 500 })
      return ok({ intervalMs: 500 })
    })
    expect((await h.app.start()).ok).toBe(true)
    expect(captureStart).toHaveBeenCalledOnce()
    expect(h.agentRequests.filter((r) => r.method === 'watch.start')).toHaveLength(1)
    await h.app.stop()
  })

  it('starts the agent, starts capture, binds the configured hotkey and registers the IPC channels', async () => {
    const h = build()
    const r = await h.app.start()
    expect(r).toEqual({ ok: true, value: { accelerator: 'Cmd+Shift+V', hotkeyStatus: 'active' } })
    expect(h.captureCalls).toEqual(['start'])
    expect(h.agentRequests.map((q) => q.method)).toContain('hotkey.register')
    expect(h.registered.size).toBe(11)
  })

  it('tells the renderer the hotkey status', async () => {
    const h = build()
    await h.app.start()
    expect(h.sent).toContainEqual(['cairn:hotkey.status', { status: 'active', accelerator: 'Cmd+Shift+V' }])
  })

  it('a dead hotkey is reported as failed and start() still succeeds', async () => {
    // Spec §6: a failed bind is a product state, not a fatal error — the palette still works, and
    // the renderer shows a rebind row. Refusing to launch here would be worse than a dead hotkey.
    const h = build({ registerBound: false })
    const r = await h.app.start()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.hotkeyStatus).toBe('failed')
    expect(h.sent).toContainEqual(['cairn:hotkey.status', { status: 'failed', accelerator: 'Cmd+Shift+V' }])
  })

  it('does NOT bind before the user has answered the first-run hotkey step', async () => {
    const asked: readonly string[][] = []
    const h = build({
      firstRunDone: false,
      chooseHotkey: async (candidates) => { (asked as string[][]).push([...candidates]); return 'Cmd+Shift+C' },
    })
    const r = await h.app.start()
    expect(asked).toEqual([['Cmd+Shift+V', 'Cmd+Shift+C']])
    if (r.ok) expect(r.value.accelerator).toBe('Cmd+Shift+C')
    // The choice is persisted so the step never runs twice.
    expect(h.saved).toEqual([{ ...DEFAULT_CONFIG, accelerator: 'Cmd+Shift+C', firstRunHotkeyDone: true }])
  })

  it('does not ask again once the choice is recorded', async () => {
    const chooseHotkey = vi.fn(async () => 'Cmd+Shift+C')
    const h = build({ firstRunDone: true, chooseHotkey })
    await h.app.start()
    expect(chooseHotkey).not.toHaveBeenCalled()
    expect(h.saved).toEqual([])
  })

  // Regression. index.ts creates the palette window and loads the renderer BEFORE start() runs, and
  // the renderer's first act is history.list. IPC used to be registered at the END of start(), so
  // that call raced the agent, capture, and — on first run — a modal dialog that waits on a human.
  // It lost: "No handler registered for 'cairn:history.list'", and the palette opened empty.
  // The dialog is the worst case, so it is what this asserts: by the time anything can block
  // startup, every channel the renderer can call must already be answerable.
  it('registers every IPC channel before startup can block on the first-run dialog', async () => {
    let channelsWhenDialogOpened: string[] = []
    let agentStartedFirst = false
    const h = build({
      firstRunDone: false,
      chooseHotkey: async (candidates) => {
        channelsWhenDialogOpened = [...h.registered.keys()]
        agentStartedFirst = h.captureCalls.includes('start')
        return candidates[0]!
      },
    })
    await h.app.start()

    expect(channelsWhenDialogOpened).toContain('cairn:history.list')
    expect(channelsWhenDialogOpened).toHaveLength(11)
    // Sanity: the dialog really does open after the slow startup work, so the race was real and
    // this test would have caught it rather than passing for the wrong reason.
    expect(agentStartedFirst).toBe(true)
  })
})

describe('the hotkey → palette path', () => {
  it('explicit opening refreshes a visible palette instead of toggling it closed', async () => {
    const h = build()
    await h.app.start()
    h.app.showPalette()
    h.app.showPalette()
    expect(h.paletteCalls).toEqual(['show', 'show'])
    expect(h.sent.filter(([channel]) => channel === 'cairn:palette.shown')).toHaveLength(2)
  })

  it('shows the palette and tells the renderer when it was shown', async () => {
    const h = build()
    await h.app.start()
    h.fireHotkey()
    expect(h.paletteCalls).toEqual(['show'])
    expect(h.sent).toContainEqual(['cairn:palette.shown', { shownAt: 1_767_225_600_000 }])
  })

  it('a second press while visible hides the palette, so the hotkey is a toggle', async () => {
    const h = build()
    await h.app.start()
    h.fireHotkey()
    h.fireHotkey()
    expect(h.paletteCalls).toEqual(['show', 'hide'])
  })
})

describe('the history limit is a real setting', () => {
  // Before this, retention was configurable, validated — and completely inert. evictNow() had no
  // caller anywhere, so history grew without bound whatever config.json said, and an expired secret's
  // blob stayed on disk after the palette had stopped showing it.
  it('enforces the limit at startup, so a limit lowered while closed applies immediately', async () => {
    const h = build()
    await h.app.start()
    expect(h.evictNowCalls, 'startup must sweep once').toBeGreaterThanOrEqual(1)
  })

  it('enforces the limit on every ingest, the only moment the count can exceed it', async () => {
    const h = build()
    await h.app.start()
    const before = h.evictNowCalls
    for (const cb of h.candidateCbs) {
      cb({
        reps: [rep('text/plain', 'x')], kind: 'text', contentHash: HASH, primaryText: 'x',
        hints: [], sourceApp: null, thumbnailJpeg: null, changeToken: 'c', capturedAt: 1,
      })
    }
    await vi.waitFor(() => { expect(h.evictNowCalls).toBe(before + 1) })
  })

  it('persists a new limit, applies it at once, and tells the renderer', async () => {
    const h = build()
    await h.app.start()
    const sweepsBefore = h.evictNowCalls

    await h.app.setHistoryLimit(50)

    expect(h.app.historyLimit()).toBe(50)
    expect(h.maxItemsSet, 'history must be told, or the sweep uses the old limit').toEqual([50])
    expect(h.saved.at(-1)?.retention.maxItems, 'and it must survive a relaunch').toBe(50)
    expect(h.evictNowCalls, 'applied now, not at the next copy').toBe(sweepsBefore + 1)
    expect(h.sent.map(([c]) => c)).toContain('cairn:history.changed')
  })

  it('reports the configured limit, not a hard-coded default', async () => {
    const h = build()
    await h.app.start()
    expect(h.app.historyLimit()).toBe(500)
    await h.app.setHistoryLimit(2_000)
    expect(h.app.historyLimit()).toBe(2_000)
  })

  it('a failed sweep is logged and does not break the ingest that triggered it', async () => {
    const h = build({ failEviction: true })
    await h.app.start()
    for (const cb of h.candidateCbs) {
      cb({
        reps: [rep('text/plain', 'y')], kind: 'text', contentHash: HASH, primaryText: 'y',
        hints: [], sourceApp: null, thumbnailJpeg: null, changeToken: 'c2', capturedAt: 2,
      })
    }
    // The item still lands and the renderer is still told; only the sweep failed.
    await vi.waitFor(() => { expect(h.ingested).toHaveLength(1) })
  })
})

describe('previews come back after the preview cache is evicted', () => {
  // The reported bug: "yesterday's copies are not visible". The boundary was not the date, it was
  // the machine going to sleep. Spec §11 control 6 evicts every decrypted preview on sleep, lock and
  // five minutes idle, and evictPreviewCache() blanks them "until load() re-reads the encrypted
  // store" — but nothing called load() again. Rows rendered with empty previews and search() answered
  // NOTHING, until the app was restarted.
  it('re-reads the store when the palette opens with previews evicted', async () => {
    const h = build({ previewsEvicted: true, reloadedItems: 42 })
    await h.app.start()
    const loadsAfterStart = h.historyLoads

    h.app.togglePalette()
    // Waiting on the EVENT, not on the flag: the event is the observable contract, and it must land
    // after the reload. Waiting on the flag alone passes one microtask too early.
    await vi.waitFor(() => { expect(h.sent.map(([c]) => c)).toContain('cairn:palette.shown') })

    expect(h.previewsEvicted).toBe(false)
    expect(h.historyLoads, 'exactly one reload, not one per open').toBe(loadsAfterStart + 1)
  })

  it('does NOT re-read on every open — only when previews are actually evicted', async () => {
    const h = build()
    await h.app.start()
    const before = h.historyLoads
    h.app.togglePalette()
    expect(h.historyLoads).toBe(before)
    expect(h.sent.map(([c]) => c)).toContain('cairn:palette.shown')
  })

  it('restores previews on wake, mirroring the suspend that dropped them', async () => {
    const h = build()
    await h.app.start()
    h.powerHandlers.get('suspend')?.()
    expect(h.previewsEvicted).toBe(true)
    h.powerHandlers.get('resume')?.()
    await vi.waitFor(() => { expect(h.previewsEvicted).toBe(false) })
  })

  it('restores previews on unlock, mirroring the lock that dropped them', async () => {
    const h = build()
    await h.app.start()
    h.powerHandlers.get('lock-screen')?.()
    expect(h.previewsEvicted).toBe(true)
    h.powerHandlers.get('unlock-screen')?.()
    await vi.waitFor(() => { expect(h.previewsEvicted).toBe(false) })
  })

  it('does NOT try to decrypt after a passphrase-mode relock, where the key is gone', async () => {
    // In passphrase mode a screen lock also zero-fills the key, so load() could only fail. The user
    // has already been told why by the relock banner; a failed decrypt on top would be noise.
    const h = build({ keyringMode: 'passphrase' })
    await h.app.start()
    h.powerHandlers.get('lock-screen')?.()
    const before = h.historyLoads
    h.app.togglePalette()
    expect(h.historyLoads).toBe(before)
    expect(h.previewsEvicted).toBe(true)
  })
})

describe('the capture → history path', () => {
  it('ingests a candidate and tells the renderer the history changed', async () => {
    const h = build()
    await h.app.start()
    const candidate: Candidate = {
      reps: [rep('text/plain', 'hello world')],
      kind: 'text',
      contentHash: HASH,
      primaryText: 'hello world',
      hints: [],
      sourceApp: null,
      thumbnailJpeg: null,
      changeToken: '4710',
      capturedAt: 1_767_225_600_000,
    }
    for (const cb of h.candidateCbs) cb(candidate)
    // Waiting on the EVENT, not on `ingested`: the event is now sent after retention is enforced,
    // which is one more await away.
    await vi.waitFor(() => {
      expect(h.sent.some(([c]) => c === 'cairn:history.changed')).toBe(true)
    })
    expect(h.ingested).toHaveLength(1)
  })
})

describe('recallCopy — the M1 Enter path', () => {
  it('does not hide a newer opening when an earlier clipboard write finishes late', async () => {
    let finishWrite!: (value: ReturnType<typeof ok<{ changeToken: string }>>) => void
    const h = build({ writeResult: new Promise((resolve) => { finishWrite = resolve }) })
    await h.app.start()
    h.fireHotkey()
    const copying = h.app.recallCopy(ID)
    await Promise.resolve()
    h.fireHotkey()
    h.fireHotkey()
    finishWrite(ok({ changeToken: '4711' }))
    await copying

    expect(h.paletteCalls).toEqual(['show', 'hide', 'show'])
    expect(h.suppressed).toEqual(['4711'])
  })

  it('writes the reps to the real clipboard, suppresses our own write, hides and toasts', async () => {
    const h = build()
    await h.app.start()
    h.fireHotkey()
    const r = await h.app.recallCopy(ID)
    expect(r).toEqual({ ok: true, value: { result: 'copied-manual', reason: 'user-preference' } })

    const write = h.agentRequests.find((q) => q.method === 'write')
    expect(write).toBeDefined()
    expect(write!.params).toEqual({
      // `transient: false` on purpose: in M1 the USER presses Cmd+V afterwards, so the item has to
      // stay on the pasteboard. M2's auto-paste path writes transient:true because it consumes the
      // item itself one keystroke later.
      transient: false,
      reps: [{ mime: 'text/plain', uti: null, b64: Buffer.from('hello world').toString('base64') }],
    })
    // Self-write suppression by the token the agent returned, so we do not recapture our own write.
    expect(h.suppressed).toEqual(['4711'])
    expect(h.paletteCalls).toEqual(['show', 'hide'])
    expect(h.sent).toContainEqual(['cairn:toast', { text: TOAST_COPIED_MANUAL, tone: 'info' }])
    expect(TOAST_COPIED_MANUAL).toBe('Copied — press Cmd+V')
  })

  it('suppresses the token BEFORE the palette hides, so a fast poll cannot beat it', async () => {
    const h = build()
    await h.app.start()
    await h.app.recallCopy(ID)
    expect(h.suppressed).toEqual(['4711'])
  })

  it('surfaces a missing item instead of toasting a lie', async () => {
    // Drive the real failure: an item with no representations cannot be put on a clipboard.
    const empty = build({ reps: [] })
    await empty.app.start()
    const r = await empty.app.recallCopy(ID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_ITEM_NOT_FOUND')
    expect(empty.sent.some(([c]) => c === 'cairn:toast')).toBe(false)
  })
})

describe('previewText', () => {
  it('returns text/plain as-is', async () => {
    const h = build({ reps: [rep('text/plain', 'plain body')] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    expect(r).toEqual({ ok: true, value: { text: 'plain body', isHtmlSource: false, truncated: false } })
  })

  it('returns HTML as SOURCE, labelled, never as markup', async () => {
    const h = build({ reps: [rep('text/html', '<img src=x onerror="window.__pwned = true">')] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.text).toBe('<img src=x onerror="window.__pwned = true">')
      expect(r.value.isHtmlSource).toBe(true)
    }
  })

  it('prefers text/plain over text/html when both exist', async () => {
    const h = build({ reps: [rep('text/html', '<b>rich</b>'), rep('text/plain', 'rich')] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    if (r.ok) {
      expect(r.value.text).toBe('rich')
      expect(r.value.isHtmlSource).toBe(false)
    }
  })

  it('truncates at the schema ceiling and says so', async () => {
    const h = build({ reps: [rep('text/plain', 'x'.repeat(9_000))] })
    await h.app.start()
    const r = await h.app.previewText(ID)
    if (r.ok) {
      expect(r.value.text).toHaveLength(8_192)
      expect(r.value.truncated).toBe(true)
    }
  })

  it.each(['png', 'jpeg'] as const)('returns a valid %s only through explicit preview IPC without copying or closing', async (format) => {
    const source = readFileSync(fixturePath('formats', 'screenshot.png'))
    const bytes = format === 'png' ? source : await sharp(source).jpeg().toBuffer()
    const h = build({ reps: [rep(`image/${format}`, bytes)] })
    await h.app.start()
    expect(h.sent.some(([, payload]) => JSON.stringify(payload).includes('data:image/'))).toBe(false)
    const requestCount = h.agentRequests.length
    const reply = await h.registered.get('cairn:history.preview')!({}, { id: ID })
    expect(reply).toEqual({
      ok: true,
      value: {
        text: '', isHtmlSource: false, truncated: false,
        imageDataUrl: `data:image/${format};base64,${bytes.toString('base64')}`,
      },
    })
    expect(h.agentRequests).toHaveLength(requestCount)
    expect(h.paletteCalls).not.toContain('hide')
  })

  it.each(['text/plain', 'text/uri-list', 'text/html', 'text/rtf'])('preserves %s preference and its text cap when an image is also present', async (mime) => {
    const png = readFileSync(fixturePath('formats', 'screenshot.png'))
    const h = build({ reps: [rep('image/png', png), rep(mime, 'x'.repeat(9_000))] })
    expect(await h.app.previewText(ID)).toEqual({
      ok: true, value: { text: 'x'.repeat(8_192), isHtmlSource: mime === 'text/html', truncated: true },
    })
  })

  it.each([
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['image/gif', 'GIF89a'],
    ['image/tiff', 'synthetic TIFF'],
    ['image/png', '<svg/>'],
    ['image/jpeg', 'not a JPEG'],
  ])('omits unsupported or mislabeled %s bytes', async (mime, body) => {
    const h = build({ reps: [rep(mime, body)] })
    expect(await h.app.previewText(ID)).toEqual({
      ok: true, value: { text: '', isHtmlSource: false, truncated: false },
    })
  })

  it('bounds original image bytes at 8 MiB instead of trusting declared byteLength', async () => {
    const png = readFileSync(fixturePath('formats', 'screenshot.png'))
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1)
    png.copy(bytes)
    const oversized = { ...rep('image/png', bytes), byteLength: png.length }
    expect(await build({ reps: [oversized] }).app.previewText(ID)).toEqual({
      ok: true, value: { text: '', isHtmlSource: false, truncated: false },
    })
    const bounded = bytes.subarray(0, -1)
    const result = await build({ reps: [rep('image/png', bounded)] }).app.previewText(ID)
    expect(result.ok && result.value.imageDataUrl?.length).toBe('data:image/png;base64,'.length + Math.ceil(bounded.length / 3) * 4)
  })

  it('can use a supported JPEG when an earlier PNG cannot be previewed', async () => {
    const png = readFileSync(fixturePath('formats', 'screenshot.png'))
    const jpeg = await sharp(png).jpeg().toBuffer()
    const h = build({ reps: [rep('image/png', '<svg/>'), rep('image/jpeg', jpeg)] })
    expect(await h.app.previewText(ID)).toMatchObject({
      ok: true, value: { imageDataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
    })
  })
})

describe('preview cache eviction (spec §11 control 6)', () => {
  it.each(['lock', 'suspend', 'idle'] as const)('hides and scrubs the renderer on %s', async (reason) => {
    const h = build()
    await h.app.start()
    h.app.showPalette()
    h.sent.length = 0
    if (reason === 'idle') {
      h.setIdle(301)
      h.clock.advance(60_000)
    } else {
      h.powerHandlers.get(reason === 'lock' ? 'lock-screen' : 'suspend')!()
    }
    expect(h.palette.isVisible()).toBe(false)
    expect(h.previewsEvicted).toBe(true)
    expect(h.sent).toEqual([['cairn:palette.hidden', {}]])
    await h.app.stop()
  })

  it.each(['lock', 'suspend', 'idle'] as const)('sends a %s scrub even when the palette is already hidden', async (reason) => {
    const h = build()
    await h.app.start()
    h.sent.length = 0
    h.app.evictPreviewCache(reason)
    expect(h.paletteCalls).toEqual(['hide'])
    expect(h.palette.isVisible()).toBe(false)
    expect(h.sent).toEqual([['cairn:palette.hidden', {}]])
    await h.app.stop()
  })

  it('does not announce a pending opening after cache eviction cancels it', async () => {
    const h = build({ previewsEvicted: true })
    let finishReload!: (result: Awaited<ReturnType<History['load']>>) => void
    const reloading = new Promise<Awaited<ReturnType<History['load']>>>((resolve) => { finishReload = resolve })
    vi.spyOn(h.history, 'load').mockReturnValue(reloading)
    await h.app.start()
    h.sent.length = 0
    h.app.showPalette()
    h.app.evictPreviewCache('lock')
    finishReload(ok({ items: 1 }))
    await reloading
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(h.palette.isVisible()).toBe(false)
    expect(h.sent).toEqual([['cairn:palette.hidden', {}]])
    await h.app.stop()
  })

  it('evicts on screen lock', async () => {
    const h = build()
    await h.app.start()
    h.powerHandlers.get('lock-screen')!()
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('evicts on sleep', async () => {
    const h = build()
    await h.app.start()
    h.powerHandlers.get('suspend')!()
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('evicts after the idle timeout, on the injected clock', async () => {
    const h = build()
    await h.app.start()
    h.setIdle(60)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(0)   // one minute idle is not five
    h.setIdle(301)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('does not evict repeatedly while the user stays idle', async () => {
    const h = build()
    await h.app.start()
    h.setIdle(301)
    h.clock.advance(60_000)
    h.clock.advance(60_000)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(1)
  })

  it('re-arms after the user comes back', async () => {
    const h = build()
    await h.app.start()
    h.setIdle(301)
    h.clock.advance(60_000)
    h.setIdle(0)
    h.clock.advance(60_000)
    h.setIdle(301)
    h.clock.advance(60_000)
    expect(h.previewCacheEvictions).toBe(2)
  })

  it('subscribes to exactly the four macOS power events we handle', async () => {
    const h = build()
    await h.app.start()
    expect([...h.powerHandlers.keys()].sort()).toEqual(['lock-screen', 'resume', 'suspend', 'unlock-screen'])
  })
})

describe('re-locking on screen lock (spec §11 control 6, third clause)', () => {
  it('in passphrase mode a screen lock zeroes the master key, and unlock says so', async () => {
    // "in passphrase mode the store re-locks on screen lock and requires the passphrase again".
    // Evicting the preview cache is not enough: the master key itself must go.
    const h = build({ keyringMode: 'passphrase' })
    await h.app.start()
    h.powerHandlers.get('lock-screen')!()
    expect(h.previewCacheEvictions).toBe(1)
    expect(h.keyringLocked).toBe(1)
    h.powerHandlers.get('unlock-screen')!()
    expect(h.sent).toContainEqual(['cairn:toast', { text: KEYRING_RELOCKED_BANNER, tone: 'warn' }])
  })

  it('in os-keyring mode a screen lock does NOT zero the key, because the OS re-supplies it', async () => {
    const h = build({ keyringMode: 'os-keyring' })
    await h.app.start()
    h.powerHandlers.get('lock-screen')!()
    expect(h.previewCacheEvictions).toBe(1)
    expect(h.keyringLocked).toBe(0)
    h.powerHandlers.get('unlock-screen')!()
    expect(h.sent.some(([c, p]) => c === 'cairn:toast' && (p as { text: string }).text === KEYRING_RELOCKED_BANNER)).toBe(false)
  })
})

describe('securityStatus', () => {
  it('appends the keyring’s own honest backend notes and its warning', async () => {
    // Task 5 measures the backend and writes the sentence; this is the only path by which that
    // sentence reaches `cairn:security.status.notes`. A hard-coded list here would lie to a user
    // whose keyring is weak.
    const h = build({ keyringWarning: 'Your desktop has no secure keyring, so Cairn will not pretend to encrypt. Set a passphrase.' })
    await h.app.start()
    const s = h.app.securityStatus()
    expect(s.keyringMode).toBe('os-keyring')
    expect(s.dataDirMode).toBe('700')
    expect(s.notes[0]).toContain('AES-256-GCM')
    expect(s.notes).toContain(KEYCHAIN_NOTE)
    expect(s.notes[s.notes.length - 1]).toBe(
      'Your desktop has no secure keyring, so Cairn will not pretend to encrypt. Set a passphrase.',
    )
  })
})

describe('stop', () => {
  it('drains captured history writes before closing the store, including repeated stop callers', async () => {
    const h = build()
    let finishWrite!: (result: Awaited<ReturnType<History['ingest']>>) => void
    const write = new Promise<Awaited<ReturnType<History['ingest']>>>((resolve) => { finishWrite = resolve })
    vi.spyOn(h.history, 'ingest').mockReturnValue(write)
    await h.app.start()
    h.candidateCbs[0]!({
      reps: [rep('text/plain', 'pending copy')], kind: 'text', contentHash: HASH,
      primaryText: 'pending copy', hints: [], sourceApp: null, thumbnailJpeg: null,
      changeToken: 'pending', capturedAt: 1,
    })
    let firstDone = false
    let secondDone = false
    const first = h.app.stop().then(() => { firstDone = true })
    const second = h.app.stop().then(() => { secondDone = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(firstDone).toBe(false)
      expect(secondDone).toBe(false)
      expect(h.storeCloses).toBe(0)
      expect(h.keyringLocked).toBe(0)
    } finally {
      finishWrite(ok({ outcome: 'skipped', reason: 'synthetic' }))
      await Promise.all([first, second])
    }
    expect(h.storeCloses).toBe(1)
    expect(h.keyringLocked).toBe(1)
  })

  it('continues capturing after a failed history write and drains the next one', async () => {
    const h = build()
    const ingest = vi.spyOn(h.history, 'ingest')
      .mockRejectedValueOnce(new Error('synthetic failed write'))
      .mockResolvedValueOnce(ok({ outcome: 'skipped', reason: 'synthetic' }))
    await h.app.start()
    const candidate: Candidate = {
      reps: [rep('text/plain', 'next copy')], kind: 'text', contentHash: HASH,
      primaryText: 'next copy', hints: [], sourceApp: null, thumbnailJpeg: null,
      changeToken: 'next', capturedAt: 1,
    }
    h.candidateCbs[0]!(candidate)
    h.candidateCbs[0]!({ ...candidate, changeToken: 'after-error' })
    await h.app.stop()
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(h.storeCloses).toBe(1)
  })

  it('unbinds the hotkey, stops capture, disposes the agent and zeroes the master key', async () => {
    const h = build()
    await h.app.start()
    await h.app.stop()
    expect(h.agentRequests.map((q) => q.method)).toContain('hotkey.unregister')
    // 'whenIdle' is in this list because stop() AWAITS capture teardown: `stop()` is async in Task 7's
    // Capture, and whenIdle() is what guarantees no candidate is still mid-assembly when the store
    // closes. A fire-and-forget `capture.stop()` would leave a half-assembled rep holding clipboard
    // bytes in memory past the point the key is zeroed.
    expect(h.captureCalls).toEqual(['start', 'stop', 'whenIdle'])
    expect(h.keyringLocked).toBe(1)
    expect(h.registered.size).toBe(0)
  })

  it('closes the store so the derived blob name subkey is zeroed too, exactly once', async () => {
    // Task 6's store.close() zero-fills the derived blob name subkey. Without this call that subkey
    // stays live in a Buffer for the life of the process image — a tested-but-dead control.
    const h = build()
    await h.app.start()
    await h.app.stop()
    expect(h.storeCloses).toBe(1)
    await h.app.stop()
    expect(h.storeCloses).toBe(1)
  })

  it('is safe to call twice', async () => {
    const h = build()
    await h.app.start()
    await h.app.stop()
    await h.app.stop()
    expect(h.keyringLocked).toBe(1)
  })
})
