import type { Cancel, Clock, ItemKind, ItemSummary, Tab } from '@cairn/protocol'
import { tick } from 'svelte'
import {
  parseHistoryChanged,
  parseHotkeyStatus,
  parsePaletteShown,
  parseToast,
  safePreviewImageSrc,
  type CairnBridge,
  type CopyReason,
  type HotkeyStatus,
  type ToastPayload,
} from './api'

/** Row height stays fixed; the number of visible rows follows the available list height. */
export const ROW_HEIGHT_PX = 44
export const VISIBLE_ROWS = 8
export const OVERSCAN_ROWS = 2
/** Minimum page size; taller windows fetch enough rows to cover the viewport. */
export const FETCH_SPAN = 32
export const SEARCH_LIMIT = 50
export const TOAST_MS = 2_000

/** What the action bar can do to the selected row. `null` is a hint with no button behind it. */
export type PaletteAction = 'copy' | 'title' | 'pin' | 'tab' | 'delete' | 'close'

/**
 * The action bar. This started life as a row of grey text naming keyboard shortcuts, because pinning
 * and deleting were keyboard-only and nothing anywhere said so. Naming them was an improvement over
 * nothing and still left every action unreachable with a mouse, so each of these is now a real
 * button that both performs the action and shows the key that does it.
 *
 * `↑↓` keeps `action: null`: it is genuinely a hint, and a button that moved the selection by one
 * row would be a scrollbar with extra steps.
 *
 * `⌫` rather than "Backspace" because that is what is printed on the key.
 */
export const SHORTCUT_HINTS = [
  { keys: '↑↓', label: 'navigate', action: null },
  { keys: '⏎', label: 'copy', action: 'copy' },
  { keys: '⌘E', label: 'title', action: 'title' },
  { keys: '⌘P', label: 'pin', action: 'pin' },
  { keys: '⌘T', label: 'tab', action: 'tab' },
  { keys: '⌘⌫', label: 'delete', action: 'delete' },
  { keys: 'esc', label: 'close', action: 'close' },
] as const satisfies readonly { keys: string; label: string; action: PaletteAction | null }[]

/**
 * Which tab the palette is showing. `pinned` is deliberately its own kind rather than a reserved tag
 * name: pinning is a retention promise the store enforces, and a tag is not, so a user who created a
 * tab called "pinned" must not get retention exemption out of it.
 */
export type ActiveTab =
  | { readonly kind: 'all' }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'tag'; readonly tag: string }

export const ALL_TAB: ActiveTab = { kind: 'all' }
export const PINNED_TAB: ActiveTab = { kind: 'pinned' }

export function sameTab(a: ActiveTab, b: ActiveTab): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'tag' || b.kind !== 'tag' || a.tag === b.tag
}

export function tabLabel(t: ActiveTab): string {
  return t.kind === 'all' ? 'All' : t.kind === 'pinned' ? 'Pinned' : t.tag
}

/** The `list`/`search` narrowing a tab implies. `all` narrows by nothing. */
export function tabFilter(t: ActiveTab): { pinnedOnly: boolean; tag?: string } {
  if (t.kind === 'pinned') return { pinnedOnly: true }
  if (t.kind === 'tag') return { pinnedOnly: false, tag: t.tag }
  return { pinnedOnly: false }
}

export const EMPTY_TEXT = 'Nothing copied yet'
export const EMPTY_TAB_TEXT = 'Nothing filed under this tab yet — anything you file here is kept'
export const EMPTY_PINNED_TEXT = 'Nothing pinned yet — pinned copies are never evicted'
export const NO_RESULTS_TEXT = 'No matches'
export const TAG_PLACEHOLDER = 'Tab name, then ⏎'
/** Mirrors `TAGS_MAX_PER_ITEM` in `@cairn/protocol`; asserted equal by palette-state.test.ts, because
 *  the renderer cannot import that barrel at runtime (it re-exports node:crypto). */
export const MAX_TABS_PER_ITEM = 8
export const TAG_LIMIT_TEXT = `An item can be in at most ${String(MAX_TABS_PER_ITEM)} tabs`
export const TAG_FAILED_TEXT = 'Cairn could not file that into a tab'
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

export function windowStartFor(selected: number, windowStart: number, total: number, visibleRows = VISIBLE_ROWS): number {
  const maxStart = Math.max(0, total - visibleRows)
  let start = Math.min(Math.max(0, windowStart), maxStart)
  if (selected < start) start = selected
  else if (selected >= start + visibleRows) start = selected - visibleRows + 1
  return Math.max(0, Math.min(start, maxStart))
}

export function visibleRange(windowStart: number, total: number, visibleRows = VISIBLE_ROWS): { start: number; end: number } {
  const start = Math.max(0, windowStart - OVERSCAN_ROWS)
  const end = Math.max(start, Math.min(total, windowStart + visibleRows + OVERSCAN_ROWS))
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
  readonly afterRender?: () => Promise<void>
}

export class PaletteState {
  query = $state('')
  selectedIndex = $state(0)
  windowStart = $state(0)
  viewportRows = $state(VISIBLE_ROWS)
  total = $state(0)
  mode: 'recent' | 'search' = $state('recent')
  hotkeyStatus: HotkeyStatus = $state('active')
  hotkeyAccelerator = $state('')
  toast: ToastPayload | null = $state(null)
  statusText: string | null = $state(null)
  previewText = $state('')
  previewMime: 'text/plain' | 'text/html' = $state('text/plain')
  previewImageUrl: string | null = $state(null)
  previewTruncated = $state(false)
  shownAt = $state(0)
  nowMs = $state(0)
  /** Every tab that has at least one item, counted over the whole history, not the loaded page. */
  tabs: Tab[] = $state([])
  pinnedCount = $state(0)
  activeTab: ActiveTab = $state(ALL_TAB)
  /** The inline "file this into a tab" field. Open only while the user is typing a tab name. */
  tagging = $state(false)
  tagDraft = $state('')
  titleEditing = $state(false)
  titleDraft = $state('')
  revealedItemId: string | null = $state(null)
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
  #titleItemId: string | null = null
  #titleEditSeq = 0
  #openingSeq = 0

  constructor(deps: PaletteDeps) {
    this.#deps = deps
  }

  visibleRows: VisibleRow[] = $derived.by(() => {
    const { start, end } = visibleRange(this.windowStart, this.total, this.viewportRows)
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

  get contentHidden(): boolean {
    const item = this.selectedItem
    return item?.title != null && this.revealedItemId !== item.id
  }

  /** What the empty list should say, which depends entirely on WHY it is empty. */
  get emptyText(): string {
    if (this.mode === 'search') return NO_RESULTS_TEXT
    if (this.activeTab.kind === 'pinned') return EMPTY_PINNED_TEXT
    if (this.activeTab.kind === 'tag') return EMPTY_TAB_TEXT
    return EMPTY_TEXT
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
        this.#showToast(p)
      }),
      api.onHistoryChanged((raw) => {
        const p = parseHistoryChanged(raw)
        if (p === null) return
        if (this.mode === 'recent') this.pending = this.reload()
      }),
      api.onPaletteShown((raw) => {
        const p = parsePaletteShown(raw)
        if (p === null) return
        const openingSeq = ++this.#openingSeq
        // Main re-shows the same window, so "opening the palette" is an event, not a mount.
        this.shownAt = p.shownAt
        this.query = ''
        this.mode = 'recent'
        this.selectedIndex = 0
        this.windowStart = 0
        this.#cancelToast?.()
        this.#cancelToast = null
        this.toast = null
        // The tab resets with the query, for the same reason: the palette is opened to find the thing
        // you just copied far more often than to return to a tab you were in an hour ago.
        this.activeTab = ALL_TAB
        this.closeTagging()
        this.closeTitleEditing()
        this.hidePreview()
        this.pending = this.reload().then(async () => {
          await tick()
          await this.#deps.afterRender?.()
          if (openingSeq !== this.#openingSeq) return
          try {
            await api.paletteReady({ shownAt: p.shownAt })
          } catch {
            this.statusText = LOAD_FAILED_TEXT
          }
        })
      }),
    )
    await this.reload()
  }

  dispose(): void {
    this.#openingSeq += 1
    for (const un of this.#unsubs.splice(0)) un()
    this.#cancelToast?.()
    this.#cancelToast = null
    this.hidePreview()
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
    this.hidePreview()
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
      const res = await this.#deps.api.search({ q, limit: SEARCH_LIMIT, ...tabFilter(this.activeTab) })
      if (seq !== this.#listSeq) return
      this.rows = res.results.map((r) => r.item)
      this.rangesByIndex = res.results.map((r) => [...r.ranges])
      this.rowsOffset = 0
      this.total = res.results.length
      this.tabs = [...res.tabs]
      this.pinnedCount = res.pinnedCount
      this.statusText = null
    } catch {
      if (seq !== this.#listSeq) return
      this.statusText = LOAD_FAILED_TEXT
    }
    await this.loadPreview()
  }

  moveSelection(key: NavKey): void {
    this.hidePreview()
    this.selectedIndex = nextIndex(this.selectedIndex, key, this.total)
    this.windowStart = windowStartFor(this.selectedIndex, this.windowStart, this.total, this.viewportRows)
    this.pending = this.ensureLoaded().then(() => this.loadPreview())
  }

  async viewItem(index: number): Promise<void> {
    if (this.rowAt(index) === null) return
    this.hidePreview()
    this.selectedIndex = index
    await this.revealPreview()
  }

  setScrollTop(px: number): void {
    const maxStart = Math.max(0, this.total - this.viewportRows)
    this.windowStart = Math.max(0, Math.min(Math.floor(px / ROW_HEIGHT_PX), maxStart))
    this.pending = this.ensureLoaded()
  }

  setViewportHeight(px: number): void {
    const rows = Math.max(1, Math.floor(px / ROW_HEIGHT_PX))
    if (rows === this.viewportRows) return
    const selectionVisible = this.selectedIndex >= this.windowStart &&
      this.selectedIndex < this.windowStart + this.viewportRows
    this.viewportRows = rows
    this.windowStart = selectionVisible
      ? windowStartFor(this.selectedIndex, this.windowStart, this.total, rows)
      : Math.min(this.windowStart, Math.max(0, this.total - rows))
    this.pending = this.ensureLoaded()
  }

  async ensureLoaded(): Promise<void> {
    if (this.mode !== 'recent') return
    const { start, end } = visibleRange(this.windowStart, this.total, this.viewportRows)
    if (start >= this.rowsOffset && end <= this.rowsOffset + this.rows.length) return
    await this.#fetchWindow(Math.max(0, start))
  }

  async #fetchWindow(offset: number): Promise<void> {
    const seq = ++this.#listSeq
    try {
      const res = await this.#deps.api.list({
        limit: Math.min(200, Math.max(FETCH_SPAN, this.viewportRows + OVERSCAN_ROWS * 2)),
        offset,
        ...tabFilter(this.activeTab),
      })
      if (seq !== this.#listSeq) return
      this.rows = [...res.items]
      this.rowsOffset = offset
      this.total = res.total
      // Always from the list reply, never accumulated: a tab that just lost its last item has to
      // disappear from the bar in the same frame the row disappears from the list.
      this.tabs = [...res.tabs]
      this.pinnedCount = res.pinnedCount
      this.rangesByIndex = []
      this.statusText = null
      if (this.selectedIndex >= this.total) this.selectedIndex = Math.max(0, this.total - 1)
    } catch {
      if (seq !== this.#listSeq) return
      this.statusText = LOAD_FAILED_TEXT
    }
  }

  async loadPreview(): Promise<void> {
    const seq = ++this.#previewSeq
    const item = this.selectedItem
    if (item === null || this.contentHidden) {
      this.previewText = ''
      this.previewMime = 'text/plain'
      this.previewImageUrl = null
      this.previewTruncated = false
      return
    }
    try {
      const res = await this.#deps.api.preview({ id: item.id })
      if (seq !== this.#previewSeq) return
      this.previewText = res.text
      this.previewImageUrl = safePreviewImageSrc(res.imageDataUrl)
      this.previewTruncated = res.truncated
      // `text` is ALWAYS plain text: for an HTML item it is the HTML *source*, and `isHtmlSource`
      // only labels the pane. Nothing here ever becomes markup.
      this.previewMime = res.isHtmlSource ? 'text/html' : 'text/plain'
    } catch {
      if (seq !== this.#previewSeq) return
      this.previewText = ''
      this.previewMime = 'text/plain'
      this.previewImageUrl = null
      this.previewTruncated = false
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
        // Main already hides after copying; a delayed close would dismiss a newly opened palette.
        this.toast = null
        this.#cancelToast = null
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
    await this.refresh()
  }

  /** Switching tabs keeps the query, so "everything matching `invoice` in Work" is one click. */
  async selectTab(tab: ActiveTab): Promise<void> {
    if (sameTab(tab, this.activeTab)) return
    this.activeTab = tab
    this.selectedIndex = 0
    this.windowStart = 0
    this.closeTagging()
    this.closeTitleEditing()
    this.hidePreview()
    if (this.mode === 'search' && this.query.trim().length > 0) {
      await this.setQuery(this.query)
      return
    }
    await this.reload()
  }

  /** Opens the tab-name field for the selected row. There is no separate "create a tab" step: a tab
   *  exists because an item is in it, so typing a new name here is what creates one. */
  openTagging(): void {
    if (this.selectedItem === null) return
    this.closeTitleEditing()
    this.tagging = true
    this.tagDraft = ''
  }

  closeTagging(): void {
    this.tagging = false
    this.tagDraft = ''
  }

  openTitleEditing(): void {
    const item = this.selectedItem
    if (item === null) return
    this.#titleEditSeq += 1
    this.closeTagging()
    this.#titleItemId = item.id
    this.titleDraft = item.title ?? ''
    this.titleEditing = true
  }

  closeTitleEditing(): void {
    this.#titleEditSeq += 1
    this.titleEditing = false
    this.titleDraft = ''
    this.#titleItemId = null
  }

  async commitTitle(): Promise<void> {
    const id = this.#titleItemId
    const editSeq = this.#titleEditSeq
    if (id === null) return
    const title = this.titleDraft.replace(/\s+/g, ' ').trim() || null
    if (title !== null && title.length > 120) {
      this.#showToast({ text: 'Keep the title to 120 characters', tone: 'warn' })
      return
    }
    try {
      await this.#deps.api.setTitle({ id, title })
    } catch {
      if (editSeq !== this.#titleEditSeq) return
      this.#showToast({ text: 'Could not save the title. Try again.', tone: 'warn' })
      return
    }
    if (editSeq !== this.#titleEditSeq) return
    this.closeTitleEditing()
    this.hidePreview()
    await this.refresh()
  }

  async revealPreview(): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    this.revealedItemId = item.id
    await this.loadPreview()
  }

  hidePreview(): void {
    this.revealedItemId = null
    this.#previewSeq += 1
    this.previewText = ''
    this.previewMime = 'text/plain'
    this.previewImageUrl = null
    this.previewTruncated = false
  }

  async commitTag(): Promise<void> {
    const item = this.selectedItem
    const draft = this.tagDraft
    if (item === null || draft.trim().length === 0) {
      this.closeTagging()
      return
    }
    this.closeTagging()
    await this.#applyTag(item.id, draft, true)
  }

  /** Takes the selected item out of one tab. The chip's ✕ and nothing else calls this. */
  async untag(tag: string): Promise<void> {
    const item = this.selectedItem
    if (item === null) return
    await this.#applyTag(item.id, tag, false)
  }

  async #applyTag(id: string, tag: string, tagged: boolean): Promise<void> {
    try {
      await this.#deps.api.tag({ id, tag, tagged })
    } catch (e) {
      const code = e instanceof Error ? e.message : ''
      this.#showToast({ text: code === 'E_TAG_LIMIT' ? TAG_LIMIT_TEXT : TAG_FAILED_TEXT, tone: 'warn' })
      return
    }
    await this.refresh()
  }

  /** Re-runs whichever view is on screen. A tab change and a tag change both need this, and doing it
   *  with `reload()` alone silently dropped the user's query. */
  async refresh(): Promise<void> {
    if (this.mode === 'search' && this.query.trim().length > 0) {
      await this.setQuery(this.query)
      return
    }
    await this.reload()
  }

  /** The action bar's one entry point, so a button and its keyboard shortcut cannot drift apart. */
  run(action: PaletteAction): Promise<void> {
    switch (action) {
      case 'copy':
        return this.recall()
      case 'title':
        this.openTitleEditing()
        return Promise.resolve()
      case 'pin':
        return this.togglePin()
      case 'tab':
        this.openTagging()
        return Promise.resolve()
      case 'delete':
        return this.removeSelected()
      case 'close':
        return this.close()
    }
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
    await this.refresh()
  }

  async close(): Promise<void> {
    this.#openingSeq += 1
    this.#cancelToast?.()
    this.#cancelToast = null
    this.toast = null
    this.closeTitleEditing()
    this.hidePreview()
    await this.#deps.api.close()
  }

  #showToast(t: ToastPayload): void {
    this.#cancelToast?.()
    this.#cancelToast = null
    this.toast = t
  }
}
