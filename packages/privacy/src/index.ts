export { ENTROPY_BITS_PER_CHAR, ENTROPY_MAX_RUN, ENTROPY_MIN_RUN, highEntropyRuns, shannonBits } from './entropy'
export { ALL_DETECTORS, detectSpans, mergeSpans } from './detectors'
export { mask } from './mask'
// No `type Classification` / `type PrivacyRules` here: both live in `@cairn/protocol` (contract
// §5.7). Re-exporting them from this barrel would give consumers two import paths for one shape.
export { DEFAULT_RULES, SKIP_HINTS, classify, shouldSkipOnHints } from './classify'
export { isPinnable, secretExpiresAt } from './retention-policy'
export { assertSyncable } from './assert-syncable'
