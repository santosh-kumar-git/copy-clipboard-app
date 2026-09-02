import { createHash } from 'node:crypto'
import type { ContentHash } from './types'

/** `sha256-<43 char base64url>`. Hashed over RAW representation bytes, never over JSON. */
export function contentHash(bytes: Uint8Array): ContentHash {
  return ('sha256-' + createHash('sha256').update(bytes).digest('base64url')) as ContentHash
}
