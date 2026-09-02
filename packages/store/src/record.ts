import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { STORE_AAD_MAGIC, err, ok, type Result, type StoreEventKind } from '@cairn/protocol'

export const RECORD_KINDS = [
  'ITEM_ADDED',
  'ITEM_UPDATED',
  'ITEM_DELETED',
  'CHECKPOINT',
] as const satisfies readonly StoreEventKind[]

export const NONCE_BYTES = 12
export const TAG_BYTES = 16
/** Line 0 of every log generation is the anchor CHECKPOINT, sealed under this fixed AAD seq —
 *  the reader cannot know the generation's first seq before it has decrypted something. */
export const ANCHOR_AAD_SEQ = 0

/** `'cairn/store/v1' || u64be(lineIndex) || u64be(seq) || recordKind` (spec §4). */
export function recordAad(lineIndex: number, seq: number, kind: StoreEventKind): Buffer {
  const counters = Buffer.alloc(16)
  counters.writeBigUInt64BE(BigInt(lineIndex), 0)
  counters.writeBigUInt64BE(BigInt(seq), 8)
  return Buffer.concat([Buffer.from(STORE_AAD_MAGIC, 'utf8'), counters, Buffer.from(kind, 'utf8')])
}

export function sealRecord(args: {
  key: Buffer
  lineIndex: number
  seq: number
  kind: StoreEventKind
  payload: Uint8Array
}): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', args.key, nonce)
  cipher.setAAD(recordAad(args.lineIndex, args.seq, args.kind))
  const ct = Buffer.concat([cipher.update(args.payload), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64')
}

export function openRecord(args: {
  key: Buffer
  lineIndex: number
  seq: number
  kind: StoreEventKind
  line: string
}): Result<Buffer> {
  const raw = Buffer.from(args.line, 'base64')
  if (raw.length < NONCE_BYTES + TAG_BYTES) {
    return err('E_STORE_DECRYPT', `record at line ${args.lineIndex} is too short to be a record`)
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', args.key, raw.subarray(0, NONCE_BYTES))
    decipher.setAAD(recordAad(args.lineIndex, args.seq, args.kind))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    const head = decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES))
    return ok(Buffer.concat([head, decipher.final()]))
  } catch {
    return err('E_STORE_DECRYPT', `record at line ${args.lineIndex} failed to authenticate`)
  }
}

/**
 * The reader cannot know a record's kind before opening it, and the kind is in the AAD, so it
 * tries all four (microseconds each). This is not a hole: forging a GCM tag under a different AAD
 * is what is infeasible, and `log-store` additionally cross-checks the opened payload's own `kind`
 * against the kind it opened under.
 */
export function openRecordAnyKind(args: {
  key: Buffer
  lineIndex: number
  seq: number
  line: string
}): Result<{ kind: StoreEventKind; payload: Buffer }> {
  for (const kind of RECORD_KINDS) {
    const opened = openRecord({ ...args, kind })
    if (opened.ok) return ok({ kind, payload: opened.value })
  }
  return err(
    'E_STORE_DECRYPT',
    `record at line ${args.lineIndex} failed to authenticate under every record kind`,
  )
}
