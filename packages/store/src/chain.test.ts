import { afterEach, describe, expect, it } from 'vitest'
import { contentHash } from '@cairn/protocol'
import type { Result, StoreEvent } from '@cairn/protocol'
import { CHAIN_GENESIS, chainNext, chainTip, createChainVerifier } from './chain'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openStore, type Store } from './log-store'
import { fixedClock, itemFixture, randomTestKey, silentLogger, tempStoreDir, testItemId } from './testing'

describe('chain primitives', () => {
  it('has a fixed, domain-separated genesis hash', () => {
    expect(CHAIN_GENESIS).toBe('sha256-65kkf25TFtOBWoOISYgGREW0uYOzKyXTZbpV_niBLM4')
    expect(CHAIN_GENESIS).toBe(contentHash(Buffer.from('cairn/store/v1/genesis', 'utf8')))
  })

  it('folds the SEALED line into the running hash', () => {
    const first = chainNext(CHAIN_GENESIS, 'AAAA')
    expect(first).toBe(
      contentHash(Buffer.concat([Buffer.from(CHAIN_GENESIS, 'utf8'), Buffer.from('AAAA', 'utf8')])),
    )
    expect(first).not.toBe(chainNext(CHAIN_GENESIS, 'AAAB'))
    expect(chainNext(first, 'BBBB')).not.toBe(chainNext(CHAIN_GENESIS, 'BBBB'))
  })

  it('chainTip is order-sensitive', () => {
    expect(chainTip(['A', 'B', 'C'])).toBe(chainNext(chainNext(chainNext(CHAIN_GENESIS, 'A'), 'B'), 'C'))
    expect(chainTip(['A', 'B', 'C'])).not.toBe(chainTip(['A', 'C', 'B']))
    expect(chainTip([])).toBe(CHAIN_GENESIS)
  })

  it('accepts a well-formed chain and advances the tip', () => {
    const verifier = createChainVerifier()
    const first = verifier.check(0, 'AAAA', CHAIN_GENESIS)
    expect(first.ok).toBe(true)
    expect(verifier.tip()).toBe(chainNext(CHAIN_GENESIS, 'AAAA'))
    expect(verifier.check(1, 'BBBB', chainNext(CHAIN_GENESIS, 'AAAA')).ok).toBe(true)
    expect(verifier.tip()).toBe(chainTip(['AAAA', 'BBBB']))
  })

  it('rejects a record whose declared prev is not the running hash', () => {
    const verifier = createChainVerifier()
    expect(verifier.check(0, 'AAAA', CHAIN_GENESIS).ok).toBe(true)
    const broken = verifier.check(1, 'BBBB', CHAIN_GENESIS)
    expect(broken.ok).toBe(false)
    if (broken.ok) throw new Error('unreachable')
    expect(broken.code).toBe('E_STORE_CHAIN_BROKEN')
    expect(broken.message).toContain('chain broken at line 1')
  })
})

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const logPath = (dir: string): string => join(dir, 'history.ndjson')
const readSealedLines = (dir: string): string[] =>
  readFileSync(logPath(dir), 'utf8').split('\n').slice(0, -1)
const writeSealedLines = (dir: string, lines: readonly string[]): void =>
  writeFileSync(logPath(dir), `${lines.join('\n')}\n`)

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
function addItem(store: Store, n: number, text: string): void {
  const blob = store.putBlob(Buffer.from(text, 'utf8'))
  if (!blob.ok) throw new Error(blob.message)
  const appended = store.appendEvent({ kind: 'ITEM_ADDED', item: itemFixture(testItemId(n), blob.value, text) })
  if (!appended.ok) throw new Error(appended.message)
}
function seededOnDisk(n: number): { dir: string; key: Buffer; store: Store } {
  const { dir, cleanup } = tempStoreDir()
  cleanups.push(cleanup)
  const key = randomTestKey()
  const store = openAt(dir, key)
  for (let i = 0; i < n; i++) addItem(store, i + 1, `payload-${i}`)
  return { dir, key, store }
}

describe('at-rest integrity: every mutation of history.ndjson is detected', () => {
  it('detects two records SWAPPED, because the AAD binds the line index', async () => {
    const { dir, key, store } = seededOnDisk(4)
    store.close()
    const lines = readSealedLines(dir)
    const held = lines[2] as string
    lines[2] = lines[3] as string
    lines[3] = held
    writeSealedLines(dir, lines)
    const records = await drain(openAt(dir, key))
    expect(records.filter((r) => r.ok)).toHaveLength(2) // lines 0 and 1 are untouched
    const broken = records.at(-1)
    if (broken === undefined || broken.ok) throw new Error('unreachable')
    expect(broken.code).toBe('E_STORE_DECRYPT')
    expect(broken.message).toContain('line 2')
  })

  it('detects an ITEM_DELETED record DELETED from the middle — a deleted secret must not come back', async () => {
    const { dir, key, store } = seededOnDisk(3)
    store.appendEvent({ kind: 'ITEM_DELETED', id: testItemId(2), reason: 'user' })
    store.checkpoint(2)
    store.close()
    const lines = readSealedLines(dir)
    expect(lines).toHaveLength(6) // anchor + 3 adds + 1 delete + 1 checkpoint
    lines.splice(4, 1) // excise the ITEM_DELETED
    writeSealedLines(dir, lines)
    const records = await drain(openAt(dir, key))
    const broken = records.find((r) => !r.ok)
    if (broken === undefined || broken.ok) throw new Error('unreachable')
    expect(broken.code).toBe('E_STORE_DECRYPT')
    expect(broken.message).toContain('line 4')
  })

  it('detects a record DUPLICATED onto the end', async () => {
    const { dir, key, store } = seededOnDisk(3)
    store.close()
    const lines = readSealedLines(dir)
    lines.push(lines[2] as string)
    writeSealedLines(dir, lines)
    const broken = (await drain(openAt(dir, key))).find((r) => !r.ok)
    if (broken === undefined || broken.ok) throw new Error('unreachable')
    expect(broken.code).toBe('E_STORE_DECRYPT')
  })

  it('detects a record DUPLICATED into the middle', async () => {
    const { dir, key, store } = seededOnDisk(4)
    store.close()
    const lines = readSealedLines(dir)
    lines.splice(2, 0, lines[1] as string)
    writeSealedLines(dir, lines)
    const broken = (await drain(openAt(dir, key))).find((r) => !r.ok)
    if (broken === undefined || broken.ok) throw new Error('unreachable')
    expect(broken.code).toBe('E_STORE_DECRYPT')
  })

  it('detects a record ROLLED BACK to an older record with the same line, seq and kind', async () => {
    // This is the attack the AAD cannot see and the hash chain exists for: yesterday's line 2,
    // lifted out of a backup of the same log under the same key, spliced over today's line 2.
    const main = tempStoreDir()
    const backups = tempStoreDir()
    cleanups.push(main.cleanup, backups.cleanup)
    const key = randomTestKey()

    let store = openAt(main.dir, key)
    addItem(store, 1, 'first')
    store.close()
    copyFileSync(logPath(main.dir), join(backups.dir, 'prefix')) // 2 lines: anchor + line 1

    store = openAt(main.dir, key)
    addItem(store, 2, 'second-REAL')
    store.close()
    copyFileSync(logPath(main.dir), join(backups.dir, 'real'))

    // Fork from the identical 2-line prefix, so the alternative line 2 declares the same `prev`.
    copyFileSync(join(backups.dir, 'prefix'), logPath(main.dir))
    store = openAt(main.dir, key)
    addItem(store, 3, 'second-ROLLBACK')
    store.close()
    const rolledBackLine = readSealedLines(main.dir)[2] as string

    copyFileSync(join(backups.dir, 'real'), logPath(main.dir))
    store = openAt(main.dir, key)
    addItem(store, 4, 'third')
    store.close()
    const lines = readSealedLines(main.dir)
    expect(lines).toHaveLength(4)
    lines[2] = rolledBackLine
    writeSealedLines(main.dir, lines)

    const records = await drain(openAt(main.dir, key))
    const spliced = records[2]
    if (spliced === undefined || !spliced.ok || spliced.value.kind !== 'ITEM_ADDED') {
      throw new Error('the spliced record should still open: line, seq and kind all match')
    }
    expect(spliced.value.item.preview).toBe('second-ROLLBACK')
    const broken = records.at(-1)
    if (broken === undefined || broken.ok) throw new Error('unreachable')
    expect(broken.code).toBe('E_STORE_CHAIN_BROKEN')
    expect(broken.message).toContain('chain broken at line 3')
  })

  it('reads a clean log to the end with no error', async () => {
    const { dir, key, store } = seededOnDisk(3)
    store.close()
    const records = await drain(openAt(dir, key))
    expect(records).toHaveLength(4)
    expect(records.every((r) => r.ok)).toBe(true)
  })
})
