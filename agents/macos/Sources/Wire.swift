import Darwin
import Foundation

// MARK: - the frozen numeric limits

/// AgentProtocol.generated.swift emits `protocolVersion` and the wire TYPES and nothing else: a zod
/// schema has nowhere to hang a bare number, so the generator has none to emit. These six mirror
/// packages/protocol/src/constants.ts exactly, and the second `it()` in tools/agent-selftest.test.ts
/// reads both files and fails if a literal here drifts from the TypeScript one — so the duplication
/// cannot rot. The wire major is deliberately NOT duplicated: everything below uses the generated
/// `protocolVersion`.
let CHUNK_THRESHOLD_BYTES = 65_536
let CHUNK_PAYLOAD_BYTES = 32_768
let MAX_REP_BYTES = 20_971_520
let MAX_LINE_BYTES = 1_048_576
let AGENT_REQUEST_TIMEOUT_MS = 2_000
let WATCH_INTERVAL_MS = 500

// MARK: - envelopes (structural; every payload type comes from AgentProtocol.generated.swift)

/// Just enough of a request to route it. The typed params are decoded in a second pass, which is
/// how one Codable pass per method stays possible without a hand-written enum of param types.
struct RequestHead: Decodable {
  let v: Int
  let t: String
  let id: String
  let method: String
}

struct Request<P: Decodable>: Decodable {
  let id: String
  let params: P
}

struct ResponseOk<R: Encodable>: Encodable {
  let v = protocolVersion
  let t = "res"
  let id: String
  let ok = true
  let result: R
}

struct WireError: Encodable {
  let code: String
  let message: String
}

struct ResponseErr: Encodable {
  let v = protocolVersion
  let t = "res"
  let id: String
  let ok = false
  let error: WireError
}

struct Event<D: Encodable>: Encodable {
  let v = protocolVersion
  let t = "ev"
  let event: String
  let data: D
}

// MARK: - stdout, one line per object, serialised

enum Out {
  /// `.sortedKeys` is contract (§2): JSONEncoder is otherwise order-nondeterministic across runs,
  /// which would make recorded transcripts undiffable. `.withoutEscapingSlashes` keeps a base64
  /// chunk line at the length the contract measured instead of inflating every `/` into `\/`.
  private static let encoder: JSONEncoder = {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return e
  }()

  /// One dedicated queue so two threads can never interleave halves of a line on the pipe.
  private static let queue = DispatchQueue(label: "app.cairn.agent.stdout")

  /// Exposed so the self-test can assert the encoder's configuration without capturing stdout.
  static func encode<T: Encodable>(_ value: T) -> Data? { try? encoder.encode(value) }

  static func line<T: Encodable>(_ value: T) {
    guard var data = encode(value) else {
      stderrLine("cairn-agent: encode failed for \(T.self)")
      return
    }
    data.append(0x0A)
    queue.sync { writeAll(data) }
  }

  static func ok<R: Encodable>(id: String, _ result: R) { line(ResponseOk(id: id, result: result)) }

  static func fail(id: String, code: String, message: String) {
    line(ResponseErr(id: id, error: WireError(code: code, message: message)))
  }

  static func event<D: Encodable>(_ name: String, _ data: D) { line(Event(event: name, data: data)) }

  /// The agent's own log channel. Metadata only — never a byte of clipboard content. The host keeps
  /// `level` and `event` and drops `fields`, because the agent is not trusted to police them.
  ///
  /// `level` is the generated `LogDataLevel` enum, not a String, so a typo'd level is a compile error.
  /// `fields` is `[String: AgentLogValue]`, and `AgentLogValue` is a CLOSED union of
  /// string/number/bool/null with no `.object` and no `.array` case — there is no shape in which a
  /// clipboard payload or a nested bag can be handed to this function (spec §11 control 2, the Swift
  /// half of it). Note the field order: the generator sorts, so it is `LogData(event:fields:level:)`.
  static func log(_ level: LogDataLevel, _ event: String, _ fields: [String: AgentLogValue] = [:]) {
    line(Event(event: "log", data: LogData(event: event, fields: fields, level: level)))
  }

  /// Raw write(2), NOT FileHandle.write.
  ///
  /// `NSFileHandle.writeData:` raises an OBJECTIVE-C exception when the descriptor is gone, and Swift
  /// cannot catch that — it goes straight to `abort()`. When the host process exits, both our stdout
  /// and our stderr close, so the stdin thread's "stdin closed; exiting" breadcrumb was the last thing
  /// this process ever did: SIGABRT and a crash report, every single time the app quit normally.
  /// [verified] two `cairn-agent-macos` reports in DiagnosticReports, faulting frame
  /// `-[NSConcreteFileHandle writeData:]` -> `objc_exception_throw` -> `abort`.
  ///
  /// The result is ignored on purpose: if stderr is unwritable there is nowhere left to report it to,
  /// and failing to log must never be fatal.
  static func stderrLine(_ s: String) {
    _ = writeAll(Data((s + "\n").utf8), to: 2)
  }

  /// Returns false if the descriptor could not take every byte. Never throws and never raises: the
  /// only failure mode a closed pipe should have is a return value.
  @discardableResult
  private static func writeAll(_ data: Data, to fd: Int32) -> Bool {
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
      guard let base = raw.baseAddress else { return true }
      var off = 0
      while off < raw.count {
        let n = Darwin.write(fd, base.advanced(by: off), raw.count - off)
        if n > 0 {
          off += n
        } else if errno == EINTR {
          continue
        } else {
          return false
        }
      }
      return true
    }
  }

  private static func writeAll(_ data: Data) {
    if writeAll(data, to: 1) { return }
    // stdout is gone: the host died. Leave a breadcrumb if stderr still exists — stderrLine cannot
    // fail — and exit. 70 is EX_SOFTWARE, which the host's restart logic already understands.
    stderrLine("cairn-agent: stdout closed (errno \(errno)); exiting")
    exit(70)
  }
}

// MARK: - poll suspension bookkeeping

/// PURE. Reason-keyed suspend bookkeeping for the poll timer. Over-resuming a DispatchSource traps
/// the process, and sleep and session-switch notifications overlap in practice, so the "should I
/// actually call suspend()/resume() now?" decision lives here where it can be asserted.
struct SuspendReasons {
  private var reasons = Set<String>()

  /// True only when the caller should now call `timer.suspend()`.
  mutating func add(_ reason: String) -> Bool {
    if reasons.contains(reason) { return false }
    let wasEmpty = reasons.isEmpty
    reasons.insert(reason)
    return wasEmpty
  }

  /// True only when the caller should now call `timer.resume()`.
  mutating func remove(_ reason: String) -> Bool {
    guard reasons.contains(reason) else { return false }
    reasons.remove(reason)
    return reasons.isEmpty
  }

  var isSuspended: Bool { !reasons.isEmpty }

  /// True when the caller must resume once before cancelling.
  mutating func drain() -> Bool {
    let wasSuspended = isSuspended
    reasons.removeAll()
    return wasSuspended
  }
}

// MARK: - stdin, whole lines only

/// PURE. Bytes in, whole lines out. Kept out of the read loop so it can be asserted with no pipe: a
/// multi-byte UTF-8 character split across two chunks must never be decoded half-way, and an
/// unterminated line longer than the guard is a memory attack rather than a message.
struct LineSplitter {
  private var buf = Data()
  /// Counts lines dropped for exceeding MAX_LINE_BYTES, so the caller can log the fact once.
  private(set) var droppedOverlongLines = 0

  mutating func push(_ chunk: Data) -> [Data] {
    buf.append(chunk)
    var lines: [Data] = []
    while let nl = buf.firstIndex(of: 0x0A) {
      let line = buf.subdata(in: buf.startIndex..<nl)
      buf.removeSubrange(buf.startIndex...nl)
      if line.count > MAX_LINE_BYTES {
        droppedOverlongLines += 1
        continue
      }
      if !line.isEmpty { lines.append(line) }
    }
    if buf.count > MAX_LINE_BYTES {
      droppedOverlongLines += 1
      buf.removeAll(keepingCapacity: false)
    }
    return lines
  }
}

enum In {
  /// Blocking read loop on fd 0. All the framing logic lives in LineSplitter.
  static func readLines(_ onLine: (Data) -> Void) {
    var splitter = LineSplitter()
    var reportedDrops = 0
    var chunk = [UInt8](repeating: 0, count: 65_536)
    while true {
      let n = chunk.withUnsafeMutableBytes { Darwin.read(0, $0.baseAddress, $0.count) }
      if n == 0 { return }                       // EOF: the host closed the pipe
      if n < 0 {
        if errno == EINTR { continue }
        Out.stderrLine("cairn-agent: stdin read error \(errno)")
        return
      }
      for line in splitter.push(Data(chunk[0..<n])) { onLine(line) }
      if splitter.droppedOverlongLines > reportedDrops {
        reportedDrops = splitter.droppedOverlongLines
        Out.log(.warn, "line.too-long", ["count": .number(Double(reportedDrops))])
      }
    }
  }
}
