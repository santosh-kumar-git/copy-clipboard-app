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

export function createReassembler(opts: {
  clock: Clock
  logger: Logger
  onComplete: (repId: string, rep: ResolvedRep) => void
  onAbort: (abort: RepAbort) => void
}): Reassembler {
  const { logger, onComplete, onAbort } = opts
  const streams = new Map<string, RepStream>()

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
        logger.warn('rep.stream-aborted', { code: 'E_REP_UNKNOWN_ID', repCount: streams.size })
        return
      }
      const bytes = Buffer.from(c.b64, 'base64')
      s.parts.push(bytes)
      s.receivedBytes += bytes.length
      s.expectedSeq += 1
      if (!c.final) return
      s.sawFinal = true
      const assembled = Buffer.concat(s.parts)
      const hash = contentHash(assembled)
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
      for (const s of [...streams.values()]) {
        streams.delete(s.repId)
        logger.warn('rep.stream-aborted', { code, repCount: streams.size })
        onAbort({ repId: s.repId, mime: s.mime, code })
      }
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
