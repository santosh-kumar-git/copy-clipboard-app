import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { newItemId } from './id'
import { fixturePath } from './testing'
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
  tags: ['work'],
  expiresAt: 1_767_225_900_000,
  thumbnailDataUrl: null,
}

describe('the channel lists are frozen and complete', () => {
  it('has eleven request channels and four event channels, each with a schema', () => {
    expect(IPC_REQUEST_CHANNELS).toEqual([
      'cairn:history.list',
      'cairn:history.search',
      'cairn:history.preview',
      'cairn:history.pin',
      'cairn:history.tag',
      'cairn:history.title',
      'cairn:history.remove',
      'cairn:recall.copy',
      'cairn:palette.close',
      'cairn:palette.ready',
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
    expect(Object.keys(IpcRequestSchema)).toHaveLength(11)
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

  it.each(['text', 'richtext', 'image', 'files'])('preserves the exact %s kind in list and search params', (kind) => {
    const list = { limit: 10, offset: 0, kind, tag: 'work', pinnedOnly: true }
    const search = { q: 'report', limit: 10, kind, tag: 'work', pinnedOnly: true }
    expect(IpcRequestSchema['cairn:history.list'].params.parse(list)).toEqual(list)
    expect(IpcRequestSchema['cairn:history.search'].params.parse(search)).toEqual(search)
  })

  it('allows searching all kinds when kind is omitted', () => {
    expect(IpcRequestSchema['cairn:history.search'].params.parse({ q: 'report', limit: 10 })).toEqual({
      q: 'report', limit: 10, pinnedOnly: false,
    })
  })

  it.each(['all', 'Text', 'file', '', null, 42, {}, ['image']].map((kind) => ({ kind })))('rejects an invalid search kind $kind', ({ kind }) => {
    expect(IpcRequestSchema['cairn:history.search'].params.safeParse({ q: 'report', limit: 10, kind }).success).toBe(false)
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
  it('ItemSummary exposes a title but no body or raw representations', () => {
    const keys = Object.keys(ItemSummarySchema.shape)
    expect(keys).toEqual([
      'id', 'kind', 'title', 'preview', 'previewTruncated', 'flags', 'maskedSpanCount', 'sourceAppName',
      'byteLength', 'createdAt', 'pinned', 'tags', 'expiresAt', 'thumbnailDataUrl',
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

describe('item title contract', () => {
  it('normalizes whitespace and case-preserving titles, and clears empty titles', () => {
    const params = IpcRequestSchema['cairn:history.title'].params
    expect(params.parse({ id: summary.id, title: '  My \n Work\tClip  ' })).toEqual({
      id: summary.id, title: 'My Work Clip',
    })
    for (const title of ['', ' \n\t ', null]) {
      expect(params.parse({ id: summary.id, title })).toEqual({ id: summary.id, title: null })
    }
    expect(params.parse({ id: summary.id, title: 'x'.repeat(120) }).title).toHaveLength(120)
  })

  it('rejects oversized, missing, non-string titles and invalid ids', () => {
    const params = IpcRequestSchema['cairn:history.title'].params
    for (const title of ['x'.repeat(121), 42, {}, undefined]) {
      expect(params.safeParse({ id: summary.id, title }).success).toBe(false)
    }
    expect(params.safeParse({ id: 'invalid', title: 'Work' }).success).toBe(false)
  })

  it('defaults a legacy summary title to null and validates titled results', () => {
    expect(ItemSummarySchema.parse(summary).title).toBeNull()
    expect(ItemSummarySchema.parse({ ...summary, title: 'Work' }).title).toBe('Work')
    expect(ItemSummarySchema.safeParse({ ...summary, title: 'x'.repeat(121) }).success).toBe(false)
    const result = IpcRequestSchema['cairn:history.title'].result
    expect(result.parse({ title: null })).toEqual({ title: null })
    expect(result.parse({ title: 'Work' })).toEqual({ title: 'Work' })
  })
})

describe('palette ready contract', () => {
  it('accepts an integer shownAt and preserves either ready result', () => {
    const schema = IpcRequestSchema['cairn:palette.ready']
    expect(schema.params.parse({ shownAt: 1_767_225_600_000 })).toEqual({ shownAt: 1_767_225_600_000 })
    expect(schema.result.parse({ ready: true })).toEqual({ ready: true })
    expect(schema.result.parse({ ready: false })).toEqual({ ready: false })
  })

  it('rejects malformed timestamps and non-boolean acknowledgments', () => {
    const schema = IpcRequestSchema['cairn:palette.ready']
    for (const shownAt of [undefined, null, '123', 1.5, NaN, Infinity]) {
      expect(schema.params.safeParse({ shownAt }).success).toBe(false)
    }
    for (const ready of [undefined, null, 'true', 1]) {
      expect(schema.result.safeParse({ ready }).success).toBe(false)
    }
  })
})

describe('explicit image preview contract', () => {
  const png = readFileSync(fixturePath('formats', 'screenshot.png'))
  const result = IpcRequestSchema['cairn:history.preview'].result
  const preview = { text: '', isHtmlSource: false, truncated: false }

  it('preserves an optional PNG image and accepts existing text-only results', () => {
    const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`
    expect(result.parse({ ...preview, imageDataUrl })).toEqual({ ...preview, imageDataUrl })
    expect(result.parse(preview)).toEqual(preview)
  })

  it('rejects external URLs, SVG, malformed base64 and image bytes with a mismatched MIME', () => {
    for (const imageDataUrl of [
      'https://example.invalid/image.png',
      'file:///tmp/image.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:image/png;charset=utf-8;base64,aGVsbG8=',
      'data:image/png;base64,%%%invalid%%%',
      'data:image/png;base64,PHN2Zy8+',
      `data:image/jpeg;base64,${png.toString('base64')}`,
      `data:image/png;base64,${png.toString('base64')}\n`,
      `data:image/png;base64,${png.toString('base64')}#fragment`,
    ]) {
      expect(result.safeParse({ ...preview, imageDataUrl }).success).toBe(false)
    }
  })

  it('enforces the decoded 8 MiB boundary even when base64 lengths round to the same size', () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 1)
    png.copy(bytes)
    const imageDataUrl = `data:image/png;base64,${bytes.toString('base64')}`
    expect(result.safeParse({ ...preview, imageDataUrl }).success).toBe(false)
    const bounded = `data:image/png;base64,${bytes.subarray(0, -1).toString('base64')}`
    expect(result.parse({ ...preview, imageDataUrl: bounded }).imageDataUrl?.length).toBe(bounded.length)
  })

  it('never adds image data to an item summary', () => {
    const parsed = ItemSummarySchema.parse({
      ...summary, imageDataUrl: `data:image/png;base64,${png.toString('base64')}`,
    })
    expect(parsed).not.toHaveProperty('imageDataUrl')
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
