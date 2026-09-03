import type { Cancel, Clock, ItemKind, ItemSummary } from '@cairn/protocol'
import {
  parseHistoryChanged,
  parseHotkeyStatus,
  parsePaletteShown,
  parseToast,
  type CairnBridge,
  type CopyReason,
  type HotkeyStatus,
  type ToastPayload,
} from './api'

/** Fixed row geometry. jsdom has no layout — `clientHeight` is always 0 and `scrollIntoView` does
 *  not exist — so nothing in the palette may be measured from the DOM. */
export const ROW_HEIGHT_PX = 44
export const VISIBLE_ROWS = 8
export const OVERSCAN_ROWS = 2
/** Rows fetched per `list` call. The renderer never holds more than this many previews. */
export const FETCH_SPAN = 32
export const SEARCH_LIMIT = 50
export const TOAST_MS = 2_000

/**
 * The shortcut hints. Pinning and deleting have worked from day one — Cmd+P and Cmd+Backspace — but
 * nothing anywhere said so, so as far as anyone using the app was concerned the pin feature did not
 * exist. A feature reachable only by reading the source is not shipped.
 *
 * `⌫` rather than "Backspace" because that is what is printed on the key.
 */
export const SHORTCUT_HINTS = [
  { keys: '↑↓', label: 'navigate' },
  { keys: '⏎', label: 'copy' },
  { keys: '⌘P', label: 'pin' },
  { keys: '⌘⌫', label: 'delete' },
  { keys: 'esc', label: 'close' },
] as const

export const EMPTY_TEXT = 'Nothing copied yet'
export const NO_RESULTS_TEXT = 'No matches'
export const SECRET_PIN_REFUSED_TEXT = 'Secrets cannot be pinned — this one expires in 5 minutes'
export const RECALL_FAILED_TEXT = 'Cairn could not put that on the clipboard'
export const LOAD_FAILED_TEXT = 'Cairn could not read its history'

/** Mirrors `TOAST_COPIED_MANUAL` / `TOAST_COPIED_SECURE_INPUT` in `@cairn/protocol`; asserted equal
 *  by palette-state.test.ts, because the renderer cannot import that barrel at runtime. */
export const RECALL_TOAST_TEXT: Readonly<Record<CopyReason, string>> = {
  'user-preference': 'Copied — press Cmd+V',
  'no-permission': 'Copied — press Cmd+V',
  'elevated-target': 'Copied — press Cmd+V',
  'secure-input': 'A password field is focused — press Cmd+V yourself',
}

/** Spec §6: a dead hotkey is a first-class state, so the row is persistent and names the fix. */
export function hotkeyFailedText(accelerator: string): string {
  return `${accelerator} is not registered — another app already owns it. Try Cmd+Shift+C instead; rebinding lives in Settings, which this build does not have yet.`
}

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'

/** Wrap-around: Down past the end goes to the first row, Up past the start to the last. */
export function nextIndex(current: number, key: NavKey, total: number): number {
  if (total <= 0) return 0
  switch (key) {
    case 'ArrowDown':
      return current + 1 >= total ? 0 : current + 1
    case 'ArrowUp':
      return current - 1 < 0 ? total - 1 : current - 1
    case 'Home':
      return 0
    case 'End':
      return total - 1
  }
}

export function windowStartFor(selected: number, windowStart: number, total: number): number {
  const maxStart = Math.max(0, total - VISIBLE_ROWS)
  let start = Math.min(Math.max(0, windowStart), maxStart)
  if (selected < start) start = selected
  else if (selected >= start + VISIBLE_ROWS) start = selected - VISIBLE_ROWS + 1
  return Math.max(0, Math.min(start, maxStart))
}

export function visibleRange(windowStart: number, total: number): { start: number; end: number } {
  const start = Math.max(0, windowStart - OVERSCAN_ROWS)
  const end = Math.max(start, Math.min(total, windowStart + VISIBLE_ROWS + OVERSCAN_ROWS))
  return { start, end }
}

export interface Segment {
  readonly text: string
  readonly hit: boolean
}

/** ufuzzy ranges are a FLAT array of alternating [start, end) offsets (contract §5.6). Malformed
 *  input is ignored rather than thrown, because these offsets crossed a process boundary. */
export function highlightSegments(preview: string, ranges: readonly number[]): Segment[] {
  const out: Segment[] = []
  let cursor = 0
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i]
    const end = ranges[i + 1]
    if (start === undefined || end === undefined) break
    if (start < cursor || end <= start || end > preview.length) break
    if (start > cursor) out.push({ text: preview.slice(cursor, start), hit: false })
    out.push({ text: preview.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < preview.length) out.push({ text: preview.slice(cursor), hit: false })
  return out
}

/** `file:///Users/me/a%20b.txt` -> `/Users/me/a b.txt`. Displayed and copied only. Spec §11 control 3
 *  promises no shell in the capture or recall path at all on macOS: a copied path is attacker-chosen
 *  text, so it is never interpolated into a command line. The renderer spawns nothing, and the
 *  shell-execution ban in the wiring task's security suite — no child-process spawn helper and no
 *  `shell: true` anywhere under `packages/**` or `apps/desktop/**` — is what keeps that true. */
export function filePathsFromPreview(preview: string): string[] {
  return preview
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (!line.startsWith('file://')) return line
      const withoutScheme = line.slice('file://'.length)
      try {
        return decodeURIComponent(withoutScheme)
      } catch {
        return withoutScheme
      }
    })
}

/**
 * What a row shows when it has no text preview. An image legitimately has none, so those rows
 * rendered completely blank — a badge and empty space, indistinguishable from the bug where the
 * preview cache had been evicted. Describing the item instead means a blank row always means
 * something is wrong, rather than sometimes being normal.
 */
export function rowFallbackLabel(item: { kind: ItemKind; byteLength: number }): string {
  return `${kindChipLabel(item.kind)} · ${formatBytes(item.byteLength)}`
}

/** Binary-ish but rounded for humans: 1 decimal place under 10 units, none above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function kindChipLabel(kind: ItemKind): string {
  switch (kind) {
    case 'text':
      return 'Text'
    case 'richtext':
      return 'Rich text'
    case 'image':
      return 'Image'
    case 'files':
      return 'Files'
  }
}

export function secretExpiryLabel(expiresAt: number | null, nowMs: number): string | null {
  if (expiresAt === null) return null
  const leftMs = expiresAt - nowMs
  if (leftMs <= 0) return 'expired'
  const seconds = Math.ceil(leftMs / 1_000)
  return seconds >= 60 ? `expires in ${Math.ceil(seconds / 60)}m` : `expires in ${seconds}s`
}

export interface VisibleRow {
  readonly index: number
  readonly top: number
  readonly item: ItemSummary | null
  readonly ranges: readonly number[]
}

export interface PaletteDeps {
  readonly api: CairnBridge
  readonly clock: Clock
}

export class PaletteState {
  query = $state('')
  selectedIndex = $state(0)
  windowStart = $state(0)
  total = $state(0)
  mode: 'recent' | 'search' = $state('recent')
  hotkeyStatus: HotkeyStatus = $state('active')
  hotkeyAccelerator = $state('')
  toast: ToastPayload | null = $state(null)
  statusText: string | null = $state(null)
  previewText = $state('')
  previewMime: 'text/plain' | 'text/html' = $state('text/plain')
  shownAt = $state(0)
  nowMs = $state(0)
  /** At most FETCH_SPAN summaries — the renderer never holds the whole history. */
  rows: (ItemSummary | null)[] = $state([])
  rowsOffset = $state(0)
  rangesByIndex: number[][] = $state([])

  /** The promise of the most recent background work. The UI never awaits it; tests do. */
  pending: Promise<unknown> = Promise.resolve()

  readonly #deps: PaletteDeps
  readonly #unsubs: (() => void)[] = []
  #listSeq = 0
  #previewSeq = 0
  #cancelToast: Cancel | null = null

  constructor(deps: PaletteDeps) {
    this.#deps = deps
  }

  visibleRows: VisibleRow[] = $derived.by(() => {
    const { start, end } = visibleRange(this.windowStart, this.total)
    const out: VisibleRow[] = []
    for (let i = start; i < end; i++) {
      out.push({
        index: i,
        top: i * ROW_HEIGHT_PX,
        item: this.rowAt(i),
        ranges: this.rangesByIndex[i] ?? [],
      })
    }
    return out
  })

  get selectedItem(): ItemSummary | null {
    return this.rowAt(this.selectedIndex)
  }

  get loadedRowCount(): number {
    return this.rows.length
  }

  rowAt(index: number): ItemSummary | null {
    const local = index - this.rowsOffset
    if (local < 0 || local >= this.rows.length) return null
    return this.rows[local] ?? null
  }

  async start(): Promise<void> {
    const { api } = this.#deps
    this.#unsubs.push(
      api.onHotkeyStatus((raw) => {
        const p = parseHotkeyStatus(raw)
        if (p === null) return
        this.hotkeyStatus = p.status
        this.hotkeyAccelerator = p.accelerator
      }),
      api.onToast((raw) => {
        const p = parseToast(raw)
        if (p === null) return
        this.toast = p
      }),
      api.onHistoryChanged((raw) => {
        const p = parseHistoryChanged(raw)
        if (p === null) return
        if (this.mode === 'recent') this.pending = this.reload()
      }),
      api.onPaletteShown((raw) => {
        const p = parsePaletteShown(raw)
        if (p === null) return
        // Main re-shows the same window, so "opening the palette" is an event, not a mount.
        this.shownAt = p.shownAt
        this.query = ''
        this.mode = 'recent'
        this.selectedIndex = 0
        this.windowStart = 0
        this.toast = null
        this.pending = this.reload()
      }),
    )
    await this.reload()
  }

  dispose(): void {
    for (const un of this.#unsubs.splice(0)) un()
    this.#cancelToast?.()
    this.#cancelToast = null
  }

  async reload(): Promise<void> {
    this.mode = 'recent'
    this.nowMs = this.#deps.clock.now()
    this.rowsOffset = 0
    this.rows = []
    this.rangesByIndex = []
    await this.#fetchWindow(0)
    await this.loadPreview()
  }

  async setQuery(q: string): Promise<void> {
    this.query = q
    this.selectedIndex = 0
    this.windowStart = 0
    if (q.trim().length === 0) {
      await this.reload()
      return
    }
    this.mode = 'search'
    const seq = ++this.#listSeq
    try {
      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT })
      if (seq !== this.#listSeq) return
      this.rows = res.results.map((r) => r.item)
      this.rangesByIndex = res.results.map((r) => [...r.ranges])
      this.rowsOffset = 0
      this.total = res.results.length
      this.statusText = null
    } catch {
      if (seq !== this.#listSeq) return
      this.statusText = LOAD_FAILED_TEXT
    }
    await this.loadPreview()
  }

  moveSelection(key: NavKey): void {
    this.selectedIndex = nextIndex(this.selectedIndex, key, this.total)
    this.windowStart = windowStartFor(this.selectedIndex, this.windowStart, this.total)
    this.pending = Promise.all([this.ensureLoaded(), this.loadPreview()])
  }

  setScrollTop(px: number): void {
    const maxStart = Math.max(0, this.total - VISIBLE_ROWS)
    this.windowStart = Math.max(0, Math.min(Math.floor(px / ROW_HEIGHT_PX), maxStart))
    this.pending = this.ensureLoaded()
  }

  async ensureLoaded(): Promise<void> {
    if (this.mode !== 'recent') return
    const { start, end } = visibleRange(this.windowStart, this.total)
    if (start >= this.rowsOffset && end <= this.rowsOffset + this.rows.length) return
    await this.#fetchWindow(Math.max(0, start))
  }

  async #fetchWindow(offset: number): Promise<void> {
    const seq = ++this.#listSeq
    try {
      const res = await this.#deps.api.list({ limit: FETCH_SPAN, offset, pinnedOnly: false })
      if (seq !== this.#listSeq) return
      this.rows = [...res.items]
      this.rowsOffset = offset
      this.total = res.total
      this.rangesByIndex = []
      this.statusText = null
      if (this.selectedIndex >= this.total) this.selectedIndex = Math.max(0, this.total - 1)
    } catch {
      if (seq !== this.#listSeq) return
      this.statusText = LOAD_FAILED_TEXT
    }
  }

  async loadPreview(): Promise<void> {
    const item = this.selectedItem
    if (item === null) {
      this.previewText = ''
      this.previewMime = 'text/plain'
      return
    }
    const seq = ++this.#previewSeq
    try {
      const res = await this.#deps.api.preview({ id: item.id })
      if (seq !== this.#previewSeq) return
      this.previewText = res.text
      // `text` is ALWAYS plain text: for an HTML item it is the HTML *source*, and `isHtmlSource`
      // only labels the pane. Nothing here ever becomes markup.
      this.previewMime = res.isHtmlSource ? 'text/html' : 'text/plain'
    } catch {
      if (seq !== this.#previewSeq) return
      this.previewText = ''
      this.previewMime = 'text/plain'
    }
  }

  async recall(): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    try {
      const res = await this.#deps.api.copy({ id: item.id })
      // M1 has no synthetic paste: the toast IS the outcome, and it is exactly the M2
      // Accessibility-denied degraded mode (spec §6).
      this.#showToast({ text: RECALL_TOAST_TEXT[res.reason], tone: 'info' })
      this.#cancelToast = this.#deps.clock.setTimeout(() => {
        void this.close()
      }, TOAST_MS)
    } catch {
      this.#showToast({ text: RECALL_FAILED_TEXT, tone: 'warn' })
    }
  }

  async togglePin(): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    // Spec §11 control 5: secrets are exempt from pinning. Refusing here, with a reason, beats
    // sending an IPC we know will fail.
    if (item.flags.includes('secret')) {
      this.#showToast({ text: SECRET_PIN_REFUSED_TEXT, tone: 'warn' })
      return
    }
    try {
      await this.#deps.api.pin({ id: item.id, pinned: !item.pinned })
    } catch {
      this.#showToast({ text: LOAD_FAILED_TEXT, tone: 'warn' })
      return
    }
    await this.reload()
  }

  async removeSelected(): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    try {
      await this.#deps.api.remove({ id: item.id })
    } catch {
      this.#showToast({ text: LOAD_FAILED_TEXT, tone: 'warn' })
      return
    }
    await this.reload()
  }

  async close(): Promise<void> {
    this.#cancelToast?.()
    this.#cancelToast = null
    this.toast = null
    await this.#deps.api.close()
  }

  #showToast(t: ToastPayload): void {
    this.#cancelToast?.()
    this.#cancelToast = null
    this.toast = t
  }
}
