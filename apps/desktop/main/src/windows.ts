import { ALLOWED_DEV_ORIGINS, CSP_POLICY_DEV, CSP_POLICY_PROD, PALETTE_HEIGHT, PALETTE_WIDTH } from './constants'
import type { Clock, IpcEventChannel, Logger } from '@cairn/protocol'

export type RuntimeMode = 'packaged' | 'dev'

/**
 * Hardening can only ever be TIGHTENED by the environment, never loosened. `CAIRN_HARDENED=1`
 * lets us run the packaged configuration from source (M1 never produces a real bundle — packaging
 * is M3 — so without this switch the hardened branch would be unreachable on a developer machine).
 * There is deliberately no variable that turns hardening off.
 */
export function resolveRuntimeMode(input: {
  isPackaged: boolean
  env: Readonly<Record<string, string | undefined>>
}): RuntimeMode {
  if (input.isPackaged) return 'packaged'
  return input.env['CAIRN_HARDENED'] === '1' ? 'packaged' : 'dev'
}

export interface PaletteWebPreferences {
  readonly preload: string
  readonly sandbox: true
  readonly contextIsolation: true
  readonly nodeIntegration: false
  readonly nodeIntegrationInSubFrames: false
  readonly nodeIntegrationInWorker: false
  readonly webSecurity: true
  readonly allowRunningInsecureContent: false
  readonly experimentalFeatures: false
  readonly webviewTag: false
  readonly enableBlinkFeatures: ''
  readonly spellcheck: false
  readonly devTools: boolean
}

/**
 * Spec §11 control 4, one line per flag:
 * - `sandbox: true`          the renderer runs in a real OS sandbox with no Node.
 * - `contextIsolation: true` page JS and preload JS get separate contexts, so the page cannot
 *                            reach into our bridge and rewrite it.
 * - `nodeIntegration: false` and the two `…InSubFrames` / `…InWorker` siblings, because setting
 *                            only the first one leaves iframes and workers with Node.
 * - `webSecurity: true`      keeps the same-origin policy on; turning it off is the single most
 *                            common Electron "fix" and it disables CSP enforcement too.
 * - `allowRunningInsecureContent: false` no http subresources on an https page.
 * - `experimentalFeatures: false` unshipped Blink features are unaudited attack surface.
 * - `webviewTag: false`      `<webview>` is a second, weaker window with its own preferences.
 * - `enableBlinkFeatures: ''` explicit empty, so a merge cannot quietly add one.
 * - `spellcheck: false`      the spellchecker downloads dictionaries and sees every character you
 *                            type into a search box over your clipboard history.
 * - `devTools: false`        in packaged builds. Verified on Electron 44.1.1: with this false,
 *                            `openDevTools()` is refused and `isDevToolsOpened()` stays false.
 */
export const PALETTE_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  enableBlinkFeatures: '',
  spellcheck: false,
  devTools: false,
} as const satisfies Omit<PaletteWebPreferences, 'preload'>

export function paletteWebPreferences(mode: RuntimeMode, preloadPath: string): PaletteWebPreferences {
  return { ...PALETTE_WEB_PREFERENCES, devTools: mode === 'dev', preload: preloadPath }
}

export function cspPolicy(mode: RuntimeMode): string {
  return mode === 'packaged' ? CSP_POLICY_PROD : CSP_POLICY_DEV
}

export type PaletteEntry =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }

/**
 * Spec §11 control 4: "all content loaded from local files with no remote origins". A packaged
 * build ignores `ELECTRON_RENDERER_URL` entirely, and a dev build accepts it only for the two
 * localhost origins electron-vite actually serves — so a stray variable in a shell profile can
 * never point the palette at a remote page.
 */
export function resolvePaletteEntry(
  mode: RuntimeMode,
  env: Readonly<Record<string, string | undefined>>,
  rendererIndexPath: string,
): PaletteEntry {
  if (mode === 'packaged') return { kind: 'file', path: rendererIndexPath }
  const url = env['ELECTRON_RENDERER_URL']
  if (url !== undefined && (ALLOWED_DEV_ORIGINS as readonly string[]).includes(url)) {
    return { kind: 'url', url }
  }
  return { kind: 'file', path: rendererIndexPath }
}

export interface PaletteWindowOptions {
  readonly width: number
  readonly height: number
  readonly show: false
  readonly frame: false
  readonly transparent: true
  readonly resizable: false
  readonly movable: false
  readonly minimizable: false
  readonly maximizable: false
  readonly fullscreenable: false
  readonly skipTaskbar: true
  readonly type: 'panel'
  readonly vibrancy: 'hud'
  readonly visualEffectState: 'active'
  readonly backgroundColor: '#00000000'
  readonly hasShadow: true
  readonly roundedCorners: true
  readonly acceptFirstMouse: true
  readonly webPreferences: PaletteWebPreferences
}

/**
 * Spec §4's flag list, one line of why each — these are not cosmetic:
 * - `type: 'panel'`             asks AppKit for an NSPanel, which can float over a full-screen app
 *                               without stealing its Space. (Day-0 spike: creation succeeds on
 *                               Electron 44.1.1; whether the native class really is NSPanel is
 *                               recorded in PLATFORM-NOTES.md.)
 * - `vibrancy: 'hud'`           the translucent Spotlight look.
 * - `visualEffectState:'active'` without it the vibrancy greys out, because another app is
 *                               frontmost the entire time the palette is open — which is always.
 * - `frame: false` + `transparent: true` + `backgroundColor: '#00000000'`  no title bar, and the
 *                               vibrancy shows through instead of a grey rectangle.
 * - `show: false`               spec §4: no window on launch. We are a background utility.
 * - `skipTaskbar: true`         never a window-list entry.
 * - `resizable/movable/minimizable/maximizable/fullscreenable: false`  a palette you can drag out
 *                               of position or minimise is a palette you have to hunt for.
 * - `hasShadow` + `roundedCorners`  so a frameless transparent window still reads as a window.
 * - `acceptFirstMouse: true`    the first click after the palette appears selects a row instead of
 *                               being eaten to activate the window.
 */
export function paletteWindowOptions(o: { mode: RuntimeMode; preloadPath: string }): PaletteWindowOptions {
  return {
    width: PALETTE_WIDTH,
    height: PALETTE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: 'panel',
    vibrancy: 'hud',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    acceptFirstMouse: true,
    webPreferences: paletteWebPreferences(o.mode, o.preloadPath),
  }
}

export interface NavGuardTarget {
  on(
    event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect',
    cb: (e: { preventDefault: () => void }, url: string) => void,
  ): void
  setWindowOpenHandler(handler: (d: { url: string }) => { action: 'deny' }): void
}

/**
 * All three, in this order. Verified on Electron 44.1.1: a renderer-initiated
 * `location.href = 'https://evil.example'` fires `will-frame-navigate`, and because our handler
 * calls `preventDefault()` there, `will-navigate` is never emitted at all. Guarding only
 * `will-navigate` would therefore look correct in a code review and do nothing.
 */
export const NAV_GUARD_EVENTS = ['will-navigate', 'will-frame-navigate', 'will-redirect'] as const

export function registerNavigationGuards(wc: NavGuardTarget, onBlocked: (url: string) => void): void {
  for (const event of NAV_GUARD_EVENTS) {
    wc.on(event, (e, url) => {
      e.preventDefault()
      onBlocked(url)
    })
  }
  wc.setWindowOpenHandler(({ url }) => {
    onBlocked(url)
    return { action: 'deny' }
  })
}

export interface HeadersReceivedDetails { readonly responseHeaders?: Record<string, string[]> }

/** Belt to the index.html meta tag's braces: a server-sent policy can never be weaker than ours. */
export function applyCspHeader(
  details: HeadersReceivedDetails,
  policy: string,
  callback: (r: { responseHeaders: Record<string, string[]> }) => void,
): void {
  const headers: Record<string, string[]> = { ...(details.responseHeaders ?? {}) }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-security-policy') delete headers[key]
    if (key.toLowerCase() === 'content-security-policy-report-only') delete headers[key]
  }
  headers['Content-Security-Policy'] = [policy]
  callback({ responseHeaders: headers })
}

export interface HardenableSession {
  webRequest: {
    onHeadersReceived(
      fn: (d: HeadersReceivedDetails, cb: (r: { responseHeaders: Record<string, string[]> }) => void) => void,
    ): void
  }
  setPermissionRequestHandler(
    fn: (wc: unknown, permission: string, cb: (granted: false) => void) => void,
  ): void
}

/** Deny-all, including permissions that do not exist yet: the default for a new permission must
 *  never be "granted" in a process holding decrypted clipboard history. */
export function hardenSession(
  session: HardenableSession,
  policy: string,
  onDenied: (permission: string) => void,
): void {
  session.webRequest.onHeadersReceived((details, cb) => { applyCspHeader(details, policy, cb) })
  session.setPermissionRequestHandler((_wc, permission, cb) => {
    onDenied(permission)
    cb(false)
  })
}

export interface BrowserWindowLike {
  readonly webContents: NavGuardTarget & {
    send(channel: string, payload: unknown): void
    isDestroyed(): boolean
  }
  setAlwaysOnTop(flag: boolean, level: string): void
  setVisibleOnAllWorkspaces(
    visible: boolean,
    opts: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean },
  ): void
  loadFile(path: string): Promise<void>
  loadURL(url: string): Promise<void>
  show(): void
  hide(): void
  focus(): void
  isVisible(): boolean
  isDestroyed(): boolean
  destroy(): void
}

export interface PaletteController {
  show(): void
  hide(): void
  isVisible(): boolean
  send<C extends IpcEventChannel>(channel: C, payload: unknown): void
  destroy(): void
}

export function createPaletteWindow(deps: {
  BrowserWindowCtor: new (o: PaletteWindowOptions) => BrowserWindowLike
  mode: RuntimeMode
  preloadPath: string
  rendererIndexPath: string
  env: Readonly<Record<string, string | undefined>>
  clock: Clock
  logger: Logger
}): PaletteController {
  const { BrowserWindowCtor, mode, preloadPath, rendererIndexPath, env, logger } = deps
  const win = new BrowserWindowCtor(paletteWindowOptions({ mode, preloadPath }))

  // 'screen-saver' is the only always-on-top level that clears a full-screen app.
  win.setAlwaysOnTop(true, 'screen-saver')
  // skipTransformProcessType keeps us an accessory app: without it this call flips the process
  // type and the Dock icon we hid comes straight back.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

  let blockedCount = 0
  registerNavigationGuards(win.webContents, () => {
    blockedCount += 1
    logger.warn('renderer.navigation-blocked', { count: blockedCount })
  })

  const entry = resolvePaletteEntry(mode, env, rendererIndexPath)
  const load = entry.kind === 'file' ? win.loadFile(entry.path) : win.loadURL(entry.url)
  void load.catch(() => { logger.error('renderer.navigation-blocked', { ok: false }) })

  return {
    show() {
      win.show()
      // An accessory app is not activated by show() alone, so the search field would get no
      // keystrokes. focus() is what makes typing work.
      win.focus()
    },
    hide() { win.hide() },
    isVisible() { return !win.isDestroyed() && win.isVisible() },
    send(channel, payload) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(channel, payload)
    },
    destroy() { if (!win.isDestroyed()) win.destroy() },
  }
}
