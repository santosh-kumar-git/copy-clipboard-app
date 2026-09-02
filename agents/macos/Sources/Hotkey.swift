import AppKit
import Carbon
import Foundation

/// Carbon `RegisterEventHotKey`, not Electron's `globalShortcut`, for one reason that matters in
/// M2: a Carbon hot key keeps firing while secure input is active, which is what lets the palette
/// open over a focused password field at all. Nothing else in Cairn uses Carbon.
enum HotkeyMap {
  /// Physical ANSI virtual key codes. A hot key is registered by key CODE, not by character, so on
  /// a non-ANSI layout `Cmd+Shift+V` is the key in the V position. That is how every macOS app
  /// behaves and is not something we can fix here.
  static let keyCodes: [String: UInt32] = [
    "A": UInt32(kVK_ANSI_A), "B": UInt32(kVK_ANSI_B), "C": UInt32(kVK_ANSI_C), "D": UInt32(kVK_ANSI_D),
    "E": UInt32(kVK_ANSI_E), "F": UInt32(kVK_ANSI_F), "G": UInt32(kVK_ANSI_G), "H": UInt32(kVK_ANSI_H),
    "I": UInt32(kVK_ANSI_I), "J": UInt32(kVK_ANSI_J), "K": UInt32(kVK_ANSI_K), "L": UInt32(kVK_ANSI_L),
    "M": UInt32(kVK_ANSI_M), "N": UInt32(kVK_ANSI_N), "O": UInt32(kVK_ANSI_O), "P": UInt32(kVK_ANSI_P),
    "Q": UInt32(kVK_ANSI_Q), "R": UInt32(kVK_ANSI_R), "S": UInt32(kVK_ANSI_S), "T": UInt32(kVK_ANSI_T),
    "U": UInt32(kVK_ANSI_U), "V": UInt32(kVK_ANSI_V), "W": UInt32(kVK_ANSI_W), "X": UInt32(kVK_ANSI_X),
    "Y": UInt32(kVK_ANSI_Y), "Z": UInt32(kVK_ANSI_Z),
    "0": UInt32(kVK_ANSI_0), "1": UInt32(kVK_ANSI_1), "2": UInt32(kVK_ANSI_2), "3": UInt32(kVK_ANSI_3),
    "4": UInt32(kVK_ANSI_4), "5": UInt32(kVK_ANSI_5), "6": UInt32(kVK_ANSI_6), "7": UInt32(kVK_ANSI_7),
    "8": UInt32(kVK_ANSI_8), "9": UInt32(kVK_ANSI_9),
    "F1": UInt32(kVK_F1), "F2": UInt32(kVK_F2), "F3": UInt32(kVK_F3), "F4": UInt32(kVK_F4),
    "F5": UInt32(kVK_F5), "F6": UInt32(kVK_F6), "F7": UInt32(kVK_F7), "F8": UInt32(kVK_F8),
    "F9": UInt32(kVK_F9), "F10": UInt32(kVK_F10), "F11": UInt32(kVK_F11), "F12": UInt32(kVK_F12),
    "SPACE": UInt32(kVK_Space), "RETURN": UInt32(kVK_Return), "ENTER": UInt32(kVK_Return),
    "TAB": UInt32(kVK_Tab), "ESCAPE": UInt32(kVK_Escape), "ESC": UInt32(kVK_Escape),
    "BACKSPACE": UInt32(kVK_Delete), "DELETE": UInt32(kVK_ForwardDelete),
    "LEFT": UInt32(kVK_LeftArrow), "RIGHT": UInt32(kVK_RightArrow),
    "UP": UInt32(kVK_UpArrow), "DOWN": UInt32(kVK_DownArrow),
    ",": UInt32(kVK_ANSI_Comma), ".": UInt32(kVK_ANSI_Period), "/": UInt32(kVK_ANSI_Slash),
    ";": UInt32(kVK_ANSI_Semicolon), "'": UInt32(kVK_ANSI_Quote), "[": UInt32(kVK_ANSI_LeftBracket),
    "]": UInt32(kVK_ANSI_RightBracket), "\\": UInt32(kVK_ANSI_Backslash),
    "`": UInt32(kVK_ANSI_Grave), "-": UInt32(kVK_ANSI_Minus), "=": UInt32(kVK_ANSI_Equal),
  ]

  /// PURE. Electron-style accelerator -> (virtual key code, Carbon modifier mask).
  /// Returns nil for an unknown key, a missing key, or NO modifier — a modifier-less global hot key
  /// would swallow a bare letter system-wide, so we refuse to register one.
  static func parse(_ accelerator: String) -> (keyCode: UInt32, modifiers: UInt32)? {
    var modifiers: UInt32 = 0
    var key: String?
    for rawPart in accelerator.split(separator: "+", omittingEmptySubsequences: false) {
      let part = rawPart.trimmingCharacters(in: .whitespaces)
      if part.isEmpty { continue }
      switch part.uppercased() {
      case "CMD", "COMMAND", "META", "SUPER", "COMMANDORCONTROL", "CMDORCTRL":
        modifiers |= UInt32(cmdKey)
      case "SHIFT":
        modifiers |= UInt32(shiftKey)
      case "ALT", "OPTION":
        modifiers |= UInt32(optionKey)
      case "CTRL", "CONTROL":
        modifiers |= UInt32(controlKey)
      default:
        if key != nil { return nil }            // two non-modifier keys is not an accelerator
        key = part
      }
    }
    guard modifiers != 0, let key, let code = keyCodes[key.uppercased()] else { return nil }
    return (code, modifiers)
  }
}

enum Hotkey {
  private static var ref: EventHotKeyRef?
  private static var handler: EventHandlerRef?
  private static var accelerator: String?
  private static let signature: OSType = 0x4341_524E     // 'CARN'

  /// MUST be called on the main thread: Carbon hot key events are delivered to the main run loop's
  /// event dispatcher target.
  static func register(_ accel: String) -> Bool {
    unregister()
    guard let parsed = HotkeyMap.parse(accel) else {
      Out.log(.warn, "hotkey.unparseable", ["accelerator": .string(accel)])
      return false
    }
    installHandlerIfNeeded()
    var newRef: EventHotKeyRef?
    let hotKeyID = EventHotKeyID(signature: signature, id: 1)
    let status = RegisterEventHotKey(
      parsed.keyCode, parsed.modifiers, hotKeyID, GetEventDispatcherTarget(), 0, &newRef)
    guard status == noErr, let newRef else {
      // -9878 is eventHotKeyExistsErr. [verified] it fires only for a duplicate registration WITHIN
      // this process: two separate processes can both register Cmd+Shift+V and both get noErr. So
      // `bound: true` means "the API accepted it", never "nobody else has it" — which is exactly why
      // spec §4 makes a dead hot key a first-class UI state with a rebind row instead of trusting a
      // return code.
      Out.log(.warn, "hotkey.register-failed", ["accelerator": .string(accel), "status": .number(Double(status))])
      return false
    }
    ref = newRef
    accelerator = accel
    return true
  }

  static func unregister() {
    if let r = ref { UnregisterEventHotKey(r) }
    ref = nil
    accelerator = nil
  }

  static func current() -> String? { accelerator }

  private static func installHandlerIfNeeded() {
    guard handler == nil else { return }
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let callback: EventHandlerUPP = { _, event, _ in
      var fired = EventHotKeyID()
      let got = GetEventParameter(
        event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
        nil, MemoryLayout<EventHotKeyID>.size, nil, &fired)
      // Logged before the signature guard on purpose. "No hotkey.event line at all" means the
      // application event queue is not being pumped (see NSApp.run() in main.swift); "an event line
      // but no hotkey.fired" means it arrived and was filtered. Without this, the two are
      // indistinguishable from the outside, which is what made the dead-hot-key bug hard to place.
      Out.log(.debug, "hotkey.event", ["got": .number(Double(got)), "signature": .number(Double(fired.signature))])
      guard got == noErr, fired.signature == Hotkey.signature else { return noErr }
      Hotkey.fire()
      return noErr
    }
    InstallEventHandler(GetEventDispatcherTarget(), callback, 1, &spec, nil, &handler)
  }

  /// The focus token is opaque in M1 — nothing restores focus until M2 — but it is emitted from day
  /// one so the wire never changes. It records who was frontmost the instant the key fired, which is
  /// exactly what M2's focus.restore needs and what reading "previous app" at paste time cannot
  /// give: while our accessory app is active, NSWorkspace.frontmostApplication returns *us*.
  private static func fire() {
    guard let accel = accelerator else { return }
    let firedAt = Int(Date().timeIntervalSince1970 * 1000)
    let snapshot = Frontmost.snapshot()
    let token = "\(snapshot.bundleId ?? "unknown")|\(firedAt)"
    // Alphabetical labels: HotkeyFiredData is (accelerator:firedAt:focusToken:).
    Out.event("hotkey.fired", HotkeyFiredData(accelerator: accel, firedAt: firedAt, focusToken: token))
  }
}
