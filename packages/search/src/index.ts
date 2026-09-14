import uFuzzy from '@leeoniya/ufuzzy'
import { SEARCH_INDEX_DEFAULT, SEARCH_INDEX_HARD_CAP, type ItemId } from '@cairn/protocol'

export interface SearchEntry {
  readonly id: ItemId
  /** ALREADY MASKED. `@cairn/history` masks at ingest, so a raw secret can never reach here. */
  readonly preview: string
  readonly pinned: boolean
  /** In at least one tab. Exempt from overflow eviction for the same reason `pinned` is. */
  readonly tagged: boolean
  readonly updatedAt: number
  /** The store `seq` of the item's ITEM_ADDED record: a restart-identical recency tiebreak. */
  readonly ord: number
}

export interface SearchHit {
  readonly id: ItemId
  /** 1 for the best hit, then 1/2, 1/3 … Display ordering only; never a relevance percentage. */
  readonly score: number
  /** Flat alternating [start, end) UTF-16 offsets into `preview`, exactly as ufuzzy emits them. */
  readonly ranges: readonly number[]
}

export interface SearchIndex {
  add(entry: SearchEntry): void
  remove(id: ItemId): boolean
  query(q: string, limit: number): readonly SearchHit[]
  clear(): void
  readonly size: number
  debugHaystack(): readonly string[]
}

/**
 * Every one of these four overrides was measured, and ufuzzy's defaults get each one wrong for a
 * clipboard palette:
 *  - intraIns: 0 by default, which means `wrhs` does NOT match `warehouse`.
 *  - intraChars: '[a-z\d]' by default, so a term cannot span a space; `hlwrd` misses `hello world`.
 *  - compare: an Intl.Collator by default, so equally-relevant rows sort ALPHABETICALLY. Returning
 *    0 makes ufuzzy's stable sort fall back to haystack order, which we keep as newest-first.
 */
export const UFUZZY_OPTIONS = {
  intraIns: Infinity,
  interIns: Infinity,
  intraChars: '[\\s\\S]',
  interChars: '[\\s\\S]',
  compare: () => 0,
} as const

const literalPattern = (text: string, flags = 'i'): RegExp =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)

function requiredLiterals(terms: readonly string[]): RegExp[] {
  return terms.flatMap((term) => {
    let contraction = ''
    const base = term.replace(/'[a-z]{1,2}\b/gi, (suffix) => {
      contraction = suffix
      return ''
    })
    if (base.startsWith('"')) return [literalPattern(base.slice(1, -1), 'ig')]
    const chars = base.split('')
    // uFuzzy requires the contraction suffix directly after the preceding character.
    if (contraction !== '') chars.push((chars.pop() ?? '') + contraction)
    return chars.map((char) => literalPattern(char, 'ig'))
  })
}

export function createSearchIndex(opts: { limit?: number } = {}): SearchIndex {
  const capacity = Math.min(opts.limit ?? SEARCH_INDEX_DEFAULT, SEARCH_INDEX_HARD_CAP)
  if (capacity < 1) throw new Error(`createSearchIndex: limit must be >= 1, got ${String(opts.limit)}`)
  const uf = new uFuzzy(UFUZZY_OPTIONS)
  const entries = new Map<ItemId, SearchEntry>()
  let ordered: SearchEntry[] = []
  let dirty = true

  const byRecency = (a: SearchEntry, b: SearchEntry): number => b.updatedAt - a.updatedAt || b.ord - a.ord

  function rebuild(): void {
    if (!dirty) return
    // Recency only. Pinned entries used to sort first, which put a pin from last week above the thing
    // you copied ten seconds ago and made the one list people read lie about time. `pinned` is still
    // read — by evictOverflow, where it means "never drop this", which is a promise rather than a
    // ranking. The Pinned tab is where "show me only these" lives now.
    ordered = [...entries.values()].sort(byRecency)
    dirty = false
  }

  function evictOverflow(): void {
    if (entries.size <= capacity) return
    // Oldest first: negate the newest-first comparator. Pinned and filed rows are exempt (spec §4),
    // and for the same reason retention exempts them: the user said this one matters.
    const unpinnedOldestFirst = [...entries.values()]
      .filter((en) => !en.pinned && !en.tagged)
      .sort((a, b) => -byRecency(a, b))
    let over = entries.size - capacity
    for (const en of unpinnedOldestFirst) {
      if (over <= 0) break
      entries.delete(en.id)
      over -= 1
    }
    dirty = true
  }

  return {
    add(entry) {
      entries.set(entry.id, entry)
      dirty = true
      evictOverflow()
    },
    remove(id) {
      const had = entries.delete(id)
      if (had) dirty = true
      return had
    },
    clear() {
      entries.clear()
      ordered = []
      dirty = false
    },
    get size() {
      return entries.size
    },
    debugHaystack() {
      rebuild()
      return ordered.map((en) => en.preview)
    },
    query(q, limit) {
      if (limit < 1) return []
      rebuild()
      if (ordered.length === 0) return []
      const rank = (list: readonly { id: ItemId; ranges: readonly number[] }[]): SearchHit[] =>
        list.slice(0, limit).map((h, i) => ({ id: h.id, score: 1 / (1 + i), ranges: h.ranges }))
      const needle = q.trim()
      if (needle === '') return rank(ordered.map((en) => ({ id: en.id, ranges: [] })))
      const haystack = ordered.map((en) => en.preview)
      // With our intraChars option, uFuzzy treats the entire exclusion suffix as one term.
      const suffix = /(?:\s+|^)-[\s\S]+/.exec(needle)
      const positive = suffix === null ? needle : needle.slice(0, suffix.index)
      const term = suffix?.[0].trim().slice(1) ?? ''
      const literal = term.startsWith('"') ? term.slice(1, -1) : term.replace(/\p{P}/gu, '')
      const excluded = literal === '' ? null : literalPattern(literal)
      const tokens = requiredLiterals(uf.split(positive))
      const candidates: number[] = []
      for (let i = 0; i < haystack.length; i++) {
        const text = haystack[i]!
        if (excluded?.test(text)) continue
        let cursor = 0
        // Literal scans are linear; the unlimited-gap regex can backtrack exponentially on misses.
        if (tokens.every((token) => {
          token.lastIndex = cursor
          if (token.exec(text) === null) return false
          cursor = token.lastIndex
          return true
        })) candidates.push(i)
      }
      if (tokens.length === 0) return rank(candidates.map((i) => ({ id: ordered[i]!.id, ranges: [] })))
      if (candidates.length === 0) return []
      const [idxs, info, order] = uf.search(haystack, positive, 0, undefined, candidates)
      if (idxs === null) return rank(ordered.map((en) => ({ id: en.id, ranges: [] })))
      if (info === null || order === null) {
        return rank(idxs.map((hi) => ({ id: ordered[hi]!.id, ranges: [] })))
      }
      return rank(order.map((oi) => ({ id: ordered[info.idx[oi]!]!.id, ranges: info.ranges[oi] ?? [] })))
    },
  }
}
