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
    let args = Array(CommandLine.arguments.dropFirst())
    if args.first == "--mark" {
      mark(args.count > 1 ? args[1] : "")
      return
    }
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

    // 5. the UTI -> mime allowlist
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.utf8-plain-text", "NSStringPboardType"]).map(\.mime),
      ["text/plain"],
      "a plain-text item yields exactly one text/plain plan and ignores the legacy alias")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.png", "public.tiff"]).map(\.mime),
      ["image/png"],
      "png wins over tiff, and only one image rep is planned")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.tiff", "com.adobe.pdf"]).first?.tiffToPng,
      true,
      "a tiff-only item is planned as a TIFF->PNG conversion")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.tiff", "com.adobe.pdf"]).map(\.mime),
      ["image/png"],
      "tiff wins over pdf")
    expectEqual(
      RepFilter.plan(forItemTypes: ["dyn.ah62d4rv4gu8zg55mrrxg23petzxg", "public.utf8-plain-text"]).map(\.uti),
      ["public.utf8-plain-text"],
      "a dyn.* UTI is never read")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.utf8-plain-text", "org.chromium.source-url"]).map(\.mime),
      ["text/plain", "text/x-source-url"],
      "Chrome's source-url rides alongside the text, in that order")
    expectEqual(
      RepFilter.plan(forItemTypes: [HintUTI.concealed, "public.utf8-plain-text"]).map(\.mime),
      ["text/plain"],
      "the hint UTIs are markers, never representations")
    expectEqual(
      RepFilter.plan(forItemTypes: ["public.utf8-plain-text", "public.html", "public.rtf", "public.file-url"]).map(\.mime),
      ["text/plain", "text/html", "text/rtf", "text/uri-list"],
      "the plan order is frozen so two machines hash the same copy identically")

    // 6. the concealed decision — the single most important branch in this file
    expect(!Pasteboard.mayReadBytes(hints: [.concealed]), "a concealed hint forbids reading any byte")
    expect(!Pasteboard.mayReadBytes(hints: [.transient, .concealed]), "concealed wins over other hints")
    expect(Pasteboard.mayReadBytes(hints: [.transient]), "a transient hint alone still allows reading")
    expect(Pasteboard.mayReadBytes(hints: []), "no hint allows reading")

    // 7. the wedged-read escalation policy
    expectEqual(ReadWatchdog.decide(elapsedMs: 1_999, strikes: 0), .ignore, "a read under 2 s is not wedged")
    expectEqual(ReadWatchdog.decide(elapsedMs: 2_001, strikes: 0), .warn, "the first strike over 2 s only warns")
    expectEqual(ReadWatchdog.decide(elapsedMs: 2_001, strikes: 1), .killProcess, "the second strike kills the process so the host restarts it")
    expectEqual(ReadWatchdog.decide(elapsedMs: 60_000, strikes: 0), .warn, "even a very long first strike only warns once")

    // 8. content hash, identical to @cairn/protocol's contentHash()
    expectEqual(
      contentHash(Data("hello".utf8)),
      "sha256-LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ",
      "contentHash matches the TypeScript vector for 'hello'")
    expectEqual(
      contentHash(Data("hello world".utf8)),
      "sha256-uU0nuZNNPgilLlLX2n2r-sSE7-N6U4DukIj3rOLvzek",
      "contentHash matches the transcript fixture vector for 'hello world'")
    expectEqual(contentHash(Data()).count, 7 + 43, "a content hash is always sha256- plus 43 chars")

    // 9. TIFF -> PNG, which happens at capture so nothing downstream ever sees a TIFF
    let tiff = makeTiff(width: 8, height: 6)
    expectEqual(Array(tiff.prefix(2)), [77, 77], "the input really is a TIFF (MM big-endian magic)")
    guard let png = RepFilter.tiffToPng(tiff) else { return expect(false, "TIFF converts to PNG") }
    expectEqual(Array(png.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10], "the converted bytes carry the PNG magic number")
    expect(RepFilter.tiffToPng(Data("not an image".utf8)) == nil, "garbage does not convert")
    // 10. chunk splitting. `Chunker.split` returns RAW `[Data]`, because RepChunkData.b64 is `Data`
    //     and JSONEncoder base64s it on the way out — nothing here calls a base64 API for a payload.
    let big = Data(repeating: 0x5A, count: 200_000)
    let chunks = Chunker.split(big)
    expectEqual(chunks.count, 7, "200 000 bytes split into 7 chunks of at most 32 768")
    expectEqual(chunks[0].count, 32_768, "one full chunk carries exactly 32 768 raw bytes")
    expectEqual(chunks[6].count, 3_392, "the last chunk carries the 3 392-byte remainder")
    expectEqual(
      chunks[0].base64EncodedString().count,
      43_692,
      "32 768 raw bytes become exactly 43 692 base64 characters on the wire, under Node's 64 KiB pipe watermark")
    expectEqual(
      chunks.reduce(0) { $0 + $1.count },
      200_000,
      "the chunks account for exactly the input length")
    expect(Data(chunks.joined()) == big, "the chunks reassemble byte-for-byte")
    expectEqual(Chunker.split(Data()).count, 0, "an empty representation produces no chunks")

    // 11. the inline / stream threshold, which must match CHUNK_THRESHOLD_BYTES exactly
    let small = Chunker.prepare(mime: "text/plain", uti: "public.utf8-plain-text", bytes: Data(repeating: 0x41, count: 65_535))
    expect(small.rep.inline != nil && small.rep.repId == nil && small.stream == nil, "65 535 bytes travel inline")
    let large = Chunker.prepare(mime: "text/plain", uti: "public.utf8-plain-text", bytes: Data(repeating: 0x41, count: 65_536))
    expect(large.rep.inline == nil && large.rep.repId != nil && large.stream != nil, "65 536 bytes travel as a stream")
    expectEqual(large.stream?.payloads.count, 2, "65 536 bytes is exactly two chunks")
    expectEqual(large.rep.sha256, contentHash(Data(repeating: 0x41, count: 65_536)), "a streamed rep declares the hash of the whole representation")
  }

  static func makeTiff(width: Int, height: Int) -> Data {
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: width * 4, bitsPerPixel: 32)!
    var seed: UInt32 = 0x9E37_79B9
    let plane = rep.bitmapData!
    for i in 0..<(width * height * 4) {
      seed = seed &* 1_664_525 &+ 1_013_904_223
      plane[i] = UInt8((seed >> 16) & 0xFF)
    }
    return rep.tiffRepresentation!
  }

  /// Puts deliberately synthetic content with the awkward UTIs on the REAL pasteboard.
  static func mark(_ which: String) {
    let pb = NSPasteboard.general
    switch which {
    case "concealed":
      let item = NSPasteboardItem()
      item.setString("SYNTHETIC-NOT-A-REAL-SECRET", forType: .string)
      item.setData(Data(), forType: NSPasteboard.PasteboardType(HintUTI.concealed))
      pb.clearContents()
      _ = pb.writeObjects([item])
      print("marked: concealed + text, changeCount=\(pb.changeCount)")
    case "files":
      // Two paths that exist on every macOS install. Both facts below were measured: a file URL for
      // a path that does NOT exist is dropped from the pasteboard entirely, and a writer that exits
      // immediately after writeObjects can leave a foreign reader seeing only the first item.
      pb.clearContents()
      _ = pb.writeObjects([URL(fileURLWithPath: "/bin/ls") as NSURL, URL(fileURLWithPath: "/bin/cat") as NSURL])
      print("marked: two file urls, changeCount=\(pb.changeCount)")
    case "tiff":
      let item = NSPasteboardItem()
      item.setData(makeTiff(width: 200, height: 200), forType: NSPasteboard.PasteboardType(RepFilter.tiff))
      pb.clearContents()
      _ = pb.writeObjects([item])
      print("marked: tiff only, changeCount=\(pb.changeCount)")
    case "chrome":
      let item = NSPasteboardItem()
      item.setString("synthetic copied text", forType: .string)
      item.setString("https://example.com/page", forType: NSPasteboard.PasteboardType(RepFilter.chromeSourceURL))
      pb.clearContents()
      _ = pb.writeObjects([item])
      print("marked: text + chromium source-url, changeCount=\(pb.changeCount)")
    default:
      print("usage: cairn-agent-selftest --mark concealed|files|tiff|chrome")
      exit(2)
    }
    // Do not exit instantly: a pasteboard write is asynchronous to the pasteboard server.
    Thread.sleep(forTimeInterval: 0.5)
  }
}
