import type { Classification, Flag, PasteboardHint, PrivacyRules, Snapshot } from '@cairn/protocol'
import { ALL_DETECTORS, detectSpans } from './detectors'

export const DEFAULT_RULES: PrivacyRules = {
  detectors: ALL_DETECTORS,
  honourHints: true,
  excludedBundleIds: [],          // always [] in M1; M2 fills this from the exclusion UI
}

/**
 * Hints that mean "do not record at all". `concealed` is the macOS
 * `org.nspasteboard.ConcealedType` convention every password manager sets; `password-manager` is
 * KDE's `x-kde-passwordManagerHint: secret` (spec §4, Tier C). Both are honoured, both fail closed.
 */
export const SKIP_HINTS: readonly PasteboardHint[] = ['concealed', 'password-manager']

/** Layer 1 on its own, so a caller can decide before reading, converting or thumbnailing a byte. */
export function shouldSkipOnHints(hints: readonly PasteboardHint[], rules: PrivacyRules): boolean {
  if (!rules.honourHints) return false
  return hints.some((h) => SKIP_HINTS.includes(h))
}

export function classify(snapshot: Snapshot, rules: PrivacyRules): Classification {
  // Layer 1: OS hints. Short-circuits before anything looks at bytes.
  if (shouldSkipOnHints(snapshot.hints, rules)) {
    return { action: 'skip', flags: ['concealed'], reason: 'os-hint' }
  }
  const flags: Flag[] = []
  for (const h of snapshot.hints) {
    if (h === 'transient') flags.push('transient')
    if (h === 'auto-generated') flags.push('auto-generated')
  }
  // Layer 2: app exclusion list. Inert in M1, and fails CLOSED when a rule is active and the
  // owner is unknowable — source-app attribution is a heuristic on every OS (spec §10).
  if (rules.excludedBundleIds.length > 0) {
    const bundleId = snapshot.sourceApp?.bundleId ?? null
    if (bundleId === null) return { action: 'skip', flags: ['excluded'], reason: 'owner-unknown-fail-closed' }
    if (rules.excludedBundleIds.includes(bundleId)) {
      return { action: 'skip', flags: ['excluded'], reason: 'excluded-app' }
    }
  }
  // Layer 3: detectors. A secret is RECORDED and flagged, not dropped: a masked, TTL'd,
  // unpinnable, unsyncable row is more useful than a hole in the history (contract §5.7).
  const text = snapshot.primaryText
  if (text !== null && text !== '') {
    const spans = detectSpans(text, rules.detectors)
    if (spans.length > 0) {
      const names = [...new Set(spans.map((s) => s.detector))].join(',')
      return { action: 'record', flags: [...flags, 'secret'], reason: `detectors:${names}` }
    }
  }
  return { action: 'record', flags, reason: 'clean' }
}
