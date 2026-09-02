import * as z from 'zod'
import {
  err,
  IPC_EVENT_CHANNELS,
  IPC_REQUEST_CHANNELS,
  IpcEventSchema,
  IpcRequestSchema,
  ok,
  type IpcEventChannel,
  type IpcRequestChannel,
  type Item,
  type ItemId,
  type ItemSummary,
  type KeyringMode,
  type Logger,
  type Result,
  type Unsub,
} from '@cairn/protocol'
import type { History } from '@cairn/history'

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => Promise<unknown>): void
  removeHandler(channel: string): void
}

export interface RecallPort {
  copy(id: ItemId): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>>
}
export interface PreviewPort {
  preview(id: ItemId): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>>
}
export interface SecurityStatusPort {
  status(): {
    keyringMode: KeyringMode
    encryptedAtRest: boolean
    dataDirMode: string
    notes: readonly string[]
  }
}

export interface IpcDeps {
  readonly ipcMain: IpcMainLike
  readonly history: History
  readonly preview: PreviewPort
  readonly recall: RecallPort
  readonly palette: { hide(): void; isVisible(): boolean }
  readonly security: SecurityStatusPort
  readonly logger: Logger
}

/**
 * The renderer's view of an item. Note what is NOT here: `repRefs`, `contentHash`, `updatedAt` and
 * the mask span offsets. The renderer can never ask for a body, and it cannot reconstruct where in
 * the raw text a secret was — only how many secrets there were.
 */
export function toItemSummary(item: Item, thumbnailDataUrl: string | null): ItemSummary {
  return {
    id: item.id,
    kind: item.kind,
    preview: item.preview,
    previewTruncated: item.previewTruncated,
    flags: [...item.flags],
    maskedSpanCount: item.maskSpans.length,
    sourceAppName: item.sourceApp?.name ?? null,
    byteLength: item.byteLength,
    createdAt: item.createdAt,
    pinned: item.pinned,
    expiresAt: item.expiresAt,
    thumbnailDataUrl,
  } as ItemSummary
}

type Handler = (params: unknown, deps: IpcDeps) => Promise<Result<unknown>>

/** One entry per frozen channel. Adding a key here that is not in `IPC_REQUEST_CHANNELS` is a
 *  compile error, and so is omitting one. */
const HANDLERS: Record<IpcRequestChannel, Handler> = {
  'cairn:history.list': async (params, deps) => {
    const p = params as { limit: number; offset: number; kind?: Item['kind']; pinnedOnly: boolean }
    const { items, total } = deps.history.list(p)
    return ok({ items: items.map((it) => toItemSummary(it, null)), total })
  },
  'cairn:history.search': async (params, deps) => {
    const p = params as { q: string; limit: number }
    const results = deps.history.search(p.q, p.limit)
    return ok({
      results: results.map((r) => ({
        item: toItemSummary(r.item, null),
        score: r.score,
        ranges: [...r.ranges],
      })),
    })
  },
  'cairn:history.preview': async (params, deps) =>
    await deps.preview.preview((params as { id: string }).id as ItemId),
  'cairn:history.pin': async (params, deps) => {
    const p = params as { id: string; pinned: boolean }
    return await deps.history.pin(p.id as ItemId, p.pinned)
  },
  'cairn:history.remove': async (params, deps) =>
    await deps.history.remove((params as { id: string }).id as ItemId),
  'cairn:recall.copy': async (params, deps) =>
    await deps.recall.copy((params as { id: string }).id as ItemId),
  'cairn:palette.close': async (_params, deps) => {
    deps.palette.hide()
    return ok({ closed: true as const })
  },
  'cairn:security.status': async (_params, deps) => {
    const s = deps.security.status()
    return ok({ ...s, notes: [...s.notes] })
  },
}

/**
 * Spec §11 control 8. Both directions are validated:
 *  - inbound `params` against `IpcRequestSchema[c].params` BEFORE any domain call, so a malformed
 *    message is rejected rather than trusted, and the domain layer never sees renderer-shaped input;
 *  - outbound payload against `IpcRequestSchema[c].result` before replying, so a bug in main cannot
 *    hand the renderer a shape it will treat as trustworthy.
 * The reply envelope is `Result<T>` (contract §6); `result` validates the `value`.
 */
export function registerIpcHandlers(deps: IpcDeps): Unsub {
  for (const channel of IPC_REQUEST_CHANNELS) {
    // The indexed access is a union of schema types; one local widening keeps every call site clean.
    const schemas = IpcRequestSchema[channel] as unknown as { params: z.ZodType; result: z.ZodType }
    const handler = HANDLERS[channel]

    deps.ipcMain.handle(channel, async (_event, raw) => {
      const parsedParams = schemas.params.safeParse(raw)
      if (!parsedParams.success) {
        deps.logger.warn('ipc.rejected', { code: 'E_IPC_REJECTED' })
        return err('E_IPC_REJECTED', z.prettifyError(parsedParams.error))
      }

      let outcome: Result<unknown>
      try {
        outcome = await handler(parsedParams.data, deps)
      } catch {
        // The message is deliberately generic: an exception string can contain anything, including
        // a fragment of clipboard content from a template literal somewhere upstream.
        deps.logger.error('ipc.rejected', { code: 'E_INTERNAL' })
        return err('E_INTERNAL', 'the handler threw')
      }
      if (!outcome.ok) return outcome

      const parsedResult = schemas.result.safeParse(outcome.value)
      if (!parsedResult.success) {
        deps.logger.error('ipc.rejected', { code: 'E_INTERNAL' })
        return err('E_INTERNAL', 'the handler returned a shape the contract does not allow')
      }
      return ok(parsedResult.data)
    })
  }

  return () => {
    for (const channel of IPC_REQUEST_CHANNELS) deps.ipcMain.removeHandler(channel)
  }
}

export interface EventTarget_ {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

/** Main→renderer events are validated too, so a bug here cannot poison renderer state. */
export function sendIpcEvent(
  target: EventTarget_,
  channel: IpcEventChannel,
  payload: unknown,
  logger: Logger,
): boolean {
  if (!(IPC_EVENT_CHANNELS as readonly string[]).includes(channel)) return false
  if (target.isDestroyed()) return false
  const schema = IpcEventSchema[channel] as unknown as z.ZodType
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    logger.error('ipc.rejected', { code: 'E_IPC_REJECTED' })
    return false
  }
  target.send(channel, parsed.data)
  return true
}
