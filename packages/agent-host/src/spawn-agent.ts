import { spawn, type ChildProcess } from 'node:child_process'
import {
  AGENT_REQUEST_TIMEOUT_MS,
  err,
  ok,
  parseAgentLine,
  WIRE_MAJOR,
  type AgentCapabilities,
  type AgentEventMap,
  type AgentMethod,
  type AgentParams,
  type AgentPlatform,
  type AgentResult,
  type ClipboardAgent,
  type Clock,
  type ErrorCode,
  type Logger,
  type Result,
  type Unsub,
} from '@cairn/protocol'
import { createCorrelator, type Correlator } from './correlator'
import { createLineSplitter } from './framing'
import { createChangeAssembler } from './reassembler'

/** Sent as `hello.params.hostVersion`. */
export const HOST_VERSION = '0.1.0'
/** Restart delays in ms. After the last one the host gives up (contract §5.4). */
export const RESTART_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000] as const
export const DEFAULT_MAX_RESTARTS = 5
/** Unparseable stdout lines in a row before the child is considered wedged (contract §3 rule 7). */
export const MAX_CONSECUTIVE_PARSE_FAILURES = 10

export interface AgentCore {
  /** Feed raw stdout bytes. */
  handleBytes(chunk: Uint8Array): void
  /** Feed one already-split NDJSON line. */
  handleLine(line: string): void
  request<M extends AgentMethod>(
    method: M,
    params: AgentParams<M>,
    timeoutMs?: number,
  ): Promise<Result<AgentResult<M>>>
  on<E extends keyof AgentEventMap>(event: E, cb: (payload: AgentEventMap[E]) => void): Unsub
  hello(timeoutMs?: number): Promise<Result<AgentCapabilities>>
  failAllPending(code: ErrorCode, message: string): void
  abortStreams(code: ErrorCode): void
  resetFraming(): void
  /** What to re-send after a restart, so a crash does not silently stop the watch. */
  readonly lastWatchIntervalMs: number | null
  readonly lastAccelerator: string | null
  readonly pendingRequests: number
  readonly openRepStreams: number
}

export function createAgentCore(opts: {
  clock: Clock
  logger: Logger
  /** Writes one `\n`-terminated line, or returns why it could not. */
  send: (line: string) => Result<void>
  /** The wire is unusable: the transport must replace or fail the child. */
  onFatal: (code: ErrorCode) => void
}): AgentCore {
  const { clock, logger, send } = opts
  const correlator: Correlator = createCorrelator({ clock, logger })
  const listeners: { [E in keyof AgentEventMap]: Set<(p: AgentEventMap[E]) => void> } = {
    'clipboard.changed': new Set(),
    'rep.chunk': new Set(),
    'hotkey.fired': new Set(),
    log: new Set(),
  }

  const emit = <E extends keyof AgentEventMap>(event: E, payload: AgentEventMap[E]): void => {
    for (const cb of [...listeners[event]]) cb(payload)
  }

  const changes = createChangeAssembler({
    clock,
    logger,
    emit: (payload) => emit('clipboard.changed', payload),
  })

  let consecutiveParseFailures = 0
  let lastWatchIntervalMs: number | null = null
  let lastAccelerator: string | null = null

  const splitter = createLineSplitter({
    onLine: (line) => core.handleLine(line),
    onOverflow: (droppedBytes) => {
      logger.error('agent.line-unparseable', { code: 'E_LINE_TOO_LONG', byteLength: droppedBytes })
    },
  })

  const core: AgentCore = {
    handleBytes(chunk): void {
      splitter.push(chunk)
    },

    handleLine(line): void {
      const parsed = parseAgentLine(line)
      if (!parsed.ok) {
        consecutiveParseFailures += 1
        logger.warn('agent.line-unparseable', { code: parsed.code, count: consecutiveParseFailures })
        return
      }
      consecutiveParseFailures = 0
      const l = parsed.value
      if (l.t === 'req') {
        // The agent never asks the host for anything in M1.
        logger.warn('agent.line-unparseable', { code: 'E_UNKNOWN_METHOD', method: l.method })
        return
      }
      if (l.t === 'res') {
        correlator.settle(l)
        return
      }
      switch (l.event) {
        case 'clipboard.changed':
          changes.handleChanged(l.data)
          return
        case 'rep.chunk':
          // The payload we hand listeners carries NO bytes — just enough to draw a progress row.
          emit('rep.chunk', { repId: l.data.repId, seq: l.data.seq, final: l.data.final })
          changes.handleChunk(l.data)
          return
        case 'hotkey.fired':
          logger.info('hotkey.fired', { accelerator: l.data.accelerator })
          emit('hotkey.fired', l.data)
          return
        case 'log':
          // `fields` is dropped on purpose: the agent is not trusted to keep clipboard content out.
          emit('log', { level: l.data.level, event: l.data.event })
          return
      }
    },

    async request<M extends AgentMethod>(
      method: M,
      params: AgentParams<M>,
      timeoutMs = AGENT_REQUEST_TIMEOUT_MS,
    ): Promise<Result<AgentResult<M>>> {
      const id = correlator.nextId()
      const line = JSON.stringify({ v: WIRE_MAJOR, t: 'req', id, method, params }) + '\n'
      const promise = correlator.register<AgentResult<M>>(id, method, timeoutMs)
      const written = send(line)
      if (!written.ok) {
        correlator.fail(id, written.code, written.message)
        return promise
      }
      if (method === 'watch.start') {
        lastWatchIntervalMs = (params as AgentParams<'watch.start'>).intervalMs
      } else if (method === 'watch.stop') {
        lastWatchIntervalMs = null
      } else if (method === 'hotkey.register') {
        lastAccelerator = (params as AgentParams<'hotkey.register'>).accelerator
      } else if (method === 'hotkey.unregister') {
        lastAccelerator = null
      }
      return promise
    },

    on(event, cb): Unsub {
      const set = listeners[event] as Set<(p: AgentEventMap[typeof event]) => void>
      set.add(cb)
      return () => {
        set.delete(cb)
      }
    },

    hello(timeoutMs = AGENT_REQUEST_TIMEOUT_MS): Promise<Result<AgentCapabilities>> {
      return core.request('hello', { hostVersion: HOST_VERSION }, timeoutMs)
    },

    failAllPending(code, message): void {
      correlator.failAll(code, message)
    },

    abortStreams(code): void {
      changes.abortAll(code)
    },

    resetFraming(): void {
      splitter.reset()
      consecutiveParseFailures = 0
    },

    get lastWatchIntervalMs(): number | null {
      return lastWatchIntervalMs
    },
    get lastAccelerator(): string | null {
      return lastAccelerator
    },
    get pendingRequests(): number {
      return correlator.pending
    },
    get openRepStreams(): number {
      return changes.openStreams
    },
  }

  return core
}

export interface SpawnAgentOptions {
  platform: AgentPlatform
  binPath: string
  clock: Clock
  logger: Logger
  maxRestarts?: number
  /**
   * argv for the child. Empty for the real Swift binary; the tests use it to run a Node stand-in
   * agent as `process.execPath -e <source>`, which is how the spawn path is exercised without
   * writing an executable to disk.
   */
  args?: readonly string[]
}

export function spawnAgent(opts: SpawnAgentOptions): ClipboardAgent {
  const { platform, binPath, clock, logger } = opts
  const args = [...(opts.args ?? [])]

  let child: ChildProcess | null = null
  let disposed = false
  let failed = false

  const send = (line: string): Result<void> => {
    if (disposed) return err('E_AGENT_DISPOSED', 'agent has been disposed')
    if (failed) return err('E_AGENT_EXIT', 'agent is not running')
    const stdin = child?.stdin
    if (child === null || stdin === null || stdin === undefined || !stdin.writable) {
      return err('E_AGENT_EXIT', 'agent is not running')
    }
    stdin.write(line)
    return ok(undefined)
  }

  const core = createAgentCore({
    clock,
    logger,
    send,
    onFatal: () => {
      // Given a fatal wire error the child is replaced; wired in Steps 41 and 45.
    },
  })

  const killChild = (): void => {
    const c = child
    if (c === null) return
    child = null
    c.kill('SIGTERM')
  }

  const spawnChild = (): void => {
    logger.info('agent.spawning', { agent: platform })
    // `spawn` with an argv ARRAY and no shell option: spec §11 control 3 wants no shell anywhere in
    // the capture or recall path. `binPath` and `args` are never interpolated into a command string,
    // so a pasteboard-derived path can never become shell syntax.
    const c = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    c.stdout?.on('data', (b: Buffer) => core.handleBytes(b))
    // Drained and discarded on purpose: we cannot prove the agent kept clipboard content out of its
    // human-readable stderr, so it is never copied into our log. Draining stops the pipe filling.
    c.stderr?.resume()
    c.on('error', (e: Error) => {
      child = null
      failed = true
      logger.error('agent.exited', { code: 'E_AGENT_SPAWN' })
      core.failAllPending('E_AGENT_SPAWN', `could not spawn ${binPath}: ${e.message}`)
    })
    c.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      child = null
      logger.warn('agent.exited', { code: 'E_AGENT_EXIT', ok: code === 0 })
      // Everything in flight is definitively over: no caller waits on a dead process.
      core.abortStreams('E_REP_TIMEOUT')
      core.failAllPending('E_AGENT_EXIT', `agent exited (code ${String(code)}, signal ${String(signal)})`)
      core.resetFraming()
    })
    child = c
  }

  return {
    async start(): Promise<AgentCapabilities> {
      if (disposed) throw new Error('cairn: agent has been disposed')
      spawnChild()
      const r = await core.hello()
      if (!r.ok) {
        failed = true
        killChild()
        throw new Error(
          `cairn: refusing to start the ${platform} agent — hello failed (${r.code}): ${r.message}`,
        )
      }
      logger.info('agent.started', { agent: platform })
      return r.value
    },

    request(method, params, timeoutMs) {
      return core.request(method, params, timeoutMs)
    },

    on(event, cb) {
      return core.on(event, cb)
    },

    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      core.abortStreams('E_REP_TIMEOUT')
      const c = child
      if (c !== null) {
        const closed = new Promise<void>((resolve) => c.once('close', () => resolve()))
        // Courtesy first so a real agent can unregister its Carbon hotkey, then SIGTERM so dispose
        // can never hang: the agent holds no unflushed state, so there is nothing to lose.
        if (c.stdin?.writable === true) {
          c.stdin.write(JSON.stringify({ v: WIRE_MAJOR, t: 'req', id: '0', method: 'shutdown', params: {} }) + '\n')
        }
        child = null
        c.kill('SIGTERM')
        await closed
      }
      core.failAllPending('E_AGENT_DISPOSED', 'agent disposed')
      logger.info('app.quitting', { agent: platform })
    },
  }
}
