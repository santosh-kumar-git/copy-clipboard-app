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
  }
}
