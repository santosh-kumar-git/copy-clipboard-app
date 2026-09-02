import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { stripComments } from './source-scan'
import { EventEmitter } from 'node:events'
import { CSP_POLICY_DEV, CSP_POLICY_PROD } from '../apps/desktop/main/src/constants'
import {
  cspPolicy,
  hardenSession,
  NAV_GUARD_EVENTS,
  PALETTE_WEB_PREFERENCES,
  paletteWebPreferences,
  registerNavigationGuards,
  resolvePaletteEntry,
} from '../apps/desktop/main/src/windows'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Comment-stripped, deliberately. index.ts documents WHY it never calls
// `Menu.setApplicationMenu(null)` and why `app.setName` must precede
// `app.requestSingleInstanceLock()`, so a raw read finds those identifiers inside the explanation
// first: `indexOf` then reports the comment's position and every ordering assertion below inverts.
// The repo-wide rule is already "a ban matches non-comment lines only" (security/source-scan.ts);
// this file has to follow it or it fails on the code being correctly documented.
const ENTRY = stripComments(readFileSync(join(REPO_ROOT, 'apps/desktop/main/src/index.ts'), 'utf8'))

describe('the hardened set is what the window actually gets', () => {
  it('every dangerous webPreference is off in a packaged build', () => {
    const p = paletteWebPreferences('packaged', '/preload.js')
    expect(p.sandbox).toBe(true)
    expect(p.contextIsolation).toBe(true)
    expect(p.nodeIntegration).toBe(false)
    expect(p.nodeIntegrationInSubFrames).toBe(false)
    expect(p.nodeIntegrationInWorker).toBe(false)
    expect(p.webSecurity).toBe(true)
    expect(p.allowRunningInsecureContent).toBe(false)
    expect(p.experimentalFeatures).toBe(false)
    expect(p.webviewTag).toBe(false)
    expect(p.enableBlinkFeatures).toBe('')
    expect(p.spellcheck).toBe(false)
    expect(p.devTools).toBe(false)
  })

  it('the baseline constant cannot be widened without this test noticing', () => {
    expect(Object.keys(PALETTE_WEB_PREFERENCES).sort()).toEqual([
      'allowRunningInsecureContent', 'contextIsolation', 'devTools', 'enableBlinkFeatures',
      'experimentalFeatures', 'nodeIntegration', 'nodeIntegrationInSubFrames',
      'nodeIntegrationInWorker', 'sandbox', 'spellcheck', 'webSecurity', 'webviewTag',
    ])
  })
})

describe('CSP', () => {
  it('production has no unsafe-inline, no unsafe-eval and no wildcard', () => {
    expect(CSP_POLICY_PROD).not.toContain('unsafe-inline')
    expect(CSP_POLICY_PROD).not.toContain('unsafe-eval')
    expect(CSP_POLICY_PROD).not.toContain('*')
    expect(CSP_POLICY_PROD).not.toContain('http://')
    expect(CSP_POLICY_PROD).not.toContain('https://')
  })

  it('production denies all network egress from the renderer', () => {
    expect(CSP_POLICY_PROD).toContain("connect-src 'none'")
    expect(CSP_POLICY_PROD).toContain("default-src 'none'")
  })

  it('the dev policy is unreachable from a packaged build', () => {
    expect(cspPolicy('packaged')).toBe(CSP_POLICY_PROD)
    expect(CSP_POLICY_DEV).toContain('localhost')
    expect(CSP_POLICY_PROD).not.toContain('localhost')
  })
})

describe('navigation and window-open both deny', () => {
  it('preventDefault on all three events and deny on setWindowOpenHandler', () => {
    const emitter = new EventEmitter()
    let openHandler: ((d: { url: string }) => { action: 'deny' }) | null = null
    registerNavigationGuards(
      {
        on: (ev, cb) => { emitter.on(ev, cb) },
        setWindowOpenHandler: (h) => { openHandler = h },
      },
      () => {},
    )
    for (const ev of NAV_GUARD_EVENTS) {
      const preventDefault = vi.fn()
      emitter.emit(ev, { preventDefault }, 'https://evil.example')
      expect(preventDefault, `${ev} must be prevented`).toHaveBeenCalledTimes(1)
    }
    expect(openHandler!({ url: 'https://evil.example' })).toEqual({ action: 'deny' })
  })

  it('every permission request is denied', () => {
    let permFn: ((wc: unknown, p: string, cb: (g: false) => void) => void) | null = null
    hardenSession(
      {
        webRequest: { onHeadersReceived: () => {} },
        setPermissionRequestHandler: (fn) => { permFn = fn },
      },
      CSP_POLICY_PROD,
      () => {},
    )
    const granted = vi.fn()
    permFn!({}, 'clipboard-read', granted as never)
    expect(granted).toHaveBeenCalledWith(false)
  })
})

describe('content comes from local files only', () => {
  it('a packaged build never resolves a URL', () => {
    expect(
      resolvePaletteEntry('packaged', { ELECTRON_RENDERER_URL: 'http://evil.example' }, '/x/index.html'),
    ).toEqual({ kind: 'file', path: '/x/index.html' })
  })
})

describe('the entry file really installs the controls', () => {
  it('calls hardenSession with the mode-resolved policy', () => {
    expect(ENTRY).toContain('hardenSession(session.defaultSession, cspPolicy(mode)')
  })

  it('calls assertEditMenuIntact before setting the application menu', () => {
    expect(ENTRY).toContain('assertEditMenuIntact(menuTemplate)')
    expect(ENTRY.indexOf('assertEditMenuIntact(menuTemplate)')).toBeLessThan(
      ENTRY.indexOf('Menu.setApplicationMenu('),
    )
  })

  it('never nulls the application menu, which is what kills Cmd+A/C/V', () => {
    expect(ENTRY).not.toContain('setApplicationMenu(null)')
  })

  it('sets the app name BEFORE requesting the single-instance lock', () => {
    // Verified: reversing these two lines silently relocates the store to
    // ~/Library/Application Support/Electron while app.name still reports 'Cairn'.
    const nameAt = ENTRY.indexOf('app.setName(DATA_DIR_NAME)')
    const lockAt = ENTRY.indexOf('app.requestSingleInstanceLock()')
    expect(nameAt).toBeGreaterThan(-1)
    expect(lockAt).toBeGreaterThan(-1)
    expect(nameAt).toBeLessThan(lockAt)
  })

  it('hides the Dock icon and opens no window on the launch path', () => {
    // `.show()` cannot be banned outright: the 'second-instance' handler calls paletteRef?.show(),
    // which is the whole point of taking the single-instance lock. What must not exist is a window
    // shown at launch — only the hotkey may do that.
    expect(ENTRY).toContain('app.dock?.hide()')
    expect(ENTRY).not.toContain('win.show()')
    expect(ENTRY).not.toContain('showInactive()')
    expect(ENTRY).not.toContain('ready-to-show')
  })

  it('never opens DevTools', () => {
    expect(ENTRY).not.toContain('openDevTools')
  })

  it('explains a refused keyring in a dialog and quits, rather than throwing into the void', () => {
    // Spec §6's "No OS keyring" degraded mode. An accessory app has no window, so an uncaught throw
    // is a process that vanishes with no explanation the user can see.
    expect(ENTRY).toContain('dialog.showErrorBox(')
    expect(ENTRY).toContain('KEYRING_WEAK_DIALOG_TITLE')
    expect(ENTRY).toContain('BANNER_KEYRING_WEAK')
    expect(ENTRY).not.toContain('cannot open the store: ${masterKey.code}')
  })

  it('passes the keyring the AgentPlatform value, never process.platform', () => {
    // 'darwin' is not one of 'macos' | 'win32' | 'linux', so it would match no probeBackend branch.
    expect(ENTRY).toContain("platform: 'macos'")
    expect(ENTRY).not.toContain('platform: process.platform')
  })

  it('hands the store to composeApp so quit can zero the blob name subkey', () => {
    expect(ENTRY).toContain('const store = opened.value')
    expect(ENTRY).toMatch(/composeApp\(\{[\s\S]*?\n\s{4}store,\n/)
  })
})
