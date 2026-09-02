import {
  contentHash,
  type ClipboardChangedPayload, type LogEvent, type Logger,
  type PasteboardHint, type ResolvedRep,
} from '@cairn/protocol'

/** A ResolvedRep from a string or a Buffer, with byteLength and sha256 computed for you. */
export function rep(mime: string, uti: string | null, body: string | Uint8Array): ResolvedRep {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  return { mime, uti, bytes, byteLength: bytes.length, sha256: contentHash(bytes) }
}

/** A post-reassembly clipboard.changed payload. `changeToken` is String(changeCount) on macOS. */
export function changed(
  changeCount: number,
  reps: readonly ResolvedRep[],
  hints: readonly PasteboardHint[] = [],
): ClipboardChangedPayload {
  return {
    changeCount,
    changeToken: String(changeCount),
    hints,
    reps,
    sourceApp: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', confidence: 'heuristic' },
    droppedReps: [],
  }
}

/** Records only the LogEvent ids, which is all a metadata-only logger is allowed to carry. */
export function createSpyLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = []
  const push = (e: LogEvent): void => { events.push(e) }
  const logger: Logger = {
    log: (_level, e) => push(e),
    debug: (e) => push(e),
    info: (e) => push(e),
    warn: (e) => push(e),
    error: (e) => push(e),
  }
  return { logger, events }
}
