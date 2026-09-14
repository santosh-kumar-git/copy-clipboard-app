// TYPE-ONLY, always: the @cairn/protocol barrel re-exports hash.ts, which imports node:crypto, and a
// renderer bundle containing that fails with `"createHash" is not exported by
// "__vite-browser-external"`. Types are erased, so the shapes still cannot drift.
import type { IpcEvent, IpcEventChannel, IpcRequest, ItemSummary, Unsub } from '@cairn/protocol'

type ParamsOf<C extends IpcRequest['channel']> = Extract<IpcRequest, { channel: C }>['params']
type ResultOf<C extends IpcRequest['channel']> = Extract<IpcRequest, { channel: C }>['result']
type PayloadOf<C extends IpcEventChannel> = Extract<IpcEvent, { channel: C }>['payload']

export type ListParams = ParamsOf<'cairn:history.list'>
export type ListResult = ResultOf<'cairn:history.list'>
export type SearchParams = ParamsOf<'cairn:history.search'>
export type SearchResult = ResultOf<'cairn:history.search'>
export type PreviewResult = ResultOf<'cairn:history.preview'>
export type CopyResult = ResultOf<'cairn:recall.copy'>
export type CopyReason = CopyResult['reason']
export type SecurityStatus = ResultOf<'cairn:security.status'>
export type HistoryChangedPayload = PayloadOf<'cairn:history.changed'>
export type HotkeyStatusPayload = PayloadOf<'cairn:hotkey.status'>
export type ToastPayload = PayloadOf<'cairn:toast'>
export type PaletteShownPayload = PayloadOf<'cairn:palette.shown'>
export type PaletteHiddenPayload = PayloadOf<'cairn:palette.hidden'>
export type HotkeyStatus = HotkeyStatusPayload['status']

/** Named operations only; no generic IPC channel access. */
export interface CairnBridge {
  list(params: ListParams): Promise<ListResult>
  search(params: SearchParams): Promise<SearchResult>
  preview(params: { id: string }): Promise<PreviewResult>
  pin(params: { id: string; pinned: boolean }): Promise<{ pinned: boolean }>
  tag(params: { id: string; tag: string; tagged: boolean }): Promise<{ tags: string[] }>
  setTitle(params: { id: string; title: string | null }): Promise<{ title: string | null }>
  remove(params: { id: string }): Promise<{ removed: boolean }>
  copy(params: { id: string }): Promise<CopyResult>
  close(): Promise<{ closed: true }>
  paletteReady(params: { shownAt: number }): Promise<{ ready: boolean }>
  securityStatus(): Promise<SecurityStatus>
  onHistoryChanged(cb: (p: HistoryChangedPayload) => void): Unsub
  onHotkeyStatus(cb: (p: HotkeyStatusPayload) => void): Unsub
  onToast(cb: (p: ToastPayload) => void): Unsub
  onPaletteShown(cb: (p: PaletteShownPayload) => void): Unsub
  onPaletteHidden(cb: (p: PaletteHiddenPayload) => void): Unsub
}

declare global {
  interface Window { readonly cairn: CairnBridge }
}

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u)

export function parseHistoryChanged(u: unknown): HistoryChangedPayload | null {
  if (!isRecord(u)) return null
  const { reason, total } = u
  if (reason !== 'ingest' && reason !== 'update' && reason !== 'delete' && reason !== 'evict') return null
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null
  return { reason, total }
}

export function parseHotkeyStatus(u: unknown): HotkeyStatusPayload | null {
  if (!isRecord(u)) return null
  const { status, accelerator } = u
  if (status !== 'active' && status !== 'unbound' && status !== 'failed') return null
  if (typeof accelerator !== 'string' || accelerator.length > 64) return null
  return { status, accelerator }
}

export function parseToast(u: unknown): ToastPayload | null {
  if (!isRecord(u)) return null
  const { text, tone } = u
  if (typeof text !== 'string' || text.length === 0 || text.length > 200) return null
  if (tone !== 'info' && tone !== 'warn') return null
  return { text, tone }
}

export function parsePaletteShown(u: unknown): PaletteShownPayload | null {
  if (!isRecord(u)) return null
  const { shownAt } = u
  if (typeof shownAt !== 'number' || !Number.isInteger(shownAt)) return null
  return { shownAt }
}

export const THUMBNAIL_DATA_URL_PREFIX = 'data:image/jpeg;base64,'

/** Thumbnails accept only bounded JPEG data URLs. */
export function safeThumbnailSrc(value: ItemSummary['thumbnailDataUrl']): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith(THUMBNAIL_DATA_URL_PREFIX)) return null
  if (value.length > 64 * 1024) return null
  return value
}

export function safePreviewImageSrc(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(8 * 1024 * 1024 / 3) + 32) return null
  return /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null
}
