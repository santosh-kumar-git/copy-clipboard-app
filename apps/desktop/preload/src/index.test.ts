import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The preload↔renderer SEAM. Nothing covered it, and that is how the whole palette shipped broken:
 * main answers with `Result<T>` (`{ ok, value }`), `CairnBridge` declares the unwrapped `T`, and
 * `ipcRenderer.invoke` is typed `Promise<any>` — so passing the wrapper through type-checked, every
 * renderer call got `undefined` where it wanted data, and the palette read "Cairn could not read its
 * history" while the main process logged `ipc.served count:31`.
 *
 * The existing security test's mock already returned `{ ok: true, value: {} }`, so the shape was
 * known; what was missing was any assertion about what the bridge does with it.
 */
const exposed: Record<string, unknown> = {}
let nextResult: unknown = { ok: true, value: {} }

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api },
  },
  ipcRenderer: {
    invoke: () => Promise.resolve(nextResult),
    on: () => {},
    removeListener: () => {},
  },
}))

type Bridge = Record<string, (p?: unknown) => Promise<unknown>>

const loadPreload = async (): Promise<Bridge> => {
  vi.resetModules()
  await import('./index')
  return exposed['cairn'] as Bridge
}

/** The eight request methods, with an argument each where one is taken. */
const CALLS: readonly [string, unknown][] = [
  ['list', { limit: 32, offset: 0, pinnedOnly: false }],
  ['search', { q: 'x', limit: 50 }],
  ['preview', { id: 'i' }],
  ['pin', { id: 'i', pinned: true }],
  ['remove', { id: 'i' }],
  ['copy', { id: 'i' }],
  ['close', undefined],
  ['securityStatus', undefined],
]

beforeEach(() => { nextResult = { ok: true, value: {} } })

describe('the bridge unwraps the main process Result', () => {
  it('resolves with `value`, not the wrapper, for every request method', async () => {
    const api = await loadPreload()
    for (const [name, params] of CALLS) {
      const sentinel = { items: [{ id: name }], total: 1 }
      nextResult = { ok: true, value: sentinel }
      // Identity, deliberately: the boundary must not clone, re-wrap or reshape the payload.
      expect(await api[name]!(params), `${name} must resolve the unwrapped value`).toBe(sentinel)
    }
  })

  it('is what the renderer needs: `(await list()).items` is the array, not undefined', async () => {
    // The exact expression that threw in the palette. `[...res.items]` is what set the error text.
    nextResult = { ok: true, value: { items: [{ id: 'a' }, { id: 'b' }], total: 2 } }
    const api = await loadPreload()
    const res = (await api['list']!({ limit: 32, offset: 0, pinnedOnly: false })) as {
      items: unknown[]
      total: number
    }
    expect(res.items).toHaveLength(2)
    expect([...res.items]).toHaveLength(2)
    expect(res.total).toBe(2)
  })

  it('REJECTS on ok:false for every request method, because the renderer uses try/catch', async () => {
    const api = await loadPreload()
    for (const [name, params] of CALLS) {
      nextResult = { ok: false, code: 'E_ITEM_NOT_FOUND', message: 'no such item' }
      await expect(api[name]!(params), `${name} must reject`).rejects.toThrow('E_ITEM_NOT_FOUND')
    }
  })

  it('rejects with the CODE only, never the Err message', async () => {
    // `Err.message` can be a prettified zod dump containing the offending value, which for these
    // schemas can be a clipboard preview. A renderer exception can reach a devtools console, so the
    // message must stay in the main process, where it is already logged.
    nextResult = {
      ok: false,
      code: 'E_IPC_REJECTED',
      message: 'invalid input: expected string, received "AKIA-CANARY-SECRET-VALUE"',
    }
    const api = await loadPreload()
    const error = await api['list']!({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('E_IPC_REJECTED')
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('AKIA')
  })

  it('rejects with E_INTERNAL when the reply is not a Result at all', async () => {
    const api = await loadPreload()
    for (const bad of [undefined, null, 'a string', 42, { items: [] }, { ok: 'true', value: 1 }]) {
      nextResult = bad
      await expect(api['list']!({}), `reply ${JSON.stringify(bad)} must reject`).rejects.toThrow(
        'E_INTERNAL',
      )
    }
  })

  it('passes a falsy `value` through rather than treating it as a failure', async () => {
    // `ok === true` is the only thing that decides success. A handler legitimately answering with
    // false/0/null must not be turned into a rejection.
    const api = await loadPreload()
    for (const value of [false, 0, null, '']) {
      nextResult = { ok: true, value }
      expect(await api['list']!({})).toBe(value)
    }
  })
})
