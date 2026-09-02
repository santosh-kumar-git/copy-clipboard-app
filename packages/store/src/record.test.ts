import { describe, expect, it } from 'vitest'
import { STORE_AAD_MAGIC } from '@cairn/protocol'
import {
  ANCHOR_AAD_SEQ,
  NONCE_BYTES,
  RECORD_KINDS,
  TAG_BYTES,
  openRecord,
  openRecordAnyKind,
  recordAad,
  sealRecord,
} from './record'
import { randomTestKey } from './testing'

const PAYLOAD = Buffer.from('{"seq":7,"kind":"ITEM_ADDED"}', 'utf8')

describe('recordAad', () => {
  it('is magic || u64be(lineIndex) || u64be(seq) || kind', () => {
    const aad = recordAad(3, 7, 'ITEM_ADDED')
    expect(aad.subarray(0, 14).toString('utf8')).toBe(STORE_AAD_MAGIC)
    expect(aad.readBigUInt64BE(14)).toBe(3n)
    expect(aad.readBigUInt64BE(22)).toBe(7n)
    expect(aad.subarray(30).toString('utf8')).toBe('ITEM_ADDED')
    expect(aad.length).toBe(14 + 16 + 'ITEM_ADDED'.length)
  })

  it('covers all four record kinds and the anchor seq is 0', () => {
    expect(RECORD_KINDS).toEqual(['ITEM_ADDED', 'ITEM_UPDATED', 'ITEM_DELETED', 'CHECKPOINT'])
    expect(ANCHOR_AAD_SEQ).toBe(0)
  })
})

describe('sealRecord / openRecord', () => {
  it('round-trips base64(nonce12 || ct || tag16)', () => {
    const key = randomTestKey()
    const line = sealRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', payload: PAYLOAD })
    expect(line).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    const raw = Buffer.from(line, 'base64')
    expect(raw.length).toBe(NONCE_BYTES + PAYLOAD.length + TAG_BYTES)
    const opened = openRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', line })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error('unreachable')
    expect(opened.value.toString('utf8')).toBe(PAYLOAD.toString('utf8'))
  })

  it('uses a fresh nonce per record, so the same payload never seals to the same line', () => {
    const key = randomTestKey()
    const a = sealRecord({ key, lineIndex: 0, seq: 0, kind: 'CHECKPOINT', payload: PAYLOAD })
    const b = sealRecord({ key, lineIndex: 0, seq: 0, kind: 'CHECKPOINT', payload: PAYLOAD })
    expect(a).not.toBe(b)
  })

  it('refuses a record moved to a different LINE', () => {
    const key = randomTestKey()
    const line = sealRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', payload: PAYLOAD })
    const moved = openRecord({ key, lineIndex: 4, seq: 7, kind: 'ITEM_ADDED', line })
    expect(moved.ok).toBe(false)
    if (moved.ok) throw new Error('unreachable')
    expect(moved.code).toBe('E_STORE_DECRYPT')
    expect(moved.message).toContain('line 4')
  })

  it('refuses a record replayed under a different SEQ or a different KIND', () => {
    const key = randomTestKey()
    const line = sealRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_ADDED', payload: PAYLOAD })
    const wrongSeq = openRecord({ key, lineIndex: 3, seq: 8, kind: 'ITEM_ADDED', line })
    const wrongKind = openRecord({ key, lineIndex: 3, seq: 7, kind: 'ITEM_DELETED', line })
    expect(wrongSeq.ok).toBe(false)
    expect(wrongKind.ok).toBe(false)
    if (wrongSeq.ok || wrongKind.ok) throw new Error('unreachable')
    expect(wrongSeq.code).toBe('E_STORE_DECRYPT')
    expect(wrongKind.code).toBe('E_STORE_DECRYPT')
  })

  it('refuses a record sealed under a different key', () => {
    const line = sealRecord({ key: randomTestKey(), lineIndex: 0, seq: 0, kind: 'CHECKPOINT', payload: PAYLOAD })
    const opened = openRecord({ key: randomTestKey(), lineIndex: 0, seq: 0, kind: 'CHECKPOINT', line })
    expect(opened.ok).toBe(false)
  })

  it('never throws on garbage, however short', () => {
    const key = randomTestKey()
    for (const line of ['', '!!!', 'AAAA', 'not base64 at all']) {
      const opened = openRecord({ key, lineIndex: 0, seq: 0, kind: 'CHECKPOINT', line })
      expect(opened.ok).toBe(false)
      if (opened.ok) throw new Error('unreachable')
      expect(opened.code).toBe('E_STORE_DECRYPT')
    }
  })
})

describe('openRecordAnyKind', () => {
  it('finds the kind the record was sealed under', () => {
    const key = randomTestKey()
    const line = sealRecord({ key, lineIndex: 2, seq: 5, kind: 'ITEM_DELETED', payload: PAYLOAD })
    const opened = openRecordAnyKind({ key, lineIndex: 2, seq: 5, line })
    expect(opened.ok).toBe(true)
    if (!opened.ok) throw new Error('unreachable')
    expect(opened.value.kind).toBe('ITEM_DELETED')
    expect(opened.value.payload.toString('utf8')).toBe(PAYLOAD.toString('utf8'))
  })

  it('still refuses a record at the wrong line, under every kind', () => {
    const key = randomTestKey()
    const line = sealRecord({ key, lineIndex: 2, seq: 5, kind: 'ITEM_DELETED', payload: PAYLOAD })
    const opened = openRecordAnyKind({ key, lineIndex: 9, seq: 5, line })
    expect(opened.ok).toBe(false)
    if (opened.ok) throw new Error('unreachable')
    expect(opened.message).toContain('every record kind')
  })
})
