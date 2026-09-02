import type { ItemId } from './types'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Deterministic given (nowMs, rnd) so tests are reproducible. `rnd` must be exactly 10 bytes. */
export function newItemId(nowMs: number, rnd: Uint8Array): ItemId {
  if (rnd.length !== 10) throw new Error(`newItemId needs exactly 10 random bytes, got ${rnd.length}`)
  let ts = ''
  let n = BigInt(nowMs)
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[Number(n % 32n)]! + ts
    n /= 32n
  }
  let bits = 0
  let acc = 0
  let rand = ''
  for (const byte of rnd) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rand += CROCKFORD[(acc >> bits) & 31]!
    }
  }
  return (ts + rand.slice(0, 16)) as ItemId
}
