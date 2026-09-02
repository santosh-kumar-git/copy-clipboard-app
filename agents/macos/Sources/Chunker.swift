import Foundation

/// Representations at or over 64 KiB are streamed over the SAME stdout pipe as `rep.chunk` events.
/// There is no other path. The agent never opens a file for clipboard bytes — no spool, no temp, no
/// cache (spec §11 control 1). The only sink in this file is stdout. If you are about to reach for
/// anything in the filesystem API here, stop: that is the vulnerability this design removed.
enum Chunker {
  struct Stream {
    let repId: String
    /// At most CHUNK_PAYLOAD_BYTES RAW bytes each, in order. `RepChunkData.b64` is `Data`, so
    /// JSONEncoder base64-encodes each payload on the way out and nothing here touches a base64 API.
    let payloads: [Data]
  }

  private static let lock = NSLock()
  private static var counter = 0

  static func nextRepId() -> String {
    lock.lock(); defer { lock.unlock() }
    counter += 1
    return "r\(counter)"
  }

  /// PURE. Splits raw bytes into slices of at most `payloadBytes` RAW bytes each. `Data(...)` is a
  /// real copy rather than a slice, so each payload's own indices start at 0 and the encoder cannot
  /// be confused by a non-zero `startIndex`.
  /// 32 768 raw bytes base64-encode to exactly 43 692 characters, so one chunk line stays under
  /// Node's 64 KiB default pipe highWaterMark and far under MAX_LINE_BYTES.
  static func split(_ bytes: Data, payloadBytes: Int = CHUNK_PAYLOAD_BYTES) -> [Data] {
    var out: [Data] = []
    var offset = bytes.startIndex
    while offset < bytes.endIndex {
      let end = min(bytes.index(offset, offsetBy: payloadBytes, limitedBy: bytes.endIndex) ?? bytes.endIndex, bytes.endIndex)
      out.append(Data(bytes[offset..<end]))
      offset = end
    }
    return out
  }

  /// Builds the wire Rep. Under the threshold the bytes ride inline on the declaring line; at or
  /// over it they become a Stream the caller MUST emit AFTER the declaring line.
  ///
  /// Note the argument order: the generator sorts fields alphabetically, so it is
  /// `Rep(byteLength:inline:mime:repId:sha256:uti:)`, and `inline` is `Data` — the raw bytes go
  /// straight in, and JSONEncoder base64s them.
  static func prepare(mime: String, uti: String?, bytes: Data) -> (rep: Rep, stream: Stream?) {
    let hash = contentHash(bytes)
    if bytes.count < CHUNK_THRESHOLD_BYTES {
      return (
        Rep(byteLength: bytes.count, inline: bytes, mime: mime, repId: nil, sha256: hash, uti: uti),
        nil
      )
    }
    let repId = nextRepId()
    return (
      Rep(byteLength: bytes.count, inline: nil, mime: mime, repId: repId, sha256: hash, uti: uti),
      Stream(repId: repId, payloads: split(bytes))
    )
  }

  /// Emits every chunk of every stream. ORDER IS LOAD-BEARING: the host's reassembler only creates
  /// a stream when it sees the declaring `Rep.repId`, so a chunk emitted before its declaring line
  /// is answered with E_REP_UNKNOWN_ID and the whole representation is discarded.
  static func emit(_ streams: [Stream]) {
    for stream in streams {
      let last = stream.payloads.count - 1
      for (seq, payload) in stream.payloads.enumerated() {
        // Alphabetical labels again: RepChunkData is (b64:final:repId:seq:).
        Out.event("rep.chunk", RepChunkData(b64: payload, final: seq == last, repId: stream.repId, seq: seq))
      }
    }
  }
}
