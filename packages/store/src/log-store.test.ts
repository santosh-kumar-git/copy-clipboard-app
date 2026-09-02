import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ItemId, Result, StoreEvent } from '@cairn/protocol'
import { openStore, type Store, type StoreMeta } from './log-store'
import { fixedClock, itemFixture, randomTestKey, silentLogger, tempStoreDir, testItemId } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function openAt(dir: string, key: Buffer): Store {
  const opened = openStore({ dir, key, clock: fixedClock(), logger: silentLogger })
  if (!opened.ok) throw new Error(`openStore failed: ${opened.code} ${opened.message}`)
  return opened.value
}

async function drain(store: Store): Promise<Result<StoreEvent>[]> {
  const out: Result<StoreEvent>[] = []
  for await (const record of store.readAll()) out.push(record)
  return out
}

/** A store holding `n` text items, each with its own blob. */
function seeded(n: number): { dir: string; key: Buffer; store: Store; ids: ItemId[] } {
  const { dir, cleanup } = tempStoreDir()
  cleanups.push(cleanup)
  const key = randomTestKey()
  const store = openAt(dir, key)
  const ids: ItemId[] = []
  for (let i = 0; i < n; i++) {
    const text = `payload-${i}`
    const blob = store.putBlob(Buffer.from(text, 'utf8'))
    if (!blob.ok) throw new Error(blob.message)
    const id = testItemId(i + 1)
    ids.push(id)
    const appended = store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(id, blob.value, text) })
    if (!appended.ok) throw new Error(appended.message)
  }
  return { dir, key, store, ids }
}

describe('openStore', () => {
  it('throws for a key that is not 32 bytes — that is a programmer error, not a state', () => {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    expect(() =>
      openStore({ dir, key: Buffer.alloc(16), clock: fixedClock(), logger: silentLogger }),
    ).toThrow('openStore: key must be exactly 32 bytes, got 16')
  })

  it('seals an anchor CHECKPOINT as line 0 of a brand new log', async () => {
    const { store } = seeded(0)
    const records = await drain(store)
    expect(records).toHaveLength(1)
    const first = records[0]
    if (first === undefined || !first.ok) throw new Error('unreachable')
    expect(first.value).toEqual({
      kind: 'CHECKPOINT',
      seq: 1,
      at: 1_767_225_600_000,
      maxSeq: 0,
      liveItemCount: 0,
      watermarks: {},
    })
  })

  it('reports E_STORE_DECRYPT for a store opened with the wrong key', () => {
    const { dir } = seeded(1)
    const wrong = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
    expect(wrong.ok).toBe(false)
    if (wrong.ok) throw new Error('unreachable')
    expect(wrong.code).toBe('E_STORE_DECRYPT')
  })
})

describe('appendEvent / readAll', () => {
  it('assigns contiguous seqs and returns the sealed event', async () => {
    const { store, ids } = seeded(3)
    const records = await drain(store)
    expect(records.every((r) => r.ok)).toBe(true)
    expect(records).toHaveLength(4)
    expect(records.map((r) => (r.ok ? r.value.seq : -1))).toEqual([1, 2, 3, 4])
    const deleted = store.appendEvent({ kind: 'ITEM_DELETED', id: ids[0] as ItemId, reason: 'user' })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) throw new Error('unreachable')
    expect(deleted.value).toEqual({
      kind: 'ITEM_DELETED',
      seq: 5,
      at: 1_767_225_600_000,
      id: ids[0],
      reason: 'user',
    })
  })

  it('round-trips all three caller-visible event kinds', async () => {
    const { store, ids } = seeded(1)
    store.appendEvent({ kind: 'ITEM_UPDATED', id: ids[0] as ItemId, patch: { updatedAt: 42, pinned: true } })
    store.appendEvent({ kind: 'ITEM_DELETED', id: ids[0] as ItemId, reason: 'retention-count' })
    const records = await drain(store)
    expect(records.map((r) => (r.ok ? r.value.kind : 'ERR'))).toEqual([
      'CHECKPOINT',
      'ITEM_ADDED',
      'ITEM_UPDATED',
      'ITEM_DELETED',
    ])
    const updated = records[2]
    if (updated === undefined || !updated.ok || updated.value.kind !== 'ITEM_UPDATED') {
      throw new Error('unreachable')
    }
    expect(updated.value.patch).toEqual({ updatedAt: 42, pinned: true })
  })

  it('survives quit and relaunch, and keeps counting from where it stopped', async () => {
    const { dir, key, store, ids } = seeded(3)
    store.close()
    const reopened = openAt(dir, key)
    const records = await drain(reopened)
    expect(records).toHaveLength(4)
    expect(records.every((r) => r.ok)).toBe(true)
    const appended = reopened.appendEvent({ kind: 'ITEM_DELETED', id: ids[1] as ItemId, reason: 'user' })
    expect(appended.ok && appended.value.seq).toBe(5)
    expect((await drain(reopened)).every((r) => r.ok)).toBe(true)
  })

  it('writes max_seq into a SEALED CHECKPOINT record, inside the log', async () => {
    const { store } = seeded(3)
    const checkpoint = store.checkpoint(3)
    expect(checkpoint.ok).toBe(true)
    if (!checkpoint.ok || checkpoint.value.kind !== 'CHECKPOINT') throw new Error('unreachable')
    expect(checkpoint.value.seq).toBe(5)
    expect(checkpoint.value.maxSeq).toBe(4)
    expect(checkpoint.value.liveItemCount).toBe(3)
    expect(checkpoint.value.watermarks).toEqual({})
    const last = (await drain(store)).at(-1)
    if (last === undefined || !last.ok) throw new Error('unreachable')
    expect(last.value.kind).toBe('CHECKPOINT')
  })

  it('reports stats without decrypting the whole log', () => {
    const { dir, store } = seeded(2)
    const stats = store.stat()
    expect(stats.ok).toBe(true)
    if (!stats.ok) throw new Error('unreachable')
    expect(stats.value.lineCount).toBe(3)
    expect(stats.value.anchorSeq).toBe(1)
    expect(stats.value.maxSeq).toBe(3)
    expect(stats.value.blobCount).toBe(2)
    expect(stats.value.logBytes).toBe(statSync(join(dir, 'history.ndjson')).size)
  })
})

describe('meta.json', () => {
  it('holds ONLY schema version, key mode and the scrypt salt — no sequence data', () => {
    const { dir, store } = seeded(3)
    store.checkpoint(3)
    const text = readFileSync(join(dir, 'meta.json'), 'utf8')
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>).sort()).toEqual([
      'keyMode',
      'schemaVersion',
      'scryptSaltB64',
    ])
    // The watermark vector and max_seq live in the sealed CHECKPOINT, never here (spec §4).
    expect(/seq|watermark|line|count/i.test(text)).toBe(false)
    expect(statSync(join(dir, 'meta.json')).mode & 0o777).toBe(0o600)
  })

  it('round-trips a key mode and a salt without widening the mode', () => {
    const { dir, store } = seeded(0)
    expect(store.readMeta()).toEqual({
      ok: true,
      value: { schemaVersion: 1, keyMode: 'unknown', scryptSaltB64: null },
    })
    expect(store.writeMeta({ schemaVersion: 1, keyMode: 'passphrase', scryptSaltB64: 'AAAA' }).ok).toBe(true)
    const meta = store.readMeta()
    expect(meta.ok && meta.value.keyMode).toBe('passphrase')
    expect(statSync(join(dir, 'meta.json')).mode & 0o777).toBe(0o600)

    // `keyMode` is EXACTLY 'os-keyring' | 'passphrase' | 'unknown'. `@cairn/keyring`'s runtime
    // `KeyringMode` has a fourth member, `'locked'`, and it is NOT persistable — it describes this
    // process, not the store on disk, and writing it would leave the next cold start unable to work
    // out how to get the key back. This is a TYPE-level assertion on purpose: it never calls
    // `writeMeta`, so it cannot put a bad value in `meta.json`, and `tsc` fails with
    // `TS2578: Unused '@ts-expect-error' directive` the day somebody widens the union.
    // @ts-expect-error 'locked' is a runtime KeyringMode, never a persisted one
    const notPersistable: StoreMeta = { schemaVersion: 1, keyMode: 'locked', scryptSaltB64: null }
    void notPersistable
  })
})
