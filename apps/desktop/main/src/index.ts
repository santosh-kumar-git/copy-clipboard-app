import { join } from 'node:path'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, safeStorage, session, Tray,
} from 'electron'
import { createHistory } from '@cairn/history'
import { createSearchIndex } from '@cairn/search'
import { createHotkey } from '@cairn/hotkey'
import { createCapture, defaultCaptureConfig } from '@cairn/capture'
import { createKeyring } from '@cairn/keyring'
import { openStore } from '@cairn/store'
import { classify, DEFAULT_RULES, mask, shouldSkipOnHints } from '@cairn/privacy'
import { spawnAgent } from '@cairn/agent-host'
import { AGENT_BIN_NAME, BANNER_KEYRING_WEAK, DATA_DIR_NAME, systemClock } from '@cairn/protocol'
import {
  FIRST_RUN_HOTKEY_BUTTONS,
  FIRST_RUN_HOTKEY_CHOICES,
  FIRST_RUN_HOTKEY_DETAIL,
  FIRST_RUN_HOTKEY_MESSAGE,
  FIRST_RUN_HOTKEY_TITLE,
  KEYRING_WEAK_DIALOG_DETAIL,
  KEYRING_WEAK_DIALOG_TITLE,
} from './constants'
import { loadConfig, saveConfig } from './config'
import { createStderrLogger } from './logger'
import { assertEditMenuIntact, buildAppMenuTemplate } from './menu'
import { createTray, trayIconPath, type TrayLike } from './tray'
import { composeApp } from './wiring'
import { cspPolicy, createPaletteWindow, hardenSession, resolveRuntimeMode } from './windows'

// =============================================================================================
// DELIBERATELY ABSENT, and each absence is asserted by a test in `security/`. The banned
// identifiers are NOT spelled out below: the security scans match plain substrings with no
// "unless it is a comment" exemption, and a ban with a comment hole is a weaker ban.
//
//   1. Crash reporting is never initialised (spec §11 control 1). A crash dump of this process IS
//      the clipboard history. Electron's crash-reporting module is never even imported, and no
//      third-party crash SDK or upload switch appears anywhere in the repo.
//
//   2. No custom URI scheme is registered (spec §11 control 10). Registering one would let any web
//      page you visit invoke this app with attacker-chosen parameters. The pairing payload is a QR
//      code the PHONE parses; the desktop only ever displays it.
//
//   3. Nothing here opens or dials a socket and nothing reaches the network (spec §11 control 1 and
//      §9): no TCP or UDP server, no HTTP client, no websocket, no mDNS advertisement. There is NO
//      local control socket and NO unauthenticated local API — decrypted history is reachable only
//      through contextBridge inside our own process tree. The rejected daemon design would have
//      served full secret values to any same-user process. Do not add one "just for the CLI".
//
// If you are here to add any of the above, read spec §11 first and then don't.
// =============================================================================================

// app.setName MUST come before ANYTHING that touches a path — verified: calling
// `app.requestSingleInstanceLock()` first freezes userData at
// `~/Library/Application Support/Electron`, and `app.name` still reports 'Cairn', so the store
// silently lands in a directory shared with every other unnamed Electron app.
app.setName(DATA_DIR_NAME)

if (!app.requestSingleInstanceLock()) {
  // A second launch hands the running instance the focus and exits. Verified: the second process
  // gets `false` and the first receives 'second-instance'.
  app.exit(0)
}

const mode = resolveRuntimeMode({ isPackaged: app.isPackaged, env: process.env })
const logger = createStderrLogger({ clock: systemClock, minLevel: mode === 'packaged' ? 'info' : 'debug' })

// `app.getAppPath()` is NOT the repo root. Unpackaged it is `<repo>/apps/desktop` — the only
// package.json with a `main`, so that is the app root Electron is handed. Packaged it is
// `Cairn.app/Contents/Resources/app`. The agent binary and the tray icon sit OUTSIDE that directory
// in both layouts, at different depths, which is why this is computed once here rather than inline.
// `app.isPackaged` and not `mode`: CAIRN_HARDENED=1 makes `mode` 'packaged' during development, and
// the paths must stay the development ones then.
//   dev      <repo>/apps/desktop         -> ../..      = <repo>
//   packaged .../Contents/Resources/app  -> ..         = .../Contents/Resources
const AGENT_DIR = app.isPackaged
  ? join(app.getAppPath(), '..')
  : join(app.getAppPath(), '..', '..')
const RESOURCES_DIR = app.isPackaged
  ? join(app.getAppPath(), '..')
  : join(app.getAppPath(), 'resources')

app.on('second-instance', () => {
  paletteRef?.show()
})

// An accessory app has no windows most of the time; the default "quit when the last window closes"
// would quit us the first time the palette is dismissed.
app.on('window-all-closed', () => {})

let paletteRef: { show(): void } | null = null
/** Module scope on purpose: a Tray only referenced inside a function is collected and the icon
 *  disappears from the menu bar a few seconds after launch. */
let trayRef: TrayLike | null = null

async function main(): Promise<void> {
  // The Dock icon goes away here rather than via Info.plist, because M1 produces no bundle —
  // `LSUIElement: 1` is added to the Info.plist at M3 packaging (recorded in PLATFORM-NOTES.md).
  app.dock?.hide()

  // THE EDIT MENU. An accessory app shows no menu bar, so it is tempting to call
  // `Menu.setApplicationMenu(null)`. Verified on Electron 44.1.1: Electron installs a default menu
  // that already contains cut/copy/paste/selectAll, so removing ours looks harmless and instead
  // kills Cmd+A / Cmd+C / Cmd+V inside our own search field.
  const menuTemplate = buildAppMenuTemplate(app.name)
  assertEditMenuIntact(menuTemplate)
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate as Electron.MenuItemConstructorOptions[]))

  hardenSession(session.defaultSession, cspPolicy(mode), (permission) => {
    logger.warn('renderer.permission-denied', { count: 1 })
    void permission
  })

  const dataDir = app.getPath('userData')
  const { config, source } = loadConfig(dataDir)
  if (source !== 'file') logger.info('config.loaded-default')

  // `platform: 'macos'`, NOT process.platform. @cairn/keyring's `AgentPlatform` is
  // 'macos' | 'win32' | 'linux'; process.platform is 'darwin' here, which is a type error and — if
  // cast away — matches none of probeBackend()'s branches. M1 is macOS-only (contract §0).
  const keyring = createKeyring({ safeStorage, platform: 'macos', dir: dataDir, logger })
  // Synchronous on purpose: two callers must not race into writing two different key.bin files.
  const masterKey = keyring.getOrCreateMasterKey()
  if (!masterKey.ok) {
    // Spec §6's "No OS keyring" degraded mode. An uncaught throw here is invisible to the user: the
    // app is an accessory with no window, so it would vanish with no explanation. Say what happened,
    // in the keyring's own words, then quit — we do not fall back to pretending to encrypt.
    const probe = keyring.probeBackend()
    logger.error('keyring.backend-refused', { code: masterKey.code })
    dialog.showErrorBox(
      KEYRING_WEAK_DIALOG_TITLE,
      `${probe.warning ?? BANNER_KEYRING_WEAK}\n\n${KEYRING_WEAK_DIALOG_DETAIL}\n\n(${masterKey.code})`,
    )
    app.quit()
    return
  }
  logger.info('keyring.mode', { mode: keyring.getMode() })

  // openStore returns Result<Store>, not Store: a wrong key or a tampered log is a state, not a
  // programmer error. Only a key that is not 32 bytes throws.
  const opened = openStore({ dir: dataDir, key: masterKey.value, clock: systemClock, logger })
  if (!opened.ok) {
    logger.error('store.opened', { code: opened.code })
    dialog.showErrorBox(
      KEYRING_WEAK_DIALOG_TITLE,
      `Cairn could not open its store: ${opened.code}.\n\n${opened.message}`,
    )
    app.quit()
    return
  }
  const store = opened.value
  // meta.json is the only plaintext file, and these two lines are the only thing that keeps its
  // `keyMode` honest — without them the field stays `'unknown'` forever. `scryptSaltB64` stays null
  // because @cairn/keyring keeps the salt inside key.bin, never in a plaintext file.
  // The map is REQUIRED, not defensive: `keyring.getMode()` returns `KeyringMode`, which includes
  // 'locked', while `StoreMeta.keyMode` is `'os-keyring' | 'passphrase' | 'unknown'` and has no
  // 'locked' member — 'locked' is a runtime state and is never persisted. Without the map this line
  // is `TS2322: Type '"locked"' is not assignable to type '"os-keyring" | "passphrase" | "unknown"'`.
  // The branch itself is unreachable at runtime, because getOrCreateMasterKey just succeeded.
  const keyMode = keyring.getMode()
  store.writeMeta({
    schemaVersion: 1,
    keyMode: keyMode === 'locked' ? 'unknown' : keyMode,
    scryptSaltB64: null,
  })

  const agent = spawnAgent({
    platform: 'macos',
    // app.getAppPath() is <repo>/apps/desktop: that directory holds the only package.json with a
    // `main`, so it is the app root Electron is given. The agent lives at the REPO root, two up.
    // (M3 packaging moves it into Contents/Resources and revisits this one line.)
    binPath: join(AGENT_DIR, 'agents', 'macos', 'build', AGENT_BIN_NAME),
    clock: systemClock,
    logger,
  })

  // One object that satisfies both ports: @cairn/history's `PrivacyPort` needs `rules`, `classify`
  // and `mask`; @cairn/capture's `CaptureDeps.privacy` needs `classify`, `mask` and
  // `shouldSkipOnHints`. It is passed as a variable, not an inline literal, so the extra member is
  // not an excess-property error at either call site.
  const privacy = { rules: DEFAULT_RULES, classify, mask, shouldSkipOnHints }
  // `config` is a CaptureConfig — {debounceMs, watchIntervalMs, rules} — and NOT a PrivacyRules.
  // Passing DEFAULT_RULES here arms the debounce timer with `undefined` ms and sends
  // `watch.start {intervalMs: undefined}`, which the frozen AgentRequestSchema rejects.
  const capture = createCapture({
    agent,
    privacy,
    config: defaultCaptureConfig(DEFAULT_RULES),
    clock: systemClock,
    logger,
  })
  const search = createSearchIndex()
  const history = createHistory({
    store,
    privacy,
    search,
    clock: systemClock,
    logger,
    retention: { ...config.retention, secretTtlMs: 300_000 },
  })
  await history.load()

  const palette = createPaletteWindow({
    BrowserWindowCtor: BrowserWindow as never,
    mode,
    preloadPath: join(app.getAppPath(), 'out', 'preload', 'index.js'),
    rendererIndexPath: join(app.getAppPath(), 'out', 'renderer', 'index.html'),
    env: process.env,
    clock: systemClock,
    logger,
  })
  paletteRef = palette

  const cairn = composeApp({
    agent,
    capture,
    history,
    hotkey: createHotkey({ agent, logger }),
    keyring,
    store,
    palette,
    ipcMain,
    powerMonitor,
    clock: systemClock,
    logger,
    config,
    dataDir,
    saveConfig: (next) => { saveConfig(dataDir, next) },
    // Spec §9's one-tap first-run step. A native message box needs no new IPC channel and no
    // renderer code, and `defaultId: 0` is what makes Cmd+Shift+V "pre-selected".
    chooseHotkey: async (candidates) => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: FIRST_RUN_HOTKEY_TITLE,
        message: FIRST_RUN_HOTKEY_MESSAGE,
        detail: FIRST_RUN_HOTKEY_DETAIL,
        buttons: [...FIRST_RUN_HOTKEY_BUTTONS],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      return candidates[response] ?? FIRST_RUN_HOTKEY_CHOICES[0]
    },
  })

  const started = await cairn.start()
  if (!started.ok) throw new Error(`cairn: startup failed: ${started.code} ${started.message}`)

  // The menu bar icon, created AFTER start() so it never appears while the app is still unusable —
  // and so it can label itself with the accelerator that actually bound. Held in a module-level
  // variable because a Tray that is only referenced locally is garbage collected and vanishes from
  // the menu bar seconds after launch.
  trayRef = createTray({
    icon: nativeImage.createFromPath(trayIconPath(RESOURCES_DIR)),
    makeTray: (icon) => new Tray(icon as Electron.NativeImage),
    buildMenu: (template) => Menu.buildFromTemplate([...template] as Electron.MenuItemConstructorOptions[]),
    accelerator: started.value.accelerator,
    onToggle: () => { cairn.togglePalette() },
    onQuit: () => { app.quit() },
    logger,
  })

  app.on('before-quit', () => {
    trayRef?.destroy()
    void cairn.stop()
  })
}

void app.whenReady().then(main)
