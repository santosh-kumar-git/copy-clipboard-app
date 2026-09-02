import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

  describe('a torn trailing line is a crash, not an attack', () => {
    it('discards it on open, repairs the file, and keeps appending cleanly', async () => {
      const { dir, key, store } = seeded(2)
      store.close()
      const path = join(dir, 'history.ndjson')
      writeFileSync(path, `${readFileSync(path, 'utf8')}AAAApartialrecordwithoutanewline`)
      const reopened = openAt(dir, key)
      const stats = reopened.stat()
      expect(stats.ok && stats.value.tornLineRepairedOnOpen).toBe(true)
      expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
      const records = await drain(reopened)
      expect(records).toHaveLength(3)
      expect(records.every((r) => r.ok)).toBe(true)
      const appended = reopened.appendEvent({ kind: 'ITEM_DELETED', id: testItemId(1), reason: 'user' })
      expect(appended.ok && appended.value.seq).toBe(4)
      expect((await drain(reopened)).every((r) => r.ok)).toBe(true)
    })

    it('does NOT discard a complete, newline-terminated line whose bytes were altered', async () => {
      const { dir, key, store } = seeded(2)
      store.close()
      const path = join(dir, 'history.ndjson')
      const lines = readFileSync(path, 'utf8').split('\n').slice(0, -1)
      lines[1] = (lines[1] as string).slice(0, -8) // still `\n`-terminated: a committed record
      writeFileSync(path, `${lines.join('\n')}\n`)
      const reopened = openAt(dir, key)
      const stats = reopened.stat()
      expect(stats.ok && stats.value.tornLineRepairedOnOpen).toBe(false)
      const broken = (await drain(reopened)).find((r) => !r.ok)
      expect(broken?.ok).toBe(false)
      if (broken === undefined || broken.ok) throw new Error('unreachable')
      expect(broken.code).toBe('E_STORE_DECRYPT')
    })
  })

  describe('compact', () => {
    it('rewrites the log as an anchor CHECKPOINT plus one materialised ITEM_ADDED per live id', async () => {
      const { store, ids } = seeded(5)
      store.appendEvent({ kind: 'ITEM_UPDATED', id: ids[0] as ItemId, patch: { updatedAt: 99, pinned: true } })
      store.appendEvent({ kind: 'ITEM_DELETED', id: ids[4] as ItemId, reason: 'retention-count' })
      const seqsBefore = (await drain(store)).map((r) => (r.ok ? r.value.seq : -1))
      expect(seqsBefore).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

      // ids[4] is asked for but was deleted: compaction must NOT resurrect it.
      const summary = store.compact([ids[0] as ItemId, ids[1] as ItemId, ids[4] as ItemId])
      expect(summary.ok).toBe(true)
      if (!summary.ok) throw new Error('unreachable')
      expect(summary.value).toEqual({
        liveItemCount: 2,
        linesBefore: 8,
        linesAfter: 3,
        blobsRemoved: 3,
        maxSeq: 11,
      })

      const records = await drain(store)
      expect(records.every((r) => r.ok)).toBe(true)
      expect(records.map((r) => (r.ok ? r.value.kind : 'ERR'))).toEqual([
        'CHECKPOINT',
        'ITEM_ADDED',
        'ITEM_ADDED',
      ])
      const anchor = records[0]
      const survivor = records[1]
      if (anchor === undefined || !anchor.ok || anchor.value.kind !== 'CHECKPOINT') throw new Error('unreachable')
      if (survivor === undefined || !survivor.ok || survivor.value.kind !== 'ITEM_ADDED') throw new Error('unreachable')
      expect(anchor.value.maxSeq).toBe(8) // the pre-compaction high-water mark, sealed in the log
      expect(anchor.value.liveItemCount).toBe(2)
      // The ITEM_UPDATED patch is materialised into the surviving record.
      expect(survivor.value.item.pinned).toBe(true)
      expect(survivor.value.item.updatedAt).toBe(99)
      // Seq is never reused across a compaction: a peer that already saw seq 8 cannot be told to
      // skip real events (spec §10).
      const seqsAfter = records.map((r) => (r.ok ? r.value.seq : -1))
      expect(Math.min(...seqsAfter)).toBeGreaterThan(Math.max(...seqsBefore))
    })

    it('GCs orphan blobs and keeps the live ones', async () => {
      const { store, ids } = seeded(3)
      const before = store.stat()
      expect(before.ok && before.value.blobCount).toBe(3)
      const summary = store.compact([ids[0] as ItemId])
      expect(summary.ok && summary.value.blobsRemoved).toBe(2)
      const after = store.stat()
      expect(after.ok && after.value.blobCount).toBe(1)
      const survivor = (await drain(store)).at(-1)
      if (survivor === undefined || !survivor.ok || survivor.value.kind !== 'ITEM_ADDED') throw new Error('unreachable')
      const ref = survivor.value.item.repRefs[0]
      if (ref === undefined) throw new Error('unreachable')
      expect(store.getBlob(ref.blobId).ok).toBe(true)
    })

    it('keeps appending and reopens cleanly after a compaction', async () => {
      const { dir, key, store, ids } = seeded(3)
      store.compact([ids[0] as ItemId, ids[1] as ItemId])
      expect(store.appendEvent({ kind: 'ITEM_DELETED', id: ids[1] as ItemId, reason: 'user' }).ok).toBe(true)
      expect((await drain(store)).every((r) => r.ok)).toBe(true)
      store.close()
      expect(existsSync(join(dir, 'history.ndjson.tmp'))).toBe(false)
      expect((await drain(openAt(dir, key))).every((r) => r.ok)).toBe(true)
    })

    it('refuses to compact a tampered log rather than laundering it', async () => {
      const { dir, key, store, ids } = seeded(3)
      store.close()
      const path = join(dir, 'history.ndjson')
      const lines = readFileSync(path, 'utf8').split('\n').slice(0, -1)
      const held = lines[1] as string
      lines[1] = lines[2] as string
      lines[2] = held
      writeFileSync(path, `${lines.join('\n')}\n`)
      const reopened = openAt(dir, key)
      const summary = reopened.compact([ids[0] as ItemId])
      expect(summary.ok).toBe(false)
      if (summary.ok) throw new Error('unreachable')
      expect(summary.code).toBe('E_STORE_DECRYPT')
    })

    it('leaves the OLD log completely intact if it crashes before the rename', async () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const key = randomTestKey()
      const crashing = openStore({
        dir,
        key,
        clock: fixedClock(),
        logger: silentLogger,
        unsafeTestHooks: {
          onBeforeRename: () => {
            throw new Error('simulated crash')
          },
        },
      })
      if (!crashing.ok) throw new Error('unreachable')
      const blob = crashing.value.putBlob(Buffer.from('body', 'utf8'))
      if (!blob.ok) throw new Error('unreachable')
      crashing.value.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(testItemId(1), blob.value, 'body') })
      const before = readFileSync(join(dir, 'history.ndjson'), 'utf8')

      const summary = crashing.value.compact([])
      expect(summary.ok).toBe(false)
      if (summary.ok) throw new Error('unreachable')
      expect(summary.code).toBe('E_STORE_IO')
      expect(readFileSync(join(dir, 'history.ndjson'), 'utf8')).toBe(before)
      expect(crashing.value.stat()).toEqual({
        ok: true,
        value: expect.objectContaining({ lineCount: 2, blobCount: 1 }),
      })
      crashing.value.close()

      // The stale .tmp is ignored on open and overwritten by the next compaction.
      const reopened = openAt(dir, key)
      expect(await drain(reopened)).toHaveLength(2)
      expect(reopened.compact([]).ok).toBe(true)
      expect(existsSync(join(dir, 'history.ndjson.tmp'))).toBe(false)
    })

    it('leaks an orphan blob rather than a dangling reference if it crashes after the rename', async () => {
      const { dir, cleanup } = tempStoreDir()
      cleanups.push(cleanup)
      const key = randomTestKey()
      const crashing = openStore({
        dir,
        key,
        clock: fixedClock(),
        logger: silentLogger,
        unsafeTestHooks: {
          onAfterRename: () => {
            throw new Error('simulated crash')
          },
        },
      })
      if (!crashing.ok) throw new Error('unreachable')
      const blob = crashing.value.putBlob(Buffer.from('body', 'utf8'))
      if (!blob.ok) throw new Error('unreachable')
      crashing.value.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(testItemId(1), blob.value, 'body') })
      expect(() => crashing.value.compact([])).toThrow('simulated crash')
      crashing.value.close()

      const reopened = openAt(dir, key)
      expect(await drain(reopened)).toHaveLength(1) // the new log is in place
      expect(reopened.stat()).toEqual({ ok: true, value: expect.objectContaining({ blobCount: 1 }) })
      expect(reopened.compact([]).ok).toBe(true)
      expect(reopened.stat()).toEqual({ ok: true, value: expect.objectContaining({ blobCount: 0 }) })
    })
  })
})
