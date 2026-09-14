import Foundation

struct WriteUploadError: Error {
  let code: String
}

// All mutable upload state is confined to Pasteboard.queue.
final class WriteUpload {
  private final class Transfer {
    let params: WriteBeginParams
    let startedAt: Int
    var touchedAt: Int
    var bytes: [Data]
    var sequences: [Int]
    init(_ params: WriteBeginParams, now: Int) {
      self.params = params
      startedAt = now
      touchedAt = now
      bytes = params.reps.map { _ in Data() }
      sequences = params.reps.map { _ in 0 }
    }
  }
  private let now: () -> Int
  private var current: Transfer?

  init(now: @escaping () -> Int = { Int(DispatchTime.now().uptimeNanoseconds / 1_000_000) }) { self.now = now }

  func begin(_ params: WriteBeginParams) throws {
    expire()
    guard current == nil, (1...MAX_WRITE_REPS).contains(params.reps.count) else {
      throw WriteUploadError(code: "E_REP_TOO_MANY")
    }
    guard !params.transferId.isEmpty, params.transferId.count <= 64 else {
      throw WriteUploadError(code: "E_BAD_PARAMS")
    }
    var total = 0
    for rep in params.reps {
      guard (0...MAX_REP_BYTES).contains(rep.byteLength) else { throw WriteUploadError(code: "E_REP_OVERFLOW") }
      total += rep.byteLength
      guard total <= MAX_WRITE_BYTES else { throw WriteUploadError(code: "E_REP_OVERFLOW") }
      guard !rep.mime.isEmpty, rep.mime.count <= 255, (rep.uti?.count ?? 0) <= 255,
            rep.sha256.range(of: "^sha256-[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
        throw WriteUploadError(code: "E_BAD_PARAMS")
      }
    }
    current = Transfer(params, now: now())
  }

  func append(_ params: WriteChunkParams) throws {
    let transfer = try find(params.transferId)
    do {
      guard transfer.bytes.indices.contains(params.repIndex), !params.b64.isEmpty else {
        throw WriteUploadError(code: "E_BAD_PARAMS")
      }
      let index = params.repIndex
      let expected = transfer.sequences[index]
      guard params.seq == expected else {
        throw WriteUploadError(code: params.seq < expected ? "E_REP_SEQ_DUPLICATE" : "E_REP_SEQ_GAP")
      }
      guard params.b64.count <= CHUNK_PAYLOAD_BYTES,
            transfer.bytes[index].count + params.b64.count <= transfer.params.reps[index].byteLength else {
        throw WriteUploadError(code: "E_REP_OVERFLOW")
      }
      transfer.bytes[index].append(params.b64)
      transfer.sequences[index] += 1
      transfer.touchedAt = now()
    } catch {
      discard()
      throw error
    }
  }

  func commit(_ params: WriteCommitParams) throws -> WriteParams {
    let transfer = try find(params.transferId)
    do {
      for (index, rep) in transfer.params.reps.enumerated() {
        guard transfer.bytes[index].count == rep.byteLength else { throw WriteUploadError(code: "E_REP_SHORT") }
        guard contentHash(transfer.bytes[index]) == rep.sha256 else { throw WriteUploadError(code: "E_REP_HASH_MISMATCH") }
      }
      current = nil
      return WriteParams(reps: transfer.params.reps.enumerated().map { index, rep in
        WriteParamsRepsItem(b64: transfer.bytes[index], mime: rep.mime, uti: rep.uti)
      }, transient: transfer.params.transient)
    } catch {
      discard()
      throw error
    }
  }

  func abort(_ params: WriteAbortParams) -> Bool {
    guard current?.params.transferId == params.transferId else { return false }
    discard()
    return true
  }

  func expire() {
    guard let transfer = current else { return }
    if now() - transfer.touchedAt >= REP_STREAM_TIMEOUT_MS || now() - transfer.startedAt >= WRITE_TRANSFER_TIMEOUT_MS {
      discard()
    }
  }

  private func find(_ id: String) throws -> Transfer {
    expire()
    guard let transfer = current, transfer.params.transferId == id else { throw WriteUploadError(code: "E_REP_UNKNOWN_ID") }
    return transfer
  }

  private func discard() {
    guard let transfer = current else { return }
    for index in transfer.bytes.indices {
      transfer.bytes[index].resetBytes(in: 0..<transfer.bytes[index].count)
    }
    current = nil
  }
}
