import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { contentHash, type BlobId, type Clock, type Item, type ItemId, type Logger } from '@cairn/protocol'

/** A fresh directory that is removed on cleanup. Never reused between tests. */
export function tempStoreDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A random 32-byte master key: the store takes a key as an argument precisely so every test
 *  runs on a machine with no keychain and no compiler (spec §4). */
export function randomTestKey(): Buffer {
  return randomBytes(32)
}

export const silentLogger: Logger = {
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** The store never needs timers, only `now()`. 2026-01-01T00:00:00Z by default. */
export function fixedClock(startMs = 1_767_225_600_000): Clock {
  return { now: () => startMs, setTimeout: () => () => {} }
}

/** A deterministic 26-char Crockford base32 item id, so fixtures are reproducible. */
export const testItemId = (n: number): ItemId =>
  `0000000000000000000000000${n}`.slice(-26).toUpperCase() as ItemId

/** A minimal text `Item` with one representation, pointing at an already-stored blob. These two
 *  live here rather than in a `*.test.ts` file because importing one test file from another makes
 *  vitest collect the imported file's `describe` blocks twice. */
export function itemFixture(id: ItemId, blobId: BlobId, text: string): Item {
  const hash = contentHash(Buffer.from(text, 'utf8'))
  return {
    id,
    kind: 'text',
    contentHash: hash,
    preview: text,
    previewTruncated: false,
    maskSpans: [],
    flags: [],
    repRefs: [
      { mime: 'text/plain', uti: 'public.utf8-plain-text', byteLength: text.length, sha256: hash, blobId },
    ],
    thumbnailBlobId: null,
    sourceApp: null,
    byteLength: text.length,
    createdAt: 1_767_225_600_000,
    updatedAt: 1_767_225_600_000,
    pinned: false,
    expiresAt: null,
  }
}
