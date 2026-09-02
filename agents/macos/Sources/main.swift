import AppKit
import Carbon
import Foundation

let AGENT_VERSION = "0.1.0"

// Writing to a dead stdout must return EPIPE rather than killing us with a signal, so the exit path
// is ours and is logged.
signal(SIGPIPE, SIG_IGN)

// MARK: - the poll

enum Poller {
  private static var timer: DispatchSourceTimer?
  private static var requestedIntervalMs = WATCH_INTERVAL_MS
  private static var lastChangeCount = -1
  /// Reason-keyed so sleep and session-inactive cannot over-resume each other.
  private static var suspendReasons = SuspendReasons()

  /// MUST run on Pasteboard.queue.
  static func start(intervalMs: Int) {
    stop()
    requestedIntervalMs = intervalMs
    // Whatever is already on the clipboard when watching begins is the baseline and is NOT
    // captured. The host can ask for it explicitly with `read`.
    lastChangeCount = Pasteboard.changeCount()
    let t = DispatchSource.makeTimerSource(queue: Pasteboard.queue)
    // 200 ms leeway lets the kernel coalesce our wakeup with others: a changeCount read costs
    // ~0.77 µs, so the timer wakeup, not the read, is the only cost worth managing.
    t.schedule(deadline: .now() + .milliseconds(effectiveIntervalMs()),
               repeating: .milliseconds(effectiveIntervalMs()),
               leeway: .milliseconds(200))
    t.setEventHandler { tick() }
    t.activate()
    timer = t
    Out.log(.info, "watch.started", ["changeCount": .number(Double(lastChangeCount)),
                                     "intervalMs": .number(Double(effectiveIntervalMs()))])
  }

  /// MUST run on Pasteboard.queue.
  static func stop() {
    guard let t = timer else { return }
    // A suspended source cannot be cancelled cleanly, and we suspend at most once no matter how
    // many reasons are active, so exactly one resume balances it.
    if suspendReasons.drain() { t.resume() }
    t.cancel()
    timer = nil
  }

  /// Low Power Mode slows the poll to 1 s. Nothing else changes: we keep watching, because a
  /// clipboard manager that stops recording on battery is a clipboard manager that lost your data.
  static func effectiveIntervalMs() -> Int {
    ProcessInfo.processInfo.isLowPowerModeEnabled ? max(1_000, requestedIntervalMs) : requestedIntervalMs
  }

  /// MUST run on Pasteboard.queue.
  static func suspend(reason: String) {
    guard let t = timer else { return }
    if suspendReasons.add(reason) {
      t.suspend()
      Out.log(.info, "watch.suspended", ["reason": .string(reason)])
    }
  }

  /// MUST run on Pasteboard.queue.
  static func resume(reason: String) {
    guard let t = timer else { return }
    if suspendReasons.remove(reason) {
      t.resume()
      Out.log(.info, "watch.resumed", ["reason": .string(reason)])
      // A copy made while asleep or in another session bumped changeCount without a tick; the next
      // tick compares against lastChangeCount and reports it, so nothing is lost.
    }
  }

  /// MUST run on Pasteboard.queue.
  static func reschedule() {
    guard timer != nil else { return }
    Out.log(.info, "watch.rescheduled", ["intervalMs": .number(Double(effectiveIntervalMs()))])
    start(intervalMs: requestedIntervalMs)
  }

  private static func tick() {
    let cc = Pasteboard.changeCount()
    if cc == lastChangeCount { return }
    lastChangeCount = cc
    let outcome = Pasteboard.read()
    let front = Frontmost.snapshot()
    // attributionConfidence is ALWAYS 'heuristic', never authoritative: macOS exposes no
    // pasteboard-owner API, so this is only "whatever was frontmost when changeCount bumped" and it
    // races on background or scripted copies (spec §10).
    // Alphabetical labels: the generator sorts, so it is
    // (attributionConfidence:changeCount:frontmostBundleId:frontmostName:hints:reps:).
    // `hints` is `[Hint]?` but we always pass the array, never nil, so the line carries "hints":[].
    Out.event("clipboard.changed", ClipboardChangedData(
      attributionConfidence: front.bundleId == nil ? .unknown : .heuristic,
      changeCount: outcome.changeCount,
      frontmostBundleId: front.bundleId,
      frontmostName: front.name,
      hints: outcome.hints,
      reps: outcome.reps))
    // Chunks AFTER the declaring line, always.
    Chunker.emit(outcome.streams)
  }
}

// MARK: - request dispatch

/// A lock box, so the reader thread and the pasteboard queue never race on a result that a timeout
/// has abandoned.
final class Box<T> {
  private let lock = NSLock()
  private var value: T?
  func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
  func get() -> T? { lock.lock(); defer { lock.unlock() }; return value }
}

/// Alphabetical labels again, and every one of `agent`, `clipboardWatch`, `hotkey`, `paste` and
/// `tier` is a generated nested ENUM rather than a String, so a typo is a compile error instead of a
/// capability the host silently fails to recognise. `AgentCapabilitiesPaste.none` must be spelled in
/// full: a bare `.none` is ambiguous with `Optional.none`.
func capabilities() -> AgentCapabilities {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return AgentCapabilities(
    agent: .macos,
    agentVersion: AGENT_VERSION,
    chunkThresholdBytes: CHUNK_THRESHOLD_BYTES,
    clipboardWatch: .changecountPoll,
    concealedTypeHints: true,
    focusApp: true,
    hotkey: .carbon,
    maxRepBytes: MAX_REP_BYTES,
    missingTools: [],
    paste: AgentCapabilitiesPaste.none,   // M1 has no paste. M2 turns this into .cgevent.
    platformVersion: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
    tier: .a,
    wireMajor: protocolVersion)
}

func decodeParams<P: Decodable>(_ line: Data, _ type: P.Type) -> P? {
  (try? JSONDecoder().decode(Request<P>.self, from: line))?.params
}

func handle(line: Data) {
  guard let head = try? JSONDecoder().decode(RequestHead.self, from: line) else {
    Out.log(.warn, "request.unparseable", [:])
    return
  }
  guard head.v == protocolVersion else {
    Out.fail(id: head.id, code: "E_WIRE_MAJOR", message: "unsupported wire major \(head.v)")
    return
  }
  guard head.t == "req" else {
    Out.log(.warn, "request.not-a-req", ["t": .string(head.t)])
    return
  }
  let id = head.id

  switch head.method {
  case "hello":
    guard decodeParams(line, HelloParams.self) != nil else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "hello needs hostVersion")
    }
    Out.ok(id: id, capabilities())

  case "watch.start":
    guard let p = decodeParams(line, WatchStartParams.self) else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "watch.start needs intervalMs")
    }
    Pasteboard.queue.async {
      Poller.start(intervalMs: p.intervalMs)
      let effective = Poller.effectiveIntervalMs()
      if effective != p.intervalMs {
        Out.log(.info, "watch.low-power", ["intervalMs": .number(Double(effective))])
      }
      // The echoed intervalMs is the REQUESTED one, so a recorded transcript is identical on a
      // machine in Low Power Mode; the effective interval is reported in the log event above.
      Out.ok(id: id, WatchStartResult(intervalMs: p.intervalMs, watching: true))
    }

  case "watch.stop":
    Pasteboard.queue.async {
      Poller.stop()
      Out.ok(id: id, WatchStopResult(watching: false))
    }

  case "read":
    guard let p = decodeParams(line, ReadParams.self) else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "read needs changeCount")
    }
    let box = Box<Pasteboard.ReadOutcome>()
    let sem = DispatchSemaphore(value: 0)
    Pasteboard.queue.async {
      box.set(Pasteboard.read())
      sem.signal()
    }
    if sem.wait(timeout: .now() + .milliseconds(AGENT_REQUEST_TIMEOUT_MS)) == .timedOut {
      // The read is still wedged on the pasteboard queue — a promised public.tiff being rendered by
      // Photoshop, say. Answer honestly and let the watchdog decide whether to take the process
      // down; a second response is never sent for this id.
      Out.fail(id: id, code: "E_TIMEOUT", message: "promised pasteboard read exceeded \(AGENT_REQUEST_TIMEOUT_MS)ms")
      return
    }
    guard let outcome = box.get() else {
      return Out.fail(id: id, code: "E_INTERNAL", message: "read produced no outcome")
    }
    if outcome.changeCount != p.changeCount {
      Out.log(.info, "read.stale", ["changeCount": .number(Double(outcome.changeCount))])
    }
    Out.ok(id: id, ReadResult(changeCount: outcome.changeCount, hints: outcome.hints, reps: outcome.reps))
    Chunker.emit(outcome.streams)

  case "write":
    // `WriteParamsRepsItem.b64` is `Data`, so a b64 field that is not valid base64 fails the decode
    // here and is answered E_BAD_PARAMS. That is why the agent has no `write.bad-base64` log id.
    guard let p = decodeParams(line, WriteParams.self), !p.reps.isEmpty else {
      return Out.fail(id: id, code: "E_BAD_PARAMS",
                      message: "write needs at least one rep with a valid base64 b64")
    }
    Pasteboard.queue.async {
      let token = Writer.write(reps: p.reps, transient: p.transient)
      // The poll WILL see this changeCount and emit clipboard.changed for it. That is deliberate:
      // suppression is the host's job, keyed on the token we return here, and a transcript proves it.
      Out.ok(id: id, WriteResult(changeToken: String(token)))
    }

  case "hotkey.register":
    guard let p = decodeParams(line, HotkeyRegisterParams.self) else {
      return Out.fail(id: id, code: "E_BAD_PARAMS", message: "hotkey.register needs accelerator")
    }
    DispatchQueue.main.async {
      let bound = Hotkey.register(p.accelerator)
      // Never an error response: a hot key that failed to bind is a first-class product state, and
      // a rejected promise would let @cairn/hotkey swallow it (contract §3).
      Out.ok(id: id, HotkeyRegisterResult(accelerator: p.accelerator, bound: bound))
    }

  case "hotkey.unregister":
    DispatchQueue.main.async {
      Hotkey.unregister()
      Out.ok(id: id, HotkeyUnregisterResult(bound: false))
    }

  case "shutdown":
    Out.ok(id: id, ShutdownResult(bye: true))
    exit(0)

  default:
    Out.fail(id: id, code: "E_UNKNOWN_METHOD", message: "unknown method \(head.method)")
  }
}

// MARK: - startup

// NSApplication.shared initialises AppKit and connects this process to the window server, which is
// what makes NSWorkspace notifications and Carbon hot keys deliver. `.prohibited` keeps the agent
// out of the Dock and the app switcher.
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

Frontmost.startObserving()
ReadWatchdog.start()

// Sleep and fast-user-switch both mean "nobody is copying anything right now". Observed on main and
// marshalled onto the pasteboard queue, per spec §4's thread discipline.
let wsCenter = NSWorkspace.shared.notificationCenter
for (name, reason, isSuspend) in [
  (NSWorkspace.willSleepNotification, "sleep", true),
  (NSWorkspace.didWakeNotification, "sleep", false),
  (NSWorkspace.sessionDidResignActiveNotification, "session-inactive", true),
  (NSWorkspace.sessionDidBecomeActiveNotification, "session-inactive", false),
] {
  wsCenter.addObserver(forName: name, object: nil, queue: .main) { _ in
    Pasteboard.queue.async { isSuspend ? Poller.suspend(reason: reason) : Poller.resume(reason: reason) }
  }
}
NotificationCenter.default.addObserver(
  forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: .main
) { _ in
  Pasteboard.queue.async { Poller.reschedule() }
}

// stdin blocks, so it gets its own thread; the main thread belongs to the run loop that delivers
// Carbon hot keys and NSWorkspace notifications.
Thread.detachNewThread {
  In.readLines { line in handle(line: line) }
  Out.stderrLine("cairn-agent: stdin closed; exiting")
  exit(0)
}

RunLoop.main.run()
