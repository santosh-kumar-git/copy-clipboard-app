import {
  CHUNK_PAYLOAD_BYTES, MAX_LINE_BYTES, MAX_REP_BYTES, MAX_WRITE_BYTES, MAX_WRITE_REPS,
  WRITE_TRANSFER_TIMEOUT_MS, WIRE_MAJOR, contentHash, err,
  type AgentMethod, type AgentParams, type AgentResult, type Clock, type Result,
} from '@cairn/protocol'

type Request = <M extends AgentMethod>(
  method: M, params: AgentParams<M>, timeoutMs: number,
) => Promise<Result<AgentResult<M>>>

export function createWriteTransport(deps: {
  request: Request
  supportsChunks(): boolean
  nextId(): string
  clock: Clock
}): (params: AgentParams<'write'>, timeoutMs: number) => Promise<Result<AgentResult<'write'>>> {
  let active = false
  return async (params, timeoutMs) => {
    if (active) return err('E_REP_TOO_MANY', 'a clipboard write is already in progress')
    if (params.reps.length === 0 || params.reps.length > MAX_WRITE_REPS) {
      return err('E_REP_TOO_MANY', 'clipboard writes require between 1 and 8 representations')
    }
    const decoded: Buffer[] = []
    active = true
    try {
      let total = 0
      for (const rep of params.reps) {
        if (rep.b64.length > Math.ceil(MAX_REP_BYTES / 3) * 4) {
          return err('E_REP_OVERFLOW', 'a clipboard representation exceeds 20 MiB')
        }
        if (!rep.mime || rep.mime.length > 255 || (rep.uti !== null && rep.uti.length > 255)) {
          return err('E_BAD_PARAMS', 'invalid representation type')
        }
        const bytes = Buffer.from(rep.b64, 'base64')
        decoded.push(bytes)
        if (bytes.toString('base64') !== rep.b64) return err('E_REP_BAD_BASE64', 'invalid representation encoding')
        total += bytes.length
        if (bytes.length > MAX_REP_BYTES || total > MAX_WRITE_BYTES) {
          return err('E_REP_OVERFLOW', 'clipboard writes are limited to 20 MiB per representation and 64 MiB total')
        }
      }
      // Reserve the maximum request-id length so a boundary-sized inline request remains capped.
      const envelope = JSON.stringify({ v: WIRE_MAJOR, t: 'req', id: '0'.repeat(64), method: 'write',
        params: { ...params, reps: params.reps.map((rep) => ({ ...rep, b64: '' })) } })
      const lineBytes = Buffer.byteLength(envelope) + params.reps.reduce((sum, rep) => sum + rep.b64.length, 0)
      if (lineBytes <= MAX_LINE_BYTES) return await deps.request('write', params, timeoutMs)
      if (!deps.supportsChunks()) {
        return err('E_LINE_TOO_LONG', 'this agent does not support large clipboard writes; update Cairn')
      }
      const transferId = deps.nextId()
      const deadline = deps.clock.now() + WRITE_TRANSFER_TIMEOUT_MS
      const send: Request = (method, payload) => {
        const remaining = deadline - deps.clock.now()
        return remaining <= 0
          ? Promise.resolve(err('E_TIMEOUT', 'clipboard upload exceeded 30 seconds'))
          : deps.request(method, payload, Math.min(timeoutMs, remaining))
      }
      let committed = false
      try {
        const begun = await send('write.begin', {
          transferId, transient: params.transient,
          reps: params.reps.map((rep, index) => ({
            mime: rep.mime, uti: rep.uti, byteLength: decoded[index]!.length, sha256: contentHash(decoded[index]!),
          })),
        }, timeoutMs)
        if (!begun.ok) return begun
        for (const [repIndex, bytes] of decoded.entries()) {
          for (let offset = 0, seq = 0; offset < bytes.length; offset += CHUNK_PAYLOAD_BYTES, seq += 1) {
            const chunk = await send('write.chunk', {
              transferId, repIndex, seq,
              b64: bytes.subarray(offset, offset + CHUNK_PAYLOAD_BYTES).toString('base64'),
            }, timeoutMs)
            if (!chunk.ok) return chunk
          }
        }
        const result = await send('write.commit', { transferId }, timeoutMs)
        committed = result.ok
        return result
      } finally {
        if (!committed) await deps.request('write.abort', { transferId }, Math.min(timeoutMs, 1_000))
      }
    } finally {
      active = false
      for (const bytes of decoded) bytes.fill(0)
    }
  }
}
