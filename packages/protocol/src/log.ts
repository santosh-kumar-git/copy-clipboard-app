import type { AgentEventName, AgentMethod } from './agent'
import type { ErrorCode } from './result'
import type { AgentPlatform, DetectorName, Flag, ItemId, ItemKind, KeyringMode } from './types'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** The closed set of log message ids. A free-form string is a compile error, which is what
 *  stops `log.info('the user copied ' + text)`. Add ids here; never inline a message.
 *  The order is frozen: `log.test.ts` pins the count, and appending is the only legal edit. */
export const LOG_EVENTS = [
  'agent.spawning', 'agent.started', 'agent.exited', 'agent.restart-scheduled',
  'agent.request-timeout', 'agent.line-unparseable', 'agent.wire-major-mismatch',
  'rep.inline-received', 'rep.stream-begin', 'rep.stream-complete', 'rep.stream-aborted',
  'capture.candidate', 'capture.self-write-suppressed', 'capture.debounced', 'capture.thumbnail',
  'privacy.skipped', 'privacy.masked', 'privacy.sync-refused',
  'history.ingested', 'history.duplicate', 'history.evicted', 'history.pinned', 'history.removed',
  'store.opened', 'store.appended', 'store.compacted', 'store.torn-line-discarded',
  'store.blob-written',
  'keyring.mode', 'keyring.backend-refused', 'keyring.unlock-failed', 'keyring.zeroed',
  'hotkey.bound', 'hotkey.bind-failed', 'hotkey.fired',
  // The desktop shell's ids. The preview-cache eviction *reason* lives in the id rather than in
  // a field, because LogFields has no slot for it and inventing one would widen the
  // metadata-only type this whole control rests on.
  'renderer.navigation-blocked', 'renderer.permission-denied',
  'preview-cache.evicted-lock', 'preview-cache.evicted-suspend', 'preview-cache.evicted-idle',
  'config.loaded-default', 'config.saved',
  // `ipc.served` is debug-level and carries a count, never a value. Without it, the ABSENCE of an
  // `ipc.rejected` line is ambiguous between "the call succeeded" and "the renderer never made the
  // call at all" — which is exactly what made an empty palette impossible to diagnose from a log.
  'ipc.rejected', 'ipc.served', 'recall.copied', 'app.ready', 'app.quitting',
  'tray.ready', 'tray.icon-missing',
] as const
export type LogEvent = (typeof LOG_EVENTS)[number]

/**
 * Metadata only. Every value type is a primitive or an array of a closed string union, so there
 * is no field into which clipboard bytes or a preview could be placed even by accident.
 * DO NOT ADD an index signature and DO NOT widen a value type to `unknown`.
 */
export interface LogFields {
  readonly kind?: ItemKind
  readonly mime?: string
  readonly byteLength?: number
  readonly repCount?: number
  readonly seq?: number
  /** First 12 chars of a ContentHash, e.g. `sha256-LPJN`. Never the full hash of a short secret. */
  readonly hashPrefix?: string
  readonly itemId?: ItemId
  readonly flags?: readonly Flag[]
  readonly detectors?: readonly DetectorName[]
  readonly code?: ErrorCode
  readonly durationMs?: number
  readonly count?: number
  readonly agent?: AgentPlatform
  readonly method?: AgentMethod
  readonly event?: AgentEventName
  readonly bundleId?: string
  readonly mode?: KeyringMode
  readonly accelerator?: string
  readonly ok?: boolean
  readonly attempt?: number
  /**
   * ZOD ISSUE PATHS ONLY, e.g. `['items.3.preview']`. Field NAMES from a schema, which are source
   * constants, plus array indices. It exists because `ipc.rejected` previously carried only a code,
   * so a contract mismatch said "the handler returned a shape the contract does not allow" without
   * saying which field — undiagnosable from a user's log.
   * NEVER assign a parsed value, an error `message`, or anything derived from clipboard bytes: zod
   * puts the offending VALUE in `issue.message`, so pass `issue.path`, never the issue.
   */
  readonly paths?: readonly string[]
}

/** Collapses every key not in LogFields to `never`, so an extra key is a compile error. */
export type ExactLogFields<T> = LogFields & {
  readonly [K in Exclude<keyof T, keyof LogFields>]: never
}

export interface Logger {
  log<T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>): void
  debug<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  info<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  warn<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
  error<T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>): void
}
