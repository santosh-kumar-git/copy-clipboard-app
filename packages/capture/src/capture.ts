import {
  CAPTURE_DEBOUNCE_MS, WATCH_INTERVAL_MS, err, ok,
  type Candidate, type ClipboardAgent, type ClipboardChangedPayload, type Clock,
  type Classification, type Logger, type PasteboardHint, type PrivacyRules, type Result,
  type Snapshot, type Unsub,
} from '@cairn/protocol'
import { classifyKind, selectPrimaryRep } from './classify-kind'
import { normalizeReps } from './normalize-reps'
import { thumbnail } from './thumbnail'

export interface CaptureConfig {
  readonly debounceMs: number
  readonly watchIntervalMs: number
  readonly rules: PrivacyRules
}

export interface CaptureDeps {
  readonly agent: ClipboardAgent
  /** Structurally satisfied by `import * as privacy from '@cairn/privacy'`. */
  readonly privacy: {
    classify: (s: Snapshot, r: PrivacyRules) => Classification
    mask: (t: string) => { readonly preview: string; readonly spans: readonly { readonly start: number; readonly end: number }[] }
    shouldSkipOnHints: (h: readonly PasteboardHint[], r: PrivacyRules) => boolean
  }
  readonly config: CaptureConfig
  readonly clock: Clock
  readonly logger: Logger
}

export interface Capture {
  start(): Promise<Result<{ intervalMs: number }>>
  stop(): Promise<void>
  onCandidate(cb: (c: Candidate) => void): Unsub
  suppressToken(token: string): void
  /** Resolves when no candidate is mid-assembly. */
  whenIdle(): Promise<void>
}

export const defaultCaptureConfig = (rules: PrivacyRules): CaptureConfig => ({
  debounceMs: CAPTURE_DEBOUNCE_MS,
  watchIntervalMs: WATCH_INTERVAL_MS,
  rules,
})

export function createCapture(deps: CaptureDeps): Capture {
  const { agent, privacy, config, clock, logger } = deps
  const listeners = new Set<(c: Candidate) => void>()
  const suppressed = new Set<string>()
  let pending: ClipboardChangedPayload | null = null
  let cancelDebounce: (() => void) | null = null
  let unsubAgent: Unsub | null = null
  // Flushes are chained rather than fired in parallel, so a 5 MB PNG that thumbnails slowly can
  // never emit its candidate after the 12-byte text copied a moment later.
  let inFlight: Promise<void> = Promise.resolve()

  const emit = async (ev: ClipboardChangedPayload): Promise<void> => {
    // LAYER 1 of the privacy model, and it runs BEFORE normalizeReps or thumbnail read a byte.
    if (privacy.shouldSkipOnHints(ev.hints, config.rules)) {
      logger.info('privacy.skipped', { count: ev.reps.length })
      return
    }
    const reps = await normalizeReps(ev.reps)
    const primary = selectPrimaryRep(reps)
    if (primary === null) {
      logger.info('privacy.skipped', { count: 0 })
      return
    }
    const kind = classifyKind(reps)
    const rawText = primary.mime.startsWith('text/') ? Buffer.from(primary.bytes).toString('utf8') : null
    const snapshot: Snapshot = {
      reps,
      primaryText: rawText,
      kind,
      hints: ev.hints,
      sourceApp: ev.sourceApp,
      totalBytes: reps.reduce((n, r) => n + r.byteLength, 0),
    }
    const verdict = privacy.classify(snapshot, config.rules)
    if (verdict.action === 'skip') {
      logger.info('privacy.skipped', { kind, flags: verdict.flags })
      return
    }
    // MASKING AT INGEST (spec §11 control 5). The candidate that leaves this module carries the
    // masked preview, so nothing downstream — least of all the in-memory index — holds the raw
    // secret. The raw bytes stay in `reps`, bound for the encrypted store and nowhere else.
    let previewText = rawText
    if (verdict.flags.includes('secret') && rawText !== null) {
      const masked = privacy.mask(rawText)
      previewText = masked.preview
      logger.info('privacy.masked', { kind, count: masked.spans.length })
    }
    let thumb: Uint8Array | null = null
    const pngRep = reps.find((r) => r.mime === 'image/png')
    if (pngRep !== undefined) {
      thumb = await thumbnail(pngRep.bytes)
      logger.debug('capture.thumbnail', { byteLength: thumb.length })
    }
    const candidate: Candidate = {
      reps,
      kind,
      contentHash: primary.sha256,          // already contentHash(primary.bytes), resealed above
      primaryText: previewText,
      hints: ev.hints,
      sourceApp: ev.sourceApp,
      thumbnailJpeg: thumb,
      changeToken: ev.changeToken,
      capturedAt: clock.now(),
    }
    logger.info('capture.candidate', {
      kind,
      repCount: reps.length,
      byteLength: snapshot.totalBytes,
      hashPrefix: candidate.contentHash.slice(0, 12),
      flags: verdict.flags,
    })
    for (const cb of [...listeners]) cb(candidate)
  }

  const flush = (): void => {
    cancelDebounce = null
    const ev = pending
    pending = null
    if (ev === null) return
    inFlight = inFlight.then(() => emit(ev))
  }

  const onChanged = (ev: ClipboardChangedPayload): void => {
    // SELF-WRITE SUPPRESSION. One-shot: the token is consumed, so an unrelated later change with a
    // recycled token is still recorded.
    if (suppressed.has(ev.changeToken)) {
      suppressed.delete(ev.changeToken)
      logger.info('capture.self-write-suppressed', { count: suppressed.size })
      return
    }
    if (pending !== null) logger.debug('capture.debounced', { count: 1 })
    pending = ev
    // Fixed window from the FIRST event of a burst: a chatty app cannot postpone capture forever.
    if (cancelDebounce === null) cancelDebounce = clock.setTimeout(flush, config.debounceMs)
  }

  return {
    async start() {
      unsubAgent = agent.on('clipboard.changed', onChanged)
      const res = await agent.request('watch.start', { intervalMs: config.watchIntervalMs })
      if (!res.ok) return err(res.code, res.message)
      return ok({ intervalMs: config.watchIntervalMs })
    },
    async stop() {
      if (cancelDebounce !== null) { cancelDebounce(); cancelDebounce = null }
      pending = null
      unsubAgent?.()
      unsubAgent = null
      await agent.request('watch.stop', {})
    },
    onCandidate(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    suppressToken(token) { suppressed.add(token) },
    whenIdle() { return inFlight },
  }
}
