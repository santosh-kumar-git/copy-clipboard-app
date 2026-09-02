import { describe, expect, it } from 'vitest'
import { APP_NAME } from '@cairn/protocol'
import {
  assertEditMenuIntact,
  buildAppMenuTemplate,
  editSubmenuRoles,
  REQUIRED_EDIT_ROLES,
  type MenuItemTemplate,
} from './menu'

describe('buildAppMenuTemplate', () => {
  const template = buildAppMenuTemplate(APP_NAME)

  it('has an application menu and an Edit menu, and nothing else', () => {
    expect(template.map((m) => m.label)).toEqual(['Cairn', 'Edit'])
  })

  it('the Edit menu carries every clipboard role in the order macOS users expect', () => {
    expect(editSubmenuRoles(template)).toEqual([
      'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll',
    ])
  })

  it('the required roles are exactly the ones that make Cmd+A/C/V work in our search field', () => {
    expect(REQUIRED_EDIT_ROLES).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    for (const role of REQUIRED_EDIT_ROLES) {
      expect(editSubmenuRoles(template)).toContain(role)
    }
  })

  it('the application menu can quit', () => {
    const appMenu = template.find((m) => m.label === 'Cairn')
    expect(appMenu?.submenu?.map((i) => i.role ?? i.type)).toEqual(['about', 'separator', 'quit'])
  })
})

describe('assertEditMenuIntact', () => {
  it('accepts the real template', () => {
    expect(() => assertEditMenuIntact(buildAppMenuTemplate(APP_NAME))).not.toThrow()
  })

  it('throws when the whole Edit menu is gone', () => {
    const gutted: MenuItemTemplate[] = [{ label: 'Cairn', submenu: [{ role: 'quit' }] }]
    expect(() => assertEditMenuIntact(gutted)).toThrow(
      'cairn: the Edit menu is missing — Cmd+A, Cmd+C and Cmd+V would be dead in the search field',
    )
  })

  it('throws naming the exact role that went missing', () => {
    const trimmed: MenuItemTemplate[] = [
      { label: 'Cairn', submenu: [{ role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] },
    ]
    expect(() => assertEditMenuIntact(trimmed)).toThrow(
      'cairn: the Edit menu is missing roles: selectAll',
    )
  })

  it('throws for an empty template, which is what setApplicationMenu(null) amounts to', () => {
    expect(() => assertEditMenuIntact([])).toThrow(/Edit menu is missing/)
  })
})
