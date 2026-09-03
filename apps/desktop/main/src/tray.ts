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
  readonly type?: 'separator'
  readonly accelerator?: string
  readonly click?: () => void
}

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
  onOpen: () => void
  onQuit: () => void
}): readonly TrayMenuItem[] {
  return [
    { label: `Open Cairn   ${deps.accelerator}`, click: deps.onOpen },
    { type: 'separator' },
    { label: 'Quit Cairn', click: deps.onQuit },
  ]
}

export interface CreateTrayDeps {
  readonly icon: NativeImageLike
  readonly makeTray: (icon: NativeImageLike) => TrayLike
  readonly buildMenu: (template: readonly TrayMenuItem[]) => unknown
  readonly accelerator: string
  readonly onToggle: () => void
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
  const menu = deps.buildMenu(
    trayMenuTemplate({ accelerator: deps.accelerator, onOpen: deps.onToggle, onQuit: deps.onQuit }),
  )
  tray.on('right-click', () => { tray.popUpContextMenu(menu) })
  deps.logger.info('tray.ready')
  return tray
}
