import { describe, expect, expectTypeOf, it } from 'vitest'
import type { LogEvent, LogFields, Logger } from './log'

/**
 * SECURITY CONTROL (spec §11 control 2). The logger cannot be handed an item body: `LogFields`
 * is a closed set of metadata keys and `LogEvent` is a closed set of message ids, so putting
 * clipboard content into a log call is a COMPILE error rather than a code-review question.
 *
 * The six `@ts-expect-error` directives below are the test. `tsc` fails with
 * `TS2578: Unused '@ts-expect-error' directive` the moment any of them stops being an error.
 * Run `npm run typecheck` to execute this half of the file.
 */
const log: Logger = {
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// @ts-expect-error extra key `text` is not a LogFields key
log.info('history.ingested', { text: 'CANARY-SECRET' })
// @ts-expect-error extra key `body` is not a LogFields key
log.info('history.ingested', { kind: 'text', body: new Uint8Array([1, 2]) })
// @ts-expect-error `preview` is not a LogFields key
log.info('privacy.masked', { preview: 'AKIA...' })
// @ts-expect-error mime must be a string, not bytes
log.info('history.ingested', { mime: new Uint8Array([1]) })
// @ts-expect-error the event name is a closed union: no free-form message strings
log.info('the user copied ' + 'CANARY-SECRET')
// @ts-expect-error byteLength must be a number
log.info('history.ingested', { byteLength: 'CANARY-SECRET' })

describe('LogFields is metadata-only (spec §11 control 2)', () => {
  it('has no index signature, so an arbitrary key cannot be assigned', () => {
    expectTypeOf<LogFields>().not.toHaveProperty('text')
    expectTypeOf<LogFields>().not.toHaveProperty('preview')
    expectTypeOf<LogFields>().not.toHaveProperty('bytes')
    expectTypeOf<LogFields>().not.toHaveProperty('body')
  })

  it('exposes only primitives and closed string unions — no Uint8Array, Buffer or unknown', () => {
    expectTypeOf<LogFields['mime']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<LogFields['byteLength']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<LogFields['ok']>().toEqualTypeOf<boolean | undefined>()
  })

  it('LogEvent is a closed union, not string', () => {
    expectTypeOf<LogEvent>().not.toEqualTypeOf<string>()
    expectTypeOf<'history.ingested'>().toExtend<LogEvent>()
  })

  it('a real logger implementation only ever receives keys drawn from LogFields', () => {
    const seen: string[] = []
    const spy: Logger = {
      log: (_l, _e, f) => seen.push(...Object.keys(f ?? {})),
      debug: (e, f) => spy.log('debug', e, f),
      info: (e, f) => spy.log('info', e, f),
      warn: (e, f) => spy.log('warn', e, f),
      error: (e, f) => spy.log('error', e, f),
    }
    spy.info('history.ingested', { kind: 'text', byteLength: 11, hashPrefix: 'sha256-LPJN' })
    spy.warn('rep.stream-aborted', { code: 'E_REP_HASH_MISMATCH', repCount: 2 })
    expect(seen).toEqual(['kind', 'byteLength', 'hashPrefix', 'code', 'repCount'])
    expect(JSON.stringify(seen)).not.toContain('text')
  })
})
