import { describe, expect, it } from 'vitest'
import { newItemId } from './id'
import {
  IPC_EVENT_CHANNELS,
  IPC_REQUEST_CHANNELS,
  IpcEventSchema,
  IpcRequestSchema,
  ItemIdSchema,
  ItemSummarySchema,
} from './ipc'

const summary = {
  id: '01KDVDNA00000G40R40M30E209',
  kind: 'text',
  preview: 'AKIA••••A7QD',
  previewTruncated: false,
  flags: ['secret'],
  maskedSpanCount: 1,
  sourceAppName: 'TextEdit',
  byteLength: 20,
  createdAt: 1_767_225_600_000,
  pinned: false,
  expiresAt: 1_767_225_900_000,
  thumbnailDataUrl: null,
}

describe('the channel lists are frozen and complete', () => {
  it('has eight request channels and four event channels, each with a schema', () => {
    expect(IPC_REQUEST_CHANNELS).toEqual([
      'cairn:history.list',
      'cairn:history.search',
      'cairn:history.preview',
      'cairn:history.pin',
      'cairn:history.remove',
      'cairn:recall.copy',
      'cairn:palette.close',
      'cairn:security.status',
    ])
    expect(IPC_EVENT_CHANNELS).toEqual([
      'cairn:history.changed',
      'cairn:hotkey.status',
      'cairn:toast',
      'cairn:palette.shown',
    ])
    for (const c of IPC_REQUEST_CHANNELS) {
      expect(IpcRequestSchema[c].params).toBeDefined()
      expect(IpcRequestSchema[c].result).toBeDefined()
    }
    for (const c of IPC_EVENT_CHANNELS) expect(IpcEventSchema[c]).toBeDefined()
    expect(Object.keys(IpcRequestSchema)).toHaveLength(8)
    expect(Object.keys(IpcEventSchema)).toHaveLength(4)
  })
})

describe('inbound params are validated (main side)', () => {
  it('applies the pinnedOnly default and refuses an out-of-range limit', () => {
    const params = IpcRequestSchema['cairn:history.list'].params
    expect(params.parse({ limit: 50, offset: 0 })).toEqual({ limit: 50, offset: 0, pinnedOnly: false })
    expect(params.safeParse({ limit: 0, offset: 0 }).success).toBe(false)
    expect(params.safeParse({ limit: 201, offset: 0 }).success).toBe(false)
    const bad = params.safeParse({ limit: 10, offset: 1.5 })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.message).toBe('Invalid input: expected int, received number')
  })

  it('refuses an id that is not a 26-char Crockford ItemId', () => {
    const params = IpcRequestSchema['cairn:history.preview'].params
    expect(params.safeParse({ id: '01KDVDNA00000G40R40M30E209' }).success).toBe(true)
    expect(params.safeParse({ id: 'nope' }).success).toBe(false)
    expect(params.safeParse({ id: '01KDVDNA00000G40R40M30E20I' }).success).toBe(false) // I is not Crockford
  })

  it('accepts an id minted by newItemId — the two modules agree on the format', () => {
    expect(ItemIdSchema.safeParse(newItemId(1_767_225_600_000, new Uint8Array(10))).success).toBe(true)
  })
})

describe('outbound results are validated (main side), and carry no bytes', () => {
  it('ItemSummary has exactly twelve keys, none of which can hold a body', () => {
    const keys = Object.keys(ItemSummarySchema.shape)
    expect(keys).toEqual([
      'id', 'kind', 'preview', 'previewTruncated', 'flags', 'maskedSpanCount', 'sourceAppName',
      'byteLength', 'createdAt', 'pinned', 'expiresAt', 'thumbnailDataUrl',
    ])
    for (const banned of ['bytes', 'reps', 'repRefs', 'blobId', 'raw', 'html', 'text']) {
      expect(keys).not.toContain(banned)
    }
    expect(ItemSummarySchema.safeParse(summary).success).toBe(true)
  })

  it('refuses a preview over 512 chars and a thumbnail that is not an inline JPEG data URL', () => {
    expect(ItemSummarySchema.safeParse({ ...summary, preview: 'x'.repeat(513) }).success).toBe(false)
    expect(
      ItemSummarySchema.safeParse({ ...summary, thumbnailDataUrl: 'https://evil.example/x.png' }).success,
    ).toBe(false)
    expect(
      ItemSummarySchema.safeParse({
        ...summary,
        thumbnailDataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
      }).success,
    ).toBe(true)
  })

  it('recall.copy can only ever report copied-manual in M1', () => {
    const result = IpcRequestSchema['cairn:recall.copy'].result
    expect(result.safeParse({ result: 'copied-manual', reason: 'user-preference' }).success).toBe(true)
    expect(result.safeParse({ result: 'copied-auto', reason: 'user-preference' }).success).toBe(false)
  })
})

describe('event payloads are validated too (renderer side)', () => {
  it('accepts the frozen toast and rejects an unknown tone', () => {
    expect(
      IpcEventSchema['cairn:toast'].safeParse({ text: 'Copied — press Cmd+V', tone: 'info' }).success,
    ).toBe(true)
    expect(IpcEventSchema['cairn:toast'].safeParse({ text: 'x', tone: 'shout' }).success).toBe(false)
    expect(
      IpcEventSchema['cairn:history.changed'].safeParse({ reason: 'ingest', total: 3 }).success,
    ).toBe(true)
    expect(
      IpcEventSchema['cairn:history.changed'].safeParse({ reason: 'wat', total: 3 }).success,
    ).toBe(false)
  })
})
