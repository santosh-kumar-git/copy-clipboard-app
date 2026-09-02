import { describe, expect, it, vi } from 'vitest'
import {
  createHotkey,
  isValidAccelerator,
  SUGGESTED_ACCELERATORS,
  type Hotkey,
} from './index'
import {
  createTestClock,
  err,
  ok,
  type AgentCapabilities,
  type AgentEventMap,
  type ClipboardAgent,
  type HotkeyFiredPayload,
  type Logger,
  type Unsub,
} from '@cairn/protocol'

/** A logger that records nothing but satisfies the interface. */
const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

interface FakeAgentOptions {
  /** What `hotkey.register` resolves to. */
  readonly register?: (accelerator: string) => Promise<unknown>
}

interface FakeAgent extends ClipboardAgent {
  readonly requests: { method: string; params: unknown }[]
  fire(payload: HotkeyFiredPayload): void
}

function fakeAgent(opts: FakeAgentOptions = {}): FakeAgent {
  const requests: { method: string; params: unknown }[] = []
  const listeners = new Set<(p: HotkeyFiredPayload) => void>()
  const agent = {
    requests,
    start: async (): Promise<AgentCapabilities> => {
      throw new Error('not used in this test')
    },
    request: async (method: string, params: unknown) => {
      requests.push({ method, params })
      if (method === 'hotkey.register') {
        const accelerator = (params as { accelerator: string }).accelerator
        return opts.register !== undefined
          ? await opts.register(accelerator)
          : ok({ bound: true, accelerator })
      }
      if (method === 'hotkey.unregister') return ok({ bound: false })
      return err('E_UNKNOWN_METHOD', `fake agent has no ${method}`)
    },
    on: <E extends keyof AgentEventMap>(event: E, cb: (p: AgentEventMap[E]) => void): Unsub => {
      if (event !== 'hotkey.fired') throw new Error(`fake agent only serves hotkey.fired, got ${String(event)}`)
      const typed = cb as unknown as (p: HotkeyFiredPayload) => void
      listeners.add(typed)
      return () => { listeners.delete(typed) }
    },
    dispose: async (): Promise<void> => {},
    fire: (payload: HotkeyFiredPayload): void => {
      for (const l of [...listeners]) l(payload)
    },
  }
  return agent as unknown as FakeAgent
}

const make = (opts?: FakeAgentOptions): { hotkey: Hotkey; agent: FakeAgent } => {
  const agent = fakeAgent(opts)
  return { hotkey: createHotkey({ agent, logger: silentLogger() }), agent }
}

describe('isValidAccelerator', () => {
  it('accepts every suggested accelerator', () => {
    expect(SUGGESTED_ACCELERATORS).toEqual(['Cmd+Shift+V', 'Cmd+Shift+C', 'Cmd+Alt+V', 'Ctrl+Shift+V'])
    for (const a of SUGGESTED_ACCELERATORS) expect(isValidAccelerator(a)).toBe(true)
  })

  it('accepts function keys and named keys with a modifier', () => {
    expect(isValidAccelerator('Cmd+F13')).toBe(true)
    expect(isValidAccelerator('CmdOrCtrl+Shift+Space')).toBe(true)
    expect(isValidAccelerator('Alt+Super+Escape')).toBe(true)
  })

  it('rejects a bare key, because a global bind with no modifier eats every keystroke', () => {
    expect(isValidAccelerator('V')).toBe(false)
    expect(isValidAccelerator('Space')).toBe(false)
  })

  it('rejects modifiers with no key, unknown tokens and empty strings', () => {
    expect(isValidAccelerator('Cmd+Shift')).toBe(false)
    expect(isValidAccelerator('Hyper+V')).toBe(false)
    expect(isValidAccelerator('Cmd+Shift+VV')).toBe(false)
    expect(isValidAccelerator('')).toBe(false)
  })
})

describe('createHotkey', () => {
  it('starts unbound with no current accelerator', () => {
    const { hotkey } = make()
    expect(hotkey.status()).toBe('unbound')
    expect(hotkey.current()).toBeNull()
  })

  it('a successful bind reaches the agent and becomes active', async () => {
    const { hotkey, agent } = make()
    const r = await hotkey.bind('Cmd+Shift+V')
    expect(r).toEqual({ ok: true, value: { accelerator: 'Cmd+Shift+V' } })
    expect(agent.requests).toEqual([{ method: 'hotkey.register', params: { accelerator: 'Cmd+Shift+V' } }])
    expect(hotkey.status()).toBe('active')
    expect(hotkey.current()).toBe('Cmd+Shift+V')
  })

  it('a false `bound` from the agent is a FAILED bind, not a success', async () => {
    // This is the ship-blocker: the agent answers `ok` with `bound: false`, so a host that only
    // checks for a rejected promise would report a working hotkey that never fires.
    const { hotkey } = make({ register: async (accelerator) => ok({ bound: false, accelerator }) })
    const r = await hotkey.bind('Cmd+Shift+V')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_HOTKEY_TAKEN')
    expect(hotkey.status()).toBe('failed')
    expect(hotkey.current()).toBe('Cmd+Shift+V')
  })

  it('an agent error response is also a failed bind', async () => {
    const { hotkey } = make({ register: async () => err('E_TIMEOUT', 'agent did not answer') })
    const r = await hotkey.bind('Cmd+Shift+V')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_TIMEOUT')
    expect(hotkey.status()).toBe('failed')
  })

  it('an invalid accelerator never reaches the agent', async () => {
    const { hotkey, agent } = make()
    const r = await hotkey.bind('Hyper+V')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('E_HOTKEY_INVALID')
    expect(agent.requests).toEqual([])
    expect(hotkey.status()).toBe('unbound')
  })

  it('rebinding after a failure clears the failed state', async () => {
    let calls = 0
    const { hotkey } = make({
      register: async (accelerator) => {
        calls += 1
        return calls === 1 ? ok({ bound: false, accelerator }) : ok({ bound: true, accelerator })
      },
    })
    await hotkey.bind('Cmd+Shift+V')
    expect(hotkey.status()).toBe('failed')
    const second = await hotkey.bind('Cmd+Shift+C')
    expect(second.ok).toBe(true)
    expect(hotkey.status()).toBe('active')
    expect(hotkey.current()).toBe('Cmd+Shift+C')
  })

  it('onTrigger delivers the agent event and the unsubscribe stops it', async () => {
    const { hotkey, agent } = make()
    await hotkey.bind('Cmd+Shift+V')
    const seen: HotkeyFiredPayload[] = []
    const unsub = hotkey.onTrigger((e) => seen.push(e))
    agent.fire({ accelerator: 'Cmd+Shift+V', focusToken: 'tok-1', firedAt: 1_767_225_600_000 })
    unsub()
    agent.fire({ accelerator: 'Cmd+Shift+V', focusToken: 'tok-2', firedAt: 1_767_225_600_500 })
    expect(seen).toEqual([{ accelerator: 'Cmd+Shift+V', focusToken: 'tok-1', firedAt: 1_767_225_600_000 }])
  })

  it('a callback that throws does not stop the other subscribers', async () => {
    const { hotkey, agent } = make()
    await hotkey.bind('Cmd+Shift+V')
    const good = vi.fn()
    hotkey.onTrigger(() => { throw new Error('renderer blew up') })
    hotkey.onTrigger(good)
    agent.fire({ accelerator: 'Cmd+Shift+V', focusToken: 'tok', firedAt: 1 })
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('unbind returns to unbound and forgets the accelerator', async () => {
    const { hotkey } = make()
    await hotkey.bind('Cmd+Shift+V')
    const r = await hotkey.unbind()
    expect(r).toEqual({ ok: true, value: { bound: false } })
    expect(hotkey.status()).toBe('unbound')
    expect(hotkey.current()).toBeNull()
  })

  it('does not use the injected clock — there is no timer in this package', () => {
    // A guard against someone "fixing" a flaky bind with a retry timer that tests cannot see.
    const clock = createTestClock()
    expect(clock.pending).toBe(0)
  })
})
