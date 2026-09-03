# Cairn — roadmap

Everything here is deliberately **not** in v1. v1 is: history, palette + hotkey, pins, secret
masking, encrypted store, and a LAN pairing server. See
`docs/superpowers/specs/2026-09-02-cairn-clipboard-manager-design.md`.

Effort: **S** ≈ a day · **M** ≈ a few days · **L** ≈ a week or two · **XL** ≈ a project of its own.

---

## Known gaps in v1

These are not "future features" — they are places where v1 is less than it appears. Listed first
because they are corrections, not additions.

### Retention is configured but never enforced — S
`config.json` accepts `retention.maxItems`, `maxAgeMs` and `maxBytes`, and `planEviction()` in
`packages/history/src/retention.ts` implements all three correctly, with pins exempt. But the only
caller is `history.evictNow()`, and **nothing calls that** — not on ingest, not on a timer, not at
startup. So history grows without bound and the three settings have no effect.

The security-relevant half: a masked secret disappears from the palette at its 5-minute TTL because
`list()` filters on `isLive()` at read time, but its encrypted record and blob stay on disk, because
that removal is eviction's job too. Wiring is small — call `evictNow()` at startup and after each
ingest — and `retention.test.ts` already covers the policy itself.

### Image thumbnails are captured but never served — S
`@cairn/capture` generates a JPEG thumbnail per image, the store holds it, `ItemSummary` has a
`thumbnailDataUrl` field and `ItemRow.svelte` already renders one when present — but
`toItemSummary(item, null)` in `apps/desktop/main/src/ipc-handlers.ts` passes `null` on both the
`list` and `search` paths, so it is always absent. Image rows therefore had no text preview AND no
image, and rendered completely blank; they now show `Image · 235 KB` instead, which is a description
rather than the thing itself.

Serving them means decrypting one blob per visible row and handing image bytes to the renderer, so it
wants a decision about caching and about `img-src data:` in the CSP — small, but not a one-liner.

### No settings UI — M
Every setting lives in `~/Library/Application Support/Cairn/config.json`, is read once at startup,
and needs a relaunch. Worse, an invalid or incomplete file is rejected **whole**, silently falling
back to every default, with only a `config.loaded-default` log line to say so — so a hand-edit that
looks reasonable can quietly change nothing.

Wants: a panel for the hotkey and the three retention limits, validation shown in the UI rather than
in a log, live application without a restart, and a visible reason when a file is rejected.
`hotkeyFailedText()` in the renderer already tells users "rebinding lives in Settings, which this
build does not have yet".

---

## Highest value first

### Snippets and templates — M
Pinned entries promoted to named, folder-organised snippets with `{{cursor}}`, `{{clipboard}}`,
`{{date:%Y-%m-%d}}` and `{{input:Label}}` placeholders, filled via a small form at paste time.

The single most-requested power-user feature in this app class, and the store already has pinning
plus a `kind` enum. A future device sending `kind:'snippet'` is already tolerated, because unknown
kinds are stored opaquely.

### Paste transforms as a modifier — M
`Cmd+Shift+Enter` applies a stack of pure text transforms: plain-text-only, trim, collapse
whitespace, case/slug conversion, JSON/XML pretty or minify, base64 and URL encode/decode,
markdown-to-plain, strip URL tracking parameters, unwrap hard-wrapped lines, sort/dedupe lines.

Turns the palette from a history into a tool. Pure functions over the primary representation, so
it's a fully testable module with zero platform code.

### OCR on image items — L
macOS `VNRecognizeTextRequest` directly inside the existing Swift agent (free, offline, nothing extra
to notarize); `Windows.Media.Ocr` on Windows; `tesseract` as an optional Linux dependency. Stored as
an alternate representation so search indexes it.

By far the highest-value image feature — a history full of unsearchable screenshots is a history
full of nothing.

### Full-text search over bodies — M
Migrate the store behind its existing `appendEvent`/`readAll`/`compact` interface to
`better-sqlite3-multiple-ciphers` + FTS5 (Node-API, all 8 prebuilds inside the npm tarball, so
nothing is downloaded or compiled; FTS5-inside-SQLCipher verified working).

Lifts the ~2000-item in-memory ceiling to 100k+ and makes OCR text and HTML searchable. Genuinely
additive, because the interface is only three methods.

### Native Windows clipboard listener — M
Replace the 300 ms sequence-number poll with a message-only HWND +
`AddClipboardFormatListener` + `WM_CLIPBOARDUPDATE`, written as a small Rust/napi-rs agent against
the Microsoft-maintained `windows` crate.

Removes ~450 ms worst-case capture latency **and** the permanent hole where a copy followed by the
source app exiting loses every delayed-rendered format. Also unblocks the `CF_HDROP` write path. The
agent boundary makes the language choice free — this is the payoff for that boundary.

### Paste stacks / queued paste — M
Select N items and have successive `Cmd+V` presses walk them in order, plus numbered
`Cmd+Ctrl+1..9` direct slots.

The killer workflow for filling a form from a spreadsheet column, or porting config values between
two files.

### Per-app paste profiles — S
Remember that pasting into a terminal or Slack should default to plain text while Pages keeps
formatting, keyed on the same frontmost-app identity the exclusion list already uses.

Nearly free once attribution and transforms both exist, and it silently removes a daily papercut.

---

## Linux, properly

### `org.freedesktop.portal.Clipboard` + RemoteDesktop path on GNOME Wayland — L
D-Bus with UnixFD passing, promoting Tier C to near-full: real background capture with no XWayland
dependency, plus `NotifyKeyboardKeysym` auto-paste, made one-time by RemoteDesktop v2's
`persist_mode` + `restore_token`.

The single biggest quality-of-life win available to Linux users, and the only sanctioned path GNOME
actually endorses.

### Wayland auto-paste, tiered and opt-in — M
A `ydotool` setup wizard with the udev rule shipped-but-not-installed-active on wlroots and GNOME;
RemoteDesktop-portal `NotifyKeyboardKeysym` on KDE; `libei`/`reis` if a maintained Node binding
appears.

The only remaining fully-missing feature on Wayland. Gated behind capability flags that already exist
in the agent protocol.

### GNOME Shell extension as a first-class GNOME Wayland backend — XL
`St.Clipboard` / `Meta.Selection` capture as the compositor, `Main.wm.addKeybinding` for a real
hotkey, Clutter focus info for the exclusion list, bridged to the app over a socket.

The only way GNOME Wayland gets full capability including app-based exclusions. Costs a separate
extensions.gnome.org review and breaks every 6 months — which is exactly why it's roadmap.

---

## Phone sync, completed

### iOS and Android clients — XL
Written against the v1 `PROTOCOL.md` and golden vectors with **zero desktop changes**.
iOS: `NWBrowser` + `NWConnection` + swift-sodium. Android: `NsdManager` (with a MulticastLock and a
serialised resolve queue) + `SocketChannel` + lazysodium-android + kotlinx.serialization-cbor.

Shaped as **push-to-phone plus pull-on-open**, because iOS cannot read the clipboard in the
background at all, and Android 10+ allows it only for the focused app or an active IME.

This is the entire point of shipping the wire protocol first — the golden vectors let a Swift or
Kotlin dev debug their handshake with no access to the desktop.

### Relay for off-LAN sync — L
Behind the reserved `features:['relay']` flag, shipping **simultaneously** with per-event Ed25519
origin signatures in the reserved `sig` field, so neither a relay nor a compromised hub can forge
events.

Closes the one honest security gap in v1 (hop-only authentication) at the same moment it removes the
LAN-only limitation. Additive inside wire major 1 by construction.

---

## Power-user surface

### Shell-command and script actions — M
User-defined commands with the item piped on stdin and stdout optionally replacing the clipboard
(`jq .`, `sqlformat`, convert to webp), plus user-scriptable transforms in a QuickJS sandbox with no
network and no filesystem.

Infinite extensibility without a plugin API. Needs an explicit per-action trust prompt and an
allowlist, because it is the app's biggest self-inflicted attack surface.

### Rules engine — M
Over the existing redaction policy plumbing: *if the text matches this regex and came from that app,
then never store it / always pin it / auto-tag it / route it to this snippet folder.*

Exposes machinery that already exists as a user-facing feature — high value per line of new code.

### Search operators and saved smart folders — S
`kind:image`, `app:slack`, `has:link`, `before:2026-08-01`, `is:pinned`, plus a regex mode.

The natural payoff of the FTS5 migration, and what makes a 10k-item history navigable.

### Clipboard diff — S
Select two text items and see a word- or line-level diff in the palette.

Trivially useful for comparing two configs, two queries, two tokens or two API responses. One
dependency.

### Smart item types — M
Detected colours with a swatch and hex/rgb/hsl conversion; detected JWTs with a decode inspector;
detected tracking-laden URLs with a one-tap clean; detected code with a syntax-highlighted preview
and a language guess.

Makes the palette feel intelligent rather than merely fast, and each detector is independently
shippable.

### Encrypted export / import and timeline browsing — M
An age- or minisign-signed archive of the log and blob store to a user-chosen folder, with an
explicit *"this file contains your clipboard history"* warning and its own passphrase, plus a
"what was I copying last Tuesday afternoon" scrub view.

History survives a machine migration without going through the sync protocol, and it's the honest
answer to "where is my data".

### Public control API + alternative UI shells — M
Document the IPC surface behind an authenticated local endpoint — per-client token in the `0700` data
dir **plus** a peer-credential check before any decrypt verb — so Raycast, Alfred, Ulauncher, a tmux
popup, a Neovim picker or a Tauri/TUI shell can drive the same engine.

Nearly free given the module boundaries, and the strongest proof the UI is swappable. **The auth must
exist before the surface is published**, or it becomes an oracle handing decrypted history to any
same-user process. This is the exact trap that got the daemon-with-a-control-socket design rejected
in v1.

---

## The one thing that would justify a CRDT

### Ordered, user-arranged snippet libraries (drag to reorder) — L
Written down explicitly so the no-CRDT decision isn't relitigated from scratch every time someone
reads the sync code: an RGA or Fugue **list** CRDT for the ordering field only, **never** for item
content. Everything else stays last-write-wins on `(updated_at, origin)`.

---

## Not planned

- **Mac App Store.** The sandbox forbids Accessibility and synthetic keystrokes. Direct notarized DMG
  is the only macOS distribution path for this app class. Microsoft Store is viable.
- **Cloud sync with an account system.** The relay above covers off-LAN without one.
- **Cross-device clipboard for a phone the user hasn't unlocked.** Not possible on either mobile OS.
