import AppKit
import ApplicationServices

// Spike (b) only. Prints whether THIS process is TCC-trusted for Accessibility, and optionally
// raises the one-time system prompt so we can read which app name TCC attributes it to.
// M1 never calls this: NSPasteboard reads, NSWorkspace attribution and Carbon hotkeys need no grant.
let prompt = CommandLine.arguments.contains("--prompt")
print("pid=\(ProcessInfo.processInfo.processIdentifier)")
print("executable=\(ProcessInfo.processInfo.arguments[0])")
print("parentBundle=\(ProcessInfo.processInfo.environment["CAIRN_SPIKE_PARENT"] ?? "none")")
print("trustedBefore=\(AXIsProcessTrusted())")
if prompt {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  let opts = [key: true] as CFDictionary
  let trusted = AXIsProcessTrustedWithOptions(opts)
  print("trustedWithPrompt=\(trusted)")
} else {
  print("trustedWithPrompt=skipped (pass --prompt to raise the TCC dialog)")
}
