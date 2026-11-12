// forge-cu · pure logic. Foundation / CoreGraphics / ImageIO only, no AppKit, no event posting, no
// capture, no TCC: the self-test (tests/main.swift) links this file alone.
import Foundation
import CoreGraphics
import ImageIO

// ───────────────────────── arguments ─────────────────────────

enum Mode: Equatable {
  case drive(ownerPid: Int32)
  case exec(path: String, args: [String])
  case bad(String)
}

func parseArgs(_ argv: [String]) -> Mode {
  let a = Array(argv.dropFirst())
  if a.first == "exec" {
    guard a.count >= 3, a[1] == "--" else { return .bad("usage: forge-cu exec -- <abs bin> <args…>") }
    guard a[2].hasPrefix("/") else { return .bad("exec needs an absolute path") }
    return .exec(path: a[2], args: Array(a.dropFirst(3)))
  }
  if a.count == 2, a[0] == "--owner-pid", let p = Int32(a[1]), p > 0 { return .drive(ownerPid: p) }
  return .bad("usage: forge-cu --owner-pid <pid>")
}

// ───────────────────────── caller check (V4) ─────────────────────────

/// `getppid() == ownerPid`; and when we live in `<X>.app/Contents/Resources/`, the parent's executable
/// must be inside `<X>.app/Contents/MacOS/`. Paths are expected already resolved (realpath).
func callerAllowed(selfPath: String, ownerPid: Int32, ppid: Int32, parentPath: String?) -> Bool {
  guard ppid == ownerPid else { return false }
  guard let r = selfPath.range(of: ".app/Contents/Resources/") else { return true }
  let bundle = String(selfPath[..<r.lowerBound]) + ".app"
  guard let parent = parentPath else { return false }
  return parent.hasPrefix(bundle + "/Contents/MacOS/")
}

// ───────────────────────── JSON lines ─────────────────────────

final class LineBuffer {
  private var buf = Data()
  func feed(_ d: Data) -> [Data] {
    buf.append(d)
    var out: [Data] = []
    while let i = buf.firstIndex(of: 0x0A) {
      let line = buf[buf.startIndex..<i]
      buf = Data(buf[buf.index(after: i)...])
      let trimmed = line.filter { $0 != 0x0D }
      if !trimmed.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { out.append(Data(trimmed)) }
    }
    return out
  }
}

struct Request { let id: Any?; let op: String; let body: [String: Any] }

func parseRequest(_ line: Data) -> Request? {
  guard let o = try? JSONSerialization.jsonObject(with: line), let d = o as? [String: Any], let op = d["op"] as? String else { return nil }
  return Request(id: d["id"], op: op, body: d)
}

func encodeLine(_ obj: [String: Any]) -> Data {
  var d = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false,\"code\":\"helper_failed\"}".utf8)
  d.append(0x0A)
  return d
}

func errorReply(id: Any?, code: String, message: String? = nil, extra: [String: Any] = [:]) -> [String: Any] {
  var r: [String: Any] = extra
  r["ok"] = false
  r["code"] = code
  if let m = message { r["message"] = m }
  if let id = id { r["id"] = id }
  return r
}

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
func int32(_ v: Any?) -> Int32? { (v as? NSNumber).map { Int32(truncating: $0) } }
func point(_ v: Any?) -> CGPoint? {
  guard let d = v as? [String: Any], let x = num(d["x"]), let y = num(d["y"]) else { return nil }
  return CGPoint(x: x, y: y)
}
func rect(_ v: Any?) -> CGRect? {
  guard let d = v as? [String: Any], let x = num(d["x"]), let y = num(d["y"]), let w = num(d["w"]), let h = num(d["h"]) else { return nil }
  return CGRect(x: x, y: y, width: w, height: h)
}
func rectJSON(_ r: CGRect) -> [String: Any] { ["x": Double(r.origin.x), "y": Double(r.origin.y), "w": Double(r.width), "h": Double(r.height)] }

// ───────────────────────── windows ─────────────────────────

struct WinInfo: Equatable {
  var pid: Int32; var windowId: Int; var layer: Int; var alpha: Double; var bounds: CGRect; var ownerName: String?
}

/// From `CGWindowListCopyWindowInfo` entries (front to back). Entries without pid / bounds are dropped.
func winInfos(from list: [[String: Any]]) -> [WinInfo] {
  list.compactMap { w in
    guard let pid = int32(w[kCGWindowOwnerPID as String]),
          let b = w[kCGWindowBounds as String] as? [String: Any],
          let x = num(b["X"]), let y = num(b["Y"]), let wd = num(b["Width"]), let ht = num(b["Height"]) else { return nil }
    return WinInfo(pid: pid, windowId: (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0,
                   layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                   alpha: num(w[kCGWindowAlpha as String]) ?? 1,
                   bounds: CGRect(x: x, y: y, width: wd, height: ht),
                   ownerName: w[kCGWindowOwnerName as String] as? String)
  }
}

/// Front-to-back first window that contains `p` and is visible (alpha > 0).
func hitWindow(_ wins: [WinInfo], at p: CGPoint) -> WinInfo? {
  wins.first { $0.alpha > 0 && $0.bounds.contains(p) }
}

func inMenuBar(_ p: CGPoint, mainBounds: CGRect, menuBarHeight: CGFloat) -> Bool {
  mainBounds.contains(p) && p.y < mainBounds.minY + menuBarHeight
}

func matchesPrefix(_ bundle: String?, _ prefixes: [String]) -> Bool {
  guard let b = bundle else { return false }
  return prefixes.contains { !$0.isEmpty && b.hasPrefix($0) }
}

/// Windows to paint over in screenshots: owner pid listed, or owner bundle has a listed prefix.
/// Invisible windows are masked too (they may become visible between list and capture).
func maskRects(_ wins: [WinInfo], bundleOf: (Int32) -> String?, maskPids: [Int32], prefixes: [String]) -> [CGRect] {
  wins.filter { maskPids.contains($0.pid) || matchesPrefix(bundleOf($0.pid), prefixes) }.map { $0.bounds }
}

// ───────────────────────── guards (V7) ─────────────────────────

struct Guard {
  var denyPids: [Int32] = []; var denyBundlePrefixes: [String] = []
  var expectPid: Int32?; var expectWindowId: Int?; var pointer: CGPoint?
}

func parseGuard(_ v: Any?) -> Guard {
  let d = v as? [String: Any] ?? [:]
  return Guard(denyPids: (d["denyPids"] as? [Any] ?? []).compactMap(int32),
               denyBundlePrefixes: d["denyBundlePrefixes"] as? [String] ?? [],
               expectPid: int32(d["expectPid"]),
               expectWindowId: (d["expectWindowId"] as? NSNumber)?.intValue,
               pointer: point(d["pointer"]))
}

struct Hit: Equatable {
  var pid: Int32; var bundleId: String?; var name: String?; var layer: Int; var windowId: Int; var inMenuBar: Bool
  var json: [String: Any] {
    var o: [String: Any] = ["pid": Int(pid), "layer": layer, "windowId": windowId, "inMenuBar": inMenuBar]
    if let b = bundleId { o["bundleId"] = b }
    if let n = name { o["name"] = n }
    return o
  }
}

func denied(_ g: Guard, pid: Int32, bundle: String?) -> Bool {
  g.denyPids.contains(pid) || matchesPrefix(bundle, g.denyBundlePrefixes)
}

/// nil = go; otherwise the error code. Run right before a pointer post.
func pointerCheck(_ g: Guard, hit: Hit?, frontPid: Int32?, frontBundle: String?) -> String? {
  guard let h = hit else { return (g.expectPid != nil || g.expectWindowId != nil) ? "target_changed" : nil }
  if denied(g, pid: h.pid, bundle: h.bundleId) { return "target_changed" }
  if let e = g.expectPid, e != h.pid { return "target_changed" }
  if let w = g.expectWindowId, w != h.windowId { return "target_changed" }
  // V7e: while we are front the menu bar strip is ours even though Window Server owns it
  if h.inMenuBar, let fp = frontPid, denied(g, pid: fp, bundle: frontBundle) { return "target_changed" }
  return nil
}

/// nil = go. `axPid` is the focused application from the system-wide AX element, `wsPid` NSWorkspace's.
func keyboardCheck(_ g: Guard, axPid: Int32?, wsPid: Int32?, bundle: String?, secure: Bool, locked: Bool) -> String? {
  if secure || locked { return "target_changed" }
  guard let a = axPid, let w = wsPid, a == w else { return "target_changed" }
  if denied(g, pid: a, bundle: bundle) { return "target_changed" }
  if let e = g.expectPid, e != a { return "target_changed" }
  return nil
}

/// Before mouse-up of a drag: the window under `to` must not be ours and must belong to the pid that
/// was under `to` when the post began — or to the drag's source app (`fromPid`: a dragged window of
/// that app now covers `to`).
func dragEndCheck(_ g: Guard, startPid: Int32?, fromPid: Int32? = nil, end: Hit?) -> String? {
  if let e = end, denied(g, pid: e.pid, bundle: e.bundleId) { return "target_changed" }
  if startPid == end?.pid { return nil }
  if let f = fromPid, f == end?.pid { return nil }
  return "target_changed"
}

// ───────────────────────── typing ─────────────────────────

enum TypeSeg: Equatable {
  case text([UInt16])
  case key(UInt16)
  var units: [UInt16] {
    switch self { case .text(let u): return u; case .key: return [0] }
  }
}

let kReturn: UInt16 = 36, kTab: UInt16 = 48

/// Text → chunks of ≤ `chunk` UTF-16 units (never splitting a surrogate pair); `\n`, `\r\n`, `\r`
/// become Return and `\t` Tab, posted as real keys (many apps ignore a Unicode newline).
func typeSegments(_ s: String, chunk: Int = 20) -> [TypeSeg] {
  var out: [TypeSeg] = []
  var cur: [UInt16] = []
  func flush() { if !cur.isEmpty { out.append(.text(cur)); cur = [] } }
  var prevCR = false
  for scalar in s.unicodeScalars {
    if scalar == "\n" { if !prevCR { flush(); out.append(.key(kReturn)) }; prevCR = false; continue }
    prevCR = false
    if scalar == "\r" { flush(); out.append(.key(kReturn)); prevCR = true; continue }
    if scalar == "\t" { flush(); out.append(.key(kTab)); continue }
    let u = Array(String(scalar).utf16)
    if cur.count + u.count > chunk { flush() }
    cur += u
  }
  flush()
  return out
}

// ───────────────────────── keys ─────────────────────────

func modifierKeycode(_ m: String) -> UInt16? {
  switch m { case "cmd": return 55; case "shift": return 56; case "alt": return 58; case "ctrl": return 59; default: return nil }
}

func modifierFlags(_ mods: [String]) -> CGEventFlags {
  var f: CGEventFlags = []
  for m in mods {
    switch m {
    case "cmd": f.insert(.maskCommand)
    case "shift": f.insert(.maskShift)
    case "alt": f.insert(.maskAlternate)
    case "ctrl": f.insert(.maskControl)
    default: break
    }
  }
  return f
}

private let ANSI: [Character: UInt16] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
]
private let ANSI_SHIFTED: [Character: Character] = [
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=",
  "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
]

/// US-ANSI fallback for `key.char` when the current layout has no key for it.
func ansiKeycode(_ ch: Character) -> (code: UInt16, shift: Bool)? {
  if let c = ANSI[ch] { return (c, false) }
  if let base = ANSI_SHIFTED[ch], let c = ANSI[base] { return (c, true) }
  if ch.isUppercase, let l = ch.lowercased().first, let c = ANSI[l] { return (c, true) }
  return nil
}

/// `idle {kind}` → CGEventType raw value for `secondsSinceLastEventType`.
func idleEventTypeRaw(_ kind: String) -> UInt32 {
  switch kind {
  case "mouseDown": return CGEventType.leftMouseDown.rawValue
  case "keyDown": return CGEventType.keyDown.rawValue
  default: return UInt32.max // kCGAnyInputEventType
  }
}

// ───────────────────────── geometry + images ─────────────────────────

/// Largest size ≤ max that keeps the aspect ratio; never upscales.
func fitSize(srcW: Int, srcH: Int, maxW: Int, maxH: Int) -> (Int, Int) {
  let k = min(1.0, Double(maxW) / Double(srcW), Double(maxH) / Double(srcH))
  return (max(1, Int((Double(srcW) * k).rounded())), max(1, Int((Double(srcH) * k).rounded())))
}

/// A global-point rect → output-pixel rect (top-left origin) of an image that shows `src` at outW×outH.
func ptRectToPx(_ r: CGRect, src: CGRect, outW: Int, outH: Int) -> CGRect {
  let c = r.intersection(src)
  if c.isNull || c.isEmpty { return .zero }
  let sx = CGFloat(outW) / src.width, sy = CGFloat(outH) / src.height
  return CGRect(x: (c.minX - src.minX) * sx, y: (c.minY - src.minY) * sy, width: c.width * sx, height: c.height * sy).integral
}

func codeBox(outW: Int, outH: Int) -> CGRect {
  CGRect(x: outW - 52 - 4, y: outH - 20 - 4, width: 52, height: 20)
}

private func rgbContext(_ w: Int, _ h: Int) -> CGContext? {
  CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
}

/// Draws `img` and fills each rect (top-left pixel coords) with mid gray.
func paintMasks(_ img: CGImage, rectsPx: [CGRect]) -> CGImage? {
  let w = img.width, h = img.height
  guard let ctx = rgbContext(w, h) else { return nil }
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  ctx.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
  for r in rectsPx where !r.isEmpty { ctx.fill(CGRect(x: r.minX, y: CGFloat(h) - r.maxY, width: r.width, height: r.height)) }
  return ctx.makeImage()
}

/// Red rings around marker points (top-left pixel coords).
func paintMarkers(_ img: CGImage, pointsPx: [CGPoint]) -> CGImage? {
  let w = img.width, h = img.height
  guard let ctx = rgbContext(w, h) else { return nil }
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  ctx.setStrokeColor(CGColor(red: 1, green: 0.15, blue: 0.15, alpha: 1))
  ctx.setLineWidth(3)
  for p in pointsPx {
    ctx.strokeEllipse(in: CGRect(x: p.x - 14, y: CGFloat(h) - p.y - 14, width: 28, height: 28))
    ctx.fill(CGRect(x: p.x - 1.5, y: CGFloat(h) - p.y - 1.5, width: 3, height: 3))
  }
  return ctx.makeImage()
}

/// The 4-char vision code in a 52×20 box at the bottom right. Glyphs are drawn as a 5×7 bitmap font so
/// this stays CoreGraphics-only (no text stack needed in the pure layer).
func drawCode(_ img: CGImage, code: String) -> CGImage? {
  let w = img.width, h = img.height
  guard let ctx = rgbContext(w, h) else { return nil }
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  let box = codeBox(outW: w, outH: h)
  let flipped = CGRect(x: box.minX, y: CGFloat(h) - box.maxY, width: box.width, height: box.height)
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(flipped)
  ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1)); ctx.setLineWidth(1); ctx.stroke(flipped.insetBy(dx: 0.5, dy: 0.5))
  ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
  let cell: CGFloat = 2, glyphW = 5 * cell, gap: CGFloat = 2
  let chars = Array(code.uppercased().prefix(4))
  let total = CGFloat(chars.count) * glyphW + CGFloat(max(0, chars.count - 1)) * gap
  var x = flipped.minX + (flipped.width - total) / 2
  let top = flipped.maxY - (flipped.height - 7 * cell) / 2
  for ch in chars {
    let rows = GLYPHS[ch] ?? GLYPHS["?"]!
    for (r, bits) in rows.enumerated() {
      for c in 0..<5 where bits & (1 << (4 - c)) != 0 {
        ctx.fill(CGRect(x: x + CGFloat(c) * cell, y: top - CGFloat(r + 1) * cell, width: cell, height: cell))
      }
    }
    x += glyphW + gap
  }
  return ctx.makeImage()
}

// 5×7 glyphs for the vision-code alphabet (ACEFHJKLMNPRTUVWXY3479) plus '?'
private let GLYPHS: [Character: [UInt8]] = [
  "A": [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], "C": [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E],
  "E": [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F], "F": [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  "H": [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], "J": [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
  "K": [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], "L": [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  "M": [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], "N": [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  "P": [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10], "R": [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  "T": [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04], "U": [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  "V": [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04], "W": [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0A],
  "X": [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11], "Y": [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
  "3": [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E], "4": [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  "7": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08], "9": [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  "?": [0x0E, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
]

/// V9: the image scaled to 32×32 8-bit gray, row-major from the top, 1024 bytes.
func graySig(_ img: CGImage) -> Data {
  var bytes = [UInt8](repeating: 0, count: 32 * 32)
  bytes.withUnsafeMutableBytes { p in
    guard let ctx = CGContext(data: p.baseAddress, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 32,
                              space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
    ctx.interpolationQuality = .medium
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: 32, height: 32))
  }
  return Data(bytes)
}

func jpegData(_ img: CGImage, quality: Double) -> Data? {
  let out = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return nil }
  CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: min(1, max(0.1, quality))] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return out as Data
}

// ───────────────────────── abort (V7g) ─────────────────────────

/// SIGUSR1 bookkeeping. While idle an abort is answered at once with `{event:'stopped'}`; during a post
/// it sets `requested`, which the post loop checks between every event.
final class AbortState {
  private let lock = NSLock()
  private var inPost = false
  private var flag = false
  /// true → the caller should emit the stopped event now (nothing in flight).
  func signal() -> Bool {
    lock.lock(); defer { lock.unlock() }
    if inPost { flag = true; return false }
    return true
  }
  var requested: Bool { lock.lock(); defer { lock.unlock() }; return flag }
  func beginPost() { lock.lock(); inPost = true; flag = false; lock.unlock() }
  func endPost() { lock.lock(); inPost = false; flag = false; lock.unlock() }
}

/// Routes SIGUSR1 to `state` through a dispatch source (handler runs in normal context, not in the signal).
func installAbortSignal(_ state: AbortState, queue: DispatchQueue, onIdle: @escaping () -> Void) -> DispatchSourceSignal {
  signal(SIGUSR1, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: queue)
  src.setEventHandler { if state.signal() { onIdle() } }
  src.resume()
  return src
}
