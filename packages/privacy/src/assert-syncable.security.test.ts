import { describe, expect, it } from 'vitest'
import { NON_SYNCABLE_FLAGS, TEST_CANARY, type Flag, type Item, type ItemId, type ContentHash } from '@cairn/protocol'
import { assertSyncable } from './assert-syncable'

const ID = '01JQ8V7Z9X0000000000000000' as ItemId
const HASH = 'sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek' as ContentHash

const itemWith = (flags: readonly Flag[]): Item => ({
  id: ID,
  kind: 'text',
  contentHash: HASH,
  preview: 'hello world',
  previewTruncated: false,
  maskSpans: [],
  flags,
  repRefs: [],
  thumbnailBlobId: null,
  sourceApp: null,
  byteLength: 11,
  createdAt: 1_767_225_600_000,
  updatedAt: 1_767_225_600_000,
  pinned: false,
  expiresAt: null,
})

describe('assertSyncable throws for every flag in the secret set', () => {
  it('covers exactly four flags', () => {
    expect([...NON_SYNCABLE_FLAGS]).toEqual(['secret', 'concealed', 'excluded', 'no-sync'])
  })
  it.each([...NON_SYNCABLE_FLAGS])('throws for flag %s', (flag) => {
    expect(() => { assertSyncable(itemWith([flag])) }).toThrow(/refusing to sync/)
  })
  it('throws for a combination and names every offending flag', () => {
    expect(() => { assertSyncable(itemWith(['secret', 'transient', 'no-sync'])) })
      .toThrow(`cairn: refusing to sync item ${ID}: flags secret,no-sync`)
  })
  it('returns undefined for a clean item and for syncable-but-flagged ones', () => {
    expect(assertSyncable(itemWith([]))).toBeUndefined()
    expect(assertSyncable(itemWith(['transient', 'auto-generated', 'cut']))).toBeUndefined()
  })
  it('never puts content in the message — only the id and the flags', () => {
    let message = ''
    try { assertSyncable(itemWith(['secret'])) } catch (e) { message = (e as Error).message }
    expect(message).not.toContain(TEST_CANARY)
    expect(message).not.toContain('AKIA')
    expect(message).toBe(`cairn: refusing to sync item ${ID}: flags secret`)
  })
})
