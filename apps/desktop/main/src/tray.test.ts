import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '@cairn/store'
import {
  createTray,
  TRAY_TOOLTIP,
  trayIconPath,
  trayMenuTemplate,
  type NativeImageLike,
  type TrayLike,
} from './tray'

function fakeIcon(empty = false): NativeImageLike & { template: boolean } {
  return {
    template: false,
    isEmpty: () => empty,
    setTemplateImage(flag: boolean) { this.template = flag },
  }
}

function fakeTray(): TrayLike & {
  handlers: Map<string, () => void>
  tooltip: string | null
  ignoredDoubleClicks: boolean
  poppedUp: unknown[]
  destroyed: boolean
} {
  const handlers = new Map<string, () => void>()
  return {
    handlers,
    tooltip: null,
    ignoredDoubleClicks: false,
    poppedUp: [],
    destroyed: false,
    on(event, cb) { handlers.set(event, cb) },
    setToolTip(text) { this.tooltip = text },
    setIgnoreDoubleClickEvents(flag) { this.ignoredDoubleClicks = flag },
    popUpContextMenu(menu) { this.poppedUp.push(menu) },
    destroy() { this.destroyed = true },
  }
}

const build = (over: { empty?: boolean } = {}) => {
  const icon = fakeIcon(over.empty ?? false)
  const tray = fakeTray()
  const onToggle = vi.fn()
  const onQuit = vi.fn()
  const menus: readonly unknown[][] = []
  const result = createTray({
    icon,
    makeTray: () => tray,
    buildMenu: (template) => { (menus as unknown[][]).push([...template]); return { menu: true } },
    accelerator: 'Cmd+Shift+V',
    onToggle,
    onQuit,
    logger: silentLogger,
  })
  return { icon, tray, onToggle, onQuit, menus, result }
}

describe('trayMenuTemplate', () => {
  it('offers exactly open and quit, separated', () => {
    const t = trayMenuTemplate({ accelerator: 'Cmd+Shift+V', onOpen: () => {}, onQuit: () => {} })
    expect(t.map((i) => i.type ?? 'item')).toEqual(['item', 'separator', 'item'])
    expect(t[0]?.label).toContain('Cmd+Shift+V')
    expect(t[2]?.label).toBe('Quit Cairn')
  })

  it('names the accelerator WITHOUT binding it', () => {
    // The hot key belongs to the Swift agent's Carbon registration. Declaring `accelerator` here
    // would have Electron try to bind it too — either failing, or stealing it from the agent.
    const t = trayMenuTemplate({ accelerator: 'Cmd+Shift+V', onOpen: () => {}, onQuit: () => {} })
    for (const item of t) expect(item.accelerator).toBeUndefined()
  })

  it('shows the accelerator that actually bound, not the configured one', () => {
    const t = trayMenuTemplate({ accelerator: 'Cmd+Shift+C', onOpen: () => {}, onQuit: () => {} })
    expect(t[0]?.label).toContain('Cmd+Shift+C')
  })
})

describe('trayIconPath', () => {
  it('names the Template icon, which is what makes macOS recolour it', () => {
    expect(trayIconPath('/somewhere/Resources')).toBe('/somewhere/Resources/trayTemplate.png')
  })
})

describe('createTray', () => {
  it('marks the image as a template so light and dark mode both work', () => {
    const { icon } = build()
    expect(icon.template).toBe(true)
  })

  it('left click toggles the palette', () => {
    const { tray, onToggle } = build()
    tray.handlers.get('click')?.()
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('right click pops the menu up rather than toggling', () => {
    const { tray, onToggle } = build()
    tray.handlers.get('right-click')?.()
    expect(tray.poppedUp).toHaveLength(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('does NOT bind the menu with setContextMenu, which would break left click', () => {
    // On macOS setContextMenu() attaches the menu to the left click too, so the icon could only
    // ever open a menu and never the palette. Asserting the absence, because the working behaviour
    // and the broken one look identical in code review.
    const { tray } = build()
    expect('setContextMenu' in tray).toBe(false)
    expect(tray.handlers.has('click')).toBe(true)
  })

  it('ignores double clicks, so a fast second click still toggles', () => {
    const { tray } = build()
    expect(tray.ignoredDoubleClicks).toBe(true)
  })

  it('sets a tooltip that names the app', () => {
    const { tray } = build()
    expect(tray.tooltip).toBe(TRAY_TOOLTIP)
  })

  it('wires the menu items to the same callbacks as the clicks', () => {
    const { menus, onToggle, onQuit } = build()
    const template = menus[0] as { label?: string; click?: () => void }[]
    template[0]?.click?.()
    expect(onToggle).toHaveBeenCalledTimes(1)
    template[2]?.click?.()
    expect(onQuit).toHaveBeenCalledTimes(1)
  })

  it('returns null instead of throwing when the icon file is missing', () => {
    // A missing asset must not take the app down: the hot key still works without an icon, and a
    // crash here would be invisible because an accessory app has no window to crash in front of.
    const { result, onToggle } = build({ empty: true })
    expect(result).toBeNull()
    expect(onToggle).not.toHaveBeenCalled()
  })
})
