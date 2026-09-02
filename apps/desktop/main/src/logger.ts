import {
  systemClock,
  type Clock,
  type ExactLogFields,
  type LogEvent,
  type LogFields,
  type Logger,
  type LogLevel,
} from '@cairn/protocol'

/**
 * The runtime half of spec §11 control 2. `@cairn/protocol`'s `ExactLogFields` already makes an
 * extra key a compile error; this list makes it a *dropped* key at runtime, so a `@ts-expect-error`,
 * a plain-JS caller or a future refactor still cannot get a clipboard body onto stderr.
 * Keep it in sync with `LogFields` in `packages/protocol/src/log.ts`.
 */
export const LOG_FIELD_KEYS: readonly string[] = [
  'ts', 'level', 'event',
  'kind', 'mime', 'byteLength', 'repCount', 'seq', 'hashPrefix', 'itemId', 'flags', 'detectors',
  'code', 'durationMs', 'count', 'agent', 'method', 'bundleId', 'mode', 'accelerator', 'ok',
  'attempt',
]

const ALLOWED = new Set(LOG_FIELD_KEYS)
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Primitives and arrays-of-strings only. Anything else is dropped rather than stringified,
 *  because `String(buffer)` is exactly how bytes end up in a log file. */
function sanitiseValue(value: unknown): string | number | boolean | null | string[] | undefined {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value as string | boolean
  if (t === 'number') return Number.isFinite(value as number) ? (value as number) : undefined
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  return undefined
}

export interface StderrLoggerOptions {
  /** Injected so tests capture lines instead of polluting the run's stderr. */
  readonly write?: (line: string) => void
  readonly clock?: Clock
  readonly minLevel?: LogLevel
}

export function createStderrLogger(opts: StderrLoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => { process.stderr.write(line) })
  const clock = opts.clock ?? systemClock
  const minLevel = LEVEL_ORDER[opts.minLevel ?? 'debug']

  const emit = (level: LogLevel, event: LogEvent, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < minLevel) return
    const line: Record<string, unknown> = { ts: clock.now(), level, event }
    for (const [key, raw] of Object.entries(fields ?? {})) {
      if (!ALLOWED.has(key)) continue
      const value = sanitiseValue(raw)
      if (value !== undefined) line[key] = value
    }
    write(JSON.stringify(line) + '\n')
  }

  return {
    log: <T extends LogFields>(level: LogLevel, event: LogEvent, fields?: ExactLogFields<T>) =>
      emit(level, event, fields as Record<string, unknown> | undefined),
    debug: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('debug', event, fields as Record<string, unknown> | undefined),
    info: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('info', event, fields as Record<string, unknown> | undefined),
    warn: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('warn', event, fields as Record<string, unknown> | undefined),
    error: <T extends LogFields>(event: LogEvent, fields?: ExactLogFields<T>) =>
      emit('error', event, fields as Record<string, unknown> | undefined),
  }
}
