import type { ItemKind, ResolvedRep } from '@cairn/protocol'

/**
 * Kind precedence, most specific first. Deliberately NOT the same list as PRIMARY_REP_ORDER: a
 * Finder copy also offers text/plain, so a primary-rep-derived kind would never say 'files'.
 */
export function classifyKind(reps: readonly ResolvedRep[]): ItemKind {
  if (reps.some((r) => r.mime === 'text/uri-list')) return 'files'
  if (reps.some((r) => r.mime.startsWith('image/'))) return 'image'
  if (reps.some((r) => r.mime === 'text/html' || r.mime === 'text/rtf')) return 'richtext'
  return 'text'
}

/** Frozen by contract §5.5: which representation's bytes are hashed into `Candidate.contentHash`. */
export const PRIMARY_REP_ORDER: readonly string[] = [
  'text/plain', 'text/uri-list', 'image/png', 'text/html', 'text/rtf',
]

export function selectPrimaryRep(reps: readonly ResolvedRep[]): ResolvedRep | null {
  if (reps.length === 0) return null
  for (const mime of PRIMARY_REP_ORDER) {
    const hit = reps.find((r) => r.mime === mime)
    if (hit !== undefined) return hit
  }
  return reps[0] ?? null
}
