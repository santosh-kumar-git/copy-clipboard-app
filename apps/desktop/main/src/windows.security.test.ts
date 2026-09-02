import { describe, expect, it } from 'vitest'
import { CSP_POLICY_DEV, CSP_POLICY_PROD } from './constants'
import {
  cspPolicy,
  PALETTE_WEB_PREFERENCES,
  paletteWebPreferences,
  resolvePaletteEntry,
  resolveRuntimeMode,
} from './windows'

const HARDENED = {
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
} as const

describe('webPreferences', () => {
  it('the exported baseline is exactly the hardened set', () => {
    expect(PALETTE_WEB_PREFERENCES).toEqual(HARDENED)
  })

  it('a packaged build gets the hardened set with DevTools off', () => {
    const prefs = paletteWebPreferences('packaged', '/tmp/preload.js')
    expect(prefs).toEqual({ ...HARDENED, preload: '/tmp/preload.js' })
  })

  it('a dev build differs ONLY by devTools', () => {
    const prefs = paletteWebPreferences('dev', '/tmp/preload.js')
    expect(prefs).toEqual({ ...HARDENED, devTools: true, preload: '/tmp/preload.js' })
  })
})

describe('resolveRuntimeMode', () => {
  it('is packaged when Electron says so', () => {
    expect(resolveRuntimeMode({ isPackaged: true, env: {} })).toBe('packaged')
  })

  it('is dev when Electron says so and nothing tightens it', () => {
    expect(resolveRuntimeMode({ isPackaged: false, env: {} })).toBe('dev')
  })

  it('CAIRN_HARDENED=1 can TIGHTEN a dev run', () => {
    expect(resolveRuntimeMode({ isPackaged: false, env: { CAIRN_HARDENED: '1' } })).toBe('packaged')
  })

  it('no environment variable can LOOSEN a packaged run', () => {
    // The asymmetry is the control: an env var that turns hardening off is a remote-exploitable
    // switch on any machine where the user's shell profile can be written.
    for (const env of [
      { CAIRN_HARDENED: '0' },
      { CAIRN_HARDENED: '' },
      { NODE_ENV: 'development' },
      { ELECTRON_IS_DEV: '1' },
      { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
    ]) {
      expect(resolveRuntimeMode({ isPackaged: true, env })).toBe('packaged')
    }
  })
})

describe('CSP', () => {
  it('the production policy has no unsafe-inline and no unsafe-eval', () => {
    expect(CSP_POLICY_PROD).not.toContain('unsafe-inline')
    expect(CSP_POLICY_PROD).not.toContain('unsafe-eval')
    expect(CSP_POLICY_PROD).not.toContain('*')
  })

  it('the production policy denies everything by default and denies all network', () => {
    expect(CSP_POLICY_PROD).toContain("default-src 'none'")
    expect(CSP_POLICY_PROD).toContain("connect-src 'none'")
    expect(CSP_POLICY_PROD).toContain("object-src 'none'")
    expect(CSP_POLICY_PROD).toContain("base-uri 'none'")
    expect(CSP_POLICY_PROD).toContain("form-action 'none'")
    expect(CSP_POLICY_PROD).toContain("frame-src 'none'")
    expect(CSP_POLICY_PROD).toContain("worker-src 'none'")
  })

  it('the production policy still allows the built renderer to run', () => {
    // Verified against Electron 44.1.1 on a real file:// load: an external module script and an
    // external stylesheet both work under `script-src 'self'` / `style-src 'self'`, while an
    // injected inline <script> and `new Function` are both blocked.
    expect(CSP_POLICY_PROD).toContain("script-src 'self'")
    expect(CSP_POLICY_PROD).toContain("style-src 'self'")
    expect(CSP_POLICY_PROD).toContain("img-src 'self' data:")
  })

  it('the dev policy is unreachable when packaged', () => {
    expect(cspPolicy('packaged')).toBe(CSP_POLICY_PROD)
    expect(cspPolicy('dev')).toBe(CSP_POLICY_DEV)
    expect(cspPolicy('packaged')).not.toBe(CSP_POLICY_DEV)
  })
})

describe('resolvePaletteEntry', () => {
  it('a packaged build always loads a local file, even with a renderer URL in the environment', () => {
    const entry = resolvePaletteEntry(
      'packaged',
      { ELECTRON_RENDERER_URL: 'http://evil.example/palette' },
      '/Apps/Cairn.app/out/renderer/index.html',
    )
    expect(entry).toEqual({ kind: 'file', path: '/Apps/Cairn.app/out/renderer/index.html' })
  })

  it('a dev build uses the vite dev server when electron-vite provides one', () => {
    const entry = resolvePaletteEntry(
      'dev',
      { ELECTRON_RENDERER_URL: 'http://localhost:5173' },
      '/repo/apps/desktop/out/renderer/index.html',
    )
    expect(entry).toEqual({ kind: 'url', url: 'http://localhost:5173' })
  })

  it('a dev build with no dev server falls back to the built file', () => {
    const entry = resolvePaletteEntry('dev', {}, '/repo/apps/desktop/out/renderer/index.html')
    expect(entry).toEqual({ kind: 'file', path: '/repo/apps/desktop/out/renderer/index.html' })
  })

  it('a dev build refuses a non-localhost renderer URL', () => {
    const entry = resolvePaletteEntry(
      'dev',
      { ELECTRON_RENDERER_URL: 'http://192.168.1.9:5173' },
      '/repo/apps/desktop/out/renderer/index.html',
    )
    expect(entry).toEqual({ kind: 'file', path: '/repo/apps/desktop/out/renderer/index.html' })
  })
})
