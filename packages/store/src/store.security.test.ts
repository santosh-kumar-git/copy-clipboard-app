import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_CANARY } from '@cairn/protocol'
import { openStore } from './log-store'
import { fixedClock, itemFixture, randomTestKey, silentLogger, tempStoreDir, testItemId } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const walk = (p: string): string[] =>
  statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : [p]

describe('nothing the store writes is plaintext (spec §11 control 1)', () => {
  it('never writes the canary to any file, under any name, through any code path', async () => {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    const opened = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
    if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)
    const store = opened.value
    const id = testItemId(7)

    // Every write path the store has: a blob body, an event, a checkpoint and a compaction.
    const blob = store.putBlob(Buffer.from(`${TEST_CANARY} in a blob body`, 'utf8'))
    if (!blob.ok) throw new Error(blob.message)
    const appended = store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(id, blob.value, TEST_CANARY) })
    expect(appended.ok).toBe(true)
    store.checkpoint(1)
    expect(store.compact([id]).ok).toBe(true)

    const files = walk(dir)
    expect(files.length).toBeGreaterThanOrEqual(3) // history.ndjson, meta.json, one blob
    for (const file of files) {
      expect(readFileSync(file).includes(TEST_CANARY)).toBe(false)
      expect(file.includes(TEST_CANARY)).toBe(false)
      // Base64 of the canary would mean a plaintext body inside a base64 field.
      expect(readFileSync(file, 'utf8').includes(Buffer.from(TEST_CANARY, 'utf8').toString('base64'))).toBe(false)
    }

    // …and the canary really did go in, so the assertions above are not vacuous.
    const previews: string[] = []
    for await (const record of store.readAll()) {
      if (record.ok && record.value.kind === 'ITEM_ADDED') previews.push(record.value.item.preview)
    }
    expect(previews).toContain(TEST_CANARY)
    const readBack = store.getBlob(blob.value)
    expect(readBack.ok && readBack.value.toString('utf8')).toBe(`${TEST_CANARY} in a blob body`)
  })

  it('the scanner itself works: a plaintext file in the same tree IS found', () => {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    writeFileSync(join(dir, 'control.txt'), `leaked: ${TEST_CANARY}`)
    const hits = walk(dir).filter((f) => readFileSync(f).includes(TEST_CANARY))
    expect(hits).toHaveLength(1)
  })

  it('keeps 0700 on every directory and 0600 on every file after a full lifecycle', () => {
    const { dir, cleanup } = tempStoreDir()
    cleanups.push(cleanup)
    const opened = openStore({ dir, key: randomTestKey(), clock: fixedClock(), logger: silentLogger })
    if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)
    const store = opened.value
    const id = testItemId(8)
    const blob = store.putBlob(Buffer.from('body', 'utf8'))
    if (!blob.ok) throw new Error(blob.message)
    store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(id, blob.value, 'body') })
    store.checkpoint(1)
    store.compact([id])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'blobs')).mode & 0o777).toBe(0o700)
    for (const file of walk(dir)) expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
