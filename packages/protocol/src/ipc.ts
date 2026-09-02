import * as z from 'zod'

export const IPC_REQUEST_CHANNELS = [
  'cairn:history.list',
  'cairn:history.search',
  'cairn:history.preview',
  'cairn:history.pin',
  'cairn:history.remove',
  'cairn:recall.copy',
  'cairn:palette.close',
  'cairn:security.status',
] as const
export type IpcRequestChannel = (typeof IPC_REQUEST_CHANNELS)[number]

export const IPC_EVENT_CHANNELS = [
  'cairn:history.changed',
  'cairn:hotkey.status',
  'cairn:toast',
  'cairn:palette.shown',
] as const
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]

export const ItemIdSchema = z.string().length(26).regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)

/** What crosses to the renderer. Note there is no `repRefs` and no raw bytes: the renderer can
 *  never ask for a body, only for the masked preview and the thumbnail. */
export const ItemSummarySchema = z.object({
  id: ItemIdSchema,
  kind: z.enum(['text', 'richtext', 'image', 'files']),
  preview: z.string().max(512),
  previewTruncated: z.boolean(),
  flags: z.array(z.enum(['secret', 'concealed', 'transient', 'auto-generated', 'excluded', 'no-sync', 'cut'])),
  maskedSpanCount: z.int().min(0),
  sourceAppName: z.string().nullable(),
  byteLength: z.int().min(0),
  createdAt: z.int(),
  pinned: z.boolean(),
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
    }),
    result: z.object({ items: z.array(ItemSummarySchema), total: z.int().min(0) }),
  },
  'cairn:history.search': {
    params: z.object({ q: z.string().max(256), limit: z.int().min(1).max(200) }),
    result: z.object({
      results: z.array(z.object({ item: ItemSummarySchema, score: z.number(), ranges: z.array(z.int().min(0)) })),
    }),
  },
  'cairn:history.preview': {
    params: z.object({ id: ItemIdSchema }),
    // `text` is ALWAYS plain text. When the item is HTML, this is the HTML *source*, and the
    // renderer prints it as text. `isHtmlSource` exists only to label the pane.
    result: z.object({ text: z.string().max(8192), isHtmlSource: z.boolean(), truncated: z.boolean() }),
  },
  'cairn:history.pin': {
    params: z.object({ id: ItemIdSchema, pinned: z.boolean() }),
    result: z.object({ pinned: z.boolean() }),
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
