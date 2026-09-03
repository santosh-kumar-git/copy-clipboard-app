/**
 * The menu bar icon — the second way into the palette, and the only visible sign the app is running
 * at all. An accessory app has no Dock icon and no window most of the time, so without this there is
 * nothing to click and no way to quit except `pkill`.
 *
 * Deliberately NOT `setContextMenu()`. On macOS that binds the menu to the LEFT click too, so the
 * icon would only ever open a menu and never the palette. Left click toggles; right click pops the
 * menu explicitly.
 */
import { join } from 'node:path'
import type { Logger } from '@cairn/protocol'

/** Just enough of Electron's Tray to build against, so this module is testable with no Electron. */
export interface TrayLike {
  on(event: 'click' | 'right-click', cb: () => void): void
  setToolTip(text: string): void
  setIgnoreDoubleClickEvents(ignore: boolean): void
  popUpContextMenu(menu: unknown): void
  destroy(): void
}

export interface NativeImageLike {
  isEmpty(): boolean
  setTemplateImage(flag: boolean): void
}

export interface TrayMenuItem {
  readonly label?: string
  readonly type?: 'separator' | 'submenu' | 'radio'
  readonly accelerator?: string
  readonly checked?: boolean
  readonly submenu?: readonly TrayMenuItem[]
  readonly click?: () => void
}

/**
 * The choices offered for "how many copies to keep". Presets rather than a free-text field: this
 * lives in a menu, a menu cannot validate typing, and the schema's real range is 1..5000. Anyone who
 * wants 137 can still put it in config.json and it is honoured — the menu shows the closest preset as
 * selected rather than pretending the value is invalid.
 */
export const HISTORY_LIMIT_CHOICES = [50, 100, 200, 500, 1_000, 2_000] as const

export const TRAY_TOOLTIP = 'Cairn — clipboard history'

/**
 * The icon is a TEMPLATE image: black plus alpha only, so macOS recolours it for light, dark and
 * the pressed state. A colour icon looks wrong in half of those and cannot be fixed at runtime.
 */
export function trayIconPath(resourcesDir: string): string {
  return join(resourcesDir, 'trayTemplate.png')
}

/**
 * `Open Cairn` names the accelerator but has NO `accelerator` binding: the hot key is registered by
 * the Swift agent through Carbon, so declaring it here as well would either fail to bind or steal the
 * key from the agent. It is a label, not a binding.
 */
export function trayMenuTemplate(deps: {
  accelerator: string
  historyLimit: number
  onOpen: () => void
  onSetHistoryLimit: (limit: number) => void
  onQuit: () => void
}): readonly TrayMenuItem[] {
  return [
    { label: `Open Cairn   ${deps.accelerator}`, click: deps.onOpen },
    { type: 'separator' },
    {
      label: 'Keep the last…',
      type: 'submenu',
      submenu: HISTORY_LIMIT_CHOICES.map((n) => ({
        label: `${n.toLocaleString('en-US')} copies`,
        type: 'radio' as const,
        // The CLOSEST preset is checked, not an exact match, so a hand-edited config.json still shows
        // something sensible instead of a submenu with nothing selected.
        checked: n === closestChoice(deps.historyLimit),
        click: () => deps.onSetHistoryLimit(n),
      })),
    },
    { type: 'separator' },
    { label: 'Quit Cairn', click: deps.onQuit },
  ]
}

/** The preset nearest `limit`; ties go to the smaller, because keeping less is the safer default. */
export function closestChoice(limit: number): number {
  return HISTORY_LIMIT_CHOICES.reduce((best, n) =>
    Math.abs(n - limit) < Math.abs(best - limit) ? n : best,
  )
}

export interface CreateTrayDeps {
  readonly icon: NativeImageLike
  readonly makeTray: (icon: NativeImageLike) => TrayLike
  readonly buildMenu: (template: readonly TrayMenuItem[]) => unknown
  readonly accelerator: string
  readonly historyLimit: () => number
  readonly onToggle: () => void
  readonly onSetHistoryLimit: (limit: number) => void
  readonly onQuit: () => void
  readonly logger: Logger
}

/**
 * Returns null when the icon file is missing or unreadable, rather than throwing. A missing asset
 * must not take the whole app down: the hot key still works, and the log says why the icon is gone.
 */
export function createTray(deps: CreateTrayDeps): TrayLike | null {
  if (deps.icon.isEmpty()) {
    deps.logger.warn('tray.icon-missing')
    return null
  }
  deps.icon.setTemplateImage(true)
  const tray = deps.makeTray(deps.icon)
  tray.setToolTip(TRAY_TOOLTIP)
  // Without this a fast second click is swallowed as a double-click, so toggling feels broken.
  tray.setIgnoreDoubleClickEvents(true)
  tray.on('click', deps.onToggle)
  // The menu is rebuilt on every right-click rather than once, so the radio tick reflects the CURRENT
  // limit. A menu built at startup would keep showing the value the app launched with.
  tray.on('right-click', () => {
    tray.popUpContextMenu(
      deps.buildMenu(
        trayMenuTemplate({
          accelerator: deps.accelerator,
          historyLimit: deps.historyLimit(),
          onOpen: deps.onToggle,
          onSetHistoryLimit: deps.onSetHistoryLimit,
          onQuit: deps.onQuit,
        }),
      ),
    )
  })
  deps.logger.info('tray.ready')
  return tray
}
