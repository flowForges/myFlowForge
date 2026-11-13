// forge-cu · guarded CGEvent posting (V7). Every post re-checks its target right before the first event,
// and the abort flag (SIGUSR1) is checked before every single event.
import Foundation
import CoreGraphics
import Carbon

private struct Stopped: Error {}
private struct Changed: Error {}

final class Poster {
  private let src = CGEventSource(stateID: .privateState)
  private let abort: AbortState
  private var heldMods: [String] = []
  private var heldButton: CGMouseButton?
  private var heldKey: UInt16?
  private var lastGuard = Guard()
  private var typed = 0

  init(abort: AbortState) { self.abort = abort }

  // ── primitives ──

  /// Posts one event unless an abort is pending.
  private func send(_ e: CGEvent?) throws {
    if abort.requested { throw Stopped() }
    e?.post(tap: .cghidEventTap)
  }

  /// Sleeps in small slices so an abort is noticed within ~5 ms.
  private func pause(_ ms: Int) throws {
    var left = ms
    while left > 0 {
      if abort.requested { throw Stopped() }
      let s = min(5, left); usleep(useconds_t(s * 1000)); left -= s
    }
    if abort.requested { throw Stopped() }
  }

  private func key(_ code: UInt16, down: Bool, flags: CGEventFlags) -> CGEvent? {
    let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    e?.flags = flags
    return e
  }

  private func modsDown(_ mods: [String]) throws {
    var flags: CGEventFlags = []
    for m in mods {
      guard let c = modifierKeycode(m) else { continue }
      flags.formUnion(modifierFlags([m]))
      try send(key(c, down: true, flags: flags))
      heldMods.append(m)
    }
  }

  private func modsUp() throws {
    var remaining = heldMods
    while let m = remaining.popLast() {
      try send(key(modifierKeycode(m)!, down: false, flags: modifierFlags(remaining)))
      heldMods = remaining
    }
  }

  private func mouseTypes(_ b: CGMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType) {
    switch b {
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
  }

  private func mouse(_ t: CGEventType, _ p: CGPoint, _ b: CGMouseButton, flags: CGEventFlags, clicks: Int64 = 1) -> CGEvent? {
    let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: b)
    e?.flags = flags
    if t != .mouseMoved { e?.setIntegerValueField(.mouseEventClickState, value: clicks) }
    return e
  }

  private func move(_ p: CGPoint) throws { try send(mouse(.mouseMoved, p, .left, flags: [])) }

  /// A point with none of the denied windows under it, for lifting a held button: the current
  /// location, then the action's own points, then the main display's corners and centre.
  private func neutral(_ g: Guard, prefer: [CGPoint]) -> CGPoint? {
    let b = mainDisplayBounds()
    let corners = [CGPoint(x: b.minX + 2, y: b.maxY - 2), CGPoint(x: b.maxX - 2, y: b.maxY - 2), CGPoint(x: b.midX, y: b.midY),
                   CGPoint(x: b.minX + 2, y: b.minY + 40), CGPoint(x: b.maxX - 2, y: b.minY + 40)]
    let here = CGEvent(source: nil)?.location ?? .zero
    return neutralPoint(onScreenWindows(), g, bundleOf: bundleOf, candidates: [here] + prefer + corners)
  }

  /// Lifts everything this process holds. Bypasses the abort flag on purpose. A held button is
  /// released only after a hit test: over a denied window the pointer first moves to a neutral point.
  func releaseHeld(prefer: [CGPoint] = []) {
    if let k = heldKey {
      key(k, down: false, flags: modifierFlags(heldMods))?.post(tap: .cghidEventTap)
      heldKey = nil
    }
    if let b = heldButton {
      let here = CGEvent(source: nil)?.location ?? .zero
      let at = neutral(lastGuard, prefer: prefer) ?? here
      if at != here { mouse(mouseTypes(b).drag, at, b, flags: [])?.post(tap: .cghidEventTap); usleep(15_000) }
      mouse(mouseTypes(b).up, at, b, flags: [])?.post(tap: .cghidEventTap)
      heldButton = nil
    }
    while let m = heldMods.popLast() {
      key(modifierKeycode(m)!, down: false, flags: modifierFlags(heldMods))?.post(tap: .cghidEventTap)
    }
  }

  // ── checks ──

  private func pointerOK(_ g: Guard, at p: CGPoint) -> Bool {
    if inputBlockedBySession() { return false }
    let f = workspaceFront()
    let wins = onScreenWindows()
    let hit = hitTest(p, wins: wins)
    if pointerCheck(g, hit: hit, frontPid: f?.processIdentifier, frontBundle: f?.bundleIdentifier) != nil { return false }
    // nothing under the point (empty desktop) and nothing expected: the AX cross-check has nothing to compare
    guard let h = hit else { return true }
    return overlayCheck(g, under: windowsUnder(p, wins), hit: h, axPid: axPidAt(p), frontPid: f?.processIdentifier, bundleOf: bundleOf) == nil
  }

  private func keyboardOK(_ g: Guard) -> Bool {
    let ws = workspaceFront()
    let s = sessionState()
    return keyboardCheck(g, axPid: axFocusedPid(), wsPid: ws?.processIdentifier, bundle: ws?.bundleIdentifier,
                         secure: secureInputOn(), locked: s.locked || !s.onConsole || displayAsleep()) == nil
  }

  // ── entry ──

  func post(_ body: [String: Any]) -> [String: Any] {
    guard let a = body["action"] as? [String: Any], let kind = a["kind"] as? String else { return errorReply(id: nil, code: "invalid_args") }
    let g = parseGuard(body["guard"])
    lastGuard = g
    typed = 0
    abort.beginPost()
    defer { abort.endPost() }
    do {
      switch kind {
      case "click": try click(a, g)
      case "move": try moveAction(a, g)
      case "drag": try drag(a, g)
      case "scroll": try scroll(a, g)
      case "type": try type(a, g)
      case "key": try keyAction(a, g)
      default: return errorReply(id: nil, code: "invalid_args")
      }
      return [:]
    } catch is Stopped {
      releaseHeld(prefer: [point(a["from"]), point(a)].compactMap { $0 })
      return errorReply(id: nil, code: "stopped", extra: kind == "type" ? ["typed": typed] : [:])
    } catch is Changed {
      releaseHeld(prefer: [point(a["from"]), point(a)].compactMap { $0 })
      return errorReply(id: nil, code: "target_changed", extra: kind == "type" ? ["typed": typed] : [:])
    } catch {
      releaseHeld()
      return errorReply(id: nil, code: "invalid_args")
    }
  }

  private func button(_ v: Any?) -> CGMouseButton {
    switch v as? String { case "right": return .right; case "middle": return .center; default: return .left }
  }

  private func pt(_ a: [String: Any]) throws -> CGPoint {
    guard let x = num(a["x"]), let y = num(a["y"]) else { throw Changed() }
    return CGPoint(x: x, y: y)
  }

  private func click(_ a: [String: Any], _ g: Guard) throws {
    let p = try pt(a), b = button(a["button"])
    let count = clampInt(num(a["count"]), 1, 3)
    let mods = a["mods"] as? [String] ?? []
    let flags = modifierFlags(mods)
    guard pointerOK(g, at: p) else { throw Changed() }
    let t = mouseTypes(b)
    try modsDown(mods)
    try send(mouse(.mouseMoved, p, b, flags: flags))
    for i in 1...count {
      // (5) every extra click of a double / triple click re-checks the target
      if i > 1 { guard pointerOK(g, at: p) else { throw Changed() } }
      try send(mouse(t.down, p, b, flags: flags, clicks: Int64(i)))
      heldButton = b
      try send(mouse(t.up, p, b, flags: flags, clicks: Int64(i)))
      heldButton = nil
      if i < count { try pause(40) }
    }
    try modsUp()
  }

  private func moveAction(_ a: [String: Any], _ g: Guard) throws {
    let p = try pt(a)
    guard pointerOK(g, at: p) else { throw Changed() }
    try move(p)
  }

  private func scroll(_ a: [String: Any], _ g: Guard) throws {
    let p = try pt(a)
    // V7c: wheel events go to the window under the cursor, so move there first and check that point
    try move(g.pointer ?? p)
    try pause(15)
    guard pointerOK(g, at: g.pointer ?? p) else { throw Changed() }
    var dy = clampInt(num(a["dy"]), -1000, 1000), dx = clampInt(num(a["dx"]), -1000, 1000)
    var first = true
    while dy != 0 || dx != 0 {
      // (5) re-check between wheel chunks
      if !first { try pause(15); guard pointerOK(g, at: g.pointer ?? p) else { throw Changed() } }
      first = false
      let sy = max(-10, min(10, dy)), sx = max(-10, min(10, dx))
      try send(CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: wheelValue(sy), wheel2: Int32(sx), wheel3: 0))
      dy -= sy; dx -= sx
    }
  }

  private func drag(_ a: [String: Any], _ g: Guard) throws {
    guard let from = point(a["from"]), let to = point(a["to"]) else { throw Changed() }
    let mods = a["mods"] as? [String] ?? []
    let flags = modifierFlags(mods)
    guard pointerOK(g, at: from) else { throw Changed() }
    let fromPid = hitTest(from)?.pid
    let toAtStart = hitTest(to)
    // (4) a drop point that is already ours is refused before anything is pressed
    if let t0 = toAtStart, denied(g, pid: t0.pid, bundle: t0.bundleId) { throw Changed() }
    let toPidAtStart = toAtStart?.pid
    let t = mouseTypes(.left)
    try modsDown(mods)
    try send(mouse(.mouseMoved, from, .left, flags: flags))
    try send(mouse(t.down, from, .left, flags: flags))
    heldButton = .left
    let steps = 20
    for i in 1...steps {
      try pause(15)
      let k = CGFloat(i) / CGFloat(steps)
      try send(mouse(t.drag, CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k), .left, flags: flags))
    }
    // V7d: re-check the drop point; on a change drag back to `from` and drop there
    var den = Guard(); den.denyPids = g.denyPids; den.denyBundlePrefixes = g.denyBundlePrefixes
    den.expectEndPid = g.expectEndPid; den.expectEndWindowId = g.expectEndWindowId
    if inputBlockedBySession() || dragEndCheck(den, startPid: toPidAtStart, fromPid: fromPid, end: hitTest(to)) != nil {
      for i in 1...5 {
        try pause(15)
        let k = CGFloat(i) / 5
        try send(mouse(t.drag, CGPoint(x: to.x + (from.x - to.x) * k, y: to.y + (from.y - to.y) * k), .left, flags: flags))
      }
      // the release happens in releaseHeld after a hit test (neutral point if `from` became ours)
      throw Changed()
    }
    try send(mouse(t.up, to, .left, flags: flags))
    heldButton = nil
    try modsUp()
  }

  private func type(_ a: [String: Any], _ g: Guard) throws {
    guard let text = a["text"] as? String else { throw Changed() }
    try withASCIIInputSource {
      for seg in typeSegments(text) {
        // V7b: front pid, secure input and lock state before every chunk
        guard keyboardOK(g) else { throw Changed() }
        switch seg {
        case .text(let units):
          let down = key(0, down: true, flags: []), up = key(0, down: false, flags: [])
          units.withUnsafeBufferPointer { p in
            down?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress)
            up?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress)
          }
          try send(down); heldKey = 0
          try send(up); heldKey = nil
        case .key(let code):
          try send(key(code, down: true, flags: [])); heldKey = code
          try send(key(code, down: false, flags: [])); heldKey = nil
        }
        typed += seg.units.count
        try pause(8)
      }
    }
  }

  private func keyAction(_ a: [String: Any], _ g: Guard) throws {
    let mods = a["mods"] as? [String] ?? []
    let code: UInt16
    if let c = (a["code"] as? NSNumber)?.uint16Value {
      code = c
    } else {
      // the app resolves characters to ANSI keycodes (and the implied shift); the helper never consults the layout for `key`
      throw Changed()
    }
    let repeatN = clampInt(num(a["repeat"]), 1, 100)
    let flags = modifierFlags(mods)
    for i in 0..<repeatN {
      guard keyboardOK(g) else { throw Changed() }
      if i == 0 { try modsDown(mods) }
      try send(key(code, down: true, flags: flags)); heldKey = code
      try send(key(code, down: false, flags: flags)); heldKey = nil
      if i < repeatN - 1 { try pause(30) }
    }
    try modsUp()
  }

  // ── release op (after a SIGKILL'd predecessor, V7g) ──

  func release(_ body: [String: Any]) -> [String: Any] {
    for m in (body["mods"] as? [String] ?? []).reversed() {
      if let c = modifierKeycode(m) { key(c, down: false, flags: [])?.post(tap: .cghidEventTap) }
    }
    if let b = body["button"] as? String {
      let btn = button(b)
      let loc = CGEvent(source: nil)?.location ?? .zero
      mouse(mouseTypes(btn).up, loc, btn, flags: [])?.post(tap: .cghidEventTap)
    }
    return [:]
  }
}

// ───────────────────────── keyboard layout / input source ─────────────────────────

/// `char` → keycode on the current layout (UCKeyTranslate), unshifted first, then with shift.
func layoutKeycode(_ ch: Character) -> (code: UInt16, shift: Bool)? {
  onMain {
    guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    let want = String(ch)
    return data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) -> (code: UInt16, shift: Bool)? in
      guard let base = buf.baseAddress else { return nil }
      let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
      for shift in [false, true] {
        let mod: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xFF) : 0
        for code in 0..<128 {
          var dead: UInt32 = 0
          var len = 0
          var chars = [UniChar](repeating: 0, count: 4)
          let st = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), mod, UInt32(LMGetKbdType()),
                                  OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &len, &chars)
          if st == noErr, len > 0, String(utf16CodeUnits: chars, count: len) == want { return (UInt16(code), shift) }
        }
      }
      return nil
    }
  }
}

/// Runs `f` with an ASCII-capable input source selected when the current one isn't (an IME would
/// swallow the Unicode events), restoring the original afterwards.
func withASCIIInputSource(_ f: () throws -> Void) rethrows {
  let previous: TISInputSource? = onMain {
    guard let cur = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return nil }
    if let p = TISGetInputSourceProperty(cur, kTISPropertyInputSourceIsASCIICapable),
       CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(p).takeUnretainedValue()) { return nil }
    guard let ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() else { return nil }
    TISSelectInputSource(ascii)
    return cur
  }
  if previous != nil { usleep(60_000) }
  defer { if let p = previous { _ = onMain { TISSelectInputSource(p) } } }
  try f()
}
