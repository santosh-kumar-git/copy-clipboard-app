import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_EVENT_CHANNELS, IPC_REQUEST_CHANNELS } from '@cairn/protocol'

const exposed: Record<string, unknown> = {}
const invokeCalls: [string, unknown][] = []
const onCalls: string[] = []
const removeCalls: string[] = []

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api },
  },
  ipcRenderer: {
    invoke: (channel: string, params: unknown) => {
      invokeCalls.push([channel, params])
      return Promise.resolve({ ok: true, value: {} })
    },
    on: (channel: string) => { onCalls.push(channel) },
    removeListener: (channel: string) => { removeCalls.push(channel) },
  },
}))

const loadPreload = async (): Promise<Record<string, unknown>> => {
  await import('./index')
  return exposed['cairn'] as Record<string, unknown>
}

beforeEach(() => { invokeCalls.length = 0; onCalls.length = 0; removeCalls.length = 0 })

describe('the exposed surface', () => {
  it('is bridged under exactly one global name', async () => {
    await loadPreload()
    expect(Object.keys(exposed)).toEqual(['cairn'])
  })

  it('exposes exactly the named operations', async () => {
    const api = await loadPreload()
    expect(Object.keys(api).sort()).toEqual([
      'close', 'createTab', 'removeTab', 'list', 'onHistoryChanged', 'onHotkeyStatus', 'onPaletteHidden', 'onPaletteShown', 'onToast',
      'paletteReady', 'pin', 'preview', 'remove', 'search', 'securityStatus', 'setTitle', 'tag',
    ].concat(['copy']).sort())
    expect(Object.keys(api)).toHaveLength(18)
  })

  it('exposes no generic bridge into the main process', async () => {
    const api = await loadPreload()
    for (const forbidden of ['invoke', 'send', 'sendSync', 'postMessage', 'on', 'emit', 'ipcRenderer', 'require', 'process']) {
      expect(api[forbidden]).toBeUndefined()
    }
  })

  it('every method is a function, so nothing is a settable data property', async () => {
    const api = await loadPreload()
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} must be a function`).toBe('function')
    }
  })
})

describe('channel hard-coding', () => {
  it('each request method sends its own frozen channel and nothing else', async () => {
    const api = await loadPreload() as Record<string, (p?: unknown) => Promise<unknown>>
    await api['list']!({ limit: 10, offset: 0 })
    await api['search']!({ q: 'a', limit: 10 })
    await api['preview']!({ id: '01KDVDNA00041061050R3GG28A' })
    await api['pin']!({ id: '01KDVDNA00041061050R3GG28A', pinned: true })
    await api['tag']!({ id: '01KDVDNA00041061050R3GG28A', tag: 'work', tagged: true })
    await api['createTab']!({ tag: 'work' })
    await api['removeTab']!({ tag: 'work' })
    await api['setTitle']!({ id: '01KDVDNA00041061050R3GG28A', title: 'Alias' })
    await api['remove']!({ id: '01KDVDNA00041061050R3GG28A' })
    await api['copy']!({ id: '01KDVDNA00041061050R3GG28A' })
    await api['close']!()
    await api['paletteReady']!({ shownAt: 1_767_225_600_000 })
    await api['securityStatus']!()
    expect(invokeCalls.map(([c]) => c)).toEqual([
      'cairn:history.list',
      'cairn:history.search',
      'cairn:history.preview',
      'cairn:history.pin',
      'cairn:history.tag',
      'cairn:tabs.create',
      'cairn:tabs.remove',
      'cairn:history.title',
      'cairn:history.remove',
      'cairn:recall.copy',
      'cairn:palette.close',
      'cairn:palette.ready',
      'cairn:security.status',
    ])
    // Every invocation must belong to the explicitly exposed request channels.
    expect(new Set(invokeCalls.map(([c]) => c))).toEqual(new Set(IPC_REQUEST_CHANNELS))
    expect(invokeCalls).toContainEqual(['cairn:history.title', { id: '01KDVDNA00041061050R3GG28A', title: 'Alias' }])
    expect(invokeCalls).toContainEqual(['cairn:palette.ready', { shownAt: 1_767_225_600_000 }])
  })

  it('the no-argument methods send an empty object, not undefined', async () => {
    const api = await loadPreload() as Record<string, () => Promise<unknown>>
    await api['close']!()
    await api['securityStatus']!()
    expect(invokeCalls).toEqual([
      ['cairn:palette.close', {}],
      ['cairn:security.status', {}],
    ])
  })

  it('each subscription method listens on its own frozen event channel and unsubscribes', async () => {
    const api = await loadPreload() as Record<string, (cb: (p: unknown) => void) => () => void>
    const unsubs = [
      api['onHistoryChanged']!(() => {}),
      api['onHotkeyStatus']!(() => {}),
      api['onToast']!(() => {}),
      api['onPaletteShown']!(() => {}),
      api['onPaletteHidden']!(() => {}),
    ]
    expect(onCalls).toEqual([...IPC_EVENT_CHANNELS])
    for (const u of unsubs) u()
    expect(removeCalls).toEqual([...IPC_EVENT_CHANNELS])
  })
})

describe('the preload source itself', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
    'utf8',
  )

  it('contains no dynamic channel plumbing', () => {
    for (const banned of [
      'ipcRenderer.send',
      'ipcRenderer.sendSync',
      'ipcRenderer.postMessage',
      'ipcRenderer.sendTo',
      'exposeInIsolatedWorld',
      'eval(',
      'new Function',
    ]) {
      expect(source, `preload must not contain ${banned}`).not.toContain(banned)
    }
  })

  it('never lets the page choose a channel name', () => {
    // The property that matters is that no channel reachable FROM THE PAGE is variable. Every one of
    // the exposed methods therefore names its channel as a quoted 'cairn:…' literal at its
    // own call site: the request methods pass it straight to ipcRenderer.invoke, and the five
    // event methods pass it to the local `subscribe` helper.
    const literals = [...source.matchAll(/(?:ipcRenderer\.invoke|subscribe)\(\s*('cairn:[a-z.]+')/g)]
    expect(literals).toHaveLength(18)

    // `subscribe` is the ONLY place an identifier may stand where a channel goes, and it is a local
    // function — never exposed — so the page cannot reach it to pick one. Assert both halves: the
    // variable uses are confined to it, and it is not on the bridge.
    const variableUses = [...source.matchAll(/ipcRenderer\.(?:invoke|on|removeListener)\(\s*([A-Za-z_$][\w$]*)/g)]
    expect(variableUses.map((m) => m[1])).toEqual(['channel', 'channel'])
    expect(source).toMatch(/^function subscribe\(/m)
    expect(source).not.toMatch(/\bsubscribe[,:]/)

    // And no channel is ever assembled rather than written out.
    expect(source).not.toMatch(/ipcRenderer\.(?:invoke|on|removeListener)\(\s*`/)
  })

  it('exposes exactly one main-world key', () => {
    expect([...source.matchAll(/exposeInMainWorld\(/g)]).toHaveLength(1)
  })
})
