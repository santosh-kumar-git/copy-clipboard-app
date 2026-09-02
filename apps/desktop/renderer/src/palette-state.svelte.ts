import type { ItemKind } from '@cairn/protocol'

/** Fixed row geometry. jsdom has no layout — `clientHeight` is always 0 and `scrollIntoView` does
 *  not exist — so nothing in the palette may be measured from the DOM. */
export const ROW_HEIGHT_PX = 44
export const VISIBLE_ROWS = 8
export const OVERSCAN_ROWS = 2
/** Rows fetched per `list` call. The renderer never holds more than this many previews. */
export const FETCH_SPAN = 32
export const SEARCH_LIMIT = 50
export const TOAST_MS = 2_000

export const EMPTY_TEXT = 'Nothing copied yet'
export const NO_RESULTS_TEXT = 'No matches'
export const SECRET_PIN_REFUSED_TEXT = 'Secrets cannot be pinned — this one expires in 5 minutes'
export const RECALL_FAILED_TEXT = 'Cairn could not put that on the clipboard'
export const LOAD_FAILED_TEXT = 'Cairn could not read its history'

/** Mirrors `TOAST_COPIED_MANUAL` / `TOAST_COPIED_SECURE_INPUT` in `@cairn/protocol`; asserted equal
 *  by palette-state.test.ts, because the renderer cannot import that barrel at runtime. */
export const RECALL_TOAST_TEXT: Readonly<Record<
  'user-preference' | 'no-permission' | 'elevated-target' | 'secure-input',
  string
>> = {
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
