import AppKit
import CoreGraphics

// Prints the frontmost app and every on-screen window's owner + CG layer.
// Neither call needs Accessibility or Screen Recording: we never ask for kCGWindowName.
let front = NSWorkspace.shared.frontmostApplication
print("frontmost=\(front?.bundleIdentifier ?? "nil") pid=\(front?.processIdentifier ?? -1)")
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
  print("no window list"); exit(1)
}
let needle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
for w in info {
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  if !needle.isEmpty && !owner.lowercased().contains(needle.lowercased()) { continue }
  let layer = w[kCGWindowLayer as String] as? Int ?? -999
  let num = w[kCGWindowNumber as String] as? Int ?? -1
  let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("window owner=\(owner) layer=\(layer) id=\(num) bounds=\(bounds["Width"] ?? "?")x\(bounds["Height"] ?? "?")")
}
