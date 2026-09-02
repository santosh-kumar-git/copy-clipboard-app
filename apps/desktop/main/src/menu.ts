export interface MenuItemTemplate {
  readonly label?: string
  readonly role?: string
  readonly type?: 'separator'
  readonly submenu?: readonly MenuItemTemplate[]
}

/**
 * Spec §4: "an accessory app has no menu bar, so Cmd+A/C/V would otherwise be dead inside our own
 * search field". These four roles are the ones the search field needs; Electron attaches the
 * standard accelerators to them automatically (verified on 44.1.1: copy -> CommandOrControl+C,
 * paste -> CommandOrControl+V, selectAll -> CommandOrControl+A).
 */
export const REQUIRED_EDIT_ROLES = ['cut', 'copy', 'paste', 'selectAll'] as const

export function buildAppMenuTemplate(appName: string): readonly MenuItemTemplate[] {
  return [
    { label: appName, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
  ]
}

/** The Edit submenu's roles with separators stripped, in order. */
export function editSubmenuRoles(template: readonly MenuItemTemplate[]): readonly string[] {
  const edit = template.find((m) => m.label === 'Edit')
  return (edit?.submenu ?? [])
    .filter((i) => i.type !== 'separator' && i.role !== undefined)
    .map((i) => i.role as string)
}

/**
 * THROWS. Called from the Electron entry before the first window exists, so deleting the Edit menu
 * is a loud crash at launch instead of a search field where Cmd+A silently does nothing — a bug
 * nobody reports because nobody believes it.
 */
export function assertEditMenuIntact(template: readonly MenuItemTemplate[]): void {
  const edit = template.find((m) => m.label === 'Edit')
  if (edit === undefined || edit.submenu === undefined || edit.submenu.length === 0) {
    throw new Error(
      'cairn: the Edit menu is missing — Cmd+A, Cmd+C and Cmd+V would be dead in the search field',
    )
  }
  const roles = new Set(editSubmenuRoles(template))
  const missing = REQUIRED_EDIT_ROLES.filter((r) => !roles.has(r))
  if (missing.length > 0) {
    throw new Error(`cairn: the Edit menu is missing roles: ${missing.join(', ')}`)
  }
}
