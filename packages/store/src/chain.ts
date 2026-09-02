import { contentHash, err, ok, type ContentHash, type Result } from '@cairn/protocol'

/** The hash every generation's line 0 declares as its `prev`. */
export const CHAIN_GENESIS: ContentHash = contentHash(Buffer.from('cairn/store/v1/genesis', 'utf8'))

/** h(i) = sha256(h(i-1) || sealedLine(i)). Hashed over the SEALED line, never over plaintext. */
export function chainNext(prev: ContentHash, sealedLine: string): ContentHash {
  return contentHash(Buffer.concat([Buffer.from(prev, 'utf8'), Buffer.from(sealedLine, 'utf8')]))
}

/** The tip after folding every line of a log in file order. */
export function chainTip(sealedLines: readonly string[]): ContentHash {
  let tip = CHAIN_GENESIS
  for (const line of sealedLines) tip = chainNext(tip, line)
  return tip
}

export interface ChainVerifier {
  /** Checks one record's declared `prev` against the running hash, then folds the line in. */
  check(lineIndex: number, sealedLine: string, prevRecordHash: ContentHash): Result<void>
  tip(): ContentHash
}

/**
 * Streaming chain check. This is what catches a record REPLACED by a different record that held
 * the same line index, seq and kind in an older state of the log — a rollback the AAD cannot see,
 * because every AAD field still matches. Without it, splicing yesterday's line 12 over today's
 * ITEM_DELETED resurrects a deleted secret.
 */
export function createChainVerifier(): ChainVerifier {
  let expected: ContentHash = CHAIN_GENESIS
  return {
    check(lineIndex, sealedLine, prevRecordHash) {
      if (prevRecordHash !== expected) {
        return err(
          'E_STORE_CHAIN_BROKEN',
          `chain broken at line ${lineIndex}: record declares prev ${prevRecordHash}, log hashes to ${expected}`,
        )
      }
      expected = chainNext(expected, sealedLine)
      return ok(undefined)
    },
    tip: () => expected,
  }
}
