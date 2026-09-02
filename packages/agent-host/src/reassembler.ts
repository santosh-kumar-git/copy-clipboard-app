import {
  contentHash,
  MAX_CONCURRENT_REP_STREAMS,
  MAX_REP_BYTES,
  REP_STREAM_TIMEOUT_MS,
  type Cancel,
  type ClipboardChangedPayload,
  type Clock,
  type ContentHash,
  type ErrorCode,
  type Logger,
  type PasteboardHint,
  type Rep,
  type ResolvedRep,
} from '@cairn/protocol'

export interface RepAbort {
  readonly repId: string
  readonly mime: string
  readonly code: ErrorCode
}

export interface RepChunkIn {
  readonly repId: string
  readonly seq: number
  readonly final: boolean
  readonly b64: string
}

export interface Reassembler {
  /** Open a stream for a wire Rep that carries `repId`. */
  declare(rep: Rep & { repId: string }): void
  /** Feed one `rep.chunk` event payload. */
  chunk(c: RepChunkIn): void
  /** Abort every open stream — the child died, or we are disposing. */
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly bufferedBytes: number
}

interface RepStream {
  readonly repId: string
  readonly mime: string
  readonly uti: string | null
  readonly declaredBytes: number
  readonly declaredHash: ContentHash
  readonly parts: Uint8Array[]
  receivedBytes: number
  expectedSeq: number
  sawFinal: boolean
  cancelTimeout: Cancel
}

const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Strict base64 decode. `Buffer.from(s, 'base64')` silently skips junk characters, so without this
 * a corrupted chunk decodes to fewer bytes and looks like a legitimately short payload.
 */
function decodeBase64(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0 || !STRICT_BASE64.test(b64)) return null
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.toString('base64') !== b64) return null
  return bytes
}

export function createReassembler(opts: {
  clock: Clock
  logger: Logger
  onComplete: (repId: string, rep: ResolvedRep) => void
  onAbort: (abort: RepAbort) => void
}): Reassembler {
  const { clock, logger, onComplete, onAbort } = opts
  const streams = new Map<string, RepStream>()
  /**
   * repIds whose `final: true` chunk has already been processed. Bounded FIFO, so it cannot grow.
   * It exists to tell "the agent sent one chunk too many" (E_REP_AFTER_FINAL) apart from "the agent
   * sent a chunk for an id it never declared" (E_REP_UNKNOWN_ID) — step 3 deletes the stream, so
   * both look identical without it.
   */
  const ended: string[] = []
  const markEnded = (repId: string): void => {
    ended.push(repId)
    if (ended.length > MAX_CONCURRENT_REP_STREAMS * 4) ended.shift()
  }

  const abort = (s: RepStream, code: ErrorCode): void => {
    s.cancelTimeout()
    // Zero what we drop: this process holds the user's clipboard, and half a private key should not
    // sit in a reachable heap object waiting for GC.
    for (const p of s.parts) p.fill(0)
    s.parts.length = 0
    streams.delete(s.repId)
    logger.warn('rep.stream-aborted', { code, repCount: streams.size })
    onAbort({ repId: s.repId, mime: s.mime, code })
  }

  const arm = (s: RepStream): void => {
    s.cancelTimeout = clock.setTimeout(() => abort(s, 'E_REP_TIMEOUT'), REP_STREAM_TIMEOUT_MS)
  }

  const refuse = (rep: Rep & { repId: string }, code: ErrorCode): void => {
    logger.warn('rep.stream-aborted', { code, repCount: streams.size })
    onAbort({ repId: rep.repId, mime: rep.mime, code })
  }

  return {
    declare(rep): void {
      if (streams.has(rep.repId) || streams.size >= MAX_CONCURRENT_REP_STREAMS) {
        return refuse(rep, 'E_REP_TOO_MANY')
      }
      // Refuse an oversized declaration before allocating anything at all.
      if (rep.byteLength > MAX_REP_BYTES) return refuse(rep, 'E_REP_OVERFLOW')
      const s: RepStream = {
        repId: rep.repId,
        mime: rep.mime,
        uti: rep.uti,
        declaredBytes: rep.byteLength,
        declaredHash: rep.sha256 as ContentHash,
        parts: [],
        receivedBytes: 0,
        expectedSeq: 0,
        sawFinal: false,
        cancelTimeout: () => {},
      }
      streams.set(s.repId, s)
      arm(s)
      logger.debug('rep.stream-begin', { mime: s.mime, byteLength: s.declaredBytes })
    },

    chunk(c): void {
      const s = streams.get(c.repId)
      if (s === undefined) {
        // Nothing to abort: there is no stream to drop, so this is log-and-forget.
        const code = ended.includes(c.repId) ? 'E_REP_AFTER_FINAL' : 'E_REP_UNKNOWN_ID'
        logger.warn('rep.stream-aborted', { code, repCount: streams.size })
        return
      }
      if (c.seq < s.expectedSeq) return abort(s, 'E_REP_SEQ_DUPLICATE')
      if (c.seq > s.expectedSeq) return abort(s, 'E_REP_SEQ_GAP')
      const bytes = decodeBase64(c.b64)
      if (bytes === null) return abort(s, 'E_REP_BAD_BASE64')
      if (
        s.receivedBytes + bytes.length > s.declaredBytes ||
        s.receivedBytes + bytes.length > MAX_REP_BYTES
      ) {
        return abort(s, 'E_REP_OVERFLOW')
      }
      s.cancelTimeout()
      s.parts.push(bytes)
      s.receivedBytes += bytes.length
      s.expectedSeq += 1
      if (!c.final) {
        arm(s)
        return
      }
      s.sawFinal = true
      markEnded(s.repId)
      if (s.receivedBytes !== s.declaredBytes) return abort(s, 'E_REP_SHORT')
      const assembled = Buffer.concat(s.parts)
      const hash = contentHash(assembled)
      // The host verifies the hash BEFORE handing the bytes to anyone.
      if (hash !== s.declaredHash) return abort(s, 'E_REP_HASH_MISMATCH')
      streams.delete(s.repId)
      logger.debug('rep.stream-complete', {
        mime: s.mime,
        byteLength: s.receivedBytes,
        hashPrefix: hash.slice(0, 12),
      })
      onComplete(s.repId, {
        mime: s.mime,
        uti: s.uti,
        bytes: assembled,
        byteLength: assembled.length,
        sha256: hash,
      })
    },

    abortAll(code): void {
      for (const s of [...streams.values()]) abort(s, code)
    },

    get openStreams(): number {
      return streams.size
    },
    get bufferedBytes(): number {
      let n = 0
      for (const s of streams.values()) n += s.receivedBytes
      return n
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The change assembler: turns ONE `clipboard.changed` wire event into ONE ClipboardChangedPayload,
// holding it until every chunked representation it declared has completed or been discarded.
// ---------------------------------------------------------------------------------------------

export interface ChangedWire {
  readonly changeCount: number
  readonly hints: readonly PasteboardHint[]
  readonly reps: readonly Rep[]
  readonly frontmostBundleId: string | null
  readonly frontmostName: string | null
  readonly attributionConfidence: 'heuristic' | 'unknown'
}

export interface ChangeAssembler {
  handleChanged(w: ChangedWire): void
  handleChunk(c: RepChunkIn): void
  abortAll(code: ErrorCode): void
  readonly openStreams: number
  readonly pendingChanges: number
}

interface Slot {
  readonly mime: string
  resolved: ResolvedRep | null
  dropped: ErrorCode | null
}

interface PendingChange {
  readonly slots: Slot[]
  readonly wire: ChangedWire
  outstanding: number
}

export function createChangeAssembler(opts: {
  clock: Clock
  logger: Logger
  emit: (payload: ClipboardChangedPayload) => void
}): ChangeAssembler {
  const { logger, emit } = opts
  /** repId -> which pending change and which slot it fills. */
  const owner = new Map<string, { change: PendingChange; slot: number }>()
  let pending: PendingChange[] = []

  const finish = (p: PendingChange): void => {
    pending = pending.filter((q) => q !== p)
    const reps: ResolvedRep[] = []
    const droppedReps: { mime: string; code: ErrorCode }[] = []
    for (const s of p.slots) {
      if (s.resolved !== null) reps.push(s.resolved)
      else if (s.dropped !== null) droppedReps.push({ mime: s.mime, code: s.dropped })
    }
    const w = p.wire
    emit({
      changeCount: w.changeCount,
      changeToken: String(w.changeCount),
      hints: w.hints,
      reps,
      sourceApp:
        w.frontmostBundleId === null && w.frontmostName === null
          ? null
          : { bundleId: w.frontmostBundleId, name: w.frontmostName, confidence: w.attributionConfidence },
      droppedReps,
    })
  }

  const reassembler = createReassembler({
    clock: opts.clock,
    logger,
    onComplete: (repId, rep) => {
      const at = owner.get(repId)
      if (at === undefined) return
      owner.delete(repId)
      at.change.slots[at.slot]!.resolved = rep
      at.change.outstanding -= 1
      if (at.change.outstanding === 0) finish(at.change)
    },
    onAbort: ({ repId, code }) => {
      const at = owner.get(repId)
      if (at === undefined) return
      owner.delete(repId)
      at.change.slots[at.slot]!.dropped = code
      at.change.outstanding -= 1
      if (at.change.outstanding === 0) finish(at.change)
    },
  })

  return {
    handleChanged(w): void {
      const slots: Slot[] = w.reps.map((r) => ({ mime: r.mime, resolved: null, dropped: null }))
      const p: PendingChange = { slots, wire: w, outstanding: 0 }
      const chunked: { rep: Rep & { repId: string }; slot: number }[] = []
      w.reps.forEach((r, i) => {
        if (r.inline !== undefined) {
          const bytes = Buffer.from(r.inline, 'base64')
          const hash = contentHash(bytes)
          if (bytes.length !== r.byteLength) {
            slots[i]!.dropped = 'E_REP_SHORT'
            logger.warn('rep.stream-aborted', { code: 'E_REP_SHORT', mime: r.mime })
          } else if (hash !== r.sha256) {
            slots[i]!.dropped = 'E_REP_HASH_MISMATCH'
            logger.warn('rep.stream-aborted', { code: 'E_REP_HASH_MISMATCH', mime: r.mime })
          } else {
            slots[i]!.resolved = { mime: r.mime, uti: r.uti, bytes, byteLength: bytes.length, sha256: hash }
            logger.debug('rep.inline-received', { mime: r.mime, byteLength: bytes.length })
          }
        } else if (r.repId !== undefined) {
          chunked.push({ rep: r as Rep & { repId: string }, slot: i })
          p.outstanding += 1
        }
      })
      if (p.outstanding === 0) {
        finish(p)
        return
      }
      pending.push(p)
      for (const c of chunked) {
        owner.set(c.rep.repId, { change: p, slot: c.slot })
        reassembler.declare(c.rep)
      }
    },

    handleChunk(c): void {
      reassembler.chunk(c)
    },

    abortAll(code): void {
      // Aborting every stream settles every pending change through onAbort, so a consumer that was
      // waiting on a chunked rep gets a payload with `droppedReps` rather than nothing at all.
      reassembler.abortAll(code)
      pending = []
      owner.clear()
    },

    get openStreams(): number {
      return reassembler.openStreams
    },
    get pendingChanges(): number {
      return pending.length
    },
  }
}
