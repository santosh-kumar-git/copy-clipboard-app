# Cairn

A clipboard manager for macOS, Windows and Linux from one codebase.

A cairn is the stack of stones you build to find your way back. That is a clipboard history.

Copy things all day; Cairn keeps the last N. Press `Cmd/Ctrl+Shift+V` in any app and a
Spotlight-style bar appears over whatever you're doing. Type a few letters to fuzzy-find something
you copied an hour ago, press Enter, and it's back on your clipboard — pasted at your cursor, with
focus returned to where you were.

Text, rich text, images and copied file paths. Pinned favourites. Passwords and API keys detected and
never recorded. History encrypted at rest. Later: sync to a paired phone over your LAN,
end-to-end encrypted, with no account and no cloud.

---

## Status

**Design and plan stage — no application code yet.**

| Document | What it is |
|---|---|
| [`docs/superpowers/specs/2026-09-02-cairn-clipboard-manager-design.md`](docs/superpowers/specs/2026-09-02-cairn-clipboard-manager-design.md) | The design. Architecture, module boundaries, security model, degraded modes, milestones, and the alternatives that were rejected and why. |
| [`ROADMAP.md`](ROADMAP.md) | Everything deliberately not in v1, with value and effort. |

Milestones (spec §8): **M1** copy → hotkey → search → recall, with secret detection, on macOS ·
**M2** auto-paste and permission honesty · **M3** a real signed app you launch at login ·
**M4** Windows and Linux · **M5** the sync wire protocol with golden vectors · **M6** LAN pairing.

## Architecture in one paragraph

Electron + TypeScript, with **100% of the clipboard, hotkey, paste and focus work in a separate
per-OS "agent" child process** speaking NDJSON over stdio — Swift on macOS, TypeScript elsewhere.
That boundary buys crash isolation (a wedged promised-pasteboard read stalls a disposable child, not
your palette), keeps `node-gyp` out of the build entirely, and makes each OS's implementation language
a free choice. Everything above the agent is plain TypeScript behind narrow interfaces, testable
against a fake agent that replays recorded transcripts — so no test needs a real clipboard or an OS
permission. See the spec for why Tauri lost despite a much better footprint, and what that choice
costs.

## Security

This app sees every password, token and private key that crosses your clipboard, so the design treats
that as the primary constraint rather than an afterthought. Spec §11 is the full model; the short
version:

- Clipboard bytes **never** touch the disk unencrypted — no spool files, no temp files, no caches.
  Crash reporting is disabled, because a crash dump of this process *is* your clipboard history.
- Copied HTML is **never rendered as HTML**. Previews render escaped text.
- Secrets are detected and masked **at ingest**, so the in-memory search index never holds the raw
  value; they carry a 5-minute TTL and can never leave the machine.
- No telemetry, no analytics, no network egress at all until you explicitly open the Pair screen.
- No custom URI scheme, no local control socket, no unauthenticated local API.
- Honest limits, stated in the app's own Security pane: on Windows, DPAPI is per-user, so anything
  running as you can decrypt the store with no prompt; and while unlocked, a long-lived process
  necessarily holds previews decrypted in RAM. Encryption at rest protects against disk theft and
  other accounts — not against malware already running as you.

**Contributing note:** `fixtures/agent-transcripts/*.ndjson` are committed on purpose — they are what
makes clipboard behaviour testable without a real clipboard. They must contain **synthetic content
only**. `tools/record-transcript.ts` captures a real session, so its output is unreviewed real
clipboard data until a human scrubs it; `.gitignore` keeps `*.raw.ndjson` and `unscrubbed/` out of the
repo, and CI scans committed transcripts for secret patterns.

## Development

Requires Node 24 (see `.nvmrc`) and, on macOS, Xcode Command Line Tools for `swiftc` — full Xcode is
not needed.

```sh
nvm use           # 24.20.0; every script refuses to run on anything older
npm ci
npm run app       # fetch Electron, build the agent + bundles, launch. The one command.
npm test          # everything runs against fakes; no OS permissions needed
# `npm run doctor` (platform capabilities and why anything is unavailable) lands in Milestone 2.
```

`npm run app` is `bootstrap && build && start`; run those individually when you want one of them.
Press **Cmd+Shift+V** once it is up. The window is an accessory panel, so it never appears in the
Dock or the app switcher, and the app logs one NDJSON line per event to stdout — `hotkey.bound` at
startup and `hotkey.fired` on each press are the two to look for.

## Install it (macOS, local)

```sh
npm run dmg              # builds dist/Cairn.app, then dist/Cairn-<version>.dmg (~145 MB)
open dist/Cairn-0.1.0.dmg # drag Cairn onto the Applications shortcut in the window
```

`npm run package:mac` stops after the `.app` if you would rather drag that straight out of `dist/`.

**First launch must be right-click → Open**, once. The bundle is unsigned and not notarized, so
double-clicking gets "Cairn is damaged or can't be opened" — that is Gatekeeper refusing an unsigned
app, not a broken build. After the first Open, it launches normally forever. A DMG does not change
this: it changes how the app is delivered, not whether Gatekeeper trusts it.

If macOS refuses even after right-click → Open, the quarantine flag can be cleared explicitly:

```sh
xattr -dr com.apple.quarantine /Applications/Cairn.app
```

Cairn has no Dock icon and no window (`LSUIElement`). It lives in the **menu bar** as three stacked
stones:

- **Left click** — opens the history. Click again to dismiss.
- **Right click** — Open / Quit.
- **Cmd+Shift+V** — same as left click, from anywhere.

Signing, notarization, a DMG, a login item and auto-update are Milestone 3.

## Settings

There is no settings UI yet. Configuration is one file, read once at startup — relaunch to apply:

```
~/Library/Application Support/Cairn/config.json
```

```json
{ "version": 1, "accelerator": "Cmd+Shift+V", "firstRunHotkeyDone": true,
  "retention": { "maxItems": 500, "maxAgeMs": 2592000000, "maxBytes": 536870912 } }
```

`maxItems` 1–5000 · `maxAgeMs` ≥ 60000 (default 30 days) · `maxBytes` ≥ 1048576 (default 512 MiB).

Two things to know before editing it:

- **The file is validated as a whole.** One bad or missing field rejects all of it and every default
  is used instead, with only a `config.loaded-default` line on stdout to say so. Keep every field.
- **The three retention limits currently do nothing.** The policy is implemented and tested, but
  nothing calls the eviction that applies it, so history grows without bound and expired secrets stay
  on disk after they vanish from the palette. See "Known gaps in v1" in `ROADMAP.md`.

## Distribution

macOS ships as a notarized direct download when there's a Developer ID; the **Mac App Store is
closed to this app class**, because the sandbox forbids Accessibility and synthetic keystrokes — which
is why every Mac clipboard manager is a direct download. Windows via NSIS per-user installer, Linux
via `.deb`/`.rpm`. Nothing is signed yet, so builds are local-share only for now.

## License

MIT — see [`LICENSE`](LICENSE).
