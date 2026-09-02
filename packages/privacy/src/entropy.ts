export const ENTROPY_MIN_RUN = 20
export const ENTROPY_MAX_RUN = 512
export const ENTROPY_BITS_PER_CHAR = 4.0

const TOKEN_RE = /^[A-Za-z0-9+/_=.-]{20,512}$/
const URLISH_RE = /^[a-z][a-z0-9+.-]*:/i          // http:, https:, data:, file:, mailto:
const CODEISH_RE = /[(){}\[\];,<>"'`|\\!@#$%^&*?~]/

export function shannonBits(s: string): number {
  const freq = new Map<string, number>()
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** Returns [start, end) offsets of every high-entropy token-shaped run. */
export function highEntropyRuns(text: string): readonly { start: number; end: number }[] {
  const hits: { start: number; end: number }[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const run = m[0].replace(/[.,;:!?)\]}'"]+$/, '')     // strip sentence punctuation
    if (run.length < ENTROPY_MIN_RUN || run.length > ENTROPY_MAX_RUN) continue
    if (URLISH_RE.test(run)) continue                     // a URL or data: URL is not a secret
    if (run.startsWith('/') || run.startsWith('./') || run.startsWith('../') || run.startsWith('~/')) continue
    if (CODEISH_RE.test(run)) continue                    // code, not a bare token
    if (!TOKEN_RE.test(run)) continue
    if (shannonBits(run) > ENTROPY_BITS_PER_CHAR) hits.push({ start: m.index, end: m.index + run.length })
  }
  return hits
}
