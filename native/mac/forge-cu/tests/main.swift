// forge-cu self-test. Compiled ONLY with Core.swift (Foundation / CoreGraphics / ImageIO): this binary
// has no code that posts input events, captures the screen or touches TCC, so running it is safe.
// Run: node scripts/build-cu-helper.mjs --self-test
import Foundation
import CoreGraphics

var failures = 0
var passed = 0
func check(_ cond: @autoclosure () -> Bool, _ what: String, line: Int = #line) {
  if cond() { passed += 1 } else { failures += 1; FileHandle.standardError.write("FAIL line \(line): \(what)\n".data(using: .utf8)!) }
}
func eq<T: Equatable>(_ a: T, _ b: T, _ what: String, line: Int = #line) {
  check(a == b, "\(what): got \(a), want \(b)", line: line)
}

// ── argument parsing ──────────────────────────────────────────────────────────
do {
  eq(parseArgs(["forge-cu", "--owner-pid", "459"]), .drive(ownerPid: 459), "drive mode")
  eq(parseArgs(["forge-cu", "exec", "--", "/usr/bin/true", "a", "b"]), .exec(path: "/usr/bin/true", args: ["a", "b"]), "exec mode")
  eq(parseArgs(["forge-cu", "exec", "--", "true"]), .bad("exec needs an absolute path"), "exec relative path")
  eq(parseArgs(["forge-cu", "exec", "/usr/bin/true"]), .bad("usage: forge-cu exec -- <abs bin> <args…>"), "exec without --")
  eq(parseArgs(["forge-cu"]), .bad("usage: forge-cu --owner-pid <pid>"), "no args")
  eq(parseArgs(["forge-cu", "--owner-pid", "x"]), .bad("usage: forge-cu --owner-pid <pid>"), "bad pid")
  eq(parseArgs(["forge-cu", "--owner-pid", "0"]), .bad("usage: forge-cu --owner-pid <pid>"), "pid 0")
}

// ── caller check (V4) ─────────────────────────────────────────────────────────
do {
  let app = "/Applications/myFlowForge.app"
  let inApp = "\(app)/Contents/Resources/native/forge-cu"
  check(callerAllowed(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: "\(app)/Contents/MacOS/myFlowForge"), "packaged + right parent")
  check(!callerAllowed(selfPath: inApp, ownerPid: 459, ppid: 460, parentPath: "\(app)/Contents/MacOS/myFlowForge"), "ppid != owner")
  check(!callerAllowed(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: "/bin/zsh"), "packaged, parent is a shell")
  check(!callerAllowed(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: "/Applications/Other.app/Contents/MacOS/Other"), "other bundle")
  check(!callerAllowed(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: "\(app)/Contents/Resources/x"), "parent not in MacOS/")
  check(!callerAllowed(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: nil), "parent path unknown")
  check(!callerAllowed(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: "\(app)/Contents/MacOSX/y"), "prefix trick")
  // dev path: only the ppid rule
  check(callerAllowed(selfPath: "/repo/build/native/darwin/forge-cu", ownerPid: 77, ppid: 77, parentPath: "/bin/zsh"), "dev path")
  check(!callerAllowed(selfPath: "/repo/build/native/darwin/forge-cu", ownerPid: 1, ppid: 77, parentPath: "/bin/zsh"), "dev path wrong pid")
}

// ── JSON line framing ─────────────────────────────────────────────────────────
do {
  let lb = LineBuffer()
  eq(lb.feed("{\"id\":\"r1\",\"op\":\"st".data(using: .utf8)!).count, 0, "partial line held")
  let lines = lb.feed("atus\"}\n\n{\"id\":2,\"op\":\"front\"}\n{\"id\":".data(using: .utf8)!)
  eq(lines.count, 2, "two complete lines, blank skipped")
  let r1 = parseRequest(lines[0])
  eq(r1?.op ?? "", "status", "op")
  eq(r1?.id as? String ?? "", "r1", "string id kept")
  let r2 = parseRequest(lines[1])
  eq((r2?.id as? NSNumber)?.intValue ?? -1, 2, "numeric id kept")
  check(parseRequest("not json".data(using: .utf8)!) == nil, "garbage → nil")
  check(parseRequest("[1]".data(using: .utf8)!) == nil, "array → nil")
  check(parseRequest("{\"id\":1}".data(using: .utf8)!) == nil, "no op → nil")
  let body = parseRequest("{\"id\":\"r3\",\"op\":\"hitTest\",\"xPt\":10.5,\"yPt\":3}".data(using: .utf8)!)!.body
  eq((body["xPt"] as? NSNumber)?.doubleValue ?? 0, 10.5, "body field")

  let out = encodeLine(["id": "r1", "ok": true, "x": "a\nb"])
  check(out.last == 0x0A, "line ends in \\n")
  eq(out.filter { $0 == 0x0A }.count, 1, "exactly one newline (embedded ones escaped)")
  let back = try! JSONSerialization.jsonObject(with: out.dropLast()) as! [String: Any]
  eq(back["x"] as? String ?? "", "a\nb", "round trip")
  let err = errorReply(id: "r9", code: "target_changed", extra: ["typed": 5])
  eq(err["ok"] as? Bool ?? true, false, "error ok:false")
  eq(err["code"] as? String ?? "", "target_changed", "error code")
  eq(err["typed"] as? Int ?? -1, 5, "error extra")
  eq(err["id"] as? String ?? "", "r9", "error id")
  check(errorReply(id: nil, code: "invalid_args")["id"] == nil, "no id → no id key")
}

// ── window list + hit test ────────────────────────────────────────────────────
func win(_ pid: Int32, _ id: Int, _ x: Double, _ y: Double, _ w: Double, _ h: Double, layer: Int = 0, alpha: Double = 1, owner: String = "App") -> [String: Any] {
  ["kCGWindowOwnerPID": pid, "kCGWindowNumber": id, "kCGWindowLayer": layer, "kCGWindowAlpha": alpha,
   "kCGWindowOwnerName": owner, "kCGWindowBounds": ["X": x, "Y": y, "Width": w, "Height": h]]
}
do {
  // front to back
  let raw: [[String: Any]] = [
    win(0, 1, 0, 0, 1792, 24, layer: 25, owner: "Window Server"),
    win(900, 5, 100, 100, 50, 50, alpha: 0),            // invisible overlay
    win(459, 7, 80, 80, 200, 200, owner: "myFlowForge"),
    win(321, 9, 0, 0, 1000, 1000, owner: "Notes"),
    ["kCGWindowOwnerPID": 1, "kCGWindowNumber": 3],     // no bounds → dropped
  ]
  let wins = winInfos(from: raw)
  eq(wins.count, 4, "malformed entry dropped")
  eq(hitWindow(wins, at: CGPoint(x: 120, y: 120))?.pid ?? -1, 459, "alpha 0 skipped, first containing window wins")
  eq(hitWindow(wins, at: CGPoint(x: 500, y: 500))?.windowId ?? -1, 9, "window id")
  eq(hitWindow(wins, at: CGPoint(x: 10, y: 10))?.ownerName ?? "", "Window Server", "menu bar")
  check(hitWindow(wins, at: CGPoint(x: 1500, y: 1100)) == nil, "nothing → nil")
  check(hitWindow(wins, at: CGPoint(x: 280, y: 120))?.pid == 321, "right edge is exclusive")

  let main = CGRect(x: 0, y: 0, width: 1792, height: 1120)
  check(inMenuBar(CGPoint(x: 10, y: 23.9), mainBounds: main, menuBarHeight: 24), "in strip")
  check(!inMenuBar(CGPoint(x: 10, y: 24), mainBounds: main, menuBarHeight: 24), "below strip")
  check(!inMenuBar(CGPoint(x: 2000, y: 5), mainBounds: main, menuBarHeight: 24), "other display")

  eq(maskRects(wins, bundleOf: { $0 == 321 ? "com.apple.Notes" : ($0 == 459 ? "com.zghua.myflowforge" : nil) },
               maskPids: [], prefixes: ["com.zghua.myflowforge"]),
     [CGRect(x: 80, y: 80, width: 200, height: 200)], "mask by bundle prefix")
  eq(maskRects(wins, bundleOf: { _ in nil }, maskPids: [459, 321], prefixes: []).count, 2, "mask by pid")
  eq(maskRects(wins, bundleOf: { _ in nil }, maskPids: [900], prefixes: []).count, 1, "invisible windows are still masked")
}

// ── guards (V7) ───────────────────────────────────────────────────────────────
do {
  let g = parseGuard(["denyPids": [459], "denyBundlePrefixes": ["com.zghua.myflowforge"], "expectPid": 321, "expectWindowId": 9,
                      "pointer": ["x": 5, "y": 6]])
  eq(g.denyPids, [459], "deny pids")
  eq(g.expectPid ?? 0, 321, "expect pid")
  eq(g.expectWindowId ?? 0, 9, "expect window")
  eq(g.pointer ?? .zero, CGPoint(x: 5, y: 6), "pointer")
  let notes = Hit(pid: 321, bundleId: "com.apple.Notes", name: "Notes", layer: 0, windowId: 9, inMenuBar: false)
  eq(pointerCheck(g, hit: notes, frontPid: 321, frontBundle: "com.apple.Notes"), nil, "same target ok")
  eq(pointerCheck(g, hit: nil, frontPid: 321, frontBundle: nil), "target_changed", "nothing under the point any more")
  var other = notes; other.windowId = 10
  eq(pointerCheck(g, hit: other, frontPid: 321, frontBundle: nil), "target_changed", "window changed (V7f)")
  other = notes; other.pid = 322
  eq(pointerCheck(g, hit: other, frontPid: 321, frontBundle: nil), "target_changed", "pid changed")
  let ours = Hit(pid: 459, bundleId: "com.zghua.myflowforge", name: "myFlowForge", layer: 0, windowId: 7, inMenuBar: false)
  let open = parseGuard(["denyPids": [459], "denyBundlePrefixes": ["com.zghua.myflowforge"]])
  eq(pointerCheck(open, hit: ours, frontPid: 1, frontBundle: nil), "target_changed", "our pid")
  var test = ours; test.pid = 999; test.bundleId = "com.zghua.myflowforge.test"
  eq(pointerCheck(open, hit: test, frontPid: 1, frontBundle: nil), "target_changed", "our bundle prefix under another pid")
  let menu = Hit(pid: 0, bundleId: nil, name: "Window Server", layer: 25, windowId: 1, inMenuBar: true)
  eq(pointerCheck(open, hit: menu, frontPid: 459, frontBundle: "com.zghua.myflowforge"), "target_changed", "menu bar while we are front (V7e)")
  eq(pointerCheck(open, hit: menu, frontPid: 321, frontBundle: "com.apple.Notes"), nil, "menu bar while another app is front")
  eq(pointerCheck(open, hit: nil, frontPid: 321, frontBundle: nil), nil, "no expectations: empty desktop is fine")

  let kg = parseGuard(["denyPids": [459], "denyBundlePrefixes": ["com.zghua.myflowforge"], "expectPid": 321])
  eq(keyboardCheck(kg, axPid: 321, wsPid: 321, bundle: "com.apple.Notes", secure: false, locked: false), nil, "keyboard ok")
  eq(keyboardCheck(kg, axPid: 321, wsPid: 459, bundle: "com.apple.Notes", secure: false, locked: false), "target_changed", "AX vs workspace disagree (V7a)")
  eq(keyboardCheck(kg, axPid: nil, wsPid: 321, bundle: "com.apple.Notes", secure: false, locked: false), "target_changed", "AX unknown")
  eq(keyboardCheck(kg, axPid: 459, wsPid: 459, bundle: "com.zghua.myflowforge", secure: false, locked: false), "target_changed", "we are front")
  eq(keyboardCheck(kg, axPid: 321, wsPid: 321, bundle: "com.apple.Notes", secure: true, locked: false), "target_changed", "secure input")
  eq(keyboardCheck(kg, axPid: 321, wsPid: 321, bundle: "com.apple.Notes", secure: false, locked: true), "target_changed", "locked")
  eq(keyboardCheck(kg, axPid: 322, wsPid: 322, bundle: "x", secure: false, locked: false), "target_changed", "other app")
  let kg2 = parseGuard(["denyPids": [459], "denyBundlePrefixes": ["com.zghua.myflowforge"]])
  eq(keyboardCheck(kg2, axPid: 999, wsPid: 999, bundle: "com.zghua.myflowforge.test", secure: false, locked: false), "target_changed", "test build by prefix")

  // drag end (V7d): ours, or a pid different from what was under `to` when the post began
  eq(dragEndCheck(open, startPid: 321, end: notes), nil, "drag end unchanged")
  eq(dragEndCheck(open, startPid: 321, end: ours), "target_changed", "drag end became ours")
  eq(dragEndCheck(open, startPid: 321, end: other), "target_changed", "drag end pid changed")
  eq(dragEndCheck(open, startPid: nil, end: nil), nil, "empty desktop both times")
  eq(dragEndCheck(open, startPid: nil, end: notes), "target_changed", "desktop → window")
  var moved = notes; moved.pid = 400
  eq(dragEndCheck(open, startPid: 321, fromPid: 400, end: moved), nil, "the dragged app's own window (window drag) is fine")
  eq(dragEndCheck(open, startPid: 321, fromPid: 459, end: ours), "target_changed", "ours even when it is the source")
}

// ── typing segments ───────────────────────────────────────────────────────────
do {
  let s = String(repeating: "a", count: 45)
  let segs = typeSegments(s)
  eq(segs.map { $0.units.count }, [20, 20, 5], "20-unit chunks")
  let emoji = String(repeating: "a", count: 19) + "😀" + "b"
  let e = typeSegments(emoji)
  eq(e.map { $0.units.count }, [19, 3], "a surrogate pair is never split")
  eq(e.reduce(0) { $0 + $1.units.count }, emoji.utf16.count, "units add up")
  let nl = typeSegments("ab\ncd\te\r\nf")
  eq(nl, [.text(Array("ab".utf16)), .key(36), .text(Array("cd".utf16)), .key(48), .text(Array("e".utf16)), .key(36), .text(Array("f".utf16))], "newline/tab as keys, CRLF once")
  eq(typeSegments("你好é").map { $0.units.count }, [3], "CJK in one chunk")
  eq(typeSegments(""), [], "empty")
  eq(TypeSeg.key(36).units.count, 1, "a key counts as one unit")
}

// ── keys ──────────────────────────────────────────────────────────────────────
do {
  eq(modifierKeycode("cmd") ?? 0, 55, "cmd")
  eq(modifierKeycode("shift") ?? 0, 56, "shift")
  eq(modifierKeycode("alt") ?? 0, 58, "alt")
  eq(modifierKeycode("ctrl") ?? 0, 59, "ctrl")
  check(modifierKeycode("hyper") == nil, "unknown mod")
  eq(modifierFlags(["cmd", "shift"]), [.maskCommand, .maskShift], "flags")
  eq(modifierFlags([]), [], "no flags")
  eq(ansiKeycode("a")?.code ?? 999, 0, "a")
  eq(ansiKeycode("v")?.code ?? 999, 9, "v")
  eq(ansiKeycode("1")?.code ?? 999, 18, "1")
  eq(ansiKeycode("A")?.code ?? 999, 0, "A")
  eq(ansiKeycode("A")?.shift ?? false, true, "A needs shift")
  eq(ansiKeycode("/")?.code ?? 999, 44, "/")
  eq(ansiKeycode("?")?.shift ?? false, true, "? is shift+/")
  check(ansiKeycode("é") == nil, "non-ANSI")
  eq(idleEventTypeRaw("any"), UInt32.max, "any = kCGAnyInputEventType")
  eq(idleEventTypeRaw("mouseDown"), CGEventType.leftMouseDown.rawValue, "mouseDown")
  eq(idleEventTypeRaw("keyDown"), CGEventType.keyDown.rawValue, "keyDown")
  eq(idleEventTypeRaw("bogus"), UInt32.max, "unknown → any")
}

// ── geometry + images ─────────────────────────────────────────────────────────
do {
  let (w, h) = fitSize(srcW: 3584, srcH: 2240, maxW: 1280, maxH: 800)
  eq([w, h], [1280, 800], "fit")
  let (w2, h2) = fitSize(srcW: 960, srcH: 640, maxW: 1280, maxH: 1280)
  eq([w2, h2], [960, 640], "never upscale")
  let (w3, h3) = fitSize(srcW: 4000, srcH: 1000, maxW: 1280, maxH: 1280)
  eq([w3, h3], [1280, 320], "long edge")
  // points → output pixels (top-left origin), region (100,50) 200x100 pt → 400x200 px
  eq(ptRectToPx(CGRect(x: 150, y: 75, width: 50, height: 25), src: CGRect(x: 100, y: 50, width: 200, height: 100), outW: 400, outH: 200),
     CGRect(x: 100, y: 50, width: 100, height: 50), "pt → px")
  eq(ptRectToPx(CGRect(x: 0, y: 0, width: 150, height: 60), src: CGRect(x: 100, y: 50, width: 200, height: 100), outW: 400, outH: 200),
     CGRect(x: 0, y: 0, width: 100, height: 20), "clipped to the source")
  check(ptRectToPx(CGRect(x: 0, y: 0, width: 10, height: 10), src: CGRect(x: 100, y: 50, width: 200, height: 100), outW: 400, outH: 200).isEmpty, "outside → empty")
  eq(codeBox(outW: 1280, outH: 800), CGRect(x: 1280 - 52 - 4, y: 800 - 20 - 4, width: 52, height: 20), "code box bottom right")

  // synthetic image: left half black, right half white → 32x32 gray sig, 1024 bytes
  let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 32, height: 64))
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); ctx.fill(CGRect(x: 32, y: 0, width: 32, height: 64))
  let img = ctx.makeImage()!
  let sig = graySig(img)
  eq(sig.count, 1024, "sig is 32x32 bytes")
  eq(sig[0], 0, "left is black")
  check(sig[31] > 240, "right is white")
  check(sig[1023] > 240, "bottom right is white")
  check(Data(base64Encoded: sig.base64EncodedString()) == sig, "base64 round trip")

  // masking paints gray in top-left coordinates
  let masked = paintMasks(img, rectsPx: [CGRect(x: 0, y: 0, width: 64, height: 8)])!
  let ms = graySig(masked)
  check(ms[0] > 100 && ms[0] < 180, "top-left row masked mid gray (got \(ms[0]))")
  eq(ms[32 * 31], 0, "bottom-left untouched")

  let jpeg = jpegData(img, quality: 0.75)
  check(jpeg != nil && jpeg!.starts(with: [0xFF, 0xD8]), "JPEG magic")
  let coded = drawCode(img, code: "AC3F")
  check(coded != nil && coded!.width == 64, "code drawn without resizing")
}

// ── abort state (V7g) ─────────────────────────────────────────────────────────
do {
  let st = AbortState()
  eq(st.signal(), true, "abort while idle → emit the stopped event now")
  eq(st.requested, false, "idle abort leaves nothing pending")
  st.beginPost()
  eq(st.signal(), false, "abort during a post → the post answers")
  eq(st.requested, true, "flag set")
  st.endPost()
  eq(st.requested, false, "flag cleared after the post")
  st.beginPost()
  eq(st.requested, false, "a new post starts clean")
  st.endPost()

  // the real SIGUSR1 source: raise it at ourselves and see the idle callback
  let st2 = AbortState()
  let sem = DispatchSemaphore(value: 0)
  let src = installAbortSignal(st2, queue: DispatchQueue(label: "t")) { sem.signal() }
  kill(getpid(), SIGUSR1)
  check(sem.wait(timeout: .now() + 2) == .success, "SIGUSR1 reached the handler while idle")
  st2.beginPost()
  kill(getpid(), SIGUSR1)
  var waited = 0
  while !st2.requested && waited < 200 { usleep(10_000); waited += 1 }
  check(st2.requested, "SIGUSR1 during a post sets the flag")
  check(sem.wait(timeout: .now() + 0.2) == .timedOut, "no idle event during a post")
  st2.endPost()
  src.cancel()
}

print("forge-cu self-test: \(passed) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
