// forge-cu self-test. Compiled ONLY with Core.swift + AXCore.swift (Foundation / CoreGraphics / ImageIO): this binary
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
  let lines = lb.feed("atus\"}\n\n{\"id\":2,\"op\":\"front\"}\n{\"id\":".data(using: .utf8)!).compactMap { $0 }
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

  // (11) a line over the cap is dropped up to its newline and reported once as nil (→ invalid_args)
  let cap = LineBuffer(maxLine: 16)
  eq(cap.feed(Data(repeating: 0x61, count: 10)).count, 0, "under the cap, held")
  eq(cap.feed(Data(repeating: 0x61, count: 10)).count, 1, "crossing the cap reports at once")
  eq(cap.feed(Data(repeating: 0x61, count: 50)).count, 0, "the rest of the long line is discarded")
  let after = cap.feed("zz\n{\"op\":\"x\"}\n".data(using: .utf8)!)
  eq(after.count, 1, "tail of the long line swallowed, next line intact")
  eq(after.first.flatMap { $0 }.map { String(decoding: $0, as: UTF8.self) } ?? "", "{\"op\":\"x\"}", "next line")
  eq(LineBuffer().maxLine, 1 << 20, "default cap 1 MB")
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

  // I-2: the approved drop window (pid AND windowId) is pinned at the moment of release
  let pinned = parseGuard(["denyPids": [459], "denyBundlePrefixes": ["com.zghua.myflowforge"], "expectEndPid": 321, "expectEndWindowId": 9])
  eq(dragEndCheck(pinned, startPid: 321, end: notes), nil, "pinned drop: same pid and window")
  var newWin = notes; newWin.windowId = 10
  eq(dragEndCheck(pinned, startPid: 321, end: newWin), "target_changed", "pinned drop: same pid, a new window appeared")
  eq(dragEndCheck(pinned, startPid: 321, end: other), "target_changed", "pinned drop: other pid")
  eq(dragEndCheck(pinned, startPid: 321, end: nil), "target_changed", "pinned drop: nothing there any more")
  eq(dragEndCheck(pinned, startPid: 321, fromPid: 400, end: moved), nil, "pinned drop: the source app's own dragged window is fine")
  let half = parseGuard(["denyPids": [459], "expectEndPid": 321])
  eq(dragEndCheck(half, startPid: 321, end: notes), "target_changed", "pid without window id is refused")
  // I-3: positive dy scrolls down; CGEvent wheel1 is positive for up
  eq(wheelValue(3), -3, "dy 3 (down) -> wheel -3")
  eq(wheelValue(-5), 5, "dy -5 (up) -> wheel 5")
  eq(wheelValue(0), 0, "no scroll")
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

// ── abort state (V7g): the flag is LATCHED until an explicit clearAbort ───────────
do {
  let st = AbortState()
  eq(st.signal(), true, "abort while idle → emit the stopped event now")
  eq(st.requested, true, "idle abort stays latched")
  // the race: SIGUSR1 lands after TS wrote a post but before beginPost — the post must not run
  st.beginPost()
  eq(st.requested, true, "beginPost does not clear the latch")
  st.endPost()
  eq(st.requested, true, "endPost does not clear the latch")
  eq(st.clear(), true, "clearAbort reports that an abort had latched")
  eq(st.requested, false, "cleared")
  eq(st.clear(), false, "nothing latched now")
  st.beginPost()
  eq(st.signal(), false, "abort during a post → the post answers")
  eq(st.requested, true, "flag set")
  st.endPost()
  eq(st.requested, true, "still latched after the post")
  _ = st.clear()

  // the real SIGUSR1 source: raise it at ourselves and see the idle callback
  let st2 = AbortState()
  let sem = DispatchSemaphore(value: 0)
  let src = installAbortSignal(st2, queue: DispatchQueue(label: "t")) { sem.signal() }
  kill(getpid(), SIGUSR1)
  check(sem.wait(timeout: .now() + 2) == .success, "SIGUSR1 reached the handler while idle")
  _ = st2.clear()
  st2.beginPost()
  kill(getpid(), SIGUSR1)
  var waited = 0
  while !st2.requested && waited < 200 { usleep(10_000); waited += 1 }
  check(st2.requested, "SIGUSR1 during a post sets the flag")
  check(sem.wait(timeout: .now() + 0.2) == .timedOut, "no idle event during a post")
  st2.endPost()
  src.cancel()
}

// ── (2) click-through overlays: AX element at the point + denied windows beneath ──
do {
  let g = parseGuard(["denyPids": [459], "denyBundlePrefixes": ["com.zghua.myflowforge"]])
  let bundles: (Int32) -> String? = { $0 == 459 ? "com.zghua.myflowforge" : ($0 == 999 ? "com.zghua.myflowforge.test" : nil) }
  let notes = Hit(pid: 321, bundleId: "com.apple.Notes", name: "Notes", layer: 0, windowId: 9, inMenuBar: false)
  let normal = WinInfo(pid: 321, windowId: 9, layer: 0, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 500, height: 500), ownerName: "Notes")
  let ours = WinInfo(pid: 459, windowId: 7, layer: 0, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 300, height: 300), ownerName: "myFlowForge")
  let overlay = WinInfo(pid: 321, windowId: 11, layer: 3, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 500, height: 500), ownerName: "Notes")
  let faint = WinInfo(pid: 321, windowId: 12, layer: 0, alpha: 0.5, bounds: CGRect(x: 0, y: 0, width: 500, height: 500), ownerName: "Notes")
  eq(overlayCheck(g, under: [normal, ours], hit: notes, axPid: 321, frontPid: 321, bundleOf: bundles), nil, "normal window above ours, AX agrees")
  eq(overlayCheck(g, under: [normal, ours], hit: notes, axPid: 459, frontPid: 321, bundleOf: bundles), "target_changed", "AX says the point is ours")
  eq(overlayCheck(g, under: [normal], hit: notes, axPid: 322, frontPid: 321, bundleOf: bundles), "target_changed", "AX pid differs")
  eq(overlayCheck(g, under: [normal], hit: notes, axPid: nil, frontPid: 321, bundleOf: bundles), "target_changed", "AX unknown → fail closed")
  eq(overlayCheck(g, under: [overlay, ours], hit: notes, axPid: 321, frontPid: 321, bundleOf: bundles), "target_changed", "floating overlay over ours")
  eq(overlayCheck(g, under: [faint, ours], hit: notes, axPid: 321, frontPid: 321, bundleOf: bundles), "target_changed", "translucent window over ours")
  let testBuild = WinInfo(pid: 999, windowId: 8, layer: 0, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 300, height: 300), ownerName: "myFlowForge Test")
  eq(overlayCheck(g, under: [overlay, testBuild], hit: notes, axPid: 321, frontPid: 321, bundleOf: bundles), "target_changed", "denied by bundle prefix beneath")
  eq(overlayCheck(g, under: [overlay], hit: notes, axPid: 321, frontPid: 321, bundleOf: bundles), nil, "overlay with nothing of ours beneath")
  // menu bar: Window Server owns the strip, AX reports the front app's menu bar
  let ws = Hit(pid: 88, bundleId: nil, name: "Window Server", layer: 24, windowId: 1, inMenuBar: true)
  let wsWin = WinInfo(pid: 88, windowId: 1, layer: 24, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1792, height: 24), ownerName: "Window Server")
  eq(overlayCheck(g, under: [wsWin], hit: ws, axPid: 321, frontPid: 321, bundleOf: bundles), nil, "menu bar → front app via AX")
  eq(overlayCheck(g, under: [wsWin], hit: ws, axPid: 400, frontPid: 321, bundleOf: bundles), "target_changed", "menu bar, AX is neither")
}

// ── (3) responsibility ─────────────────────────────────────────────────────────
do {
  check(responsibilityOK(selfPid: 50, respSelf: 459, respParent: 459), "spawned by the app: app is responsible for both")
  check(!responsibilityOK(selfPid: 50, respSelf: 50, respParent: 459), "self-responsible (disclaimed) helper refuses")
  check(!responsibilityOK(selfPid: 50, respSelf: 459, respParent: 460), "different responsible process than the parent")
  check(!responsibilityOK(selfPid: 50, respSelf: nil, respParent: 459), "unknown → refuse")
  check(!responsibilityOK(selfPid: 50, respSelf: 459, respParent: nil), "unknown parent → refuse")
  // callerRefusal: which check failed, as a path-free code for stderr (usability fix C)
  let app = "/Applications/myFlowForge.app"
  let inApp = "\(app)/Contents/Resources/native/forge-cu"
  let appBin = "\(app)/Contents/MacOS/myFlowForge"
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: appBin, selfPid: 50, respSelf: 459, respParent: 459), nil, "the app spawned us: allowed")
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 460, parentPath: appBin, selfPid: 50, respSelf: 459, respParent: 459), "owner_mismatch", "ppid != owner")
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: "/bin/zsh", selfPid: 50, respSelf: 459, respParent: 459), "parent_not_app", "parent is a shell")
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: nil, selfPid: 50, respSelf: 459, respParent: 459), "parent_not_app", "parent path unknown")
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: appBin, selfPid: 50, respSelf: nil, respParent: 459), "no_spi", "SPI missing / no answer")
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: appBin, selfPid: 50, respSelf: 459, respParent: nil), "no_spi", "no answer for the parent")
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: appBin, selfPid: 50, respSelf: 50, respParent: 300), "self_responsible", "disclaimed helper under an app launched from a terminal (app's responsible = Terminal 300)")
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: appBin, selfPid: 50, respSelf: 459, respParent: 12), "responsible_mismatch", "different responsible process than the parent")
  // An app started by app.relaunch() inherits the old (now dead) instance as its responsible process. Measured on
  // macOS 26: once that pid is gone the SPI answers every pid in the tree for itself, so our helper reads as its own
  // responsible process. TCC would then judge the helper by its own identity, not the app's: still refused.
  eq(callerRefusal(selfPath: inApp, ownerPid: 459, ppid: 459, parentPath: appBin, selfPid: 50, respSelf: 50, respParent: 459), "self_responsible", "relaunch orphan: helper answers for itself")
  for code in ["owner_mismatch", "parent_not_app", "no_spi", "self_responsible", "responsible_mismatch"] {
    check(!refusalLine(code).contains("/"), "stderr line has no path: \(code)")
    check(refusalLine(code).hasSuffix("(\(code))\n"), "stderr line ends with the code: \(code)")
  }
  check(requestAllowed(parentPath: "/Applications/myFlowForge.app/Contents/MacOS/myFlowForge", ppid: 459, respSelf: 459), "real app may request")
  check(!requestAllowed(parentPath: "/bin/zsh", ppid: 77, respSelf: 77), "a shell may not request")
  check(!requestAllowed(parentPath: "/Applications/myFlowForge.app/Contents/MacOS/myFlowForge", ppid: 459, respSelf: 12), "app binary that isn't the responsible process")
  check(!requestAllowed(parentPath: nil, ppid: 459, respSelf: 459), "unknown parent path")
}

// ── (4) neutral point for releasing a held button ────────────────────────────
do {
  let g = parseGuard(["denyPids": [459], "denyBundlePrefixes": []])
  let ours = WinInfo(pid: 459, windowId: 7, layer: 0, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 300, height: 300), ownerName: "x")
  let notes = WinInfo(pid: 321, windowId: 9, layer: 0, alpha: 1, bounds: CGRect(x: 300, y: 0, width: 300, height: 300), ownerName: "y")
  eq(neutralPoint([ours, notes], g, bundleOf: { _ in nil }, candidates: [CGPoint(x: 10, y: 10), CGPoint(x: 400, y: 10)]) ?? .zero,
     CGPoint(x: 400, y: 10), "skips a point over ours")
  eq(neutralPoint([ours], g, bundleOf: { _ in nil }, candidates: [CGPoint(x: 500, y: 500)]) ?? .zero, CGPoint(x: 500, y: 500), "empty desktop is neutral")
  let invisibleOurs = WinInfo(pid: 459, windowId: 7, layer: 0, alpha: 0, bounds: CGRect(x: 0, y: 0, width: 300, height: 300), ownerName: "x")
  check(neutralPoint([invisibleOurs], g, bundleOf: { _ in nil }, candidates: [CGPoint(x: 10, y: 10)]) == nil, "even an invisible window of ours is not neutral")
  check(neutralPoint([ours], g, bundleOf: { _ in nil }, candidates: [CGPoint(x: 10, y: 10)]) == nil, "no candidate → nil")
}

// ── (12) clamps before Int() ────────────────────────────────────────────────────
do {
  eq(clampInt(1e300, -100, 100), 100, "huge")
  eq(clampInt(-Double.infinity, -100, 100), -100, "-inf")
  eq(clampInt(Double.nan, -100, 100), 0, "NaN → 0 (or lo when 0 is out of range)")
  eq(clampInt(Double.nan, 1, 3), 1, "NaN with range above 0")
  eq(clampInt(2.6, 1, 3), 3, "rounds")
  eq(clampInt(nil, 1, 3), 1, "missing → lo")
  eq(clampInt(nil, -5, 5), 0, "missing → 0 when in range")
}

// ── AX core: fake tree (AXCore.swift) ───────────────────────────────────────────
final class FakeSource: AXSource {
  struct Node { var attrs: NodeAttrs; var kids: [Int]; var changed = false; var kidsTimeout = false }
  var nodes: [Int: Node] = [:]
  var attrReads = 0
  func attrs(_ e: Int, deadline: Deadline) -> NodeAttrs? { attrReads += 1; return nodes[e]?.attrs }
  func children(_ e: Int, role: String, deadline: Deadline) -> (items: [Int], changed: Bool)? {
    guard let n = nodes[e], !n.kidsTimeout else { return nil }
    return (n.kids, n.changed)
  }
  func key(_ e: Int) -> AnyHashable { AnyHashable(e) }
  @discardableResult func add(_ id: Int, _ role: String, subrole: String? = nil, title: String? = nil, value: String? = nil,
                              description: String? = nil, domId: String? = nil, actions: [String] = [], kids: [Int] = []) -> Int {
    var a = NodeAttrs()
    a.role = role; a.subrole = subrole; a.title = title; a.value = value; a.description = description
    a.domIdentifier = domId; a.actions = actions
    nodes[id] = Node(attrs: a, kids: kids)
    return id
  }
}
func attrs(_ role: String, subrole: String? = nil, title: String? = nil, value: String? = nil, description: String? = nil,
           placeholder: String? = nil, titleUI: String? = nil, actions: [String] = [], settable: Set<String> = []) -> NodeAttrs {
  var a = NodeAttrs()
  a.role = role; a.subrole = subrole; a.title = title; a.value = value; a.description = description
  a.placeholder = placeholder; a.titleUIText = titleUI; a.actions = actions; a.settable = settable
  return a
}
let farFuture = Deadline(ms: 60_000, now: { 0 })

// ── AX core: deadline (injectable clock, never sleeps) ──────────────────────────
do {
  var t = 100.0
  let d = Deadline(ms: 1000, now: { t })
  eq(d.remaining, 1.0, "full remaining")
  eq(d.readTimeout(), Float(0.25), "read slice capped at 0.25 s")
  eq(d.writeTimeout(), Float(0.5), "write = remaining / 2")
  t = 100.7
  eq(d.readTimeout(), Float(0.25), "read slice still 0.25 s")
  eq(d.writeTimeout(), Float(0.25), "write floored at 0.25 s")
  t = 100.9
  check(abs(d.readTimeout() - 0.1) < 0.0001, "read = remaining when < 0.25")
  check(abs(d.writeTimeout() - 0.1) < 0.0001, "write never exceeds remaining")
  check(!d.expired, "not yet expired")
  t = 102
  eq(d.remaining, 0, "remaining never negative")
  check(d.expired, "expired")
  check(d.readTimeout() > 0, "an expired deadline never yields 0 (0 = the system default timeout)")
}

// ── AX core: roles ──────────────────────────────────────────────────────────────
do {
  eq(normalizeRole(role: "AXButton", subrole: nil), "button", "AXButton")
  eq(normalizeRole(role: "AXGroup", subrole: "AXLandmarkMain"), "main", "landmark subrole wins")
  eq(normalizeRole(role: "AXTextField", subrole: nil), "textfield", "AXTextField")
  eq(normalizeRole(role: "AXWebArea", subrole: nil), "webarea", "AXWebArea")
  eq(normalizeRole(role: "AXSecureTextField", subrole: nil), "textfield", "secure field")
  eq(normalizeRole(role: "AXPopUpButton", subrole: nil), "combobox", "popup")
  eq(normalizeRole(role: "AXRow", subrole: "AXOutlineRow"), "treeitem", "outline row")
  eq(normalizeRole(role: "AXCheckBox", subrole: "AXToggle"), "switch", "toggle subrole")
  eq(normalizeRole(role: "AXCheckBox", subrole: "AXToggleButton"), "checkbox", "toggle button on a checkbox stays checkbox")
  eq(normalizeRole(role: "AXButton", subrole: "AXToggleButton"), "button", "toggle button")
  eq(normalizeRole(role: "AXButton", subrole: "AXCloseButton"), "button", "window button")
  eq(normalizeRole(role: "AXGroup", subrole: "AXApplicationDialog"), "dialog", "aria dialog")
  eq(normalizeRole(role: "AXWhatever", subrole: nil), "unknown", "unknown role")
}

// ── AX core: names ──────────────────────────────────────────────────────────────
do {
  eq(displayName(attrs("AXButton", title: "T", description: "D", titleUI: "Label"), childTexts: ["c"]) ?? "", "Label", "titleUIElement first")
  eq(displayName(attrs("AXButton", title: "T", description: "D"), childTexts: ["c"]) ?? "", "T", "then title")
  eq(displayName(attrs("AXStaticText", value: "hello", description: "D"), childTexts: []) ?? "", "hello", "static text value")
  eq(displayName(attrs("AXButton", title: "", description: "D"), childTexts: ["c"]) ?? "", "D", "empty title skipped, then description")
  eq(displayName(attrs("AXButton", actions: ["AXPress"]), childTexts: ["a", "b", "a", "c", "d", "e", "f"]) ?? "", "a b c d e",
     "interactive: ≤5 unique child texts")
  check(displayName(attrs("AXGroup"), childTexts: ["a"]) == nil, "non-interactive group: no child label")
  eq(displayName(attrs("AXTextField", placeholder: "Search"), childTexts: []) ?? "", "Search", "placeholder last")
  check(displayName(attrs("AXCheckBox", title: "1", value: "1"), childTexts: []) == nil, "checkbox name == value is not a name")
  eq(displayName(attrs("AXCheckBox", title: "Wrap", value: "1"), childTexts: []) ?? "", "Wrap", "checkbox real title kept")
  check(displayName(attrs("AXTextField", title: "abc", value: "abc"), childTexts: []) == nil, "textfield name == value dropped")
}

// ── AX core: action vocabulary / interactive ─────────────────────────────────────
do {
  eq(actionVocab(attrs("AXButton", actions: ["AXPress", "AXShowMenu", "AXScrollToVisible"])), ["click", "menu"], "press + menu")
  eq(actionVocab(attrs("AXSlider", actions: ["AXIncrement", "AXDecrement"])), ["set"], "increment → set")
  eq(actionVocab(attrs("AXTextField", settable: ["AXValue", "AXFocused", "AXSelectedText"])), ["set", "type", "focus"], "text field")
  eq(actionVocab(attrs("AXRow", settable: ["AXExpanded"])), ["expand"], "settable expanded")
  eq(actionVocab(attrs("AXLink", actions: ["AXOpen", "AXConfirm"])), ["click"], "open/confirm → one click")
  check(isInteractive(role: "button", vocab: []), "button role is interactive")
  check(isInteractive(role: "group", vocab: ["click"]), "a group with click is interactive")
  check(!isInteractive(role: "group", vocab: ["menu", "focus"]), "menu/focus alone don't make a node interactive")
  check(!isInteractive(role: "statictext", vocab: []), "static text is not interactive")
}

// ── AX core: walker ─────────────────────────────────────────────────────────────
do {
  // secure field never carries a value, even when the source hands one over
  let s = FakeSource()
  s.add(1, "AXWindow", title: "W", kids: [2, 3])
  s.add(2, "AXSecureTextField", value: "hunter2", description: "Password")
  s.add(3, "AXTextField", value: "plain", description: "User")
  let r = walk(s, root: 1, budget: Budget(maxDepth: 10), deadline: farFuture, interactiveOnly: true, skeleton: false)
  check(r.complete, "small tree complete")
  let pw = r.nodes.first { $0.0.name == "Password" }
  check(pw != nil, "secure field listed")
  check(pw?.0.value == nil, "secure field value dropped")
  eq(r.nodes.first { $0.0.name == "User" }?.0.value ?? "", "plain", "plain field value kept")
  check(pw?.0.ref != nil && pw?.1 == 2, "interactive node gets a ref and its element")
  eq(r.nodes.first?.0.role ?? "", "window", "root first (pre-order)")
}
do {
  // empty anonymous groups don't consume logical depth
  let s = FakeSource()
  s.add(1, "AXWindow", title: "W", kids: [2]); s.add(2, "AXGroup", kids: [3]); s.add(3, "AXGroup", kids: [4])
  s.add(4, "AXGroup", kids: [5]); s.add(5, "AXButton", title: "Go", actions: ["AXPress"])
  let r = walk(s, root: 1, budget: Budget(maxDepth: 2), deadline: farFuture, interactiveOnly: true, skeleton: false)
  check(r.nodes.contains { $0.0.name == "Go" && $0.0.role == "button" }, "button under 3 anonymous groups at maxDepth 2")
  check(r.complete, "transparent chain walk complete")
  check(!r.nodes.contains { $0.0.role == "group" }, "interactiveOnly drops nameless groups")
  // a named group does consume depth
  s.add(2, "AXGroup", title: "A", kids: [3]); s.add(3, "AXGroup", title: "B", kids: [4]); s.add(4, "AXGroup", title: "C", kids: [5])
  let r2 = walk(s, root: 1, budget: Budget(maxDepth: 2), deadline: farFuture, interactiveOnly: true, skeleton: false)
  check(!r2.nodes.contains { $0.0.name == "Go" }, "named groups consume depth: button cut")
  let b = r2.nodes.first { $0.0.name == "B" }?.0
  check(b?.truncated == true && b?.childrenCount == 1, "boundary node reports childrenCount + truncated")
}
do {
  // budget truncation: 100-node tree, maxNodes 10
  let s = FakeSource()
  s.add(0, "AXWindow", title: "W", kids: Array(1...99))
  for i in 1...99 { s.add(i, "AXButton", title: "b\(i)", actions: ["AXPress"]) }
  var b = Budget(maxDepth: 10); b.maxNodes = 10
  let r = walk(s, root: 0, budget: b, deadline: farFuture, interactiveOnly: true, skeleton: false)
  check(!r.complete, "node budget → incomplete")
  check(r.nodes.count <= 10, "≤ 10 nodes (got \(r.nodes.count))")
  check(r.nodes.count > 0, "partial result returned")
  eq(Budget(maxDepth: 3).maxNodes, 50_000, "default node budget")
  eq(Budget(maxDepth: 3).maxChildren, 4096, "default children budget")
  eq(Budget(maxDepth: 3).maxField, 65_536, "default field budget")
  eq(Budget(maxDepth: 3).maxDepthHard, 50, "hard depth")
  eq(Budget(maxDepth: 99).maxDepth, 50, "logical depth clamped to the hard depth")
  // children per node
  var bc = Budget(maxDepth: 10); bc.maxChildren = 5
  let rc = walk(s, root: 0, budget: bc, deadline: farFuture, interactiveOnly: true, skeleton: false)
  check(!rc.complete && rc.nodes.first?.0.truncated == true, "children budget → truncated, incomplete")
  eq(rc.nodes.filter { $0.0.role == "button" }.count, 5, "only 5 children walked")
  // deadline: clock already past → partial, never a hang
  var t = 0.0
  let d = Deadline(ms: 10, now: { t })
  t = 1
  let rd = walk(s, root: 0, budget: Budget(maxDepth: 10), deadline: d, interactiveOnly: true, skeleton: false)
  check(!rd.complete, "expired deadline → incomplete")
  // field cap
  var bf = Budget(maxDepth: 10); bf.maxField = 4
  let sf = FakeSource()
  sf.add(1, "AXButton", title: "abcdefgh", actions: ["AXPress"])
  eq(walk(sf, root: 1, budget: bf, deadline: farFuture, interactiveOnly: true, skeleton: false).nodes.first?.0.name ?? "", "abcd", "field capped")
}
do {
  // cycle: a child points back to an ancestor
  let s = FakeSource()
  s.add(1, "AXWindow", title: "W", kids: [2]); s.add(2, "AXGroup", title: "G", kids: [3])
  s.add(3, "AXButton", title: "X", actions: ["AXPress"], kids: [1, 2])
  let r = walk(s, root: 1, budget: Budget(maxDepth: 10), deadline: farFuture, interactiveOnly: false, skeleton: false)
  check(r.complete, "cycle does not make the walk incomplete")
  eq(r.nodes.count, 3, "each node once")
  eq(Set(r.nodes.compactMap { $0.0.name }).count, 3, "no duplicates")
}
do {
  // children changed while reading
  let s = FakeSource()
  s.add(1, "AXWindow", title: "W", kids: [2]); s.add(2, "AXList", title: "L", kids: [3])
  s.add(3, "AXButton", title: "X", actions: ["AXPress"])
  s.nodes[2]!.changed = true
  let r = walk(s, root: 1, budget: Budget(maxDepth: 10), deadline: farFuture, interactiveOnly: false, skeleton: false)
  check(r.nodes.first { $0.0.name == "L" }?.0.truncated == true, "changed children → truncated")
  check(!r.complete, "changed children → incomplete")
  check(r.nodes.contains { $0.0.name == "X" }, "children read before the change are still walked")
  s.nodes[2]!.changed = false; s.nodes[2]!.kidsTimeout = true
  let r2 = walk(s, root: 1, budget: Budget(maxDepth: 10), deadline: farFuture, interactiveOnly: false, skeleton: false)
  check(!r2.complete && r2.nodes.first { $0.0.name == "L" }?.0.truncated == true, "children timeout → truncated, incomplete")
}
do {
  // skeleton: boundary containers at depth 3 are drillable
  let s = FakeSource()
  s.add(1, "AXWindow", title: "W", kids: [2]); s.add(2, "AXSplitGroup", title: "S", kids: [3])
  s.add(3, "AXScrollArea", title: "Side", kids: [4]); s.add(4, "AXList", description: "Chats", kids: [5, 6, 7])
  s.add(5, "AXStaticText", value: "alpha"); s.add(6, "AXStaticText", value: "beta"); s.add(7, "AXStaticText", value: "gamma")
  let r = walk(s, root: 1, budget: Budget(maxDepth: 3), deadline: farFuture, interactiveOnly: true, skeleton: true)
  let list = r.nodes.first { $0.0.role == "list" }
  check(list != nil, "depth-3 list listed")
  eq(list?.0.depth ?? -1, 3, "list at depth 3")
  check(list?.0.ref != nil && list?.1 == 4, "boundary container has a drillable ref")
  eq(list?.0.childrenCount ?? -1, 3, "childrenCount")
  check(list?.0.truncated == true, "boundary truncated")
  check(!r.nodes.contains { $0.0.name == "alpha" }, "children below the boundary not listed")
  // nameless boundary container is named from ≤5 child texts
  s.add(4, "AXList", kids: [5, 6, 7])
  let r2 = walk(s, root: 1, budget: Budget(maxDepth: 3), deadline: farFuture, interactiveOnly: true, skeleton: true)
  eq(r2.nodes.first { $0.0.role == "list" }?.0.name ?? "", "alpha beta gamma", "boundary name from child texts")
  // without skeleton the boundary gets no ref
  let r3 = walk(s, root: 1, budget: Budget(maxDepth: 3), deadline: farFuture, interactiveOnly: false, skeleton: false)
  check(r3.nodes.first { $0.0.role == "list" }?.0.ref == nil, "full-mode boundary: no anchor ref")
}
do {
  // refs: local eN in pre-order; bounds + offscreen against the clip
  let s = FakeSource()
  s.add(1, "AXWindow", title: "W", kids: [2, 3]); s.add(2, "AXButton", title: "In", actions: ["AXPress"])
  s.add(3, "AXButton", title: "Out", actions: ["AXPress"])
  s.nodes[1]!.attrs.frame = CGRect(x: 0, y: 0, width: 100, height: 100)
  s.nodes[2]!.attrs.frame = CGRect(x: 10, y: 10, width: 20, height: 20)
  s.nodes[3]!.attrs.frame = CGRect(x: 500, y: 10, width: 20, height: 20)
  let r = walk(s, root: 1, budget: Budget(maxDepth: 10), deadline: farFuture, interactiveOnly: true, skeleton: false)
  eq(r.nodes.compactMap { $0.0.ref }, ["e1", "e2"], "local refs in pre-order")
  eq(r.nodes.first { $0.0.name == "In" }?.0.offscreen ?? true, false, "inside the window")
  eq(r.nodes.first { $0.0.name == "Out" }?.0.offscreen ?? false, true, "outside the window clip")
  eq(r.nodes.first { $0.0.name == "In" }?.0.bounds ?? .zero, CGRect(x: 10, y: 10, width: 20, height: 20), "bounds")
  s.nodes[2]!.attrs.enabled = false; s.nodes[2]!.attrs.focused = true
  let r2 = walk(s, root: 1, budget: Budget(maxDepth: 10), deadline: farFuture, interactiveOnly: true, skeleton: false)
  eq(r2.nodes.first { $0.0.name == "In" }?.0.states ?? [], ["disabled", "focused"], "states")
}

// ── AX core: ref table ──────────────────────────────────────────────────────────
do {
  check(RefTable<Int>.parse("@s3:e12").map { $0.snap == 3 && $0.n == 12 } == true, "parse @s3:e12")
  check(RefTable<Int>.parse("e12") == nil, "bare eN rejected")
  check(RefTable<Int>.parse("@s3:e") == nil, "missing n rejected")
  check(RefTable<Int>.parse("@s:e1") == nil, "missing snap rejected")
  check(RefTable<Int>.parse("@s3:e12x") == nil, "trailing garbage rejected")
  check(RefTable<Int>.parse("@s3:e+1") == nil, "sign rejected")
  let inst = Instance(pid: 42, start: "100.5")
  let fp = Fingerprint(role: "button", subrole: nil, name: "Go", description: nil, nativeId: nil, uniqueAtCapture: true)
  func node(_ ref: String?) -> SnapNode {
    SnapNode(ref: ref, depth: 1, role: "button", name: "Go", value: nil, states: [], actions: ["click"], childrenCount: nil,
             truncated: false, bounds: nil, offscreen: false)
  }
  let t = RefTable<Int>()
  var ids: [String] = []
  for i in 0..<9 { ids.append(t.put(instance: inst, window: 7, nodes: [(node("e1"), 100 + i, fp), (node(nil), nil, fp)])) }
  eq(ids.first ?? "", "s1", "first snapshot id")
  eq(Set(ids).count, 9, "distinct snapshot ids")
  check(t.get("@\(ids[0]):e1") == nil, "oldest of 9 evicted (LRU 8)")
  let last = t.get("@\(ids[8]):e1")
  eq(last?.element ?? -1, 108, "newest kept")
  eq(last?.instance ?? Instance(pid: 0, start: ""), inst, "record instance")
  eq(last?.window ?? -1, 7, "record window")
  eq(last?.fingerprint ?? fp, fp, "record fingerprint")
  check(t.get("@\(ids[8]):e2") == nil, "unknown ref → nil")
  check(t.get("e1") == nil, "bare ref → nil")
  check(t.get("@\(ids[1]):e1") != nil, "8 kept")
  t.rebind("@\(ids[8]):e1", to: 555)
  eq(t.get("@\(ids[8]):e1")?.element ?? -1, 555, "rebind")
  eq(RefTable<Int>.qualify(snapId: "s4", local: "e2"), "@s4:e2", "qualify")
}

// ── AX core: strict resolve ─────────────────────────────────────────────────────
do {
  let inst = Instance(pid: 42, start: "100.5")
  func world() -> FakeSource {
    let s = FakeSource()
    s.add(1, "AXWindow", title: "W", kids: [2, 3])
    s.add(2, "AXButton", title: "Send", domId: "send", actions: ["AXPress"])
    s.add(3, "AXButton", title: "Other", actions: ["AXPress"])
    return s
  }
  let fp = Fingerprint(role: "button", subrole: nil, name: "Send", description: nil, nativeId: "send", uniqueAtCapture: true)
  let rec = RefRecord<Int>(element: 2, instance: inst, window: 7, fingerprint: fp, bounds: nil)
  func isOk(_ o: ResolveOutcome<Int>, _ e: Int) -> Bool { if case .ok(let x) = o { return x == e }; return false }
  func isStale(_ o: ResolveOutcome<Int>) -> Bool { if case .stale = o { return true }; return false }
  func isAmb(_ o: ResolveOutcome<Int>) -> Bool { if case .ambiguous = o { return true }; return false }
  func isTimeout(_ o: ResolveOutcome<Int>) -> Bool { if case .timeout = o { return true }; return false }

  let s = world()
  check(isOk(resolveRef(s, rec: rec, liveInstance: inst, windowRoot: 1, deadline: farFuture), 2), "fast path: same identity → ok")
  check(isStale(resolveRef(s, rec: rec, liveInstance: Instance(pid: 42, start: "200.0"), windowRoot: 1, deadline: farFuture)),
        "instance start changed → stale")
  check(isStale(resolveRef(s, rec: rec, liveInstance: nil, windowRoot: 1, deadline: farFuture)), "process gone → stale")
  // element died, a look-alike exists once → rebind
  let s1 = world(); s1.nodes[2] = nil; s1.add(9, "AXButton", title: "Send", domId: "send", actions: ["AXPress"]); s1.nodes[1]!.kids = [9, 3]
  check(isOk(resolveRef(s1, rec: rec, liveInstance: inst, windowRoot: 1, deadline: farFuture), 9), "dead + 1 match → ok (rebound)")
  // dead, no match
  let s0 = world(); s0.nodes[2] = nil; s0.nodes[1]!.kids = [3]
  check(isStale(resolveRef(s0, rec: rec, liveInstance: inst, windowRoot: 1, deadline: farFuture)), "dead + 0 matches → stale")
  // dead, two matches
  let s2 = world(); s2.nodes[2] = nil
  s2.add(8, "AXButton", title: "Send", domId: "send", actions: ["AXPress"]); s2.add(9, "AXButton", title: "Send", domId: "send", actions: ["AXPress"])
  s2.nodes[1]!.kids = [8, 9, 3]
  check(isAmb(resolveRef(s2, rec: rec, liveInstance: inst, windowRoot: 1, deadline: farFuture)), "dead + 2 matches → ambiguous")
  // dead, re-walk times out
  let st = world(); st.nodes[2] = nil; st.nodes[1]!.kidsTimeout = true
  check(isTimeout(resolveRef(st, rec: rec, liveInstance: inst, windowRoot: 1, deadline: farFuture)), "dead + re-walk timeout → timeout")
  // not unique at capture → no re-walk
  let notUnique = RefRecord<Int>(element: 2, instance: inst, window: 7,
                                 fingerprint: Fingerprint(role: "button", subrole: nil, name: "Send", description: nil, nativeId: "send", uniqueAtCapture: false),
                                 bounds: nil)
  check(isStale(resolveRef(s1, rec: notUnique, liveInstance: inst, windowRoot: 1, deadline: farFuture)), "not unique + dead → stale")
  // fast path: role changed under the same element → not accepted as-is
  let sr = world(); sr.nodes[2]!.attrs.role = "AXStaticText"
  check(!isOk(resolveRef(sr, rec: rec, liveInstance: inst, windowRoot: 1, deadline: farFuture), 2), "role mismatch is never ok")
  // value and bounds never take part in identity
  let sv = world(); sv.nodes[2]!.attrs.value = "changed"; sv.nodes[2]!.attrs.frame = CGRect(x: 1, y: 2, width: 3, height: 4)
  check(isOk(resolveRef(sv, rec: rec, liveInstance: inst, windowRoot: 1, deadline: farFuture), 2), "value / bounds ignored")
  // exact identity: an absent field is not a wildcard
  let nameless = RefRecord<Int>(element: 2, instance: inst, window: 7,
                                fingerprint: Fingerprint(role: "textfield", subrole: nil, name: "Find", description: nil, nativeId: nil, uniqueAtCapture: true),
                                bounds: nil)
  let sn = world(); sn.nodes[2] = nil
  sn.add(9, "AXTextField", title: "Find", description: "Search box"); sn.nodes[1]!.kids = [9, 3]
  check(isStale(resolveRef(sn, rec: nameless, liveInstance: inst, windowRoot: 1, deadline: farFuture)),
        "recorded description nil, live one has a description → stale")
  let noName = RefRecord<Int>(element: 2, instance: inst, window: 7,
                              fingerprint: Fingerprint(role: "textfield", subrole: nil, name: nil, description: "Box", nativeId: nil, uniqueAtCapture: true),
                              bounds: nil)
  let sp = world(); sp.nodes[2] = nil
  sp.add(9, "AXSecureTextField", description: "Box"); sp.nodes[9]!.attrs.title = "Password"; sp.nodes[1]!.kids = [9, 3]
  check(isStale(resolveRef(sp, rec: noName, liveInstance: inst, windowRoot: 1, deadline: farFuture)),
        "nameless unique ref dies, a named element of the same role appears → stale")
  let bare = RefRecord<Int>(element: 2, instance: inst, window: 7,
                            fingerprint: Fingerprint(role: "textfield", subrole: nil, name: nil, description: nil, nativeId: nil, uniqueAtCapture: true),
                            bounds: nil)
  let sb = world(); sb.nodes[2] = nil
  sb.add(9, "AXTextField"); sb.nodes[1]!.kids = [9, 3]
  check(isStale(resolveRef(sb, rec: bare, liveInstance: inst, windowRoot: 1, deadline: farFuture)),
        "all-identity-nil record whose element dies → stale (even with one identical look-alike)")
  check(isOk(resolveRef(world(), rec: bare, liveInstance: inst, windowRoot: 1, deadline: farFuture), 2) == false,
        "all-identity-nil + role mismatch on the fast path → not ok")
  // capture census: walkDetailed marks uniqueness only from an exhaustive whole-window walk
  let sc = world()
  sc.add(4, "AXButton", title: "Other", actions: ["AXPress"]); sc.nodes[1]!.kids = [2, 3, 4]
  let w = walkDetailed(sc, root: 1, budget: Budget(maxDepth: 10), deadline: farFuture, interactiveOnly: true, skeleton: false)
  check(w.exhaustive, "whole small window walked exhaustively")
  let fps = markUnique(w.nodes.map { $0.2 }, census: w.census)
  eq(fps.filter { $0.name == "Send" }.map { $0.uniqueAtCapture }, [true], "Send unique")
  eq(fps.filter { $0.name == "Other" }.map { $0.uniqueAtCapture }, [false, false], "twin Other not unique")
  eq(markUnique(w.nodes.map { $0.2 }, census: nil).filter { $0.uniqueAtCapture }.count, 0, "no census → nothing unique")
  let lone = Fingerprint(role: "textfield", subrole: nil, name: nil, description: nil, nativeId: nil, uniqueAtCapture: false)
  let named = Fingerprint(role: "textfield", subrole: nil, name: "Password", description: nil, nativeId: nil, uniqueAtCapture: false)
  eq(markUnique([lone], census: [lone]).map { $0.uniqueAtCapture }, [false], "role-only identity is never unique")
  eq(markUnique([named], census: [named, lone]).map { $0.uniqueAtCapture }, [true], "nil name doesn't match a recorded name")
  check(!lone.matches(named) && !named.matches(lone), "absent ≠ present, both directions")
  let wcut = walkDetailed(sc, root: 1, budget: Budget(maxDepth: 0), deadline: farFuture, interactiveOnly: true, skeleton: false)
  check(!wcut.exhaustive, "depth-cut walk is not exhaustive")
}

// ── AX core: action chains (scripted fake actor) ──────────────────────────────────
final class FakeActor: AXActor {
  typealias E = Int
  struct N { var attrs: NodeAttrs; var kids: [Int] = []; var parent: Int? }
  var nodes: [Int: N] = [:]
  var focused: Int?
  var menuOpen = false
  var gone = Set<Int>()
  var web = false
  var calls: [String] = []
  var written: [String: Any] = [:]
  var sleeps = 0
  var onPerform: [String: (FakeActor) -> AXResult] = [:]   // "<e>:<action>"
  var onSet: [String: (FakeActor, Any) -> AXResult] = [:]   // "<e>:<attr>"
  var onKeys: ((FakeActor, String) -> AXResult)?

  @discardableResult
  func add(_ e: Int, _ role: String, parent: Int? = nil, title: String? = nil, value: String? = nil,
           actions: [String] = [], settable: Set<String> = []) -> FakeActor {
    var a = NodeAttrs(); a.role = role; a.title = title; a.value = value; a.actions = actions; a.settable = settable
    nodes[e] = N(attrs: a, parent: parent)
    if let p = parent { nodes[p]?.kids.append(e) }
    return self
  }
  func attrs(_ e: Int) -> NodeAttrs? { gone.contains(e) ? nil : nodes[e]?.attrs }
  func perform(_ e: Int, _ action: String) -> AXResult {
    calls.append("perform \(e) \(action)")
    return onPerform["\(e):\(action)"]?(self) ?? .success
  }
  func set(_ e: Int, _ attr: String, _ v: Any) -> AXResult {
    calls.append("set \(e) \(attr)"); written["\(e):\(attr)"] = v
    return onSet["\(e):\(attr)"]?(self, v) ?? .success
  }
  func children(_ e: Int) -> [Int] { nodes[e]?.kids ?? [] }
  func parent(_ e: Int) -> Int? { nodes[e]?.parent }
  func key(_ e: Int) -> AnyHashable { e }
  func probe(_ e: Int) -> EffectProbe {
    EffectProbe(focusedKey: focused.map { AnyHashable($0) }, selected: attrs(e)?.selected, menuOpen: menuOpen,
                exists: attrs(e) != nil, value: focused.flatMap { attrs($0)?.value }, expanded: attrs(e)?.expanded)
  }
  func sleep(ms: Int) { sleeps += 1 }
  func typeViaKeys(_ e: Int, _ text: String) -> AXResult {
    calls.append("keys \(e)")
    return onKeys?(self, text) ?? .success
  }
  func inWebArea(_ e: Int) -> Bool { web }
  var writes: [String] { calls.filter { $0.hasPrefix("set ") || $0.hasPrefix("keys ") } }
}

do {
  // chain stops on unverified: AXPress success, nothing observable changed → no second mutation
  let f = FakeActor().add(1, "AXButton", title: "Send", actions: ["AXPress", "AXOpen", "AXConfirm"])
  let o = runChain(f, 1, ActRequest(action: "click"))
  eq(o.delivery, .deliveredUnverified, "unverified press")
  eq(o.steps.count, 1, "one step only")
  eq(f.calls, ["perform 1 AXPress"], "AXOpen / AXConfirm never called")
  eq(f.sleeps, 10, "polled 40 ms × 10 = 400 ms through a.sleep")
  eq(Delivery.deliveredUnverified.rawValue, "delivered_unverified", "wire name")
  eq(Delivery.deliveredWithoutEffect.rawValue, "delivered_without_effect", "wire name")
  eq(Delivery.notDelivered.rawValue, "not_delivered", "wire name")
  check(Delivery.notDelivered.retrySafe && !Delivery.uncertain.retrySafe && !Delivery.deliveredVerified.retrySafe, "only not_delivered is retry-safe")

  // an effect (focus moved) → verified
  let fv = FakeActor().add(1, "AXButton", actions: ["AXPress"]).add(2, "AXTextField")
  fv.onPerform["1:AXPress"] = { $0.focused = 2; return .success }
  let ov = runChain(fv, 1, ActRequest(action: "click"))
  eq(ov.delivery, .deliveredVerified, "focus moved → verified")
  eq(fv.sleeps, 0, "effect seen at once, no wait")

  // AXPress not advertised, AXOpen advertised → Press never called
  let f2 = FakeActor().add(1, "AXButton", actions: ["AXOpen"])
  let o2 = runChain(f2, 1, ActRequest(action: "click"))
  eq(f2.calls, ["perform 1 AXOpen"], "unadvertised AXPress skipped")
  eq(o2.steps.map { $0.0 }, ["AXOpen"], "step names")

  // row: AXPress success but AXSelected stays false → without_effect, next step writes AXSelected
  let f3 = FakeActor().add(1, "AXRow", actions: ["AXPress"], settable: ["AXSelected"])
  f3.nodes[1]!.attrs.selected = false
  f3.onSet["1:AXSelected"] = { f, _ in f.nodes[1]!.attrs.selected = true; return .success }
  let o3 = runChain(f3, 1, ActRequest(action: "click"))
  eq(o3.steps.map { $0.1 }, [.deliveredWithoutEffect, .deliveredVerified], "row press without effect, then select")
  eq(o3.delivery, .deliveredVerified, "row selected")
  eq(f3.calls, ["perform 1 AXPress", "set 1 AXSelected"], "row chain order")
  check((f3.written["1:AXSelected"] as? NSNumber)?.boolValue == true, "AXSelected written true")

  // row with no further steps: press without effect → chain exhausted → without_effect
  let f3b = FakeActor().add(1, "AXRow", actions: ["AXPress"])
  f3b.nodes[1]!.attrs.selected = false
  eq(runChain(f3b, 1, ActRequest(action: "click")).delivery, .deliveredWithoutEffect, "exhausted after without_effect")

  // row not selectable itself → parent container AXSelectedRows gets [row]
  let f3c = FakeActor().add(10, "AXTable", settable: ["AXSelectedRows"]).add(1, "AXRow", parent: 10)
  f3c.nodes[1]!.attrs.selected = false
  f3c.onSet["10:AXSelectedRows"] = { f, _ in f.nodes[1]!.attrs.selected = true; return .success }
  let o3c = runChain(f3c, 1, ActRequest(action: "click"))
  eq(o3c.delivery, .deliveredVerified, "container selection")
  eq((f3c.written["10:AXSelectedRows"] as? [Int]) ?? [], [1], "one-element array")

  // child fallback: inert treeitem, first child cell has AXOpen
  let f3d = FakeActor().add(1, "AXOutlineRow").add(2, "AXCell", parent: 1, actions: ["AXOpen"])
  f3d.onPerform["2:AXOpen"] = { $0.menuOpen = true; return .success }
  let o3d = runChain(f3d, 1, ActRequest(action: "click"))
  eq(o3d.steps.map { $0.0 }, ["child1.AXOpen"], "descendant activation")
  eq(o3d.delivery, .deliveredVerified, "menu appeared")

  // native menu items: AXPress only
  let f3e = FakeActor().add(1, "AXMenuItem", actions: ["AXPress", "AXConfirm"])
  f3e.onPerform["1:AXPress"] = { _ in .notSupported }
  _ = runChain(f3e, 1, ActRequest(action: "click"))
  eq(f3e.calls, ["perform 1 AXPress"], "menu item: no other step")

  // cannotComplete → uncertain, chain stops
  let f4 = FakeActor().add(1, "AXButton", actions: ["AXPress", "AXOpen"])
  f4.onPerform["1:AXPress"] = { _ in .cannotComplete }
  let o4 = runChain(f4, 1, ActRequest(action: "click"))
  eq(o4.delivery, .uncertain, "cannotComplete → uncertain")
  eq(f4.calls, ["perform 1 AXPress"], "stopped after uncertain")

  // all steps notSupported → not_delivered + unsupported
  let f5 = FakeActor().add(1, "AXButton", actions: ["AXPress", "AXOpen", "AXConfirm"])
  for x in ["AXPress", "AXOpen", "AXConfirm"] { f5.onPerform["1:\(x)"] = { _ in .notSupported } }
  let o5 = runChain(f5, 1, ActRequest(action: "click"))
  eq(o5.delivery, .notDelivered, "all unsupported")
  eq(o5.code ?? "", "unsupported", "code unsupported")
  eq(f5.calls.count, 3, "each advertised step tried once")
  let o5b = runChain(FakeActor().add(1, "AXStaticText"), 1, ActRequest(action: "click"))
  check(o5b.delivery == .notDelivered && o5b.code == "unsupported" && o5b.steps.isEmpty, "nothing advertised")

  // invalidElement → not_delivered stale_ref, stop
  let f6 = FakeActor().add(1, "AXButton", actions: ["AXPress", "AXOpen"])
  f6.onPerform["1:AXPress"] = { _ in .invalidElement }
  let o6 = runChain(f6, 1, ActRequest(action: "click"))
  check(o6.delivery == .notDelivered && o6.code == "stale_ref" && f6.calls.count == 1, "invalid element stops, stale_ref")
  eq(runChain(f6, 99, ActRequest(action: "click")).code ?? "", "stale_ref", "dead element")
  eq(runChain(FakeActor().add(1, "AXButton"), 1, ActRequest(action: "fly")).code ?? "", "unsupported", "unknown action")

  // gradeStep table
  let p0 = EffectProbe(focusedKey: nil, selected: false, menuOpen: false, exists: true, value: nil, expanded: nil)
  var pSel = p0; pSel.selected = true
  var pGone = p0; pGone.exists = false
  eq(gradeStep(.success, before: p0, after: p0, readbackRole: false, stateChecked: nil), .deliveredUnverified, "no effect")
  eq(gradeStep(.success, before: p0, after: pGone, readbackRole: false, stateChecked: nil), .deliveredVerified, "element vanished")
  eq(gradeStep(.success, before: p0, after: p0, readbackRole: true, stateChecked: nil), .deliveredWithoutEffect, "row still unselected")
  eq(gradeStep(.success, before: p0, after: pSel, readbackRole: true, stateChecked: nil), .deliveredVerified, "row selected")
  eq(gradeStep(.success, before: p0, after: p0, readbackRole: false, stateChecked: false), .deliveredWithoutEffect, "state unchanged")
  eq(gradeStep(.success, before: p0, after: p0, readbackRole: false, stateChecked: true), .deliveredVerified, "state reached")
  eq(gradeStep(.notSupported, before: p0, after: p0, readbackRole: false, stateChecked: nil), .notDelivered, "unsupported")
  eq(gradeStep(.apiDisabled, before: p0, after: p0, readbackRole: false, stateChecked: nil), .notDelivered, "api disabled")
  eq(gradeStep(.cannotComplete, before: p0, after: pGone, readbackRole: false, stateChecked: nil), .uncertain, "cannotComplete")
  eq(gradeStep(.other(-25200), before: p0, after: p0, readbackRole: false, stateChecked: nil), .uncertain, "failure, no effect")
  eq(gradeStep(.other(-25200), before: p0, after: pGone, readbackRole: false, stateChecked: nil), .deliveredVerified, "failure but effect seen")

  // type: native field with settable AXSelectedText → insert at caret
  let t1 = FakeActor().add(1, "AXTextField", value: "ab", settable: ["AXSelectedText", "AXValue"])
  t1.onSet["1:AXSelectedText"] = { f, v in f.nodes[1]!.attrs.value = "ab" + (v as! String); return .success }
  let ot1 = runChain(t1, 1, ActRequest(action: "type", text: "cd"))
  eq(t1.writes, ["set 1 AXSelectedText"], "AXSelectedText write")
  eq(ot1.delivery, .deliveredVerified, "read back contains")
  // no AXSelectedText → append to AXValue; replace → whole value
  let t1b = FakeActor().add(1, "AXTextArea", value: "ab", settable: ["AXValue"])
  t1b.onSet["1:AXValue"] = { f, v in f.nodes[1]!.attrs.value = v as? String; return .success }
  eq(runChain(t1b, 1, ActRequest(action: "type", text: "cd")).delivery, .deliveredVerified, "append verified")
  eq(t1b.written["1:AXValue"] as? String ?? "", "abcd", "appended")
  _ = runChain(t1b, 1, ActRequest(action: "type", text: "zz", replace: true))
  eq(t1b.written["1:AXValue"] as? String ?? "", "zz", "replaced")
  // web area → typeViaKeys, never set
  let t2 = FakeActor().add(1, "AXTextField", value: "", settable: ["AXSelectedText", "AXValue"])
  t2.web = true
  t2.onKeys = { f, s in f.nodes[1]!.attrs.value = s; f.focused = 1; return .success }
  let ot2 = runChain(t2, 1, ActRequest(action: "type", text: "hi"))
  eq(t2.writes, ["keys 1"], "web field typed via keys only")
  eq(ot2.delivery, .deliveredVerified, "web read back")
  // secure field → secure_input, no writes
  let t3 = FakeActor().add(1, "AXSecureTextField", settable: ["AXSelectedText", "AXValue"])
  let ot3 = runChain(t3, 1, ActRequest(action: "type", text: "pw"))
  check(ot3.code == "secure_input" && ot3.delivery == .notDelivered && t3.writes.isEmpty, "secure field refused")
  t3.web = true
  check(runChain(t3, 1, ActRequest(action: "type", text: "pw")).code == "secure_input" && t3.writes.isEmpty, "secure web field refused")
  check(runChain(t3, 1, ActRequest(action: "set", value: "pw")).code == "secure_input" && t3.writes.isEmpty, "secure set refused")
  check(runChain(FakeActor().add(1, "AXButton"), 1, ActRequest(action: "type", text: "x")).code == "unsupported", "type on a button")

  // toggle: already in the target state → verified, no write
  let g1 = FakeActor().add(1, "AXCheckBox", value: "1", actions: ["AXPress"], settable: ["AXValue"])
  let og1 = runChain(g1, 1, ActRequest(action: "toggle", value: "on"))
  check(og1.delivery == .deliveredVerified && g1.calls.isEmpty, "already on")
  // flip via a settable boolean AXValue
  g1.onSet["1:AXValue"] = { f, v in f.nodes[1]!.attrs.value = (v as! NSNumber).boolValue ? "1" : "0"; return .success }
  let og1b = runChain(g1, 1, ActRequest(action: "toggle"))
  check(og1b.delivery == .deliveredVerified && g1.calls == ["set 1 AXValue"], "flipped by AXValue")
  // value not settable → click chain, graded by the toggle state
  let g2 = FakeActor().add(1, "AXCheckBox", value: "0", actions: ["AXPress"])
  g2.onPerform["1:AXPress"] = { $0.nodes[1]!.attrs.value = "1"; return .success }
  eq(runChain(g2, 1, ActRequest(action: "toggle", value: "true")).delivery, .deliveredVerified, "toggle via press")
  // press ignored → without_effect (value read back unchanged)
  let g3 = FakeActor().add(1, "AXCheckBox", value: "0", actions: ["AXPress"])
  eq(runChain(g3, 1, ActRequest(action: "toggle")).delivery, .deliveredWithoutEffect, "toggle ignored")
  eq(g3.sleeps, 15, "toggle settles 600 ms")
  check(runChain(FakeActor().add(1, "AXRadioButton", value: "1", actions: ["AXPress"]), 1,
                 ActRequest(action: "toggle", value: "off")).code == "unsupported", "a radio can't be unchecked")

  // set: number → NSNumber, string → String, read back equal → verified
  let s1 = FakeActor().add(1, "AXSlider", value: "5", settable: ["AXValue"])
  s1.nodes[1]!.attrs.valueKind = .number
  s1.onSet["1:AXValue"] = { f, v in f.nodes[1]!.attrs.value = (v as? NSNumber)?.stringValue; return .success }
  let os1 = runChain(s1, 1, ActRequest(action: "set", value: "7"))
  check(s1.written["1:AXValue"] is NSNumber && (s1.written["1:AXValue"] as? NSNumber)?.intValue == 7, "numeric write")
  eq(os1.delivery, .deliveredVerified, "numeric read back")
  let s2 = FakeActor().add(1, "AXTextField", value: "a", settable: ["AXValue"])
  s2.nodes[1]!.attrs.valueKind = .string
  s2.onSet["1:AXValue"] = { f, v in f.nodes[1]!.attrs.value = v as? String; return .success }
  let os2 = runChain(s2, 1, ActRequest(action: "set", value: "7"))
  check(s2.written["1:AXValue"] is String && os2.delivery == .deliveredVerified, "string write")
  check(runChain(s1, 1, ActRequest(action: "set", value: "abc")).code == "invalid_args", "non-number for a number")
  // not settable → AXIncrement steps toward the target
  let s3 = FakeActor().add(1, "AXIncrementor", value: "1", actions: ["AXIncrement", "AXDecrement"])
  s3.onPerform["1:AXIncrement"] = { f in f.nodes[1]!.attrs.value = String(Int(f.nodes[1]!.attrs.value!)! + 1); return .success }
  let os3 = runChain(s3, 1, ActRequest(action: "set", value: "4"))
  check(os3.delivery == .deliveredVerified && s3.calls.count == 3, "three increments")

  // expand / collapse
  let x1 = FakeActor().add(1, "AXOutlineRow", actions: ["AXPress"], settable: ["AXExpanded"])
  x1.nodes[1]!.attrs.expanded = false
  x1.onSet["1:AXExpanded"] = { f, v in f.nodes[1]!.attrs.expanded = (v as! NSNumber).boolValue; return .success }
  let ox1 = runChain(x1, 1, ActRequest(action: "expand"))
  check(ox1.delivery == .deliveredVerified && x1.calls == ["set 1 AXExpanded"], "expand by attribute")
  check(runChain(x1, 1, ActRequest(action: "expand")).delivery == .deliveredVerified && x1.calls.count == 1, "already expanded")
  let x2 = FakeActor().add(1, "AXDisclosureTriangle", actions: ["AXPress"])
  x2.nodes[1]!.attrs.expanded = true
  let ox2 = runChain(x2, 1, ActRequest(action: "collapse"))
  check(ox2.delivery == .deliveredWithoutEffect && x2.sleeps == 5, "collapse ignored, 200 ms settle")

  // menu, focus, submit, scroll, select
  let m1 = FakeActor().add(1, "AXButton", actions: ["AXShowMenu"])
  m1.onPerform["1:AXShowMenu"] = { $0.menuOpen = true; return .success }
  eq(runChain(m1, 1, ActRequest(action: "menu")).delivery, .deliveredVerified, "context menu opened")
  let m2 = FakeActor().add(1, "AXButton", actions: ["AXShowMenu"])
  let om2 = runChain(m2, 1, ActRequest(action: "menu"))
  check(om2.delivery == .deliveredUnverified && m2.calls.count == 1 && m2.sleeps == 15, "no menu seen: unverified, 600 ms, once")
  let fo = FakeActor().add(1, "AXTextField", settable: ["AXFocused"])
  fo.onSet["1:AXFocused"] = { f, _ in f.focused = 1; return .success }
  eq(runChain(fo, 1, ActRequest(action: "focus")).delivery, .deliveredVerified, "focus verified")
  let fo2 = FakeActor().add(1, "AXGroup", settable: ["AXFocused"]).add(2, "AXTextField", parent: 1)
  fo2.onSet["1:AXFocused"] = { f, _ in f.focused = 2; return .success }
  eq(runChain(fo2, 1, ActRequest(action: "focus")).delivery, .deliveredVerified, "focus delegated to a descendant")
  let sb = FakeActor().add(1, "AXButton", actions: ["AXConfirm"])
  sb.onPerform["1:AXConfirm"] = { $0.focused = 1; return .success }
  check(runChain(sb, 1, ActRequest(action: "submit")).delivery == .deliveredUnverified && sb.sleeps == 0, "submit never confirmed")
  check(runChain(FakeActor().add(1, "AXButton", actions: ["AXPress"]), 1, ActRequest(action: "submit")).code == "unsupported",
        "submit without AXConfirm: no Enter")
  let sc = FakeActor().add(1, "AXScrollArea").add(2, "AXScrollBar", parent: 1, value: "0", actions: ["AXIncrement"])
  sc.nodes[2]!.attrs.frame = CGRect(x: 0, y: 0, width: 10, height: 300)
  sc.add(3, "AXList", parent: 1)
  sc.onPerform["2:AXIncrement"] = { f in f.nodes[2]!.attrs.value = "0.5"; return .success }
  let osc = runChain(sc, 3, ActRequest(action: "scroll", direction: "down", amount: 2))
  check(osc.delivery == .deliveredVerified && sc.calls == ["perform 2 AXIncrement", "perform 2 AXIncrement"], "scroll via bar")
  let se = FakeActor().add(1, "AXPopUpButton", value: "A", actions: ["AXPress"]).add(2, "AXMenu", parent: 1, actions: ["AXCancel"])
  se.add(3, "AXMenuItem", parent: 2, title: "A", actions: ["AXPress"]).add(4, "AXMenuItem", parent: 2, title: "Blue", actions: ["AXPress"])
  se.onPerform["1:AXPress"] = { $0.menuOpen = true; return .success }
  se.onPerform["4:AXPress"] = { f in f.menuOpen = false; f.nodes[1]!.attrs.value = "Blue"; return .success }
  let ose = runChain(se, 1, ActRequest(action: "select", value: "blue"))
  check(ose.delivery == .deliveredVerified && se.calls == ["perform 1 AXPress", "perform 4 AXPress"], "select from popup")
  se.menuOpen = false
  let ose2 = runChain(se, 1, ActRequest(action: "select", value: "Green"))
  check(ose2.code == "not_found" && se.calls.suffix(2) == ["perform 1 AXPress", "perform 2 AXCancel"], "missing item → AXCancel")
}

// ── AX core: action chains, fix round 1 (no second act after a visible / partial delivery) ──
do {
  // row: AXPress moves focus, AXSelected stays false → it visibly worked: AXOpen never called
  let r1 = FakeActor().add(1, "AXRow", actions: ["AXPress", "AXOpen"], settable: ["AXSelected"]).add(2, "AXTextField")
  r1.nodes[1]!.attrs.selected = false
  r1.onPerform["1:AXPress"] = { $0.focused = 2; return .success }
  let or1 = runChain(r1, 1, ActRequest(action: "click"))
  check(or1.delivery == .deliveredUnverified && r1.calls == ["perform 1 AXPress"], "row press with an effect stops")
  // toggle via press: value unchanged but a menu opened → stop
  let r2 = FakeActor().add(1, "AXCheckBox", value: "0", actions: ["AXPress", "AXOpen"])
  r2.onPerform["1:AXPress"] = { $0.menuOpen = true; return .success }
  check(runChain(r2, 1, ActRequest(action: "toggle")).delivery == .deliveredUnverified && r2.calls.count == 1,
        "toggle press with an effect stops")
  let p0 = EffectProbe(focusedKey: nil, selected: false, menuOpen: false, exists: true, value: nil, expanded: nil)
  var pm = p0; pm.menuOpen = true
  eq(gradeStep(.success, before: p0, after: pm, readbackRole: true, stateChecked: nil), .deliveredUnverified, "row + effect")
  eq(gradeStep(.success, before: p0, after: pm, readbackRole: false, stateChecked: false), .deliveredUnverified, "state + effect")

  // lazy scroll bar: increments succeed, value never moves → AXValue write never runs
  let l1 = FakeActor().add(1, "AXScrollArea").add(2, "AXScrollBar", parent: 1, value: "0", actions: ["AXIncrement"], settable: ["AXValue"])
  l1.nodes[2]!.attrs.frame = CGRect(x: 0, y: 0, width: 10, height: 300)
  let ol1 = runChain(l1, 2, ActRequest(action: "scroll", direction: "down", amount: 3))
  check(ol1.delivery == .deliveredUnverified && l1.writes.isEmpty && l1.calls.count == 3 && ol1.steps.count == 1,
        "lazy scroll bar: increments only, unverified")
  // partial failure inside the scroll loop → uncertain
  let l2 = FakeActor().add(1, "AXScrollArea").add(2, "AXScrollBar", parent: 1, value: "0", actions: ["AXIncrement"], settable: ["AXValue"])
  var n = 0
  l2.onPerform["2:AXIncrement"] = { _ in n += 1; return n == 1 ? .success : .cannotComplete }
  let ol2 = runChain(l2, 2, ActRequest(action: "scroll", direction: "down", amount: 3))
  check(ol2.delivery == .uncertain && l2.writes.isEmpty && l2.calls.count == 2, "partial scroll failure → uncertain")
  let l3 = FakeActor().add(1, "AXScrollArea").add(2, "AXScrollBar", parent: 1, value: "0", actions: ["AXIncrement"])
  var n3 = 0
  l3.onPerform["2:AXIncrement"] = { _ in n3 += 1; return n3 == 1 ? .success : .notSupported }
  eq(runChain(l3, 2, ActRequest(action: "scroll", direction: "down", amount: 2)).delivery, .deliveredUnverified,
     "partial unsupported after a delivered one → unverified, not retry-safe")

  // set: write succeeds, value unchanged → no increment walk
  let v1 = FakeActor().add(1, "AXSlider", value: "1", actions: ["AXIncrement"], settable: ["AXValue"])
  v1.nodes[1]!.attrs.valueKind = .number
  let ov1 = runChain(v1, 1, ActRequest(action: "set", value: "4"))
  check(ov1.delivery == .deliveredUnverified && v1.calls == ["set 1 AXValue"], "set unchanged → stop")
  // combobox: write succeeds, value unchanged → no menu pick
  let v2 = FakeActor().add(1, "AXComboBox", value: "a", actions: ["AXShowMenu"], settable: ["AXValue"])
  check(runChain(v2, 1, ActRequest(action: "select", value: "b")).delivery == .deliveredUnverified && v2.calls == ["set 1 AXValue"],
        "combobox write unchanged → stop")

  // menu composite: AXSelected delivered, then AXShowMenu unsupported → not retry-safe
  let c1 = FakeActor().add(1, "AXRow", actions: ["AXShowMenu"], settable: ["AXSelected"])
  c1.onPerform["1:AXShowMenu"] = { _ in .notSupported }
  let oc1 = runChain(c1, 1, ActRequest(action: "menu"))
  eq(oc1.steps.map { $0.1 }, [.notDelivered, .deliveredUnverified], "select delivered, show failed")
  eq(oc1.delivery, .deliveredUnverified, "composite never not_delivered after a delivered sub-call")

  // web typing: focus moved away after the keys → unverified even though the value contains the text
  let w1 = FakeActor().add(1, "AXTextField", value: "").add(2, "AXButton")
  w1.web = true
  w1.onKeys = { f, s in f.nodes[1]!.attrs.value = s; f.focused = 2; return .success }
  eq(runChain(w1, 1, ActRequest(action: "type", text: "hi")).delivery, .deliveredUnverified, "focus left the field")
}

// ── menu shortcuts + blocked combos ────────────────────────────────────────────────
do {
  check(menuMatch(cmdChar: "N", cmdModifiers: 0, enabled: true, mods: ["cmd"], key: "n"), "cmd+n")
  check(menuMatch(cmdChar: "N", cmdModifiers: nil, enabled: true, mods: ["command"], key: "N"), "absent modifiers = cmd only")
  check(!menuMatch(cmdChar: "N", cmdModifiers: 1, enabled: true, mods: ["cmd"], key: "n"), "1 needs shift")
  check(menuMatch(cmdChar: "N", cmdModifiers: 1, enabled: true, mods: ["cmd", "shift"], key: "n"), "cmd+shift+n")
  check(menuMatch(cmdChar: "T", cmdModifiers: 6, enabled: true, mods: ["cmd", "alt", "ctrl"], key: "t"), "opt+ctrl")
  check(!menuMatch(cmdChar: "N", cmdModifiers: 0, enabled: false, mods: ["cmd"], key: "n"), "disabled")
  check(!menuMatch(cmdChar: "N", cmdModifiers: 0, enabled: nil, mods: ["cmd"], key: "n"), "enabled unknown")
  check(!menuMatch(cmdChar: "N", cmdModifiers: 8, enabled: true, mods: ["cmd"], key: "n"), "no-cmd item vs cmd combo")
  check(menuMatch(cmdChar: "N", cmdModifiers: 12, enabled: true, mods: ["ctrl"], key: "n"), "ctrl-only item")
  check(!menuMatch(cmdChar: "N", cmdModifiers: 0, enabled: true, mods: ["cmd"], key: "m"), "other key")
  check(!menuMatch(cmdChar: nil, cmdModifiers: 0, enabled: true, mods: ["cmd"], key: "n"), "no cmd char")
  check(!menuMatch(cmdChar: "N", cmdModifiers: 8, enabled: true, mods: [], key: "n"), "plain keys never go to the menu")

  for (m, k) in [(["cmd"], "q"), (["cmd", "shift"], "q"), (["cmd", "alt"], "escape"), (["ctrl", "cmd"], "q"),
                 (["cmd", "shift"], "delete"), (["cmd", "alt", "shift"], "q"), (["cmd", "ctrl", "shift"], "q"),
                 (["command", "option"], "esc"), (["cmd", "shift"], "backspace"), (["cmd"], "Q")] {
    check(isBlockedCombo(mods: Set(m), key: k), "blocked \(m)+\(k)")
  }
  check(!isBlockedCombo(mods: ["cmd"], key: "w"), "cmd+w allowed")
  check(!isBlockedCombo(mods: ["shift"], key: "q"), "shift+q allowed")
  check(!isBlockedCombo(mods: ["cmd"], key: "escape"), "cmd+esc allowed")
  check(!isBlockedCombo(mods: ["cmd"], key: "delete"), "cmd+delete allowed")
}

print("forge-cu self-test: \(passed) passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
