import type { DetectorName, MaskSpan } from '@cairn/protocol'
import { highEntropyRuns } from './entropy'

export const ALL_DETECTORS: readonly DetectorName[] = [
  'pem-private-key', 'aws-access-key', 'github-token', 'openai-key', 'anthropic-key',
  'slack-token', 'stripe-live-key', 'google-api-key', 'jwt', 'high-entropy',
]

const PATTERNS: readonly (readonly [DetectorName, RegExp])[] = [
  ['pem-private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{12,20}\b/g],
  ['github-token', /\b(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['openai-key', /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
]

/** Every span a detector claims, merged so no two overlap. Offsets are into the RAW text. */
export function detectSpans(text: string, enabled: readonly DetectorName[]): readonly MaskSpan[] {
  const spans: MaskSpan[] = []
  for (const [name, re] of PATTERNS) {
    if (!enabled.includes(name)) continue
    re.lastIndex = 0                                   // these RegExps are module-level and sticky
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, detector: name })
      if (m[0].length === 0) re.lastIndex += 1
    }
  }
  if (enabled.includes('high-entropy')) {
    for (const r of highEntropyRuns(text)) spans.push({ start: r.start, end: r.end, detector: 'high-entropy' })
  }
  return mergeSpans(spans)
}

/** Union of overlapping spans; a named detector always wins the label over 'high-entropy'. */
export function mergeSpans(spans: readonly MaskSpan[]): readonly MaskSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: MaskSpan[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && s.start < last.end) {
      out[out.length - 1] = {
        start: last.start,
        end: Math.max(last.end, s.end),
        detector: last.detector !== 'high-entropy' ? last.detector : s.detector,
      }
    } else out.push(s)
  }
  return out
}
