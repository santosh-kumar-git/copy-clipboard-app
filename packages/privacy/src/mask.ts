import { maskToken, type MaskSpan } from '@cairn/protocol'
import { ALL_DETECTORS, detectSpans } from './detectors'

/**
 * Replaces every detected span with `maskToken` of the same text. `spans` are offsets into the RAW
 * input, so a caller can highlight what was masked without ever holding the raw value again.
 */
export function mask(text: string): { readonly preview: string; readonly spans: readonly MaskSpan[] } {
  const spans = detectSpans(text, ALL_DETECTORS)
  let preview = ''
  let cursor = 0
  for (const s of spans) {
    preview += text.slice(cursor, s.start) + maskToken(text.slice(s.start, s.end))
    cursor = s.end
  }
  preview += text.slice(cursor)
  return { preview, spans }
}
