import { readFileSync } from 'node:fs'
import { WIRE_MAJOR } from '@cairn/protocol'
import * as z from 'zod'

export const TranscriptMetaSchema = z.object({
  v: z.literal(WIRE_MAJOR),
  t: z.literal('meta'),
  transcript: z.string().min(1),
  recordedOn: z.string().min(1),
  /** Committed transcripts are synthetic. `false` is not a legal value in this repo. */
  synthetic: z.literal(true),
  note: z.string().default(''),
})

const LineSchema = z.record(z.string(), z.unknown())

export const TranscriptFrameSchema = z.discriminatedUnion('dir', [
  z.object({ dir: z.literal('in'), line: LineSchema }),
  z.object({ dir: z.literal('out'), delayMs: z.int().min(0).default(0), line: LineSchema }),
])

export type TranscriptMeta = z.output<typeof TranscriptMetaSchema>

export interface TranscriptFrame {
  readonly dir: 'in' | 'out'
  /** 1-based line number in the file, so a mismatch message can point at it. */
  readonly fileLine: number
  /** `out` only; the line is scheduled on the injected clock this far ahead. */
  readonly delayMs: number
  readonly line: Record<string, unknown>
}

export interface Transcript {
  readonly path: string
  readonly meta: TranscriptMeta
  readonly frames: readonly TranscriptFrame[]
}

/**
 * Parses a transcript. Throws: a malformed committed fixture is a broken invariant, not a runtime
 * state a caller could sensibly handle.
 */
export function parseTranscript(text: string, path: string): Transcript {
  const rawLines = text.split('\n')
  let meta: TranscriptMeta | null = null
  const frames: TranscriptFrame[] = []
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.trim()
    if (raw.length === 0) continue
    const fileLine = i + 1
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error(`Transcript ${path} line ${fileLine} is not valid JSON`)
    }
    if (meta === null) {
      const parsed = TranscriptMetaSchema.safeParse(json)
      if (!parsed.success) {
        throw new Error(
          `Transcript ${path} line ${fileLine} must be the meta line: ${z.prettifyError(parsed.error)}`,
        )
      }
      meta = parsed.data
      continue
    }
    const parsed = TranscriptFrameSchema.safeParse(json)
    if (!parsed.success) {
      throw new Error(
        `Transcript ${path} line ${fileLine} is not a frame: ${z.prettifyError(parsed.error)}`,
      )
    }
    frames.push({
      dir: parsed.data.dir,
      fileLine,
      delayMs: parsed.data.dir === 'out' ? parsed.data.delayMs : 0,
      line: parsed.data.line,
    })
  }
  if (meta === null) throw new Error(`Transcript ${path} is empty: line 1 must be the meta line`)
  return { path, meta, frames }
}

export function loadTranscript(path: string): Transcript {
  return parseTranscript(readFileSync(path, 'utf8'), path)
}
