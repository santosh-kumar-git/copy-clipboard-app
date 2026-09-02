import { DEFAULT_ACCELERATOR } from '@cairn/protocol'

/** Spotlight-ish proportions. Fixed, because a resizable palette is a palette you have to aim at. */
export const PALETTE_WIDTH = 720
export const PALETTE_HEIGHT = 460

/** Spec §11 control 6: the decrypted preview cache is evicted after this much user idleness. */
export const PREVIEW_CACHE_IDLE_MS = 300_000
/** How often we ask the OS how long the user has been idle. 60 s costs nothing and is precise enough. */
export const IDLE_CHECK_INTERVAL_MS = 60_000

/** electron-vite's dev server. The ONLY remote origin any policy in this file ever names. */
const DEV_ORIGIN = 'http://localhost:5173'

/**
 * Spec §11 control 4. Verified on Electron 44.1.1 against a real `file://` load of a vite-built
 * renderer: the external module script executes, the external stylesheet applies, a `data:` image
 * loads, and an injected inline `<script>`, `new Function` and any network request from the page are
 * all blocked. (The blocked-request API is deliberately not named here: `security/`'s socket ban
 * matches plain substrings with no comment exemption, and a ban with a comment hole is a weaker ban.)
 * `'unsafe-inline'` appears nowhere, which is what stops a copied `<img onerror>` from ever
 * becoming script if a future preview pane regresses.
 */
export const CSP_POLICY_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "media-src 'none'",
  "worker-src 'none'",
].join('; ')

/**
 * Dev only, and `cspPolicy()` can never return it for a packaged build. Vite injects styles as
 * inline `<style>` elements in dev and needs a websocket for HMR; both are dev-server facts, not
 * product requirements, which is exactly why the two policies are separate constants.
 */
export const CSP_POLICY_DEV = [
  "default-src 'none'",
  `script-src 'self' ${DEV_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `font-src 'self' ${DEV_ORIGIN}`,
  `connect-src 'self' ${DEV_ORIGIN} ws://localhost:5173`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "media-src 'none'",
  "worker-src 'none'",
].join('; ')

/** electron-vite only ever serves the renderer from localhost; anything else is not our dev server. */
export const ALLOWED_DEV_ORIGINS = [DEV_ORIGIN, 'http://127.0.0.1:5173'] as const

/** Spec §9: we ship the confirmed default, but through a step that NAMES what it overrides. */
export const FIRST_RUN_HOTKEY_TITLE = 'Choose Cairn’s hotkey'
export const FIRST_RUN_HOTKEY_MESSAGE = `Cairn opens with ${DEFAULT_ACCELERATOR}.`
export const FIRST_RUN_HOTKEY_DETAIL =
  'This shortcut is intercepted before the app you are using sees it, so it will take over ' +
  'Paste and Match Style in Chrome and other Chromium browsers, Slack, Google Docs, Discord, ' +
  'Visual Studio Code and Windows Terminal. If you use that often, pick Cmd+Shift+C instead. ' +
  'You can change this later in Settings.'
export const FIRST_RUN_HOTKEY_BUTTONS = ['Use Cmd+Shift+V', 'Use Cmd+Shift+C'] as const
export const FIRST_RUN_HOTKEY_CHOICES = ['Cmd+Shift+V', 'Cmd+Shift+C'] as const

/** Shown as a persistent rebind row when `hotkey.status() === 'failed'` (spec §6). */
export const HOTKEY_DEAD_BANNER =
  'Another app already owns this shortcut, so Cairn’s hotkey is not working. Pick another one.'

/**
 * Spec §6's "No OS keyring" degraded mode. `getOrCreateMasterKey()` returns
 * `E_KEYRING_WEAK_BACKEND` when `safeStorage` reports Chromium's `basic_text` backend, which
 * "encrypts" with a hardcoded password. We refuse to start rather than pretend, and we say why in a
 * dialog instead of dying with an uncaught error the user never sees.
 */
export const KEYRING_WEAK_DIALOG_TITLE = 'Cairn cannot protect your clipboard on this machine'
export const KEYRING_WEAK_DIALOG_DETAIL =
  'Cairn stores nothing until it has a real key, so it is quitting instead of writing a history it ' +
  'cannot protect. Set up your desktop keyring — the macOS Keychain, Windows Credential Manager, or ' +
  'GNOME Keyring / KWallet on Linux — and start Cairn again.'

/**
 * Spec §11 control 6, third clause: in passphrase mode a screen lock zero-fills the master key, so
 * the history is unreadable until the passphrase is entered again. Shown on unlock so the user is
 * never left wondering why the palette is empty.
 */
export const KEYRING_RELOCKED_BANNER =
  'Cairn locked itself when your screen locked. Quit and reopen Cairn to enter your passphrase.'
