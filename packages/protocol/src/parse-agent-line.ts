import * as z from 'zod'
import { AgentLineSchema, type AgentLine } from './agent'
import { MAX_LINE_BYTES } from './constants'
import { err, ok, type Result } from './result'

/** Parses one NDJSON line. Never throws. Unknown keys are stripped, not rejected. */
export function parseAgentLine(line: string): Result<AgentLine> {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return err('E_LINE_TOO_LONG', `line exceeds ${MAX_LINE_BYTES} bytes`)
  }
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return err('E_PARSE', 'line is not valid JSON')
  }
  if (typeof json === 'object' && json !== null && 'v' in json && (json as { v: unknown }).v !== 1) {
    return err('E_WIRE_MAJOR', `unsupported wire major ${String((json as { v: unknown }).v)}`)
  }
  const parsed = AgentLineSchema.safeParse(json)
  if (!parsed.success) return err('E_PARSE', z.prettifyError(parsed.error))
  return ok(parsed.data)
}
