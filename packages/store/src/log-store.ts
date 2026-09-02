import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, statSync } from 'node:fs'
import {
  err,
  ok,
  type BlobId,
  type Clock,
  type ContentHash,
  type DeleteReason,
  type Item,
  type ItemId,
  type ItemPatch,
  type Logger,
  type Result,
  type StoreEvent,
  type StoreEventKind,
} from '@cairn/protocol'
import { CHAIN_GENESIS, chainNext, chainTip } from './chain'
import { createBlobStore, type BlobStore } from './blobs'
import { appendLine0600, dataDirLayout, ensureDir0700, fsyncPath, writeFile0600, type DataDirLayout } from './paths'
import { ANCHOR_AAD_SEQ, openRecord, openRecordAnyKind, sealRecord } from './record'

/** What a caller may append. `seq` and `at` are the store's to assign; CHECKPOINT is the store's
 *  to write, so it is deliberately absent from this union. */
export type StoreEventInput =
  | { readonly kind: 'ITEM_ADDED'; readonly item: Item }
  | { readonly kind: 'ITEM_UPDATED'; readonly id: ItemId; readonly patch: ItemPatch }
  | { readonly kind: 'ITEM_DELETED'; readonly id: ItemId; readonly reason: DeleteReason }

/** `meta.json` — the ONLY plaintext file the store writes. No sequence data, ever. */
export interface StoreMeta {
  readonly schemaVersion: 1
  readonly keyMode: 'os-keyring' | 'passphrase' | 'unknown'
  readonly scryptSaltB64: string | null
}

export interface StoreStats {
  readonly lineCount: number
  readonly anchorSeq: number
  readonly maxSeq: number
  readonly logBytes: number
  readonly blobCount: number
  readonly blobBytes: number
  readonly tornLineRepairedOnOpen: boolean
}

export interface OpenStoreOptions {
  readonly dir: string
  /** Exactly 32 bytes. Owned by @cairn/keyring; the store never reads a key from disk. */
  readonly key: Buffer
  readonly clock: Clock
  readonly logger: Logger
}

export interface Store {
  appendEvent(input: StoreEventInput): Result<StoreEvent>
  readAll(): AsyncIterable<Result<StoreEvent>>
  checkpoint(liveItemCount: number): Result<StoreEvent>
  putBlob(bytes: Uint8Array): Result<BlobId>
  getBlob(id: BlobId): Result<Buffer>
  deleteBlob(id: BlobId): Result<boolean>
  stat(): Result<StoreStats>
  readMeta(): Result<StoreMeta>
  writeMeta(meta: StoreMeta): Result<void>
  layout(): DataDirLayout
  close(): void
}

interface RecordPayload {
  readonly seq: number
  readonly at: number
  readonly kind: StoreEventKind
  readonly prev: ContentHash
  readonly item?: Item
  readonly id?: ItemId
  readonly patch?: ItemPatch
  readonly reason?: DeleteReason
  readonly maxSeq?: number
  readonly liveItemCount?: number
  readonly watermarks?: Readonly<Record<string, number>>
}

const HASH_RE = /^sha256-[A-Za-z0-9_-]{43}$/
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/**
 * The record is AUTHENTICATED before it reaches here, so this guards against our own schema
 * drift, not against an attacker. Hence structural checks only, and no deep validation of `Item`.
 */
function decodePayload(bytes: Buffer, lineIndex: number): Result<RecordPayload> {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return err('E_STORE_CORRUPT', `line ${lineIndex}: payload is not JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return err('E_STORE_CORRUPT', `line ${lineIndex}: payload is not an object`)
  }
  const p = parsed as Record<string, unknown>
  if (!isInt(p['seq']) || !isInt(p['at'])) {
    return err('E_STORE_CORRUPT', `line ${lineIndex}: seq and at must be safe integers`)
  }
  if (typeof p['prev'] !== 'string' || !HASH_RE.test(p['prev'])) {
    return err('E_STORE_CORRUPT', `line ${lineIndex}: prev is not a content hash`)
  }
  if (typeof p['kind'] !== 'string') {
    return err('E_STORE_CORRUPT', `line ${lineIndex}: kind is missing`)
  }
  return ok(parsed as RecordPayload)
}

function toStoreEvent(p: RecordPayload, lineIndex: number): Result<StoreEvent> {
  switch (p.kind) {
    case 'ITEM_ADDED':
      if (p.item === undefined) return err('E_STORE_CORRUPT', `line ${lineIndex}: ITEM_ADDED has no item`)
      return ok({ kind: 'ITEM_ADDED', seq: p.seq, at: p.at, item: p.item })
    case 'ITEM_UPDATED':
      if (p.id === undefined || p.patch === undefined) {
        return err('E_STORE_CORRUPT', `line ${lineIndex}: ITEM_UPDATED needs id and patch`)
      }
      return ok({ kind: 'ITEM_UPDATED', seq: p.seq, at: p.at, id: p.id, patch: p.patch })
    case 'ITEM_DELETED':
      if (p.id === undefined || p.reason === undefined) {
        return err('E_STORE_CORRUPT', `line ${lineIndex}: ITEM_DELETED needs id and reason`)
      }
      return ok({ kind: 'ITEM_DELETED', seq: p.seq, at: p.at, id: p.id, reason: p.reason })
    case 'CHECKPOINT':
      if (p.maxSeq === undefined || p.liveItemCount === undefined || p.watermarks === undefined) {
        return err('E_STORE_CORRUPT', `line ${lineIndex}: CHECKPOINT needs maxSeq, liveItemCount, watermarks`)
      }
      return ok({
        kind: 'CHECKPOINT',
        seq: p.seq,
        at: p.at,
        maxSeq: p.maxSeq,
        liveItemCount: p.liveItemCount,
        watermarks: p.watermarks,
      })
    default:
      return err('E_STORE_CORRUPT', `line ${lineIndex}: unknown record kind`)
  }
}

const encodePayload = (p: RecordPayload): Buffer => Buffer.from(JSON.stringify(p), 'utf8')

export function openStore(opts: OpenStoreOptions): Result<Store> {
  if (opts.key.length !== 32) {
    throw new Error(`openStore: key must be exactly 32 bytes, got ${opts.key.length}`)
  }
  const L = dataDirLayout(opts.dir)
  ensureDir0700(L.dir)
  const blobs: BlobStore = createBlobStore({ blobDir: L.blobDir, key: opts.key, logger: opts.logger })
  if (!existsSync(L.metaPath)) {
    writeFile0600(
      L.metaPath,
      JSON.stringify({ schemaVersion: 1, keyMode: 'unknown', scryptSaltB64: null } satisfies StoreMeta),
    )
  }

  // A crash can leave a half-written last line. The trailing `\n` is the commit marker, so a line
  // without one never became durable: truncate it and log it. A complete line that fails to
  // authenticate is the other case entirely — that is tamper, and readAll reports it.
  let tornRepaired = false
  if (existsSync(L.logPath)) {
    const raw = readFileSync(L.logPath)
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      const cut = raw.lastIndexOf(0x0a)
      const fd = openSync(L.logPath, 'r+')
      try {
        ftruncateSync(fd, cut + 1)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      tornRepaired = true
      opts.logger.warn('store.torn-line-discarded', { byteLength: raw.length - (cut + 1) })
    }
  }

  const readLines = (): string[] => {
    if (!existsSync(L.logPath)) return []
    const text = readFileSync(L.logPath, 'utf8')
    if (text.length === 0) return []
    const lines = text.split('\n')
    lines.pop() // the empty string after the final terminator
    return lines
  }

  let anchorSeq = 0
  let lineCount = 0
  let tipHash: ContentHash = CHAIN_GENESIS
  /** Within one generation seq is contiguous, so this is exact and needs no decryption. */
  const maxSeq = (): number => anchorSeq + lineCount - 1

  const sealAndAppend = (
    kind: StoreEventKind,
    extra: Omit<RecordPayload, 'seq' | 'at' | 'kind' | 'prev'>,
  ): Result<{ seq: number; at: number }> => {
    const lineIndex = lineCount
    const seq = maxSeq() + 1
    const at = opts.clock.now()
    const line = sealRecord({
      key: opts.key,
      lineIndex,
      seq: lineIndex === 0 ? ANCHOR_AAD_SEQ : seq,
      kind,
      payload: encodePayload({ seq, at, kind, prev: tipHash, ...extra }),
    })
    try {
      appendLine0600(L.logPath, line)
      if (lineIndex === 0) fsyncPath(L.dir)
    } catch (cause) {
      return err('E_STORE_IO', `append failed: ${(cause as Error).message}`)
    }
    tipHash = chainNext(tipHash, line)
    lineCount += 1
    return ok({ seq, at })
  }

  const existing = readLines()
  if (existing.length === 0) {
    anchorSeq = 1
    const written = sealAndAppend('CHECKPOINT', { maxSeq: 0, liveItemCount: 0, watermarks: {} })
    if (!written.ok) return written
  } else {
    const first = existing[0]
    if (first === undefined) return err('E_STORE_CORRUPT', 'log has no anchor CHECKPOINT')
    const anchor = openRecord({
      key: opts.key,
      lineIndex: 0,
      seq: ANCHOR_AAD_SEQ,
      kind: 'CHECKPOINT',
      line: first,
    })
    if (!anchor.ok) return anchor
    const payload = decodePayload(anchor.value, 0)
    if (!payload.ok) return payload
    if (payload.value.kind !== 'CHECKPOINT') {
      return err('E_STORE_CORRUPT', 'line 0 of the log is not a CHECKPOINT')
    }
    anchorSeq = payload.value.seq
    lineCount = existing.length
    tipHash = chainTip(existing)
  }

  opts.logger.info('store.opened', { count: lineCount, seq: maxSeq() })

  async function* readAll(): AsyncIterable<Result<StoreEvent>> {
    const lines = readLines()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined) return
      const opened = openRecordAnyKind({
        key: opts.key,
        lineIndex: i,
        seq: i === 0 ? ANCHOR_AAD_SEQ : anchorSeq + i,
        line,
      })
      if (!opened.ok) {
        yield opened
        return
      }
      const payload = decodePayload(opened.value.payload, i)
      if (!payload.ok) {
        yield payload
        return
      }
      if (payload.value.kind !== opened.value.kind) {
        yield err(
          'E_STORE_CORRUPT',
          `line ${i}: AAD kind ${opened.value.kind} != payload kind ${payload.value.kind}`,
        )
        return
      }
      if (payload.value.seq !== anchorSeq + i) {
        yield err('E_STORE_CORRUPT', `line ${i}: seq ${payload.value.seq} != expected ${anchorSeq + i}`)
        return
      }
      const event = toStoreEvent(payload.value, i)
      yield event
      if (!event.ok) return
    }
  }

  const store: Store = {
    layout: () => L,
    readAll,
    appendEvent(input) {
      const extra =
        input.kind === 'ITEM_ADDED'
          ? { item: input.item }
          : input.kind === 'ITEM_UPDATED'
            ? { id: input.id, patch: input.patch }
            : { id: input.id, reason: input.reason }
      const written = sealAndAppend(input.kind, extra)
      if (!written.ok) return written
      opts.logger.debug('store.appended', { seq: written.value.seq })
      switch (input.kind) {
        case 'ITEM_ADDED':
          return ok({ kind: 'ITEM_ADDED', seq: written.value.seq, at: written.value.at, item: input.item })
        case 'ITEM_UPDATED':
          return ok({
            kind: 'ITEM_UPDATED',
            seq: written.value.seq,
            at: written.value.at,
            id: input.id,
            patch: input.patch,
          })
        case 'ITEM_DELETED':
          return ok({
            kind: 'ITEM_DELETED',
            seq: written.value.seq,
            at: written.value.at,
            id: input.id,
            reason: input.reason,
          })
      }
    },
    checkpoint(liveItemCount) {
      const before = maxSeq()
      const written = sealAndAppend('CHECKPOINT', { maxSeq: before, liveItemCount, watermarks: {} })
      if (!written.ok) return written
      return ok({
        kind: 'CHECKPOINT',
        seq: written.value.seq,
        at: written.value.at,
        maxSeq: before,
        liveItemCount,
        watermarks: {},
      })
    },
    putBlob: (bytes) => blobs.put(bytes),
    getBlob: (id) => blobs.get(id),
    deleteBlob: (id) => blobs.remove(id),
    stat() {
      return ok({
        lineCount,
        anchorSeq,
        maxSeq: maxSeq(),
        logBytes: existsSync(L.logPath) ? statSync(L.logPath).size : 0,
        blobCount: blobs.files().length,
        blobBytes: blobs.totalBytes(),
        tornLineRepairedOnOpen: tornRepaired,
      })
    },
    readMeta() {
      try {
        return ok(JSON.parse(readFileSync(L.metaPath, 'utf8')) as StoreMeta)
      } catch (cause) {
        return err('E_STORE_IO', `meta.json unreadable: ${(cause as Error).message}`)
      }
    },
    writeMeta(meta) {
      try {
        writeFile0600(L.metaPath, JSON.stringify(meta))
        return ok(undefined)
      } catch (cause) {
        return err('E_STORE_IO', `meta.json unwritable: ${(cause as Error).message}`)
      }
    },
    close() {
      blobs.close()
    },
  }
  return ok(store)
}
