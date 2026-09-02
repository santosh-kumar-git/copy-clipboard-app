# Cairn — cross-platform clipboard manager

**Status:** approved design, 2026-09-02
**Name:** Cairn (`app.cairn.desktop`, mDNS `_cairn._tcp`, URI scheme `cairn:pair`)

A cairn is the stack of stones you build to find your way back. That is a clipboard history.

---

## 1. What it is

An always-running desktop utility for macOS, Windows and Linux from one codebase. It keeps a
searchable history of everything you copy — text, rich text, images, file paths — and gives it back
to you on a global hotkey. Later it syncs items to a paired phone over the LAN, end-to-end
encrypted.

### v1 scope (confirmed)

1. History of the last N items: plain text, HTML/RTF, PNG/JPEG images, copied file paths.
2. Global hotkey (default `Cmd/Ctrl+Shift+V`) opens a Spotlight-style palette: fuzzy search, arrow
   keys, `Enter` pastes into the app you were just in.
3. Pin favourites (never age out), auto-detect and mask secrets, encrypted local store, per-app
   exclusion list.
4. A pairing + sync **server** in the desktop app so iOS and Android clients can be written later
   with zero desktop changes. **No mobile app is built now.**

### Explicit non-goals for v1

- No mobile app. No cloud relay. No account system. No plugin API. No local control socket or CLI
  daemon interface (see §9).
- No Mac App Store target. The macOS sandbox forbids Accessibility and synthetic keystrokes, which
  is why every Mac clipboard manager ships as a direct download. Publishing later means a notarized
  DMG; the Microsoft Store is viable. Nothing in this architecture changes for either.
- No paid code signing. Distribution is local only for now (see §10).

---

## 2. Architecture decision

**Electron + TypeScript monolith, with 100% of clipboard / hotkey / paste / focus work in a
separate per-OS "agent" child process speaking NDJSON over stdio.**

### Why Electron and not Tauri

Tauri would give a ~15–25 MB install and ~70–110 MB idle RSS instead of Electron's ~250 MB
installed and ~150–200 MB idle. It lost anyway, on the axis that matters most here: this machine
has no `cargo`/`rustc`/`rustup` and no full Xcode, so the Rust path front-loads ~650 MB of
toolchain and a 4–12 minute cold build of 300–600 crates before line one, then puts a 15–60 second
relink on exactly the clipboard/paste code that needs hundreds of iterations to get right.

Verified on this machine instead: `swiftc -O` with AppKit + Carbon compiled a working probe in
**1.6 s using Command Line Tools only**, and that probe already read `NSPasteboard.changeCount`
(0.77 µs), the concealed-type hints, secure-input state and the frontmost bundle id. That is
essentially the whole macOS surface, working, with zero installs and zero node-gyp.

The footprint is the honest price of that velocity and **cannot be fixed later without a rewrite**.
The agent boundary keeps the door open: it is language-free, and every module except the Electron
shell is plain TypeScript behind a narrow interface, so a Tauri shell later would replace ~1500
lines of window/tray code and no domain logic.

### Why the agent process, and not an in-process native addon

- A wedged promised-pasteboard read (Photoshop rendering a `public.tiff` on demand) stalls a
  disposable child, not the palette.
- A crash kills the child; `agent-host` restarts it with backoff.
- No `napi_threadsafe_function`, no V8 ABI, no `node-gyp`, no `@electron/rebuild` — anywhere. This
  is a **CI-enforced invariant**.
- Each OS gets the right language for free. The Windows agent can become Rust at v1.1 as a drop-in
  swap.

### The one rule that makes it work

**Electron's `clipboard` module is never on the happy path.** All reads and writes go through the
agents. `clipboard.read()` stays wired as a named, CI-tested per-OS *fallback* only.

This single rule deletes four defects at once: an unverified bet that Electron's
`application/osclipboard;format="…"` reaches Win32 registered formats by name (which gated lossless
image capture, multi-file and cut-detection on Windows); blindness to `EnumClipboardFormats`
**order**, which would persist OS-synthesized `CF_TEXT`/`CF_BITMAP` as if the source app had offered
them; an X11 self-write token that is unknowable while Chromium owns the selection; and
promised-read blocking in the process that owns the UI. It also immunises us against the next
Chromium clipboard rewrite — Electron 44 already deleted `availableFormats`, `readBuffer`,
`readImage` and `readRTF` outright.

---

## 3. Stack

| Concern | Choice |
|---|---|
| Runtime | Electron `44.1.1`, pinned exact |
| Languages | TypeScript 5.9 strict; Swift 6.3.3 for the macOS agent |
| Node (build tooling only) | `.nvmrc` = `24.20.0` |
| Package manager | npm workspaces (never Yarn PnP; Yarn 1 is EOL) |
| Build | electron-vite 5, tsup for packages, a 6-line Makefile calling `swiftc`, electron-builder 26 |
| UI | Svelte 5 + `@leeoniya/ufuzzy` |
| Contracts | zod 4, one schema file, codegen'd to Swift `Codable` |
| Store | append-only AES-256-GCM NDJSON log + content-addressed encrypted blobs, `node:crypto` only |
| Keys | Electron `safeStorage`, with a hard refusal of `basic_text` backend → scrypt passphrase |
| Thumbnails | `sharp` (Node-API prebuilds) |
| Sync (M5–M6) | `noise-handshake`, `cbor-x`, `bonjour-service`, `ws`, `qrcode`, `@noble/hashes` |
| Windows agent | `koffi` (Node-API) |
| Linux agent | `x11` for notification only, bytes via `xclip` / `wl-paste` |

`.nvmrc` governs **build tooling only** — main-process code runs on Electron's bundled Node 24.
Node 20.16.0 (this machine's default) is below the electron-vite 5 / Vite 7 floor and is where
`node-gyp` dies with an undici `TypeError`.

Every native artifact in the tree is either Node-API (`sharp`, `koffi`) or a standalone process
(the three agents). That is the invariant that designs out Electron's single biggest source of pain.

---

## 4. Modules

Each has one responsibility and an interface you can use without reading its internals.

### `@cairn/protocol`
Single source of truth for every contract: agent NDJSON, renderer IPC, and later the sync wire.
Zero I/O, zero platform code.

`parseAgentLine(s)`, `contentHash(primaryRepBytes) -> 'sha256-<b64url>'`, `WIRE_MAJOR = 1`, plus zod
schemas for `AgentRequest`/`AgentResponse`/`AgentEvent`, `IpcRequest`/`IpcEvent`, `ItemEnvelope`.
Enforced by test: **unknown map keys are ignored, never an error.**
`npm run gen:agent-types` emits `agents/macos/Sources/AgentProtocol.generated.swift`, so the two
sides of the process boundary cannot drift; a field rename becomes a compile error instead of a
runtime failure.

### `@cairn/agent-host`
Agent lifecycle and transport: spawn, NDJSON framing, request→response correlation with timeouts,
crash-restart with backoff, large-representation chunking. Ships the fakes.

```ts
interface ClipboardAgent {
  start(): Promise<AgentCapabilities>
  request<M>(m: M, params, timeoutMs?): Promise<Result<M>>
  on(ev, cb): Unsub
  dispose(): Promise<void>
}
```

Factories: `spawnAgent({platform, binPath})` and `createFakeAgent(transcriptPath)`, which replays
`fixtures/agent-transcripts/*.ndjson` **and asserts the host's outbound request script**.

**Large-representation rule — clipboard bytes never touch the disk unencrypted.** Representations at
or over 64 KiB are streamed over the *same stdout pipe* as a sequence of
`rep.chunk{repId, seq, final, b64}` events and reassembled in memory by the host, which verifies the
declared `sha256` before handing the bytes to anyone and discards the whole representation on
mismatch, short count, or a gap in `seq`. A per-representation byte ceiling (20 MB, matching the
agent's cap) bounds the reassembly buffer, and an incomplete stream is evicted on a timeout so a
wedged agent cannot grow memory without limit.

An earlier revision of this design spooled oversized representations to plaintext files in
`$TMPDIR`. That was a real hole: a copied private key, `.env` paste or password-manager export would
land unencrypted on disk, outside the store we go to some trouble to encrypt, readable by any process
running as the user and likely to survive in free space after unlink. Chunking over the pipe removes
the artifact entirely rather than trying to protect it. Pipes are fast enough that base64's 33%
overhead is irrelevant at these sizes.

Every other module depends on `ClipboardAgent`, never on a process.

### `agents/macos` — Swift, the one compiled artifact
The only code in the product that touches NSPasteboard, NSWorkspace, Carbon hotkeys, CGEvent, TCC
or secure input. No storage, no policy, no history.

Requests: `hello`, `watch.start{intervalMs}`, `watch.stop`, `read{changeCount}`,
`write{reps,transient}`, `paste{}`, `focus.capture`, `focus.restore{token}`,
`hotkey.register{accel}`, `hotkey.unregister`, `permission.check|request|openSettings`,
`secureInput.check`, `shutdown`.
Events: `clipboard.changed{changeCount, hints[], reps[], frontmostBundleId,
attributionConfidence:'heuristic'}`, `rep.chunk{repId, seq, final, b64}`, `hotkey.fired{focusToken}`,
`permission.changed`, `log`.

Measured facts this depends on: `changeCount` reads in 0.77 µs, so a 500 ms `DispatchSourceTimer`
poll costs ~1.5 µs/s of CPU — polling is free. `availableType(from: [ConcealedType, TransientType,
AutoGeneratedType])` returns the hint **before any byte is read**. `pb.pasteboardItems` gives clean
per-item UTIs where `pb.types` leaks the `NSStringPboardType` alias. `IsSecureEventInputEnabled()`
requires `import Carbon`. `NSWorkspace.frontmostApplication` works with `AXIsProcessTrusted() ==
false`. The paste keycode is resolved from the current `TISInputSource`, never hardcoded to 9.

**Thread discipline:** all `NSPasteboard` access is serialised onto one dedicated `DispatchQueue`
with an explicit autorelease pool per read. `NSWorkspace` activation notifications are observed on
main and marshalled onto that queue. NSPasteboard's thread safety is undocumented by Apple and is a
known crash and stale-read source.

### `agents/win32` — TypeScript + koffi
Same NDJSON contract, own process. Capabilities `{clipboardWatch:'sequence-poll',
paste:'sendinput', hdropWrite:false}`.

`GetClipboardSequenceNumber` at 300 ms + 150 ms debounce + re-check.
**Exclusion semantics, which are easy to get wrong:**
`ExcludeClipboardContentFromMonitorProcessing` — presence alone is authoritative.
`CanIncludeInClipboardHistory` and `CanUploadToCloudClipboard` — read the **DWORD value** (`1` =
allow, `0` = deny) and fail closed if absent-with-a-rule, unreadable, or under 4 bytes. Probing all
three by presence would silently never record any app that explicitly *permits* clipboard history.

Read in `EnumClipboardFormats` order, never `IsClipboardFormatAvailable`-as-offered: registered
`PNG` → `CF_DIBV5` → `CF_DIB` → `CF_UNICODETEXT` (bounded NUL scan) → lenient `HTML Format` offsets
→ `CF_HDROP` via `DragQueryFileW(0xFFFFFFFF)` → `Preferred DropEffect` (`2` = cut, flagged, never
replayed as HDROP).

Paste ladder: modifier hygiene via `GetAsyncKeyState` + `KEYEVENTF_KEYUP` → `SendInput` →
`KEYEVENTF_SCANCODE` via `MapVirtualKey` → `GetGUIThreadInfo` + `PostMessage(WM_PASTE)` →
`TokenIntegrityLevel` check → `'elevated-target'`.

### `agents/linux` — TypeScript + x11 + shell-outs
Same contract plus honest runtime tier detection. `hello` returns `{tier:'A'|'B'|'C'|'D',
clipboardWatch, paste, focusApp, hotkey, missingTools[]}`.

- **Tier A (X11):** `x11` XFIXES `SelectSelectionInput` for **notification only** (node-x11 has zero
  INCR support), bytes via `xclip -selection clipboard -t <mime> -o`.
- **Tier B (wlroots/KDE):** `wl-paste --watch` over `ext-data-control-v1`, falling back to
  `wlr-data-control` (KWin master dropped wlr).
- **Tier C (GNOME Wayland):** XFIXES over `$DISPLAY` against Mutter's XWayland selection mirror,
  **actively probed** at startup — we own a sentinel selection and expect the notify back — and
  auto-downgraded to Tier D if the probe fails. Honours `x-kde-passwordManagerHint: secret`.
- **Tier D:** capture only while our own window has focus; adds `capture.now`.

PRIMARY-selection monitoring is off by default on every tier.

### `@cairn/capture`
Turn agent change events into at most one normalised, deduped, guard-approved `Candidate`. Owns
debounce, self-write suppression, MIME normalisation, thumbnailing. Never writes to disk.

`createCapture({agent, privacy, config}) -> {start, stop, onCandidate, suppressToken(token)}`.

Pure exported helpers, unit-tested against byte fixtures: `normalizeReps(raw)` (TIFF→PNG at
capture, `CF_HTML` wrapper stripped to bare UTF-8 so a Windows and a Linux copy produce identical
rows, uri-list canonicalisation, legacy-alias dedupe), `classifyKind`, `thumbnail(png)` via sharp
(JPEG, longest edge 256 px, q70, ≤24 KiB, generated **once at capture** so no phone ever pulls a
5 MB PNG to draw a list row).

**Self-write suppression:** every agent `write()` returns the token it caused (changeCount /
sequence number / our own X11 selection-owner id — knowable now because *we* own the selection) and
capture ignores exactly that token.

### `@cairn/privacy`
The single place that answers "may this be recorded?" and "may this ever leave the machine?". Pure
functions, no I/O, no clock. The most test-dense module in the repo.

`classify(snapshot, rules) -> {action:'record'|'skip', flags, reason}`;
`mask(text) -> {preview, spans}`;
`assertSyncable(item): void` — **throws**, logs, and raises a UI banner if handed anything flagged
`secret | concealed | excluded | no-sync`. It throws rather than filtering, because a silent filter
is how "why didn't my item sync?" becomes unanswerable.

Three independent layers:
1. **OS hints**, checked before any byte is read.
2. **App exclusion list**, documented in the UI as best-effort, failing **closed** when the owner is
   unknowable and a rule is active.
3. **Detectors:** PEM private keys, `AKIA`/`ASIA`, `ghp_`/`github_pat_`, `sk-`/`sk-ant-`,
   `xox[baprs]-`, `sk_live_`, `AIza`, JWT `eyJ`, and Shannon entropy > 4.0 bits/char over any 20+
   char whitespace-free run.

The 4.0 cut point is arithmetic, not taste: uniform lowercase hex is *exactly* 4.0, so git SHAs and
UUIDs mathematically cannot trip it, while base64url (6.0 max) still does. A committed
**false-positive corpus** (base64 image data, minified JS, git SHAs, UUIDs, long URLs) must not
trip.

### `@cairn/store`
Durable encrypted persistence with tamper-evident ordering. Knows about opaque encrypted records and
content-addressed blobs; nothing about clipboards or policy. Takes a 32-byte key as an argument, so
every test is a tmpdir plus a random key on a machine with no compiler.

`appendEvent(ev)`, `readAll(): AsyncIterable`, `compact(liveIds)`, `putBlob(bytes) ->
'sha256-<b64url>'`, `getBlob(id)`, `deleteBlob(id)`, `stat()`.

`history.ndjson` holds one AES-256-GCM record per line: `base64(nonce12 || ct || tag16)`.

**At-rest integrity, which a plain per-record AAD does not give you:**
`AAD = 'cairn/store/v1' || u64be(lineIndex) || u64be(seq) || recordKind`, and every record commits
to `prevRecordHash`, forming a hash chain. Swapping, reordering, duplicating, truncating or
**deleting** a record — which would otherwise resurrect a deleted secret — is detected on read.
`max_seq` and the watermark vector live in a sealed `CHECKPOINT` record **inside** the log, never in
a plaintext `meta.json`; `meta.json` holds only schema version, key mode and the scrypt salt.

Blobs are individually sealed with an `HKDF-SHA256(master, 'cairn/blob/v1')` subkey, random nonce
prefixed, plaintext sha256 as AAD, and `fsync`'d before the referencing event is appended — a crash
can leak an orphan blob (GC'd at compaction) but never a dangling reference. A torn trailing line is
discarded on read.

### `@cairn/keyring`
Produce the 32-byte master key and report honestly which protection is actually in force. Nothing
else in the app guesses at encryption availability.

`getMode(): 'os-keyring'|'passphrase'|'locked'`, `getOrCreateMasterKey()`,
`unlockWithPassphrase(p)`, `probeBackend(): {backend, strength, warning?}`,
`rekeyAfterCorruption() -> {lostItems}`.

`safeStorage` wraps a random 32-byte key into `key.bin`. Policy lives here, not in the UI: **refuse**
os-keyring mode when `getSelectedStorageBackend() === 'basic_text'` — Chromium is "encrypting" with
a hardcoded password and nothing warns you — and require a passphrase instead
(`scryptSync(N=2^17, r=8, p=1)`, zero dependencies). On decrypt failure (macOS re-signing broke the
Keychain ACL) return a re-key path, never a crash loop. `isEncryptionAvailable()` is only meaningful
after app `ready` on Linux, so the check is sequenced accordingly.

Windows honesty, verbatim in the Security pane: **DPAPI is per-user, so any process running as you
can decrypt this store with no prompt.** It protects against disk theft and other accounts, not
local malware.

### `@cairn/history` + `@cairn/search`
Clipboard domain service (ingest, dedupe, retention, pin, delete) and palette ranking. No OS access,
no crypto.

`ingest(snapshot)`, `list({limit,offset,kind,pinnedOnly})`, `search(q,limit) -> ScoredItem[]`,
`resolveReps(id)`, `pin(id,bool)`, `remove(id)`, `evictNow()`.

Search is `ufuzzy` over decrypted previews held in memory: 500 items default / 2000 hard cap in v1,
~512 KB — no FTS5 needed. Empty query = pinned first, then recency. The clock is injected so
retention and TTL tests are deterministic.

Retention: 500 items / 30 days / 512 MiB; pinned exempt forever; secrets TTL 5 minutes.
**Local eviction is local only and emits no tombstone** — otherwise a phone with a smaller cap
deletes items off your desktop.

### `@cairn/hotkey`
Own the global shortcut end to end: register, **detect that registration failed**, offer a rebind,
expose a "my hotkey is dead" state. A silently dead hotkey is the classic ship-blocker for this app
class, so it is a first-class state.

`bind(accel) -> {ok:true} | {ok:false, reason:'taken'|'invalid'|'portal-identity-missing'}`,
`current()`, `status(): 'active'|'unbound'|'failed'`, `onTrigger(cb)`.

Always checks `globalShortcut.register()`'s boolean return. macOS and Windows go through the agent
(Carbon `RegisterEventHotKey` keeps firing under secure input, which is why the palette opens over a
password field at all). Linux Wayland uses Electron's GlobalShortcuts portal with
`app.setDesktopName('app.cairn.desktop')`, which **must** resolve to an installed `.desktop` file or
GNOME denies every bind silently.

### `@cairn/paste`
Deliver a chosen item to the previously focused app, walking an honest ladder, and never claim a
paste it cannot observe. One documented function, so the ordering bug can only exist in one place.

```ts
deliver(id, mode: 'auto' | 'copy-only'): Promise<{
  result: 'pasted' | 'copied-manual'
  reason?: 'no-permission' | 'secure-input' | 'elevated-target'
         | 'wayland-no-injection' | 'x11-tool-missing' | 'user-preference'
}>
```

Fixed sequence: the focus token was captured **at hotkey time** — never read "previous app" at paste
time, because while our accessory app is active `NSWorkspace.frontmostApplication` returns *us* →
`agent.write(reps, transient:true)` marked `TransientType` + `AutoGeneratedType` → `suppressToken` →
hide palette (fire-and-forget, **not** an awaited renderer ack) → `agent.focus.restore` →
`secureInput.check` → `agent.paste`.

macOS restore is the 14+ cooperative dance: `orderOut` → `NSApp.yieldActivation(to:)` →
`activate(from:options:)` → await `didActivateApplication` with a 120 ms fallback.

Every non-ok outcome resolves as `'copied-manual'` and the palette toasts the matching sentence. An
optional, off-by-default "legacy paste method" uses `osascript` (documented as costing a second
Automation TCC prompt) purely as an escape hatch when `CGEventPost` is blocked.

### `@cairn/sync-protocol` (M5)
The wire protocol as pure code: Noise handshakes, framing, stream multiplexing, CBOR messages, SAS,
HELLO negotiation, reconciliation. Zero sockets, zero storage, zero Electron. **This module is the
spec a future Swift or Kotlin developer implements.**

`newSession({role, staticKey, psk?, prologue, pattern:'XXpsk0'|'IK'})`,
`encodeEnvelope`/`decodeEnvelope`, `deriveSas(handshakeHash)`, `reconcile(theirWatermarks, log)`.

Verified against `noise-handshake@4.2.0` on this machine: the suite is
**`Noise_XXpsk0_25519_ChaChaPoly_BLAKE2b` with a 64-byte handshake hash** (not BLAKE2s — two of
three candidate designs got this wrong in prose, and a wrong suite name means every future mobile
client fails at message 1 with an opaque MAC error). XXpsk0 completes in 3 messages with identical
hashes on both sides; SAS matched; 65519 plaintext → 65535 ciphertext, 65520 throws.

**The footgun, reproduced:** after the handshake completes, `peer.encrypt()` returns the **plaintext
unchanged** — 25 bytes in, 25 byte-identical bytes out — because the handshake CipherState's key is
cleared and `encrypt()` begins `if (!this.hasKey) return plaintext`. The transport API is
`new Cipher(peer.tx)` / `new Cipher(peer.rx)`, and `Cipher` is a **CommonJS default export** (an ESM
named import fails). The encoder therefore asserts
`ciphertext !== plaintext && ciphertext.length === plaintext.length + 16` on **every** outbound
frame, with a unit test that fails on regression. Without it, the app broadcasts your clipboard —
including items the privacy layer masked — in cleartext over the LAN while every functional test
passes.

Plaintext framing inside the session is `[u8 frame_type][varint stream_id][body]`: stream 0 =
control, streams ≥1 = blobs, round-robin. Without this a 5 MB PNG head-of-line-blocks the 12-byte
text you just copied, and retrofitting it is a wire break. Nothing is ever hashed over CBOR, only
over raw representation bytes, which keeps canonical encoding out of the security TCB.

### `@cairn/sync-server` (M6)
All the I/O the protocol needs and none of its logic: mDNS advertise/re-announce, one TCP listener
with a raw-vs-WebSocket sniff, pairing lifecycle, rate limiting, device registry, replication.
**Off by default — nothing binds a socket until the user opens the Pair screen**, so users who never
sync never see a firewall or Local Network prompt.

`start()`, `stop()`, `beginPairing() -> {qrUri, expiresAt}`, `onSasChallenge(cb)`,
`confirmSas(id, accept)`, `devices()`, `revoke(id)`, `publish(event)`, `status()`.

`_cairn._tcp.local.` on TCP 47811 via `bonjour-service`, with self-implemented name-conflict
suffixing and re-announce on IP change or resume. One TCP listener with a 4-byte `GET ` sniff routes
to `ws` in `noServer` mode carrying identical Noise frames — **raw TCP is primary because it needs
zero iOS ATS keys and zero Android `network_security_config`.**

Pairing: fresh single-use 32-byte PSK per Pair-screen open, 120 s TTL, exactly one successful XXpsk0
per PSK then burned, XXpsk0 accepted **only** while the pairing screen is open (IK-only otherwise),
5 handshakes/min/source-IP, constant-time SAS compare, mismatch burns the PSK.

**`IK` msg1 carries HELLO only** — never item data, blob bytes or any bearer secret — because IK
msg1 is encrypted under `es`/`ss` against a long-term static and is therefore neither forward-secret
nor replay-proof. This invariant is written into `PROTOCOL.md` and asserted in a test.

Revoke drops `static_pub` so IK fails before any payload is parsed. The UI states plainly that this
is not remote wipe.

Blob streaming: `GET_BLOB` / `BLOB_BEGIN` / `CHUNK` / `END` with offset resume and sha256 verify;
deflate for text-ish MIMEs only, never PNG/JPEG, each blob in an isolated compression context.

Watermarks are a **vector over all known devices**, not a scalar per peer, because the desktop
relays third-party events. A scalar loses every event the desktop relays for a third device.

### `app-shell` + `renderer` + `tools`
Composition root, tray, single-instance, autostart, settings, updater, typed IPC, the Svelte
palette, and the four tools that keep everything honest. Zero domain logic.

One `ipc.ts` with zod schemas mirrored by preload into `window.api` (`sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false`). There is deliberately **no local control socket
and no unauthenticated local API**: decrypted history is reachable only through `contextBridge`
inside our own process tree.

Palette window: `type:'panel'`, `vibrancy:'hud'`, `visualEffectState:'active'`,
`alwaysOnTop(true,'screen-saver')`, `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true,
skipTransformProcessType:true})`, `LSUIElement=1`, and an **explicit Edit menu** with
copy/paste/selectAll roles — an accessory app has no menu bar, so `Cmd+A`/`C`/`V` would otherwise be
dead inside our own search field.

The renderer holds no history beyond the current page; secrets arrive pre-masked.

`tools/`: `doctor.ts` (capability tier, AX state, `IsSecureEventInputEnabled`, the
`ioreg -l -w 0 | grep SecureInput` leaked-secure-input diagnostic, keyring backend strength, missing
system tools, mDNS/firewall reachability, exact remediation per failure, stable exit codes);
`record-transcript.ts` (capture a real pasteboard session into a replayable fixture);
`gen-agent-types.ts`; `gen-protocol-vectors.ts` (regenerates `PROTOCOL.md`'s suite name, hash length
and golden vectors **from** the library, so the spec cannot drift from the code).

---

## 5. Data flow

**Capture:** agent timer ticks → `changeCount` changed → probe concealed hints *first* → enumerate
formats → read reps (chunk over the pipe if ≥64 KiB) → emit `clipboard.changed` → `agent-host`
reassembles and verifies each rep's `sha256`
→ `capture` debounces, drops self-writes by token, normalises MIMEs, thumbnails → `privacy.classify`
→ `history.ingest` → `store.appendEvent` + `store.putBlob` → search index updated → renderer
notified.

**Recall:** hotkey fires in the agent → `focus.capture` returns a token → palette shows → user types
→ `ufuzzy` over in-memory previews → `Enter` → `paste.deliver(id)` runs the fixed ladder → toast
states what actually happened.

**Sync (M6):** local event appended → `privacy.assertSyncable` → `sync-server.publish` → CBOR
envelope → Noise frame on stream 0 → peer reconciles by watermark vector → blobs fetched lazily on
stream ≥1 by content hash.

---

## 6. Error handling and degraded modes

These are first-class product states, not errors. The app must stay useful in every one.

**macOS Accessibility denied** (the required default assumption): everything works except the final
keystroke — capture, palette, search, pins, masking, exclusions, retention, sync — because
NSPasteboard reads, NSWorkspace attribution and Carbon hotkeys need no permission at all. `Enter`
still copies the item, closes the palette, restores focus (restoring focus is **not** TCC-gated;
only posting events is) and toasts *"Copied — press Cmd+V"*. One dismissible banner calls
`AXIsProcessTrustedWithOptions` **once**; because macOS never re-shows that alert after a Deny,
later taps deep-link `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
and poll `AXIsProcessTrusted` at 1 Hz for 60 s so the banner flips the instant the box is ticked.
`deliver()` returns `{result:'copied-manual', reason:'no-permission'}` — we never claim a paste we
cannot observe, because `CGEventPost` fails **silently**.

**macOS secure input active** (focused `NSSecureTextField`, loginwindow, Terminal's Secure Keyboard
Entry, most password managers): `IsSecureEventInputEnabled()` is checked immediately before posting;
short-circuit to `{result:'copied-manual', reason:'secure-input'}` with *"A password field is
focused — press Cmd+V yourself"*. The palette still opens, because Carbon hotkeys keep firing.
`doctor` ships the leaked-secure-input diagnostic, because a crashed app can hold secure input and
break synthetic paste globally with no visible cause.

**GNOME Wayland (Tier C, the common Linux case):** capture **works** via XFIXES against Mutter's
XWayland selection mirror, images included — but the bridge is actively probed at startup, and a
failed probe downgrades to Tier D rather than producing a plausible-looking stale history. The
hotkey works through the GlobalShortcuts portal (one consent dialog) **provided** the `.desktop`
file is installed — so the hotkey must be tested from an installed `.deb`, never from `npm run dev`.
**Auto-paste is off and cannot be enabled:** a Wayland client cannot focus another window and cannot
inject keys, and neither Mutter nor KWin implements `zwp_virtual_keyboard_manager_v1`.
**The app-exclusion list is disabled in the UI with an explicit banner**, because Mutter implements
no foreign-toplevel protocol and GNOME Shell exposes no active-window D-Bus API — source-app
identity is genuinely unobtainable there, so the content-side hints and the detectors carry the
whole privacy story. Escape hatch: a single user-editable "paste command" setting, shipped **empty**,
documented for `ydotool` and its `/dev/uinput` udev rule.

**Linux Tier D:** we do not pretend. Capture degrades to "only while our own window has focus" —
realistically one entry per palette open — and a status row says exactly that. Still a useful pinned
snippet store and sync hub; not a passive recorder.

**mDNS blocked** (enterprise Wi-Fi, AP client isolation, phone VPN, firewalld's default block on
5353/udp): discovery is deliberately not on the critical path. The QR is fully self-sufficient — it
carries every IPv4, the port, the device id, the static pubkey and the PSK — and the Pair screen
always shows the literal `192.168.x.y:47811` plus a 6-digit code beside it, with a manual-connect
field on the client side. Documented client order: cached `ip:port` (300 ms timeout) → mDNS →
manual. `doctor` detects firewalld and prints the exact `firewall-cmd` invocation.

**No OS keyring / `safeStorage` reports `basic_text`:** we **refuse** os-keyring mode rather than
silently "encrypting" with Chromium's hardcoded password. First run shows two explicit choices — set
a passphrase (scrypt, key in memory only, asked once per launch) or "store history unencrypted",
which is opt-in, logged, and shown permanently in Settings → Security. The Noise static key is not
persisted at all until a real backend or a passphrase exists.

**Windows paste into an elevated window:** UIPI drops injected input silently and `SendInput` may
even report success, so we read `TokenIntegrityLevel` where permitted and return
`{result:'copied-manual', reason:'elevated-target'}`. The app ships non-elevated (per-user NSIS, no
UAC) and stays that way; elevating would fix this one case and break Explorer drag-and-drop,
per-user autoupdate and every launch.

**Hotkey registration fails:** `status()` becomes `'failed'` and the palette shows a persistent
rebind row with suggested alternatives. The tray, the `.desktop` launcher and `cairn --toggle` all
still reach a running instance — on stock non-Ubuntu GNOME the tray icon does not appear at all, so
it is never the only entry point.

---

## 7. Testing

Per-format parser fixtures test parsers. They do not catch the bugs this app class actually ships.

- **Recorded whole-session agent transcripts** (`fixtures/agent-transcripts/*.ndjson`) replay a real
  OS session — change tick → hint probe → format enumeration → read → self-write suppression →
  ingest — **and assert the host's outbound request script**. This is what catches debounce,
  multi-pass-format, duplicate-notify and self-write-loop bugs. `tools/record-transcript.ts`
  captures them off a real machine, including TIFF screenshots, multi-file Finder copies, Chrome's
  `org.chromium.source-url`, and a concealed-type hit.
- **Byte fixtures** per format for `normalizeReps`.
- **A committed secret-detector false-positive corpus** that must not trip.
- **Golden protocol vectors** generated from the library, plus a client-and-server pair of in-memory
  sessions, so `PROTOCOL.md` cannot drift.
- **Injected clocks** everywhere retention or TTL is involved.
- `createFakeAgent` means every TS module is testable on any machine with no compiler and no OS
  permissions.

---

## 8. Build order

Milestones 1–4 contain **no sync code at all**. All three candidate designs put the whole LAN sync
stack in v1 with nothing sequencing a usable palette first; the likely failure mode was "the wire
protocol is beautiful and nothing pastes yet". Deferring costs nothing, because `sync-protocol` is a
pure module with no dependency on anything built earlier.

| # | Title | You can demo |
|---|---|---|
| 1 | Copy, hotkey, find, get it back — and never record a secret (macOS) | Copy text, an image, some files. Hotkey anywhere, type out-of-order letters, `Enter` → it's on your clipboard. Copy a password out of 1Password and nothing is recorded; copy an AWS key by hand and the palette shows `AKIA••••A7QD` and expires it in 5 minutes. Relaunch: history intact, and `grep` for your copied string finds nothing in any file on disk. |
| 2 | It pastes itself, and it tells the truth | `Enter` types `Cmd+V` for you. Per-app exclusion list works. Deny Accessibility on purpose → everything still works but the last keystroke. `npm run doctor` explains anything unavailable. |
| 3 | A real app you launch at login | Signed-with-your-own-dev-identity `.app` from a DMG, login item, no Dock icon, menu bar, 500 items / 512 MiB cap, Settings with live capability status, auto-update wired. |
| 4 | Windows and Linux | Per-user NSIS installer and a `.deb` with the same palette, search and pins. `cairn doctor` on GNOME Wayland prints its tier and exactly what's unavailable and why. |
| 5 | The wire protocol, provable, no sockets yet | `npm run conformance` runs golden vectors and a real in-memory client/server pair: fixed statics + fixed PSK → the expected 64-byte handshake hash, the expected 6-digit SAS, the expected ciphertext frames. A Swift or Kotlin dev could start without touching your machine. |
| 6 | Pair a device over the LAN | Pair screen shows a QR, advertises `_cairn._tcp`; a client scans, completes XXpsk0, both screens show the same 6 digits, you confirm on both, items replicate — text instantly, images lazily by thumbnail. Revoke → next reconnect rejected before any payload is parsed. |

Milestone 1 also spends one timeboxed afternoon on two day-0 spikes: does `BrowserWindow`
`type:'panel'` still yield an `NSPanel` in Electron 44, and does TCC attribute the Accessibility
request to the Swift helper or to the parent.

---

## 9. Rejected alternatives worth recording

- **Tauri v2 in v1** — better footprint, wrong road given no Rust and no Xcode. Runner-up; pick it
  only if resident footprint becomes a product requirement, which cannot be retrofitted.
- **In-process ObjC++ node addon** — builds fine, but needs `napi_threadsafe_function`, the one
  construct whose misuse segfaults the Electron main process, and `node-gyp` hard-fails on this
  machine's default Node 20.16.0.
- **A full headless daemon + thin UI clients** — the agent boundary carries the value; the daemon
  boundary carries the cost (~400–600 lines before feature one), and its unauthenticated local
  control socket would serve decrypted history and full secret values to any same-user process,
  nullifying the passphrase mode users choose precisely because they want more than the OS keyring.
- **SQLCipher / `better-sqlite3-multiple-ciphers` in v1** — forces a Node pin after a verified
  exit-139 segfault on Node 20 and buys little at a 500-item cap with an in-memory index. It is the
  documented, compiler-free FTS5 upgrade path (Node-API, all 8 prebuilds inside the npm tarball).
- **`@napi-rs/keyring` in v1** — one more native dep for no v1 benefit; documented escape hatch.
- **Silently changing the default hotkey** — `Cmd/Ctrl+Shift+V` is intercepted before the focused app
  sees it, so it takes Paste-and-Match-Style from Chromium, Slack, Docs, Discord, VS Code and
  Windows Terminal system-wide. We ship the confirmed default but through a one-tap first-run step
  that **names what it overrides**, with `Cmd+Shift+C` (macOS) / `Ctrl+Alt+V` (Win/Linux) one tap
  away.
- **A CRDT for sync** — unjustified for 2–3 devices. Monotonic per-device counters, per-field LWW on
  `(updated_at, origin)`, delete-wins at `deleted_at >= updated_at`, dedupe by content hash.
  `ROADMAP.md` records the one feature that *would* justify one, so the decision isn't relitigated
  from scratch.

---

## 10. Known risks and honest limits

- **Footprint is structural.** ~5 processes for a menu-bar app: ~90–110 MB per-arch DMG, ~230–280 MB
  installed, ~150–200 MB idle RSS. Clipboard-manager users are exactly the audience that screenshots
  Activity Monitor. Mitigations that help: a "low memory mode" destroying the renderer after 5 idle
  minutes (~100–140 MB, at 250–400 ms on next open) and optional
  `app.disableHardwareAcceleration()`. This is the explicit price of the velocity choice.
- **Electron's cadence is a permanent tax.** Only the latest three majors are supported on an ~8-week
  cycle, so a pinned 44.1.1 is EOL in ~24 weeks, forever — 6–8 forced major upgrades a year in a
  process holding decrypted clipboard history and, once paired, listening on TCP 47811. Routing all
  clipboard I/O through the agents keeps the highest-churn API off the critical path.
- **Three agents, two languages, one machine to debug on.** The NDJSON contract plus codegen limits
  drift, not total work. The Windows agent will be the slowest part of M4 and needs a real machine
  or VM.
- **Windows clipboard watching is a 300 ms poll in v1** because koffi cannot own a WndProc, so
  worst-case capture latency is ~450 ms, and a copy immediately followed by the source app exiting
  loses every delayed-rendered format permanently. koffi 3.x does support callbacks, but whether a
  WndProc dispatched from `DispatchMessageW` inside a koffi call is safe is **unverified** and should
  not be planned around. The real fix is a small Rust/napi-rs agent using
  `AddClipboardFormatListener` — a drop-in swap at v1.1, which is the payoff for the agent boundary.
- **Tier C on GNOME Wayland is verified from Mutter's source, not measured on every flavour.** The
  sentinel probe means failure degrades honestly, but a meaningful slice of Linux users may land in
  Tier D, and release notes must not promise Tier C until it's tested on a real GNOME box.
- **macOS Accessibility grant churn will eat hours if `npm run dev:signed` isn't built on day 0.**
  TCC keys the grant to the code-signing designated requirement and falls back to path+cdhash when
  unsigned (this machine: 0 valid identities, verified), and `CGEventPost` never prompts and never
  errors when untrusted — so a stale grant looks like a paste that just doesn't happen while System
  Settings still shows the box ticked. That is phantom, non-reproducible bugs in the hardest
  subsystem. A committed script, not README prose, is the fix.
- **Standing platform risk:** `kTCCServicePasteboard` already exists in `tccd` on macOS 26.5.1, and is
  enforced today only for Catalyst/UIKit apps, not AppKit. If Apple extends the iOS-style "Allow
  paste from X?" gate to AppKit, silent background polling becomes impossible and the product
  changes shape. Nothing here should assume unmonitored polling is guaranteed forever.
- **Promised/lazy pasteboard data can block or balloon.** Reading a promised `public.tiff` from Excel,
  Photoshop or Illustrator forces the owner to render synchronously — seconds, tens of MB, or `nil`
  if it quit. Serialised queue, 20 MB cap, 2 s timeout, watchdog kill-and-retry, prefer `public.png`
  over `public.tiff`/`com.adobe.pdf`. Being in a separate process is what keeps this from freezing
  the palette.
- **Dependency rot on the sync path:** `noise-handshake@4.2.0` is a small single-maintainer package
  shipping no official Noise test vectors and pulling a ~21-package `sodium-universal`/`bare-*`
  chain. Pinned exactly; our generated golden vectors are the regression net; the documented exit is
  a ~200-line XXpsk0/IK over `@noble/curves` + `@noble/ciphers` + `@noble/hashes` that the **same
  vectors** validate. Lower-stakes: `x11` (niche, no INCR), `koffi` (install-time prebuilt
  download), `qrcode` (mature but quiet).
- **Source-app attribution is a heuristic on every OS**, and the exclusion list inherits that. macOS
  exposes no pasteboard-owner API, so it is "whatever was frontmost when `changeCount` bumped" and
  it races on background or scripted copies; Windows `GetClipboardOwner` is better but returns NULL
  for exited owners; GNOME Wayland cannot do it at all. The UI says **best effort**. We never read
  window titles, because that pulls in the macOS Screen Recording permission.
- **"Encrypted local store" is an at-rest claim only.** The in-memory fuzzy index holds every preview
  **decrypted** in a process that never exits, and masked-secret previews live in that same index.
  Settings → Security says so, and the preview cache is evicted on idle/lock rather than left
  implicit.
- **Two quiet sync-correctness traps**, guarded but named because they surface weeks later as "some
  items don't appear on my phone": a reused per-device `seq` after a crash makes peers permanently
  skip real events because their watermark is already past it (mitigated by a durable sealed
  `max_seq` plus a +1000 forward jump on unclean shutdown); and a scalar `last_seq` instead of a
  watermark vector loses every event the desktop relays for a third device (mitigated by
  `SYNC_REQ.have` covering all known devices).
- **Hub relaying is hop-authenticated, not end-to-end.** A compromised desktop could forge an event
  attributed to a phone. The reserved `sig` field plus tested ignore-unknown-fields behaviour makes
  per-event Ed25519 origin signatures additive inside wire major 1 — but **v1 does not close this**,
  and the security notes must say so.

### Distribution, given no paid certificates

- **macOS:** `npm run dev:signed` creates and uses a stable self-signed *"Cairn Local Dev"* identity,
  codesigns after every build, and always launches from one fixed path — this is what stops TCC
  churn. Builds are shareable by hand with a Gatekeeper right-click-Open. A $99/yr Developer ID is
  the only thing that unlocks notarization and working auto-update; the build config is written so
  that turning it on is a credential change, not a code change.
- **Windows:** ship unsigned for now. SmartScreen shows a full-screen block with "Run anyway" behind
  *More info*. Since June 2023 the signing key must live in FIPS 140-2 L2 hardware, so there is no
  `.pfx` for CI — the routes are Azure Artifact Signing, a Certum card (~$70–130/yr) or DigiCert
  KeyLocker / SSL.com eSigner (~$200–500/yr). A purchasing decision, not an architecture one.
- **Linux:** `.deb` and `.rpm` unsigned is normal; AppImage secondary with the libfuse2 caveat.
- **`Info.plist` gets `NSLocalNetworkUsageDescription` and `NSBonjourServices: ['_cairn._tcp']` at
  M3**, before sync exists, so the M6 permission prompt is never a mystery.

---

## 11. Security model

This app sees every password, token, private key and confidential paste that goes through the
machine's clipboard. That makes it a high-value target and an unusually unforgiving thing to be
sloppy in, so the controls below are requirements, not aspirations, and each one names how it is
verified.

### In scope

- **Another account on the machine, or a stolen disk.** Everything at rest is AES-256-GCM; the data
  dir is `0700` and every file `0600`, asserted by test.
- **The app recording a secret it should never have kept.** Three independent layers (§4 `privacy`),
  failing **closed**.
- **Untrusted clipboard content attacking the app itself.** Content we display is content an
  attacker's web page or document authored.
- **A network attacker during pairing or sync** (M5–M6): Noise XXpsk0, single-use PSK, SAS
  confirmation, rate limiting, per-device revocation.

### Explicitly out of scope, and stated in the UI rather than implied

- **Malware already running as your user.** On Windows, DPAPI is per-user, so any process running as
  you can decrypt the store with no prompt; on macOS the Keychain ACL is bound to our code signature,
  which is better but not a sandbox. Encryption at rest protects against disk theft and other
  accounts, not against code running as you.
- **Root, kernel, DMA, cold-boot, and an OS that lies** about concealed-type hints.
- **Swap and core dumps.** We zero key material we control and disable crash dumps, but we cannot
  guarantee a page never reaches swap.

### Controls

1. **Clipboard bytes never touch the disk unencrypted, at any point.** No spool files (§4), no temp
   files, no plaintext caches. Crash reporting is explicitly disabled (`crashReporter` is never
   initialised) because a crash dump of this process contains clipboard history by definition. There
   is no telemetry, no analytics and no network egress of any kind before the user opens the Pair
   screen — a test asserts no socket is bound at startup.
2. **The logger cannot be handed an item body.** Log functions accept a metadata type only — `kind`,
   `byteLength`, `mime`, and a truncated `contentHash` — so passing raw content is a type error rather
   than a code-review question. A test scans emitted log lines for a canary string that was copied
   during the test and fails if it appears.
3. **Copied HTML is never rendered as HTML.** The preview pane renders `text/plain`, or the HTML
   source escaped as text. Rendering copied markup would hand any page you copy from script execution
   inside our privileged renderer, with the whole history one IPC call away — the single worst
   vulnerability this app class can have. A rich preview, if ever wanted, goes in an `iframe
   sandbox=""` with a CSP forbidding scripts and network, and that is roadmap, not v1. Copied file
   paths are strings we display and pass to the OS clipboard; they are never interpolated into a
   shell command, and there is no shell in the capture or recall path at all on macOS.
4. **Renderer hardening:** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
   `webSecurity` left on, all content loaded from local files with no remote origins, a strict CSP
   with no `unsafe-inline`, `will-navigate` and `setWindowOpenHandler` both denying everything, and
   DevTools disabled in packaged builds. The preload exposes a fixed, enumerated set of methods — no
   dynamic dispatch, no `invoke(channel, ...)` passthrough.
5. **Secrets are masked at ingest**, so the in-memory search index holds the masked preview and never
   the raw secret. Raw bytes live only in the encrypted store and are decrypted only on an explicit
   user recall. Secret-flagged items carry a 5-minute TTL, are exempt from pinning, and
   `assertSyncable()` **throws** rather than silently filtering, so a secret can never leave the
   machine by omission. Detection (the `AKIA`/`ghp_`/`sk-`/JWT/PEM/entropy layer of §4) ships in
   **Milestone 1**, not later — the whole point is that there is no window in which the app records
   passwords in the clear.
6. **Memory hygiene:** the master key lives in a `Buffer` that is zero-filled on lock and on quit; the
   decrypted preview cache is evicted on screen lock, on sleep and after an idle timeout; in
   passphrase mode the store re-locks on screen lock and requires the passphrase again. §10 records
   honestly that "encrypted store" is an at-rest claim and that a long-lived process necessarily holds
   previews decrypted while unlocked.
7. **Blob deletion relies on key destruction, not shredding.** Unlinking a file does not erase it from
   free space, so every blob is individually sealed and deleting the key is what makes it
   unrecoverable. This is why per-blob subkeys exist (§4).
8. **IPC is validated in both directions with zod**, and a malformed renderer message is rejected
   rather than trusted (§4). There is deliberately **no local control socket and no unauthenticated
   local API** — the rejected daemon design would have served decrypted history and full secret values
   to any same-user process, nullifying the passphrase mode users choose precisely because they want
   more than the OS keyring (§9). The roadmap's public control API is gated on building the token +
   peer-credential auth *first*.
9. **Supply chain**, because a clipboard manager is an attractive place to hide a dependency:
   exact-pinned versions with a committed lockfile and `npm ci` in CI; install scripts disabled by
   default with a short, audited allowlist for the two Node-API packages that need prebuild
   downloads; a deliberately small dependency count; the `no-@electron/rebuild` guard; `npm audit` in
   CI; and the documented ~200-line `@noble` replacement for `noise-handshake`, so the one
   single-maintainer package on the security path has a rehearsed exit.
10. **The desktop registers no custom URI scheme.** `cairn:pair` is a *payload format* the phone
    parses out of a scanned QR code — it is never an inbound entry point on the desktop. Registering
    `cairn://` as a protocol handler would let any web page you visit invoke our app with
    attacker-chosen parameters, which is a remote trigger into the pairing path for no benefit
    whatsoever: the desktop *displays* the QR, it never receives one.
11. **The Security pane states exactly what is and is not protected**, per-OS, in the app's own words
    — including the Windows DPAPI sentence held as a tested string constant so it cannot silently
    drift (§4).

### Verified as a CI job, not as a habit

A `security` test suite asserts the invariants that are easy to regress and invisible in review: no
plaintext clipboard bytes appear anywhere under the data dir or the temp dir after a capture; data-dir
and file permissions are `0700`/`0600`; no socket is listening at startup; a copied canary string
never appears in any log output; `crashReporter` is not initialised; the renderer's
`webPreferences` match the hardened set; the preview pane escapes an HTML payload containing
`<img onerror>` rather than rendering it; and `assertSyncable()` throws for every flag in the secret
set.

---

## 12. Repo layout

```
.nvmrc                        24.20.0
Makefile                      swiftc invocation for the macOS agent
package.json                  npm workspaces root
docs/superpowers/specs/        this document
ROADMAP.md                    future features, with value and effort
PROTOCOL.md                   generated: agent NDJSON + sync wire (M5)
PLATFORM-NOTES.md             the capability tier table
TROUBLESHOOTING.md
packages/
  protocol/                   zod contracts + codegen
  agent-host/                 process lifecycle, framing, fakes
  capture/                    normalise, dedupe, thumbnail
  privacy/                    record?/sync? policy + detectors
  store/                      encrypted append-only log + blobs
  keyring/                    master key + honest backend reporting
  history/                    domain service
  search/                     ufuzzy ranking
  hotkey/                     global shortcut + failure states
  paste/                      the one delivery ladder
  sync-protocol/              M5, pure
  sync-server/                M6, all the I/O
agents/
  macos/Sources/              Swift, incl. AgentProtocol.generated.swift
  win32/                      TypeScript + koffi
  linux/                      TypeScript + x11 + shell-outs
apps/
  desktop/
    main/                     composition root, tray, settings, updater, ipc.ts
    preload/
    renderer/                 Svelte palette
tools/
  doctor.ts  record-transcript.ts  gen-agent-types.ts  gen-protocol-vectors.ts
fixtures/
  agent-transcripts/*.ndjson   recorded real OS sessions
  formats/                     per-format byte fixtures
  secrets/                     detector corpus + false-positive corpus
```
