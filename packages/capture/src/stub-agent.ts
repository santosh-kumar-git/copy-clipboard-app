import {
  ok,
  type AgentEventMap, type AgentMethod, type ClipboardAgent,
  type ClipboardChangedPayload, type Result,
} from '@cairn/protocol'

export interface StubAgent extends ClipboardAgent {
  emitChanged(p: ClipboardChangedPayload): void
  readonly requests: readonly { method: AgentMethod; params: Record<string, unknown> }[]
  /** What the next `write` request will report back as its changeToken. */
  nextChangeToken: string
}

export function createStubAgent(): StubAgent {
  const cbs = new Set<(p: ClipboardChangedPayload) => void>()
  const requests: { method: AgentMethod; params: Record<string, unknown> }[] = []
  const self = {
    requests,
    nextChangeToken: '999',
    async start() { return {} },
    async request(method: AgentMethod, params: Record<string, unknown>): Promise<Result<Record<string, unknown>>> {
      requests.push({ method, params })
      if (method === 'write') return ok({ changeToken: self.nextChangeToken })
      if (method === 'watch.start') return ok({ watching: true, intervalMs: 500 })
      return ok({})
    },
    on(event: keyof AgentEventMap, cb: (p: never) => void) {
      if (event !== 'clipboard.changed') return () => {}
      const fn = cb as unknown as (p: ClipboardChangedPayload) => void
      cbs.add(fn)
      return () => { cbs.delete(fn) }
    },
    async dispose() { cbs.clear() },
    emitChanged(p: ClipboardChangedPayload) { for (const cb of [...cbs]) cb(p) },
  } as unknown as StubAgent
  return self
}
