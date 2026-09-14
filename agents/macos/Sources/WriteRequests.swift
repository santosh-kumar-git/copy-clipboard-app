import Foundation

func handleWriteRequest(line: Data, id: String, method: String, upload: WriteUpload,
                        write: (WriteParams) -> String) {
  func decode<P: Decodable>(_ type: P.Type) throws -> P {
    try JSONDecoder().decode(Request<P>.self, from: line).params
  }
  do {
    switch method {
    case "write":
      let params = try decode(WriteParams.self)
      guard (1...MAX_WRITE_REPS).contains(params.reps.count) else { throw WriteUploadError(code: "E_REP_TOO_MANY") }
      guard params.reps.allSatisfy({ $0.b64.count <= MAX_REP_BYTES }),
            params.reps.reduce(0, { $0 + $1.b64.count }) <= MAX_WRITE_BYTES else {
        throw WriteUploadError(code: "E_REP_OVERFLOW")
      }
      Out.ok(id: id, WriteResult(changeToken: write(params)))
    case "write.begin":
      try upload.begin(decode(WriteBeginParams.self))
      Out.ok(id: id, WriteBeginResult(accepted: true))
    case "write.chunk":
      try upload.append(decode(WriteChunkParams.self))
      Out.ok(id: id, WriteChunkResult(accepted: true))
    case "write.commit":
      let params = try upload.commit(decode(WriteCommitParams.self))
      Out.ok(id: id, WriteCommitResult(changeToken: write(params)))
    case "write.abort":
      Out.ok(id: id, WriteAbortResult(aborted: upload.abort(try decode(WriteAbortParams.self))))
    default:
      Out.fail(id: id, code: "E_UNKNOWN_METHOD", message: "unknown write method")
    }
  } catch let error as WriteUploadError {
    Out.fail(id: id, code: error.code, message: "clipboard write upload rejected")
  } catch {
    Out.fail(id: id, code: "E_BAD_PARAMS", message: "invalid clipboard write parameters")
  }
}
