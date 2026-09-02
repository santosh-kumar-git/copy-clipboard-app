import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createTestClock, type Logger } from '@cairn/protocol'
import { PALETTE_HEIGHT, PALETTE_WIDTH } from './constants'
import {
  applyCspHeader,
  createPaletteWindow,
  hardenSession,
  NAV_GUARD_EVENTS,
  paletteWindowOptions,
  registerNavigationGuards,
  type BrowserWindowLike,
  type HardenableSession,
  type NavGuardTarget,
  type PaletteWindowOptions,
} from './windows'

const silentLogger = (): Logger => {
  const noop = (): void => {}
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop }
}

interface Recorded {
  readonly ctorOptions: PaletteWindowOptions[]
  readonly alwaysOnTop: unknown[][]
  readonly visibleOnAllWorkspaces: unknown[][]
  readonly loadedFiles: string[]
  readonly loadedUrls: string[]
  readonly sent: [string, unknown][]
  readonly navGuards: string[]
  windowOpenHandler: ((d: { url: string }) => { action: 'deny' }) | null
  shown: number
  hidden: number
  destroyed: number
}

function fakeBrowserWindow(): { Ctor: new (o: PaletteWindowOptions) => BrowserWindowLike; rec: Recorded } {
  const rec: Recorded = {
    ctorOptions: [],
    alwaysOnTop: [],
    visibleOnAllWorkspaces: [],
    loadedFiles: [],
    loadedUrls: [],
    sent: [],
    navGuards: [],
    windowOpenHandler: null,
    shown: 0,
    hidden: 0,
    destroyed: 0,
  }
  class Fake {
    readonly webContents: unknown
    private visible = false
    constructor(options: PaletteWindowOptions) {
      rec.ctorOptions.push(options)
      const emitter = new EventEmitter()
      this.webContents = {
        on: (ev: string, cb: (...a: unknown[]) => void) => { rec.navGuards.push(ev); emitter.on(ev, cb) },
        setWindowOpenHandler: (h: (d: { url: string }) => { action: 'deny' }) => { rec.windowOpenHandler = h },
        send: (channel: string, payload: unknown) => { rec.sent.push([channel, payload]) },
        isDestroyed: () => rec.destroyed > 0,
      }
    }
    setAlwaysOnTop(...args: unknown[]): void { rec.alwaysOnTop.push(args) }
    setVisibleOnAllWorkspaces(...args: unknown[]): void { rec.visibleOnAllWorkspaces.push(args) }
    loadFile(p: string): Promise<void> { rec.loadedFiles.push(p); return Promise.resolve() }
    loadURL(u: string): Promise<void> { rec.loadedUrls.push(u); return Promise.resolve() }
    show(): void { this.visible = true; rec.shown += 1 }
    hide(): void { this.visible = false; rec.hidden += 1 }
    focus(): void {}
    isVisible(): boolean { return this.visible }
    isDestroyed(): boolean { return rec.destroyed > 0 }
    destroy(): void { rec.destroyed += 1 }
  }
  return { Ctor: Fake as unknown as new (o: PaletteWindowOptions) => BrowserWindowLike, rec }
}

describe('paletteWindowOptions', () => {
  const o = paletteWindowOptions({ mode: 'packaged', preloadPath: '/tmp/preload.js' })

  it('is an NSPanel-shaped, chromeless, invisible-on-launch window', () => {
    expect(o.type).toBe('panel')
    expect(o.frame).toBe(false)
    expect(o.transparent).toBe(true)
    expect(o.show).toBe(false)
    expect(o.skipTaskbar).toBe(true)
    expect(o.width).toBe(PALETTE_WIDTH)
    expect(o.height).toBe(PALETTE_HEIGHT)
  })

  it('uses the hud vibrancy that stays lit while another app is frontmost', () => {
    expect(o.vibrancy).toBe('hud')
    expect(o.visualEffectState).toBe('active')
  })

  it('cannot be resized, moved, minimised, maximised or fullscreened', () => {
    expect(o.resizable).toBe(false)
    expect(o.movable).toBe(false)
    expect(o.minimizable).toBe(false)
    expect(o.maximizable).toBe(false)
    expect(o.fullscreenable).toBe(false)
  })

  it('carries the hardened webPreferences and the preload path', () => {
    expect(o.webPreferences.sandbox).toBe(true)
    expect(o.webPreferences.contextIsolation).toBe(true)
    expect(o.webPreferences.nodeIntegration).toBe(false)
    expect(o.webPreferences.devTools).toBe(false)
    expect(o.webPreferences.preload).toBe('/tmp/preload.js')
  })
})

describe('registerNavigationGuards', () => {
  it('prevents all three navigation events and denies every window open', () => {
    const emitter = new EventEmitter()
    let handler: ((d: { url: string }) => { action: 'deny' }) | null = null
    const blocked: string[] = []
    const wc = {
      on: (ev: string, cb: (e: { preventDefault: () => void }, url: string) => void) => { emitter.on(ev, cb) },
      setWindowOpenHandler: (h: (d: { url: string }) => { action: 'deny' }) => { handler = h },
    } as unknown as NavGuardTarget

    registerNavigationGuards(wc, (u) => blocked.push(u))

    // All three, because Electron 44 emits `will-frame-navigate` FIRST and a preventDefault there
    // means `will-navigate` never fires at all — so guarding only one of them is a coin flip.
    expect(NAV_GUARD_EVENTS).toEqual(['will-navigate', 'will-frame-navigate', 'will-redirect'])
    for (const ev of NAV_GUARD_EVENTS) {
      const preventDefault = vi.fn()
      emitter.emit(ev, { preventDefault }, `https://evil.example/${ev}`)
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }
    expect(handler).not.toBeNull()
    expect(handler!({ url: 'https://evil.example/popup' })).toEqual({ action: 'deny' })
    expect(blocked).toEqual([
      'https://evil.example/will-navigate',
      'https://evil.example/will-frame-navigate',
      'https://evil.example/will-redirect',
      'https://evil.example/popup',
    ])
  })
})

describe('applyCspHeader', () => {
  it('replaces any existing policy header, matching case-insensitively', () => {
    let got: Record<string, string[]> | null = null
    applyCspHeader(
      { responseHeaders: { 'content-security-policy': ['default-src *'], 'X-Other': ['1'] } },
      "default-src 'none'",
      (r) => { got = r.responseHeaders },
    )
    expect(got).toEqual({ 'X-Other': ['1'], 'Content-Security-Policy': ["default-src 'none'"] })
  })

  it('adds the policy when the response carries no headers at all', () => {
    let got: Record<string, string[]> | null = null
    applyCspHeader({}, "default-src 'none'", (r) => { got = r.responseHeaders })
    expect(got).toEqual({ 'Content-Security-Policy': ["default-src 'none'"] })
  })
})

describe('hardenSession', () => {
  it('installs the CSP header hook and denies every permission request', () => {
    let headersFn: ((d: unknown, cb: (r: unknown) => void) => void) | null = null
    let permFn: ((wc: unknown, p: string, cb: (granted: false) => void) => void) | null = null
    const denied: string[] = []
    const session = {
      webRequest: { onHeadersReceived: (fn: typeof headersFn) => { headersFn = fn } },
      setPermissionRequestHandler: (fn: typeof permFn) => { permFn = fn },
    } as unknown as HardenableSession

    hardenSession(session, "default-src 'none'", (p) => denied.push(p))

    expect(headersFn).not.toBeNull()
    expect(permFn).not.toBeNull()
    // Every permission is refused, including ones that do not exist yet: the default must be deny.
    for (const permission of ['media', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'notifications', 'some-future-permission']) {
      const granted = vi.fn()
      permFn!({}, permission, granted as unknown as (g: false) => void)
      expect(granted).toHaveBeenCalledWith(false)
    }
    expect(denied).toEqual(['media', 'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'notifications', 'some-future-permission'])
  })
})

describe('createPaletteWindow', () => {
  it('creates a hidden panel, pins it above the screen saver and across all workspaces', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: {},
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()

    expect(rec.ctorOptions).toHaveLength(1)
    expect(rec.ctorOptions[0]!.show).toBe(false)
    // 'screen-saver' is the only level that puts the palette above a full-screen app.
    expect(rec.alwaysOnTop).toEqual([[true, 'screen-saver']])
    // `skipTransformProcessType: true` matters: without it this call flips the process type and
    // the Dock icon we hid with app.dock.hide() comes back.
    expect(rec.visibleOnAllWorkspaces).toEqual([
      [true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
    ])
    expect(rec.navGuards).toEqual(['will-navigate', 'will-frame-navigate', 'will-redirect'])
    expect(rec.windowOpenHandler).not.toBeNull()
    expect(rec.shown).toBe(0)
  })

  it('loads the local file in a packaged build and never a URL', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()
    expect(rec.loadedFiles).toEqual(['/tmp/renderer/index.html'])
    expect(rec.loadedUrls).toEqual([])
  })

  it('show / hide / isVisible / send / destroy drive the underlying window', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    const palette = createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: {},
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()
    expect(palette.isVisible()).toBe(false)
    palette.show()
    expect(palette.isVisible()).toBe(true)
    palette.send('cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' })
    palette.hide()
    expect(palette.isVisible()).toBe(false)
    palette.destroy()
    expect(rec.shown).toBe(1)
    expect(rec.hidden).toBe(1)
    expect(rec.destroyed).toBe(1)
    expect(rec.sent).toEqual([['cairn:toast', { text: 'Copied — press Cmd+V', tone: 'info' }]])
  })

  it('send after destroy is a no-op instead of a crash', async () => {
    const { Ctor, rec } = fakeBrowserWindow()
    const palette = createPaletteWindow({
      BrowserWindowCtor: Ctor,
      mode: 'packaged',
      preloadPath: '/tmp/preload.js',
      rendererIndexPath: '/tmp/renderer/index.html',
      env: {},
      clock: createTestClock(),
      logger: silentLogger(),
    })
    await Promise.resolve()
    palette.destroy()
    palette.send('cairn:toast', { text: 'late', tone: 'info' })
    expect(rec.sent).toEqual([])
  })
})
