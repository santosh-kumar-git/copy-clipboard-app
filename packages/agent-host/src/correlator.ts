import {
  AgentResultSchema,
  err,
  ERROR_CODES,
  ok,
  type AgentMethod,
  type AgentResponse,
  type Cancel,
  type Clock,
  type ErrorCode,
  type Logger,
  type Result,
} from '@cairn/protocol'
import * as z from 'zod'

interface Pending {
  readonly id: string
  readonly method: AgentMethod
  readonly startedAt: number
  readonly settle: (r: Result<unknown>) => void
  cancelTimeout: Cancel
}

export interface Correlator {
  /** Host-allocated decimal ids starting at "1" (contract §3). */
  nextId(): string
  /** Registers a pending request and returns the promise the caller awaits. */
  register<T>(id: string, method: AgentMethod, timeoutMs: number): Promise<Result<T>>
  /** Matches a parsed `res` line to its request and settles the caller. */
  settle(res: AgentResponse): void
  /** Settles one id with a failure — used for the wire-major refusal. */
  fail(id: string, code: ErrorCode, message: string): void
  /** Settles EVERY pending caller with a failure. No caller is ever left hanging. */
  failAll(code: ErrorCode, message: string): void
  readonly pending: number
}

export function createCorrelator(opts: { clock: Clock; logger: Logger }): Correlator {
  const { clock, logger } = opts
  const pending = new Map<string, Pending>()
  let counter = 0

  const take = (id: string): Pending | undefined => {
    const p = pending.get(id)
    if (p === undefined) return undefined
    p.cancelTimeout()
    pending.delete(id)
    return p
  }

  return {
    nextId(): string {
      counter += 1
      return String(counter)
    },

    register<T>(id: string, method: AgentMethod, timeoutMs: number): Promise<Result<T>> {
      return new Promise<Result<T>>((resolve) => {
        const entry: Pending = {
          id,
          method,
          startedAt: clock.now(),
          settle: (r) => resolve(r as Result<T>),
          cancelTimeout: () => {},
        }
        entry.cancelTimeout = clock.setTimeout(() => {
          // Delete FIRST so a late response cannot settle an already-timed-out caller, and so the
          // map cannot leak an entry per timed-out request.
          pending.delete(id)
          logger.warn('agent.request-timeout', { method, durationMs: timeoutMs })
          resolve(err('E_TIMEOUT', `agent request ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, entry)
      })
    },

    settle(res): void {
      const p = take(res.id)
      if (p === undefined) {
        // A response for an id we are not waiting on: already timed out, or an agent bug.
        logger.warn('agent.line-unparseable', { code: 'E_INTERNAL' })
        return
      }
      if (!res.ok) {
        const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(res.error.code)
          ? (res.error.code as ErrorCode)
          : 'E_INTERNAL'
        p.settle(err(code, res.error.message))
        return
      }
      // The wire schema types `result` as an open record; only the method knows its real shape.
      const parsed = AgentResultSchema[p.method].safeParse(res.result)
      if (!parsed.success) {
        p.settle(err('E_PARSE', `result for ${p.method} failed validation: ${z.prettifyError(parsed.error)}`))
        return
      }
      p.settle(ok(parsed.data))
    },

    fail(id, code, message): void {
      const p = take(id)
      if (p === undefined) return
      p.settle(err(code, message))
    },

    failAll(code, message): void {
      for (const id of [...pending.keys()]) {
        const p = take(id)
        p?.settle(err(code, message))
      }
    },

    get pending(): number {
      return pending.size
    },
  }
}
