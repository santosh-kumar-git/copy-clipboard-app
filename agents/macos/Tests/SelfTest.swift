import AppKit
import Foundation

/// A plain `swiftc` harness, not `swift test`: SwiftPM cannot build a manifest with Command Line
/// Tools only on this machine, and XCTest ships with full Xcode. This binary compiles every agent
/// source except main.swift, asserts the pure parts, and exits non-zero on the first failure.
@main
struct SelfTest {
  static var failures = 0

  static func expect(_ condition: Bool, _ label: String) {
    if condition {
      print("ok   - \(label)")
    } else {
      print("FAIL - \(label)")
      failures += 1
    }
  }

  static func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
    if actual == expected {
      print("ok   - \(label)")
    } else {
      print("FAIL - \(label)\n       expected: \(expected)\n       actual:   \(actual)")
      failures += 1
    }
  }

  static func main() {
    runAssertions()
    print(failures == 0 ? "\nALL PASS" : "\n\(failures) FAILURE(S)")
    exit(failures == 0 ? 0 : 1)
  }

  static func runAssertions() {
    // 1. accelerator parsing
    let cmdShiftV = HotkeyMap.parse("Cmd+Shift+V")
    expectEqual(cmdShiftV?.keyCode, UInt32(9), "Cmd+Shift+V resolves to the V key code (9)")
    expectEqual(cmdShiftV?.modifiers, UInt32(0x0100 | 0x0200), "Cmd+Shift+V sets cmdKey|shiftKey")
    expectEqual(HotkeyMap.parse("cmd+shift+v")?.modifiers, UInt32(0x0100 | 0x0200), "parsing is case-insensitive")
    expectEqual(HotkeyMap.parse("CommandOrControl+Shift+C")?.modifiers, UInt32(0x0100 | 0x0200), "CommandOrControl means cmdKey on macOS")
    expectEqual(HotkeyMap.parse("Ctrl+Alt+V")?.modifiers, UInt32(0x1000 | 0x0800), "Ctrl+Alt sets controlKey|optionKey")
    expect(HotkeyMap.parse("V") == nil, "a modifier-less accelerator is refused")
    expect(HotkeyMap.parse("Cmd+Shift+Nope") == nil, "an unknown key name is refused")
    expect(HotkeyMap.parse("Cmd+Shift+V+X") == nil, "two non-modifier keys is refused")
    expect(HotkeyMap.parse("") == nil, "an empty accelerator is refused")

    // 2. the encoder configuration, which is what makes recorded transcripts diffable.
    //    NOTE the argument order: the generator sorts struct fields alphabetically, so `Rep` is
    //    (byteLength:inline:mime:repId:sha256:uti:) and `RepChunkData` is (b64:final:repId:seq:).
    //    `inline` and `b64` are `Data`, and JSONEncoder base64s them — no base64 call by hand.
    let inlineRep = Rep(byteLength: 2, inline: Data("hi".utf8), mime: "text/plain",
                        repId: nil, sha256: "sha256-fake", uti: "public.utf8-plain-text")
    let json = String(decoding: Out.encode(inlineRep)!, as: UTF8.self)
    expect(!json.contains("repId"), "an inline rep omits repId entirely rather than sending null")
    // 0xFFFFFF base64-encodes to "////", so this payload is the only honest test of the slash rule.
    let slashy = String(decoding: Out.encode(RepChunkData(b64: Data([0xFF, 0xFF, 0xFF]), final: true, repId: "r1", seq: 0))!, as: UTF8.self)
    expectEqual(slashy, "{\"b64\":\"////\",\"final\":true,\"repId\":\"r1\",\"seq\":0}",
                "base64 slashes are not escaped into \\/, which would inflate every chunk line")
    expectEqual(
      String(decoding: Out.encode(RepChunkData(b64: Data("hi".utf8), final: true, repId: "r1", seq: 0))!, as: UTF8.self),
      "{\"b64\":\"aGk=\",\"final\":true,\"repId\":\"r1\",\"seq\":0}",
      "keys are sorted, so two recordings of the same session are byte-identical")

    // 3. the suspend/resume ledger
    var reasons = SuspendReasons()
    expect(reasons.add("sleep"), "the first reason suspends the timer")
    expect(!reasons.add("sleep"), "the same reason twice does not suspend twice")
    expect(!reasons.add("session-inactive"), "a second reason does not suspend an already-suspended timer")
    expect(!reasons.remove("session-inactive"), "dropping one of two reasons does not resume")
    expect(reasons.remove("sleep"), "dropping the last reason resumes")
    expect(!reasons.remove("sleep"), "an unmatched resume is refused, because over-resuming traps the process")
    expect(!reasons.isSuspended, "the ledger is empty again")
    expect(!reasons.drain(), "draining an empty ledger needs no resume")
    _ = reasons.add("sleep")
    expect(reasons.drain(), "draining a suspended ledger tells the caller to resume once before cancel")

    // 4. line framing
    var splitter = LineSplitter()
    expectEqual(splitter.push(Data("{\"a\":1}\n{\"b\"".utf8)).count, 1, "a chunk ending mid-line yields only the complete line")
    expectEqual(
      splitter.push(Data(":2}\n".utf8)).map { String(decoding: $0, as: UTF8.self) },
      ["{\"b\":2}"],
      "the rest of the line arrives on the next chunk")
    var utf8Splitter = LineSplitter()
    let emoji = Array("{\"s\":\"🪨\"}\n".utf8)
    expectEqual(utf8Splitter.push(Data(emoji[0..<8])).count, 0, "a chunk split inside a multi-byte character yields nothing yet")
    expectEqual(
      utf8Splitter.push(Data(emoji[8...])).map { String(decoding: $0, as: UTF8.self) },
      ["{\"s\":\"🪨\"}"],
      "the character is decoded only once both halves have arrived")
    var guardSplitter = LineSplitter()
    _ = guardSplitter.push(Data(repeating: 0x41, count: MAX_LINE_BYTES + 1))
    expectEqual(guardSplitter.droppedOverlongLines, 1, "an unterminated line over 1 MiB is dropped, not buffered")
    var emptySplitter = LineSplitter()
    expectEqual(emptySplitter.push(Data("\n\n".utf8)).count, 0, "empty lines are ignored")
  }
}
