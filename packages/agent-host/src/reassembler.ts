import {
  contentHash,
  type Cancel,
  type Clock,
  type ContentHash,
  type ErrorCode,
  type Logger,
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
  const { logger, onComplete, onAbort } = opts
  const streams = new Map<string, RepStream>()

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

  return {
    declare(rep): void {
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
      logger.debug('rep.stream-begin', { mime: s.mime, byteLength: s.declaredBytes })
    },

    chunk(c): void {
      const s = streams.get(c.repId)
      if (s === undefined) {
        // Nothing to abort: there is no stream to drop, so this is log-and-forget.
        logger.warn('rep.stream-aborted', { code: 'E_REP_UNKNOWN_ID', repCount: streams.size })
        return
      }
      if (c.seq < s.expectedSeq) return abort(s, 'E_REP_SEQ_DUPLICATE')
      if (c.seq > s.expectedSeq) return abort(s, 'E_REP_SEQ_GAP')
      const bytes = decodeBase64(c.b64)
      if (bytes === null) return abort(s, 'E_REP_BAD_BASE64')
      if (s.receivedBytes + bytes.length > s.declaredBytes) return abort(s, 'E_REP_OVERFLOW')
      s.parts.push(bytes)
      s.receivedBytes += bytes.length
      s.expectedSeq += 1
      if (!c.final) return
      s.sawFinal = true
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
