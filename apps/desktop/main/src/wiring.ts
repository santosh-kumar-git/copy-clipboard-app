import {
  err,
  ok,
  TOAST_COPIED_MANUAL,
  type Candidate,
  type Cancel,
  type Clock,
  type ClipboardAgent,
  type ItemId,
  type KeyringMode,
  type Logger,
  type Result,
  type ResolvedRep,
  type Unsub,
  WATCH_INTERVAL_MS,
} from '@cairn/protocol'
import type { Capture } from '@cairn/capture'
import type { History } from '@cairn/history'
import type { Hotkey, HotkeyStatus } from '@cairn/hotkey'
import {
  FIRST_RUN_HOTKEY_CHOICES,
  IDLE_CHECK_INTERVAL_MS,
  KEYRING_RELOCKED_BANNER,
  PREVIEW_CACHE_IDLE_MS,
} from './constants'
import type { CairnConfig } from './config'
import { registerIpcHandlers, sendIpcEvent, type IpcMainLike } from './ipc-handlers'
import type { PaletteController } from './windows'

/** Only what the composition root needs from the keyring, so a signature change upstream is a
 *  one-line fix in index.ts rather than a rewrite here. `probeBackend` is here because the keyring is
 *  the only component that knows what is really protecting the key, and spec §11 control 11 requires
 *  us to tell the user the truth rather than a hard-coded reassurance. */
export interface KeyringPort {
  getMode(): KeyringMode
  probeBackend(): { readonly notes: readonly string[]; readonly warning?: string }
  lock(): void
}

/** The store's derived blob name subkey is zero-filled by close(), so quit has to call it. */
export interface StorePort {
  close(): void
}

// There is deliberately NO local `CapturePort`. `capture` is typed as Task 7's `Capture`, imported
// above, and the reason is the shutdown path: a narrowed structural copy declaring `stop(): void` is
// *assignable* from `stop(): Promise<void>`, so it compiles — and then `stop()` below cannot await
// capture teardown, and `whenIdle()` (the only handle Task 7 gives a caller for "no candidate is
// mid-assembly") is not in the type at all. A half-assembled rep still holding clipboard bytes when
// keyring.lock() zero-fills the key is exactly the leak security invariant 1 exists to prevent.
// Using the real interface also removes the void-in-a-union problem the old port existed to work
// around: `Capture.start()` is plainly `Promise<Result<{intervalMs: number}>>`.

export interface PowerMonitorLike {
  on(event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume', cb: () => void): void
  getSystemIdleTime(): number
}

export type EvictReason = 'lock' | 'suspend' | 'idle'

export interface ComposeDeps {
  readonly agent: ClipboardAgent
  readonly capture: Capture
  readonly history: History
  readonly hotkey: Hotkey
  readonly keyring: KeyringPort
  readonly store: StorePort
  readonly palette: PaletteController
  readonly ipcMain: IpcMainLike
  readonly powerMonitor: PowerMonitorLike
  readonly clock: Clock
  readonly logger: Logger
  readonly config: CairnConfig
  readonly dataDir: string
  readonly saveConfig: (config: CairnConfig) => void
  readonly chooseHotkey: (candidates: readonly string[]) => Promise<string>
}

export interface CairnApp {
  start(): Promise<Result<{ accelerator: string; hotkeyStatus: HotkeyStatus }>>
  stop(): Promise<void>
  evictPreviewCache(reason: EvictReason): void
  recallCopy(id: ItemId): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>>
  previewText(id: ItemId): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>>
  securityStatus(): {
    keyringMode: KeyringMode
    encryptedAtRest: boolean
    dataDirMode: string
    notes: readonly string[]
  }
}

/** The frozen `cairn:history.preview` result caps `text` at 8192 characters. */
const PREVIEW_TEXT_MAX = 8_192

/** Spec §5.5's primary-representation order, restricted to the two the preview pane can show. */
function previewRep(reps: readonly ResolvedRep[]): ResolvedRep | undefined {
  return (
    reps.find((r) => r.mime === 'text/plain') ??
    reps.find((r) => r.mime === 'text/uri-list') ??
    reps.find((r) => r.mime === 'text/html') ??
    reps.find((r) => r.mime.startsWith('text/'))
  )
}

/**
 * The honest at-rest sentence, held as code so it cannot drift from what is true (spec §11
 * control 11). It is deliberately not reassuring.
 */
const SECURITY_NOTES = [
  'Everything Cairn stores is encrypted with AES-256-GCM. The data directory is 0700 and every file is 0600.',
  'Encryption at rest protects against disk theft and another account on this machine, not against code running as you.',
  'While Cairn is unlocked, the search index holds every preview decrypted in memory. It is emptied on screen lock, on sleep and after five minutes idle.',
  'Cairn sends nothing anywhere. There is no telemetry, no crash reporting and no network connection of any kind.',
] as const

export function composeApp(deps: ComposeDeps): CairnApp {
  const {
    agent, capture, history, hotkey, keyring, store, palette, ipcMain, powerMonitor, clock, logger,
    saveConfig, chooseHotkey,
  } = deps

  let config = deps.config
  let stopped = false
  let unregisterIpc: Unsub = () => {}
  let cancelIdleTick: Cancel = () => {}
  let evictedWhileIdle = false
  /** True between a passphrase-mode screen lock and the next unlock, so the user is told why the
   *  history went away instead of being shown a silently empty palette. */
  let relockedOnScreenLock = false

  const evictPreviewCache = (reason: EvictReason): void => {
    history.evictPreviewCache()
    logger.info(
      reason === 'lock'
        ? 'preview-cache.evicted-lock'
        : reason === 'suspend'
          ? 'preview-cache.evicted-suspend'
          : 'preview-cache.evicted-idle',
    )
  }

  const armIdleTick = (): void => {
    cancelIdleTick = clock.setTimeout(() => {
      // getSystemIdleTime() is in SECONDS (verified on Electron 44.1.1).
      const idleMs = powerMonitor.getSystemIdleTime() * 1_000
      if (idleMs >= PREVIEW_CACHE_IDLE_MS) {
        if (!evictedWhileIdle) {
          evictedWhileIdle = true
          evictPreviewCache('idle')
        }
      } else {
        evictedWhileIdle = false
      }
      if (!stopped) armIdleTick()
    }, IDLE_CHECK_INTERVAL_MS)
  }

  const recallCopy = async (
    id: ItemId,
  ): Promise<Result<{ result: 'copied-manual'; reason: 'user-preference' }>> => {
    const resolved = await history.resolveReps(id)
    if (!resolved.ok) return resolved
    if (resolved.value.length === 0) {
      return err('E_ITEM_NOT_FOUND', 'the item has no representations to put on the clipboard')
    }
    const write = await agent.request('write', {
      // transient: false — in M1 the USER presses Cmd+V afterwards, so the item must stay on the
      // pasteboard. M2's auto-paste path writes transient:true because it consumes it immediately.
      transient: false,
      reps: resolved.value.map((r) => ({
        mime: r.mime,
        uti: r.uti,
        b64: Buffer.from(r.bytes).toString('base64'),
      })),
    })
    if (!write.ok) return write
    // BEFORE hiding, and before anything can await: the agent's 500 ms poll must never see our own
    // write as a new clipboard item, or every recall doubles the history.
    capture.suppressToken(write.value.changeToken)
    palette.hide()
    sendIpcEvent(paletteTarget, 'cairn:toast', { text: TOAST_COPIED_MANUAL, tone: 'info' }, logger)
    logger.info('recall.copied', { itemId: id, repCount: resolved.value.length })
    return ok({ result: 'copied-manual' as const, reason: 'user-preference' as const })
  }

  /** `PaletteController.send` already validates nothing, so route events through sendIpcEvent. */
  const paletteTarget = {
    send: (channel: string, payload: unknown) => { palette.send(channel as never, payload) },
    isDestroyed: () => false,
  }

  const previewText = async (
    id: ItemId,
  ): Promise<Result<{ text: string; isHtmlSource: boolean; truncated: boolean }>> => {
    const resolved = await history.resolveReps(id)
    if (!resolved.ok) return resolved
    const chosen = previewRep(resolved.value)
    if (chosen === undefined) return ok({ text: '', isHtmlSource: false, truncated: false })
    // Decoded as text and returned as text. Spec §11 control 3: copied HTML is NEVER rendered as
    // HTML — when the item is HTML this is the source, and `isHtmlSource` only labels the pane.
    const full = new TextDecoder('utf-8', { fatal: false }).decode(chosen.bytes)
    const truncated = full.length > PREVIEW_TEXT_MAX
    return ok({
      text: truncated ? full.slice(0, PREVIEW_TEXT_MAX) : full,
      isHtmlSource: chosen.mime === 'text/html',
      truncated,
    })
  }

  const securityStatus = (): ReturnType<CairnApp['securityStatus']> => {
    // The keyring is the only component that knows what is actually protecting the key, so its own
    // sentences are appended rather than paraphrased here. On a machine with a weak backend
    // `warning` is BANNER_KEYRING_WEAK, and this is the path by which the user ever sees it.
    const probe = keyring.probeBackend()
    return {
      keyringMode: keyring.getMode(),
      encryptedAtRest: keyring.getMode() !== 'locked',
      dataDirMode: '700',
      notes: [
        ...SECURITY_NOTES,
        ...probe.notes,
        ...(probe.warning === undefined ? [] : [probe.warning]),
      ],
    }
  }

  return {
    async start() {
      // 0. IPC FIRST. This used to be step 5, reasoned as "IPC last, so no handler can be called
      //    before its dependencies exist" — which had the race backwards. The palette window is
      //    created and its renderer is loaded by index.ts BEFORE start() is ever called, and the
      //    renderer's first act is history.list. Registering handlers down at step 5 meant that
      //    call raced an `await agent.start()`, an `await capture.start()` and, on first run, a
      //    MODAL DIALOG. It lost: "No handler registered for 'cairn:history.list'", and the palette
      //    opened empty.
      //    Registering here is safe because every dependency below is already constructed: history
      //    is loaded before the window exists, and `palette` is the window itself. The one handler
      //    that genuinely needs a started agent is recall.copy, which is only reachable by clicking
      //    a row in a palette that cannot be shown until the hotkey binds at step 4.
      unregisterIpc = registerIpcHandlers({
        ipcMain,
        history,
        preview: { preview: previewText },
        recall: { copy: recallCopy },
        palette: { hide: () => palette.hide(), isVisible: () => palette.isVisible() },
        security: { status: securityStatus },
        logger,
      })

      // 1. The agent: nothing else in M1 works without it.
      await agent.start()
      await agent.request('watch.start', { intervalMs: WATCH_INTERVAL_MS })

      // 2. Capture -> privacy -> history -> search. `capture` emits at most one Candidate per
      //    clipboard change and has already applied the privacy layer's `skip` decision.
      // The parameter is annotated on purpose: `Candidate` is imported as a type above, and with
      // `noUnusedLocals: true` an inferred callback parameter would make that import an unused-local
      // error (TS6133) now that there is no local `CapturePort` declaration mentioning it.
      capture.onCandidate((candidate: Candidate) => {
        void history.ingest(candidate).then((r) => {
          if (!r.ok) return
          const total = history.list({ limit: 1, offset: 0 }).total
          sendIpcEvent(paletteTarget, 'cairn:history.changed', { reason: 'ingest', total }, logger)
        })
      })
      history.onChange((e) => {
        sendIpcEvent(paletteTarget, 'cairn:history.changed', { reason: e.reason, total: e.total }, logger)
      })
      await capture.start()

      // 3. The first-run hotkey step (spec §9). Asked once, then persisted, and the default is
      //    pre-selected — but the dialog NAMES what Cmd+Shift+V overrides.
      let accelerator = config.accelerator
      if (!config.firstRunHotkeyDone) {
        const chosen = await chooseHotkey(FIRST_RUN_HOTKEY_CHOICES)
        accelerator = chosen
        config = { ...config, accelerator: chosen, firstRunHotkeyDone: true }
        saveConfig(config)
        logger.info('config.saved', { accelerator: chosen })
      }

      // 4. The hotkey, through the Swift agent's Carbon registration. A failed bind is a STATE.
      const bound = await hotkey.bind(accelerator)
      const status = hotkey.status()
      if (!bound.ok) logger.warn('hotkey.bind-failed', { accelerator, code: bound.code })
      sendIpcEvent(paletteTarget, 'cairn:hotkey.status', { status, accelerator }, logger)

      hotkey.onTrigger(() => {
        if (palette.isVisible()) {
          palette.hide()
          return
        }
        palette.show()
        sendIpcEvent(paletteTarget, 'cairn:palette.shown', { shownAt: clock.now() }, logger)
      })

      // 5. (IPC used to be registered here. See step 0 for why it cannot be.)

      // 6. Preview-cache hygiene (spec §11 control 6). Electron maps 'lock-screen' /
      //    'unlock-screen' to the macOS distributed notifications com.apple.screenIsLocked /
      //    com.apple.screenIsUnlocked, and 'suspend' / 'resume' to
      //    NSWorkspaceWillSleepNotification / NSWorkspaceDidWakeNotification.
      //    The third clause of control 6 is the `getMode() === 'passphrase'` branch: in passphrase
      //    mode a screen lock must zero the master key too, not merely the preview cache, because
      //    the whole point of a passphrase is that walking away re-arms it. In os-keyring mode we do
      //    NOT lock: the OS keyring re-supplies the key on login anyway, and zeroing it would leave
      //    the running process unable to read its own store with nothing gained.
      //    M1 NARROWING, recorded so this is not read as full compliance: the lock zero-fills the key
      //    and the palette shows KEYRING_RELOCKED_BANNER, but re-entering the passphrase requires
      //    relaunching Cairn, because the in-session prompt is renderer surface deferred to M3.
      //    `keyring.unlockWithPassphrase()` therefore has no M1 call site and is covered only by
      //    `packages/keyring/src/keyring.test.ts`. The invariant still holds — the key really is gone.
      powerMonitor.on('lock-screen', () => {
        evictPreviewCache('lock')
        if (keyring.getMode() === 'passphrase') {
          keyring.lock()
          relockedOnScreenLock = true
        }
      })
      powerMonitor.on('suspend', () => evictPreviewCache('suspend'))
      powerMonitor.on('unlock-screen', () => {
        evictedWhileIdle = false
        if (relockedOnScreenLock) {
          relockedOnScreenLock = false
          sendIpcEvent(paletteTarget, 'cairn:toast', { text: KEYRING_RELOCKED_BANNER, tone: 'warn' }, logger)
        }
      })
      powerMonitor.on('resume', () => { evictedWhileIdle = false })
      armIdleTick()

      logger.info('app.ready', { mode: keyring.getMode() })
      return ok({ accelerator, hotkeyStatus: status })
    },

    async stop() {
      if (stopped) return
      stopped = true
      logger.info('app.quitting')
      cancelIdleTick()
      unregisterIpc()
      await hotkey.unbind()
      // AWAITED, both of them. `Capture.stop()` is `Promise<void>`; `whenIdle()` resolves once no
      // candidate is mid-assembly. Firing and forgetting either one leaves a half-assembled rep
      // holding clipboard bytes in memory past the line below that zero-fills the key — the exact
      // leak security invariant 1 exists to prevent.
      await capture.stop()
      await capture.whenIdle()
      await agent.dispose()
      // Spec §11 control 6, in order: the master key Buffer is zero-filled, then the store zero-fills
      // the derived blob name subkey. Both, or the second one stays live in a Buffer for the rest of
      // the process image.
      keyring.lock()
      store.close()
    },

    evictPreviewCache,
    recallCopy,
    previewText,
    securityStatus,
  }
}
