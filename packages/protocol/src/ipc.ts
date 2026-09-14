import * as z from 'zod'
import { PREVIEW_IMAGE_MAX_BYTES, TABS_MAX, TAG_MAX_CHARS, TAGS_MAX_PER_ITEM, TITLE_MAX_CHARS, normalizeTitle } from './constants'

export const IPC_REQUEST_CHANNELS = [
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
] as const
export type IpcRequestChannel = (typeof IPC_REQUEST_CHANNELS)[number]

export const IPC_EVENT_CHANNELS = [
  'cairn:history.changed',
  'cairn:hotkey.status',
  'cairn:toast',
  'cairn:palette.shown',
  'cairn:palette.hidden',
] as const
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]

export const ItemIdSchema = z.string().length(26).regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

/** A tab name as it crosses the boundary: already normalised, so a schema violation here means the
 *  normaliser was skipped rather than that the user typed something odd. */
export const TagSchema = z.string().min(1).max(TAG_MAX_CHARS)
export const TabSchema = z.object({ tag: TagSchema, count: z.int().min(0) })
export const TitleSchema = z.string().max(TITLE_MAX_CHARS).nullable().transform(normalizeTitle)

function isPreviewImageDataUrl(value: string): boolean {
  if (value.length > 'data:image/jpeg;base64,'.length + Math.ceil(PREVIEW_IMAGE_MAX_BYTES / 3) * 4) return false
  const prefix = /^data:image\/(png|jpeg);base64,/.exec(value)
  if (prefix === null) return false
  const encoded = value.slice(prefix[0].length)
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  if (encoded.length / 4 * 3 - padding > PREVIEW_IMAGE_MAX_BYTES) return false
  const tail = encoded.slice(-4)
  if (btoa(atob(tail)) !== tail) return false
  const head = atob(encoded.slice(0, 12))
  return prefix[1] === 'png' ? head.startsWith('\x89PNG\r\n\x1a\n') : head.startsWith('\xff\xd8\xff')
}

export const PreviewImageDataUrlSchema = z.string().refine(
  isPreviewImageDataUrl,
  'expected a PNG or JPEG base64 data URL within the preview image limit',
)

/** What crosses to the renderer. Note there is no `repRefs` and no raw bytes: the renderer can
 *  never ask for a body, only for the masked preview and the thumbnail. */
export const ItemSummarySchema = z.object({
  id: ItemIdSchema,
  kind: z.enum(['text', 'richtext', 'image', 'files']),
  title: TitleSchema.default(null),
  preview: z.string().max(512),
  previewTruncated: z.boolean(),
  flags: z.array(z.enum(['secret', 'concealed', 'transient', 'auto-generated', 'excluded', 'no-sync', 'cut'])),
  maskedSpanCount: z.int().min(0),
  sourceAppName: z.string().nullable(),
  byteLength: z.int().min(0),
  createdAt: z.int(),
  pinned: z.boolean(),
  tags: z.array(TagSchema).max(TAGS_MAX_PER_ITEM),
  expiresAt: z.int().nullable(),
  thumbnailDataUrl: z.string().startsWith('data:image/jpeg;base64,').nullable(),
})

export const IpcRequestSchema = {
  'cairn:history.list': {
    params: z.object({
      limit: z.int().min(1).max(200),
      offset: z.int().min(0),
      kind: z.enum(['text', 'richtext', 'image', 'files']).optional(),
      pinnedOnly: z.boolean().default(false),
      /** The active tab, when it is a user tag. The Pinned tab uses `pinnedOnly` instead. */
      tag: TagSchema.optional(),
    }),
    // `tabs` and `pinnedCount` are always counted over the WHOLE live set, never over the filtered
    // page: a tab bar whose counts changed depending on which tab was open would be unreadable.
    result: z.object({
      items: z.array(ItemSummarySchema),
      total: z.int().min(0),
      tabs: z.array(TabSchema).max(TABS_MAX),
      pinnedCount: z.int().min(0),
    }),
  },
  'cairn:history.search': {
    // Searching inside a tab searches that tab: a query typed with Work open that answered from the
    // whole history would silently ignore the tab the user is looking at.
    params: z.object({
      q: z.string().max(256),
      limit: z.int().min(1).max(200),
      kind: z.enum(['text', 'richtext', 'image', 'files']).optional(),
      pinnedOnly: z.boolean().default(false),
      tag: TagSchema.optional(),
    }),
    // `tabs`/`pinnedCount` ride along here as well as on `list` so the tab bar cannot go stale while
    // a query is being typed — the bar is on screen the whole time the search results are.
    result: z.object({
      results: z.array(z.object({ item: ItemSummarySchema, score: z.number(), ranges: z.array(z.int().min(0)) })),
      tabs: z.array(TabSchema).max(TABS_MAX),
      pinnedCount: z.int().min(0),
    }),
  },
  'cairn:history.preview': {
    params: z.object({ id: ItemIdSchema }),
    // `text` is ALWAYS plain text. When the item is HTML, this is the HTML *source*, and the
    // renderer prints it as text. `isHtmlSource` exists only to label the pane.
    result: z.object({
      text: z.string().max(8192),
      isHtmlSource: z.boolean(),
      truncated: z.boolean(),
      imageDataUrl: PreviewImageDataUrlSchema.optional(),
    }),
  },
  'cairn:history.pin': {
    params: z.object({ id: ItemIdSchema, pinned: z.boolean() }),
    result: z.object({ pinned: z.boolean() }),
  },
  'cairn:history.tag': {
    // `tag` is the RAW string the user typed; the handler normalises it. `tagged: false` removes it.
    params: z.object({ id: ItemIdSchema, tag: z.string().max(TAG_MAX_CHARS), tagged: z.boolean() }),
    result: z.object({ tags: z.array(TagSchema).max(TAGS_MAX_PER_ITEM) }),
  },
  'cairn:history.title': {
    params: z.object({ id: ItemIdSchema, title: TitleSchema }),
    result: z.object({ title: TitleSchema }),
  },
  'cairn:history.remove': {
    params: z.object({ id: ItemIdSchema }),
    result: z.object({ removed: z.boolean() }),
  },
  'cairn:recall.copy': {
    params: z.object({ id: ItemIdSchema }),
    // Deliberately the M2 `deliver()` shape. In M1 `result` is always 'copied-manual'.
    result: z.object({
      result: z.literal('copied-manual'),
      reason: z.enum(['user-preference', 'no-permission', 'secure-input', 'elevated-target']),
    }),
  },
  'cairn:palette.close': { params: z.object({}), result: z.object({ closed: z.literal(true) }) },
  'cairn:palette.ready': {
    params: z.object({ shownAt: z.int() }),
    result: z.object({ ready: z.boolean() }),
  },
  'cairn:security.status': {
    params: z.object({}),
    result: z.object({
      keyringMode: z.enum(['os-keyring', 'passphrase', 'locked']),
      encryptedAtRest: z.boolean(),
      dataDirMode: z.string(),               // '700'
      notes: z.array(z.string()),
    }),
  },
} as const

export const IpcEventSchema = {
  'cairn:history.changed': z.object({ reason: z.enum(['ingest', 'update', 'delete', 'evict']), total: z.int() }),
  'cairn:hotkey.status': z.object({ status: z.enum(['active', 'unbound', 'failed']), accelerator: z.string() }),
  'cairn:toast': z.object({ text: z.string().max(200), tone: z.enum(['info', 'warn']) }),
  'cairn:palette.shown': z.object({ shownAt: z.int() }),
  'cairn:palette.hidden': z.object({}),
} as const

export type IpcRequest = {
  [C in IpcRequestChannel]: {
    channel: C
    params: z.output<(typeof IpcRequestSchema)[C]['params']>
    result: z.output<(typeof IpcRequestSchema)[C]['result']>
  }
}[IpcRequestChannel]

export type IpcEvent = {
  [C in IpcEventChannel]: { channel: C; payload: z.output<(typeof IpcEventSchema)[C]> }
}[IpcEventChannel]

export type ItemSummary = z.output<typeof ItemSummarySchema>
export type ItemPreview = z.output<(typeof IpcRequestSchema)['cairn:history.preview']['result']>
