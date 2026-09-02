import { describe, expect, it } from 'vitest'
import {
  err,
  IPC_REQUEST_CHANNELS,
  ok,
  type Item,
  type ItemId,
  type Logger,
  type ResolvedRep,
  type Result,
  type ScoredItem,
  type Unsub,
} from '@cairn/protocol'
import type { ChangeReason } from '@cairn/history'
import type { History } from '@cairn/history'
import {
  registerIpcHandlers,
  sendIpcEvent,
  toItemSummary,
  type IpcMainLike,
} from './ipc-handlers'

const ID_A = '01KDVDNA00041061050R3GG28A' as ItemId
const ID_B = '01KDVDNA011440E1G50G1G4080' as ItemId

const silentLogger = (): { logger: Logger; events: string[] } => {
  const events: string[] = []
  const rec = (level: string) => (event: string) => { events.push(`${level}:${event}`) }
  return {
    events,
    logger: {
      log: (level: string, event: string) => { events.push(`${level}:${event}`) },
      debug: rec('debug'),
      info: rec('info'),
      warn: rec('warn'),
      error: rec('error'),
    } as unknown as Logger,
  }
}

const item = (over: Partial<Item> = {}): Item => ({
  id: ID_A,
  kind: 'text',
  contentHash: 'sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ' as Item['contentHash'],
  preview: 'AKIA••••A7QD',
  previewTruncated: false,
  maskSpans: [{ start: 0, end: 17, detector: 'aws-access-key' }],
  flags: ['secret'],
  repRefs: [],
  thumbnailBlobId: null,
  sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
  byteLength: 17,
  createdAt: 1_767_225_600_000,
  updatedAt: 1_767_225_600_000,
  pinned: false,
  expiresAt: 1_767_225_900_000,
  ...over,
})

interface FakeIpc extends IpcMainLike {
  readonly registered: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>
  call(channel: string, params?: unknown): Promise<unknown>
}

function fakeIpcMain(): FakeIpc {
  const registered = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  return {
    registered,
    handle(channel, listener) {
      if (registered.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      registered.set(channel, listener)
    },
    removeHandler(channel) { registered.delete(channel) },
    async call(channel, params) {
      const h = registered.get(channel)
      if (h === undefined) throw new Error(`no handler for ${channel}`)
      return await h({}, params)
    },
  }
}

interface Harness {
  readonly ipc: FakeIpc
  readonly events: string[]
  readonly domainCalls: string[]
  readonly unregister: Unsub
}

function harness(over: { historyItems?: readonly Item[] } = {}): Harness {
  const ipc = fakeIpcMain()
  const { logger, events } = silentLogger()
  const domainCalls: string[] = []
  const items = over.historyItems ?? [item()]

  const history = {
    load: async () => ok({ items: items.length }),
    ingest: async () => { throw new Error('not used') },
    list: (q?: { limit?: number; offset?: number; pinnedOnly?: boolean }) => {
      domainCalls.push(`list ${JSON.stringify(q)}`)
      return { items, total: items.length }
    },
    search: (q: string, limit: number): readonly ScoredItem[] => {
      domainCalls.push(`search ${q} ${limit}`)
      return items.map((it) => ({ item: it, score: 1, ranges: [0, 4] }))
    },
    resolveReps: async (): Promise<Result<readonly ResolvedRep[]>> => ok([]),
    pin: async (id: ItemId, pinned: boolean) => {
      domainCalls.push(`pin ${id} ${pinned}`)
      return items[0]!.flags.includes('secret')
        ? err('E_PIN_REFUSED_SECRET', 'secret-flagged items cannot be pinned')
        : ok({ pinned })
    },
    remove: async (id: ItemId) => { domainCalls.push(`remove ${id}`); return ok({ removed: true }) },
    evictNow: async () => ok({ evicted: 0 }),
    evictPreviewCache: () => {},
    get: (id: ItemId) => items.find((it) => it.id === id),
    onChange: (_cb: (e: { reason: ChangeReason; total: number }) => void): Unsub => () => {},
  } as unknown as History

  const unregister = registerIpcHandlers({
    ipcMain: ipc,
    history,
    preview: {
      preview: async (id: ItemId) => {
        domainCalls.push(`preview ${id}`)
        return ok({ text: '<b>hi</b>', isHtmlSource: true, truncated: false })
      },
    },
    recall: {
      copy: async (id: ItemId) => {
        domainCalls.push(`copy ${id}`)
        return ok({ result: 'copied-manual' as const, reason: 'user-preference' as const })
      },
    },
    palette: { hide: () => { domainCalls.push('hide') }, isVisible: () => true },
    security: {
      status: () => ({
        keyringMode: 'os-keyring' as const,
        encryptedAtRest: true,
        dataDirMode: '700',
        notes: ['Encryption at rest protects against disk theft and other accounts, not against code running as you.'],
      }),
    },
    logger,
  })

  return { ipc, events, domainCalls, unregister }
}

describe('registration', () => {
  it('registers exactly the eight frozen request channels', () => {
    const h = harness()
    expect([...h.ipc.registered.keys()].sort()).toEqual([...IPC_REQUEST_CHANNELS].sort())
  })

  it('registers nothing the renderer could use to reach a body or the store', () => {
    const h = harness()
    for (const forbidden of [
      'cairn:history.resolveReps',
      'cairn:store.readAll',
      'cairn:keyring.masterKey',
      'cairn:agent.request',
      'cairn:history.list ',
      'history.list',
    ]) {
      expect(h.ipc.registered.has(forbidden)).toBe(false)
    }
  })

  it('the unregister function removes every handler', () => {
    const h = harness()
    h.unregister()
    expect(h.ipc.registered.size).toBe(0)
  })

  it('registering twice over the same ipcMain throws instead of silently shadowing', () => {
    // Matches Electron's real behaviour: "Attempted to register a second handler for '…'".
    const h = harness()
    expect(() => registerIpcHandlers({
      ipcMain: h.ipc,
      history: {} as unknown as History,
      preview: { preview: async () => ok({ text: '', isHtmlSource: false, truncated: false }) },
      recall: { copy: async () => ok({ result: 'copied-manual' as const, reason: 'user-preference' as const }) },
      palette: { hide: () => {}, isVisible: () => false },
      security: { status: () => ({ keyringMode: 'locked' as const, encryptedAtRest: false, dataDirMode: '700', notes: [] }) },
      logger: silentLogger().logger,
    })).toThrow(/second handler/)
  })
})

describe('params validation — a malformed renderer message is rejected, not trusted', () => {
  it('rejects an over-range limit before any domain call happens', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.list', { limit: 9999, offset: 0 })
    expect(reply).toEqual({
      ok: false,
      code: 'E_IPC_REJECTED',
      message: '✖ Too big: expected number to be <=200\n  → at limit',
    })
    expect(h.domainCalls).toEqual([])
    expect(h.events).toContain('warn:ipc.rejected')
  })

  it('rejects a missing params object', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.list', undefined) as { ok: boolean; code?: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_IPC_REJECTED')
    expect(h.domainCalls).toEqual([])
  })

  it('rejects a non-object payload, including an array and a string', async () => {
    const h = harness()
    for (const bad of [[], 'x', 42, null, true]) {
      const reply = await h.ipc.call('cairn:history.search', bad) as { ok: boolean; code?: string }
      expect(reply.ok).toBe(false)
      expect(reply.code).toBe('E_IPC_REJECTED')
    }
    expect(h.domainCalls).toEqual([])
  })

  it('rejects a malformed ItemId rather than passing it to the store', async () => {
    const h = harness()
    for (const bad of ['', 'not-an-id', '01kdvdna00041061050r3gg28a', '../../etc/passwd']) {
      const reply = await h.ipc.call('cairn:history.preview', { id: bad }) as { ok: boolean; code?: string }
      expect(reply.ok).toBe(false)
      expect(reply.code).toBe('E_IPC_REJECTED')
    }
    expect(h.domainCalls).toEqual([])
  })

  it('strips extra keys instead of forwarding them', async () => {
    const h = harness()
    await h.ipc.call('cairn:history.list', { limit: 5, offset: 0, __proto__: { polluted: true }, extra: 'x' })
    expect(h.domainCalls).toEqual(['list {"limit":5,"offset":0,"pinnedOnly":false}'])
  })

  it('applies the schema default for pinnedOnly', async () => {
    const h = harness()
    await h.ipc.call('cairn:history.list', { limit: 3, offset: 0 })
    expect(h.domainCalls).toEqual(['list {"limit":3,"offset":0,"pinnedOnly":false}'])
  })
})

describe('the happy paths', () => {
  it('list returns validated ItemSummary rows with no repRefs and no raw secret', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.list', { limit: 10, offset: 0 }) as
      { ok: true; value: { items: Record<string, unknown>[]; total: number } }
    expect(reply.ok).toBe(true)
    expect(reply.value.total).toBe(1)
    const row = reply.value.items[0]!
    expect(row['preview']).toBe('AKIA••••A7QD')
    expect(row['maskedSpanCount']).toBe(1)
    expect(row['sourceAppName']).toBe('TextEdit')
    expect(row['repRefs']).toBeUndefined()
    expect(row['contentHash']).toBeUndefined()
    expect(row['maskSpans']).toBeUndefined()
  })

  it('search forwards the query and returns flat ufuzzy ranges', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.search', { q: 'aki', limit: 25 }) as
      { ok: true; value: { results: { score: number; ranges: number[] }[] } }
    expect(h.domainCalls).toEqual(['search aki 25'])
    expect(reply.value.results[0]!.ranges).toEqual([0, 4])
  })

  it('preview labels HTML as source and never as markup', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.preview', { id: ID_A }) as
      { ok: true; value: { text: string; isHtmlSource: boolean } }
    expect(reply.value).toEqual({ text: '<b>hi</b>', isHtmlSource: true, truncated: false })
  })

  it('pin surfaces E_PIN_REFUSED_SECRET instead of pretending it worked', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.pin', { id: ID_A, pinned: true }) as
      { ok: false; code: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_PIN_REFUSED_SECRET')
  })

  it('recall.copy returns the M2-shaped copied-manual result', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:recall.copy', { id: ID_A })
    expect(reply).toEqual({ ok: true, value: { result: 'copied-manual', reason: 'user-preference' } })
    expect(h.domainCalls).toEqual([`copy ${ID_A}`])
  })

  it('palette.close hides the window and accepts an empty object', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:palette.close', {})
    expect(reply).toEqual({ ok: true, value: { closed: true } })
    expect(h.domainCalls).toEqual(['hide'])
  })

  it('security.status reports the honest at-rest sentence', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:security.status', {}) as
      { ok: true; value: { keyringMode: string; dataDirMode: string; notes: string[] } }
    expect(reply.value.keyringMode).toBe('os-keyring')
    expect(reply.value.dataDirMode).toBe('700')
    expect(reply.value.notes[0]).toContain('not against code running as you')
  })

  it('remove passes the validated id through', async () => {
    const h = harness()
    const reply = await h.ipc.call('cairn:history.remove', { id: ID_B })
    expect(reply).toEqual({ ok: true, value: { removed: true } })
    expect(h.domainCalls).toEqual([`remove ${ID_B}`])
  })
})

describe('result validation — the outbound direction', () => {
  it('a handler returning the wrong shape becomes E_INTERNAL, never a raw object', async () => {
    const ipc = fakeIpcMain()
    const { logger, events } = silentLogger()
    registerIpcHandlers({
      ipcMain: ipc,
      history: {} as unknown as History,
      preview: { preview: async () => ok({ text: '', isHtmlSource: false, truncated: false }) },
      recall: { copy: async () => ok({ result: 'copied-manual' as const, reason: 'user-preference' as const }) },
      // A deliberately broken port: `closed: false` violates `z.literal(true)`.
      palette: { hide: () => {}, isVisible: () => false },
      security: {
        status: () => ({ keyringMode: 'nonsense', encryptedAtRest: true, dataDirMode: '700', notes: [] }) as never,
      },
      logger,
    })
    const reply = await ipc.call('cairn:security.status', {}) as { ok: boolean; code?: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_INTERNAL')
    expect(events).toContain('error:ipc.rejected')
  })

  it('a handler that throws becomes E_INTERNAL rather than an unhandled rejection', async () => {
    const ipc = fakeIpcMain()
    const { logger } = silentLogger()
    registerIpcHandlers({
      ipcMain: ipc,
      history: {} as unknown as History,
      preview: { preview: async () => { throw new Error('boom') } },
      recall: { copy: async () => ok({ result: 'copied-manual' as const, reason: 'user-preference' as const }) },
      palette: { hide: () => {}, isVisible: () => false },
      security: { status: () => ({ keyringMode: 'locked' as const, encryptedAtRest: false, dataDirMode: '700', notes: [] }) },
      logger,
    })
    const reply = await ipc.call('cairn:history.preview', { id: ID_A }) as { ok: boolean; code?: string; message?: string }
    expect(reply.ok).toBe(false)
    expect(reply.code).toBe('E_INTERNAL')
    expect(reply.message).not.toContain('boom')
  })
})

describe('toItemSummary', () => {
  it('drops repRefs, contentHash, updatedAt and the mask span offsets', () => {
    const summary = toItemSummary(item(), null) as unknown as Record<string, unknown>
    expect(Object.keys(summary).sort()).toEqual([
      'byteLength', 'createdAt', 'expiresAt', 'flags', 'id', 'kind', 'maskedSpanCount', 'pinned',
      'preview', 'previewTruncated', 'sourceAppName', 'thumbnailDataUrl',
    ])
  })

  it('carries a thumbnail as a data URL when one is supplied', () => {
    const summary = toItemSummary(item({ kind: 'image' }), 'data:image/jpeg;base64,/9j/AAA')
    expect(summary.thumbnailDataUrl).toBe('data:image/jpeg;base64,/9j/AAA')
  })
})

describe('sendIpcEvent', () => {
  it('validates the payload before it reaches the renderer', () => {
    const sent: [string, unknown][] = []
    const target = { send: (c: string, p: unknown) => { sent.push([c, p]) }, isDestroyed: () => false }
    const { logger, events } = silentLogger()
    expect(sendIpcEvent(target, 'cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' }, logger)).toBe(true)
    expect(sent).toEqual([['cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' }]])
    expect(sendIpcEvent(target, 'cairn:toast', { text: 'x', tone: 'shouty' }, logger)).toBe(false)
    expect(sent).toHaveLength(1)
    expect(events).toContain('error:ipc.rejected')
  })

  it('is a no-op for a destroyed target', () => {
    const sent: [string, unknown][] = []
    const target = { send: (c: string, p: unknown) => { sent.push([c, p]) }, isDestroyed: () => true }
    expect(sendIpcEvent(target, 'cairn:palette.shown', { shownAt: 1 }, silentLogger().logger)).toBe(false)
    expect(sent).toEqual([])
  })
})
