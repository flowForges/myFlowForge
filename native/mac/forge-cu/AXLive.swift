// forge-cu · live accessibility binding: AXUIElement behind `AXSource` / `AXActor` (AXCore.swift), process
// instances, window numbers and the Electron / Chromium accessibility switch (spec §6.1, §6.2, §6.7).
// Every AX call sets its messaging timeout from the request deadline first (spec C2).
import Foundation
import AppKit
import ApplicationServices

// MARK: - CF helpers

/// Identity of a remote element: CFHash + CFEqual, never the local CF object pointer.
struct AXKey: Hashable {
  let e: AXUIElement
  func hash(into h: inout Hasher) { h.combine(CFHash(e)) }
  static func == (a: AXKey, b: AXKey) -> Bool { CFEqual(a.e, b.e) }
}

func axResult(_ err: AXError) -> AXResult {
  switch err {
  case .success: return .success
  case .actionUnsupported, .attributeUnsupported, .notImplemented, .illegalArgument, .parameterizedAttributeUnsupported:
    return .notSupported
  case .cannotComplete: return .cannotComplete
  case .invalidUIElement: return .invalidElement
  case .apiDisabled: return .apiDisabled
  default: return .other(err.rawValue)
  }
}

private func isAXErrorValue(_ v: CFTypeRef) -> Bool {
  CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError
}

func cfString(_ v: CFTypeRef?) -> String? {
  guard let v else { return nil }
  let t = CFGetTypeID(v)
  if t == CFStringGetTypeID() { return (v as! CFString) as String }
  if t == CFAttributedStringGetTypeID() { return CFAttributedStringGetString((v as! CFAttributedString)) as String }
  return nil
}

func cfBool(_ v: CFTypeRef?) -> Bool? {
  guard let v else { return nil }
  if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
  if CFGetTypeID(v) == CFNumberGetTypeID() { return (v as! NSNumber).intValue != 0 }
  return nil
}

func cfInt(_ v: CFTypeRef?) -> Int? {
  guard let v, CFGetTypeID(v) == CFNumberGetTypeID() else { return nil }
  return (v as! NSNumber).intValue
}

func cfElement(_ v: CFTypeRef?) -> AXUIElement? {
  guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}

private func cfPoint(_ v: CFTypeRef?) -> CGPoint? {
  guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

private func cfSize(_ v: CFTypeRef?) -> CGSize? {
  guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var s = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

/// AXValue → text + the CF type it came in (so `set` writes the same type back).
private func valueText(_ v: CFTypeRef) -> (String, AXValueKind)? {
  let t = CFGetTypeID(v)
  if t == CFBooleanGetTypeID() { return (CFBooleanGetValue((v as! CFBoolean)) ? "true" : "false", .bool) }
  if t == CFNumberGetTypeID() {
    let d = (v as! NSNumber).doubleValue
    if d.isFinite && d == d.rounded() && abs(d) < 1e15 { return (String(Int64(d)), .number) }
    return (String(d), .number)
  }
  if let s = cfString(v) { return (s, .string) }
  return nil
}

/// One attribute with a read slice of the deadline. nil value on any error.
func axRead(_ e: AXUIElement, _ attr: String, _ d: Deadline) -> (value: CFTypeRef?, err: AXError) {
  if d.expired { return (nil, .cannotComplete) }
  AXUIElementSetMessagingTimeout(e, d.readTimeout())
  var v: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(e, attr as CFString, &v)
  return (err == .success ? v : nil, err)
}

func axElement(_ e: AXUIElement, _ attr: String, _ d: Deadline) -> AXUIElement? { cfElement(axRead(e, attr, d).value) }

func axElements(_ e: AXUIElement, _ attr: String, _ d: Deadline) -> [AXUIElement] {
  guard let v = axRead(e, attr, d).value, CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
  return ((v as! CFArray) as [AnyObject]).compactMap { cfElement($0) }
}

private func actionNames(_ e: AXUIElement, _ d: Deadline) -> [String] {
  if d.expired { return [] }
  AXUIElementSetMessagingTimeout(e, d.readTimeout())
  var names: CFArray?
  guard AXUIElementCopyActionNames(e, &names) == .success, let n = names as? [String] else { return [] }
  return n
}

private func isSettable(_ e: AXUIElement, _ attr: String, _ d: Deadline) -> Bool {
  if d.expired { return false }
  AXUIElementSetMessagingTimeout(e, d.readTimeout())
  var s = DarwinBoolean(false)
  return AXUIElementIsAttributeSettable(e, attr as CFString, &s) == .success && s.boolValue
}

/// AX trust is a precondition of every AX op (no prompt: preflight only).
func axTrusted() -> Bool { AXIsProcessTrusted() }

// MARK: - Process instance, window numbers, windows

/// pid + start time from proc_pidinfo(PROC_PIDTBSDINFO); nil once the process is gone.
func processInstance(_ pid: Int32) -> Instance? {
  guard pid > 0 else { return nil }
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
  return Instance(pid: pid, start: instanceStart(sec: info.pbi_start_tvsec, usec: info.pbi_start_tvusec))
}

func instanceJSON(_ i: Instance) -> [String: Any] { ["pid": Int(i.pid), "start": i.start] }

func parseInstance(_ v: Any?) -> Instance? {
  guard let d = v as? [String: Any], let pid = int32(d["pid"]), let start = d["start"] as? String else { return nil }
  return Instance(pid: pid, start: start)
}

private let RTLD_DEFAULT_H = UnsafeMutableRawPointer(bitPattern: -2)
private typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
/// `_AXUIElementGetWindow` (HIServices SPI, spec C3) through dlsym: missing → window numbers are unknown.
private let getWindowFn: GetWindowFn? = dlsym(RTLD_DEFAULT_H, "_AXUIElementGetWindow").map { unsafeBitCast($0, to: GetWindowFn.self) }

func axWindowNumber(_ w: AXUIElement) -> Int? {
  guard let f = getWindowFn else { return nil }
  var id: CGWindowID = 0
  return f(w, &id) == .success && id != 0 ? Int(id) : nil
}

/// The snapshot root: the given window number, else AXFocusedWindow → AXMainWindow → first AXWindows.
func pickWindow(_ app: AXUIElement, number: Int?, _ d: Deadline) -> AXUIElement? {
  if let n = number { return axElements(app, "AXWindows", d).first { axWindowNumber($0) == n } }
  return axElement(app, "AXFocusedWindow", d) ?? axElement(app, "AXMainWindow", d) ?? axElements(app, "AXWindows", d).first
}

/// `{number, title?}` for every AX window of the app that has a window number.
func appWindowList(_ pid: Int32, _ d: Deadline) -> [[String: Any]] {
  let app = AXUIElementCreateApplication(pid)
  return axElements(app, "AXWindows", d).compactMap { w in
    guard let n = axWindowNumber(w) else { return nil }
    var o: [String: Any] = ["number": n]
    if let t = cfString(axRead(w, "AXTitle", d).value), !t.isEmpty { o["title"] = t }
    return o
  }
}

private let axSystemWide = AXUIElementCreateSystemWide()

/// AX element at a global point, from the system-wide element or a given app element.
func axElementAt(_ p: CGPoint, in root: AXUIElement? = nil, _ d: Deadline) -> AXUIElement? {
  let r = root ?? axSystemWide
  AXUIElementSetMessagingTimeout(r, d.readTimeout())
  var el: AXUIElement?
  return AXUIElementCopyElementAtPosition(r, Float(p.x), Float(p.y), &el) == .success ? el : nil
}

/// System-wide focused application pid and its focused window.
func axFocusedAppWindow(_ d: Deadline) -> (pid: Int32, window: AXUIElement?)? {
  guard let app = axElement(axSystemWide, "AXFocusedApplication", d) else { return nil }
  var pid: pid_t = 0
  guard AXUIElementGetPid(app, &pid) == .success else { return nil }
  return (pid, axElement(app, "AXFocusedWindow", d))
}

// MARK: - The live tree

/// Node attributes read in one AXUIElementCopyMultipleAttributeValues call; AXValue is never in it
/// (read separately, only for a known role that is not a secure text field).
private let batchNames = [
  "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXHelp", "AXIdentifier", "AXDOMIdentifier", "AXPlaceholderValue",
  "AXEnabled", "AXFocused", "AXSelected", "AXExpanded", "AXPosition", "AXSize", "AXTitleUIElement", "AXNumberOfCharacters",
]
private let batchCF = batchNames as CFArray
private let probeNames = ["AXRole", "AXSelected", "AXExpanded"] as CFArray
/// Roles whose settable attributes never feed the action vocabulary.
private let staticRoles: Set<String> = ["AXStaticText", "AXImage", "AXHeading"]
/// Attributes the chains test with `settable` (selection writes, text ranges).
private let actorSettable = ["AXSelected", "AXSelectedTextRange", "AXSelectedRows", "AXSelectedChildren", "AXSelectedCells"]
private let childPageSize = 128
/// One more than the walker's per-node budget, so an oversized list is still seen as cut.
private let childReadCap = 4097

/// AXUIElement behind both protocols. The source side takes the walker's deadline per call; the actor
/// side uses `deadline` and fails fast once it has passed or an abort latched (spec C2, T3 brief).
final class LiveAX: AXSource, AXActor {
  typealias E = AXUIElement
  let pid: Int32
  let app: AXUIElement
  var deadline: Deadline
  let abort: AbortState?
  private(set) var mutated = false
  private(set) var hitExpired = false
  private(set) var hitAbort = false
  /// UTF-16 units web typing posted before the focus moved away (set only when typing was cut short).
  private(set) var typedPartial: Int?
  /// waitFor passes (spec §6.8): source reads keep identity, names and actions only — no AXValue
  /// except static text (a label), no settable probes.
  var identityOnly = false

  init(pid: Int32, deadline: Deadline, abort: AbortState? = nil) {
    self.pid = pid
    app = AXUIElementCreateApplication(pid)
    self.deadline = deadline
    self.abort = abort
  }

  // MARK: reads

  func readAttrs(_ e: AXUIElement, _ d: Deadline, actor: Bool) -> NodeAttrs? {
    if d.expired { return nil }
    AXUIElementSetMessagingTimeout(e, d.readTimeout())
    var out: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(e, batchCF, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
          let raw = out, CFArrayGetCount(raw) == batchNames.count else { return nil }
    let arr = raw as [AnyObject]
    func slot(_ i: Int) -> CFTypeRef? {
      let v = arr[i] as CFTypeRef
      if CFGetTypeID(v) == CFNullGetTypeID() || isAXErrorValue(v) { return nil }
      return v
    }
    var a = NodeAttrs()
    a.role = cfString(slot(0)); a.subrole = cfString(slot(1)); a.title = cfString(slot(2))
    a.description = cfString(slot(3)); a.help = cfString(slot(4)); a.identifier = cfString(slot(5))
    a.domIdentifier = cfString(slot(6)); a.placeholder = cfString(slot(7))
    a.enabled = cfBool(slot(8)); a.focused = cfBool(slot(9)); a.selected = cfBool(slot(10)); a.expanded = cfBool(slot(11))
    if let p = cfPoint(slot(12)), let s = cfSize(slot(13)) { a.frame = CGRect(origin: p, size: s) }
    if let t = cfElement(slot(14)) { a.titleUIText = titleUIText(t, d) }
    a.numberOfCharacters = cfInt(slot(15))
    let secure = a.role == "AXSecureTextField" || a.subrole == "AXSecureTextField"
    let lean = identityOnly && !actor
    if let role = a.role, !secure {
      if !lean || role == "AXStaticText", let v = axRead(e, "AXValue", d).value, let (s, k) = valueText(v) {
        a.value = s; a.valueKind = k
      }
      a.actions = actionNames(e, d)
      if !lean && (!staticRoles.contains(role) || actor) {
        var probe = ["AXValue", "AXFocused", "AXExpanded"]
        if normalizeRole(role: role, subrole: a.subrole) == "textfield" || role == "AXComboBox" { probe.append("AXSelectedText") }
        if actor { probe += actorSettable }
        for attr in probe where isSettable(e, attr, d) { a.settable.insert(attr) }
      }
    } else if a.role != nil && !lean {
      a.actions = actionNames(e, d)
      for attr in ["AXFocused"] + (actor ? ["AXSelected"] : []) where isSettable(e, attr, d) { a.settable.insert(attr) }
    }
    return a
  }

  /// AXTitleUIElement text: its title, else a non-secure static text value, else its description.
  private func titleUIText(_ t: AXUIElement, _ d: Deadline) -> String? {
    if let s = cfString(axRead(t, "AXTitle", d).value), !s.isEmpty { return s }
    if cfString(axRead(t, "AXRole", d).value) == "AXStaticText", let s = cfString(axRead(t, "AXValue", d).value), !s.isEmpty { return s }
    if let s = cfString(axRead(t, "AXDescription", d).value), !s.isEmpty { return s }
    return nil
  }

  /// Count → pages of 128 → count again; the first available source wins, an empty AXChildren is final.
  func readChildren(_ e: AXUIElement, role: String, _ d: Deadline) -> (items: [AXUIElement], changed: Bool)? {
    let sources: [String]
    switch role {
    case "AXApplication": sources = ["AXWindows", "AXChildren"]
    case "AXBrowser": sources = ["AXColumns", "AXContents"]
    default: sources = ["AXChildren", "AXChildrenInNavigationOrder", "AXContents"]
    }
    for attr in sources {
      if d.expired { return nil }
      AXUIElementSetMessagingTimeout(e, d.readTimeout())
      var count: CFIndex = 0
      switch AXUIElementGetAttributeValueCount(e, attr as CFString, &count) {
      case .success: break
      case .cannotComplete, .invalidUIElement: return nil
      default: continue
      }
      if count == 0 {
        if attr == "AXChildren" { return ([], false) }
        continue
      }
      let cap = min(count, childReadCap)
      var items: [AXUIElement] = []
      var index = 0, short = false
      while index < cap {
        if d.expired { return index == 0 ? nil : (items, true) }
        AXUIElementSetMessagingTimeout(e, d.readTimeout())
        var page: CFArray?
        let err = AXUIElementCopyAttributeValues(e, attr as CFString, index, min(childPageSize, cap - index), &page)
        guard err == .success, let p = page else {
          if index == 0 { return nil }
          short = true
          break
        }
        let objs = p as [AnyObject]
        if objs.isEmpty { short = true; break }
        items += objs.compactMap { cfElement($0) }
        index += objs.count
      }
      AXUIElementSetMessagingTimeout(e, d.readTimeout())
      var again: CFIndex = 0
      let recount = AXUIElementGetAttributeValueCount(e, attr as CFString, &again)
      return (items, short || recount != .success || again != count)
    }
    return ([], false)
  }

  // MARK: AXSource

  func attrs(_ e: AXUIElement, deadline d: Deadline) -> NodeAttrs? { readAttrs(e, d, actor: false) }
  func children(_ e: AXUIElement, role: String, deadline d: Deadline) -> (items: [AXUIElement], changed: Bool)? {
    readChildren(e, role: role, d)
  }
  func key(_ e: AXUIElement) -> AnyHashable { AnyHashable(AXKey(e: e)) }

  // MARK: AXActor

  /// nil = go on. Records why the actor stopped so the reply can say `timeout` / `stopped`.
  private func gate() -> AXResult? {
    let expired = deadline.expired, aborted = abort?.requested ?? false
    if expired { hitExpired = true }
    if aborted { hitAbort = true }
    return mutationGate(expired: expired, aborted: aborted, mutated: mutated)
  }

  private func writeSlice(_ e: AXUIElement) {
    let t = deadline.writeTimeout()
    AXUIElementSetMessagingTimeout(e, t)
    AXUIElementSetMessagingTimeout(app, t)
  }

  func attrs(_ e: AXUIElement) -> NodeAttrs? {
    if deadline.expired { hitExpired = true }
    return readAttrs(e, deadline, actor: true)
  }

  func perform(_ e: AXUIElement, _ action: String) -> AXResult {
    if let g = gate() { return g }
    writeSlice(e)
    mutated = true
    return axResult(AXUIElementPerformAction(e, action as CFString))
  }

  func set(_ e: AXUIElement, _ attr: String, _ v: Any) -> AXResult {
    if let g = gate() { return g }
    guard let value = cfValue(v) else { return .notSupported }
    writeSlice(e)
    mutated = true
    return axResult(AXUIElementSetAttributeValue(e, attr as CFString, value))
  }

  private func cfValue(_ v: Any) -> CFTypeRef? {
    if let s = v as? String { return s as CFString }
    if let a = v as? [AXUIElement] { return a as CFArray }
    if let n = v as? NSNumber { return n }
    if let r = (v as? NSValue)?.rangeValue {
      var cr = CFRange(location: r.location, length: r.length)
      return AXValueCreate(.cfRange, &cr)
    }
    return nil
  }

  func children(_ e: AXUIElement) -> [AXUIElement] {
    let role = cfString(axRead(e, "AXRole", deadline).value) ?? ""
    return readChildren(e, role: role, deadline)?.items ?? []
  }

  func parent(_ e: AXUIElement) -> AXUIElement? { axElement(e, "AXParent", deadline) }

  func probe(_ e: AXUIElement) -> EffectProbe {
    var p = EffectProbe(focusedKey: nil, selected: nil, menuOpen: false, exists: true, value: nil, expanded: nil)
    let d = deadline
    if let f = axElement(app, "AXFocusedUIElement", d) {
      p.focusedKey = key(f)
      let role = cfString(axRead(f, "AXRole", d).value)
      let sub = cfString(axRead(f, "AXSubrole", d).value)
      if role != nil, role != "AXSecureTextField", sub != "AXSecureTextField", let v = axRead(f, "AXValue", d).value {
        p.value = valueText(v)?.0
      }
    }
    if !d.expired {
      AXUIElementSetMessagingTimeout(e, d.readTimeout())
      var out: CFArray?
      let err = AXUIElementCopyMultipleAttributeValues(e, probeNames, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
      if err == .invalidUIElement {
        p.exists = false
      } else if err == .success, let raw = out, CFArrayGetCount(raw) == 3 {
        let arr = raw as [AnyObject]
        let slot: (Int) -> CFTypeRef? = { i in
          let v = arr[i] as CFTypeRef
          return CFGetTypeID(v) == CFNullGetTypeID() || isAXErrorValue(v) ? nil : v
        }
        let r0 = arr[0] as CFTypeRef
        if isAXErrorValue(r0) {
          var code = AXError.success
          if AXValueGetValue(r0 as! AXValue, .axError, &code), code == .invalidUIElement { p.exists = false }
        }
        p.selected = cfBool(slot(1))
        p.expanded = cfBool(slot(2))
      }
    }
    p.menuOpen = p.exists && (hasMenuChild(e, d, tail: 8) || hasMenuChild(app, d, tail: 32))
    return p
  }

  /// An AXMenu among the last `tail` children (popup / context menus are appended).
  private func hasMenuChild(_ x: AXUIElement, _ d: Deadline, tail: Int) -> Bool {
    if d.expired { return false }
    AXUIElementSetMessagingTimeout(x, d.readTimeout())
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(x, "AXChildren" as CFString, &count) == .success, count > 0 else { return false }
    AXUIElementSetMessagingTimeout(x, d.readTimeout())
    var page: CFArray?
    let from = max(0, count - tail)
    guard AXUIElementCopyAttributeValues(x, "AXChildren" as CFString, from, count - from, &page) == .success, let p = page else { return false }
    return (p as [AnyObject]).contains { o in
      guard let k = cfElement(o) else { return false }
      return cfString(axRead(k, "AXRole", d).value) == "AXMenu"
    }
  }

  /// Waits in 5 ms slices; returns early (without sleeping on) once aborted or past the deadline.
  func sleep(ms: Int) {
    var left = ms
    while left > 0 {
      if abort?.requested == true { hitAbort = true; return }
      if deadline.expired { hitExpired = true; return }
      let s = min(5, left)
      usleep(useconds_t(s * 1000))
      left -= s
    }
  }

  private func focusIsOn(_ e: AXUIElement) -> Bool {
    guard let f = axElement(app, "AXFocusedUIElement", deadline) else { return false }
    return CFEqual(f, e)
  }

  /// AXFocused → focus seen (≤500 ms) → Unicode key events to the pid in 32-UTF-16 chunks, focus,
  /// secure input, session, abort and deadline re-checked before every chunk. Contract (AXActor):
  /// a not-delivered result only while no chunk went out.
  func typeViaKeys(_ e: AXUIElement, _ text: String) -> AXResult {
    if let g = gate() { return g }
    writeSlice(e)
    let fr = axResult(AXUIElementSetAttributeValue(e, "AXFocused" as CFString, kCFBooleanTrue))
    switch fr {
    case .notSupported, .invalidElement, .apiDisabled: return fr
    default: break
    }
    var waited = 0
    while !focusIsOn(e) {
      if waited >= 500 || deadline.expired || abort?.requested == true {
        if deadline.expired { hitExpired = true }
        if abort?.requested == true { hitAbort = true }
        return .notSupported  // nothing typed
      }
      usleep(10_000)
      waited += 10
    }
    let src = CGEventSource(stateID: .hidSystemState)
    var posted = 0
    var result = AXResult.success
    withASCIIInputSource {
      for seg in typeSegments(text, chunk: 32) {
        let expired = deadline.expired, aborted = abort?.requested ?? false
        if expired || aborted || secureInputOn() || inputBlockedBySession() {
          if expired { hitExpired = true }
          if aborted { hitAbort = true }
          result = posted > 0 ? .cannotComplete : .notSupported
          return
        }
        if !focusIsOn(e) {
          if posted > 0 { typedPartial = posted; result = .other(-1) } else { result = .notSupported }
          return
        }
        let code: UInt16
        var units: [UInt16] = []
        switch seg {
        case .text(let u): code = 0; units = u
        case .key(let k): code = k
        }
        let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
        down?.flags = []
        up?.flags = []
        if !units.isEmpty {
          units.withUnsafeBufferPointer { p in
            down?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress)
            up?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress)
          }
        }
        mutated = true
        down?.postToPid(pid)
        usleep(4000)
        up?.postToPid(pid)
        posted += seg.units.count
        usleep(4000)
      }
    }
    return result
  }

  func inWebArea(_ e: AXUIElement) -> Bool {
    var x = parent(e), n = 0
    while let p = x, n < 64 {
      let role = cfString(axRead(p, "AXRole", deadline).value)
      if role == "AXWebArea" { return true }
      if role == "AXApplication" { return false }
      x = parent(p)
      n += 1
    }
    return false
  }

  // MARK: geometry for the physical fallback

  func frame(_ e: AXUIElement, _ d: Deadline) -> CGRect? {
    guard let p = cfPoint(axRead(e, "AXPosition", d).value), let s = cfSize(axRead(e, "AXSize", d).value) else { return nil }
    return CGRect(origin: p, size: s)
  }

  /// Frames of the clipping ancestors (AXWindow / AXScrollArea / AXWebArea / AXSheet / AXPopover) up to the app.
  func clipFrames(_ e: AXUIElement, _ d: Deadline) -> [CGRect] {
    var out: [CGRect] = [], x = axElement(e, "AXParent", d), n = 0
    while let p = x, n < 64 {
      let role = cfString(axRead(p, "AXRole", d).value) ?? ""
      if role == "AXApplication" { break }
      if ["AXWindow", "AXScrollArea", "AXWebArea", "AXSheet", "AXPopover"].contains(role), let f = frame(p, d) { out.append(f) }
      x = axElement(p, "AXParent", d)
      n += 1
    }
    return out
  }

  /// `hit` is the target or one of its descendants.
  func reaches(_ hit: AXUIElement, _ target: AXUIElement, _ d: Deadline) -> Bool {
    var x: AXUIElement? = hit, n = 0
    while let c = x, n < 64 {
      if CFEqual(c, target) { return true }
      x = axElement(c, "AXParent", d)
      n += 1
    }
    return false
  }
}

// MARK: - Electron / Chromium accessibility (spec §6.7)

/// Contents/Frameworks of the app bundle names an Electron or CEF framework.
func isChromiumApp(_ pid: Int32) -> Bool {
  guard let url = onMain({ runningApp(pid)?.bundleURL }) else { return false }
  let dir = url.appendingPathComponent("Contents/Frameworks").path
  return hasChromiumFramework((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
}

/// Which pids we switched accessibility on for (once per process instance), and which of them got
/// AXEnhancedUserInterface from us (reverted by `a11yRevert` and on exit; AXManualAccessibility is left on).
final class RendererA11y {
  static let shared = RendererA11y()
  private let lock = NSLock()
  private var attempted: [Int32: String] = [:]
  private var enhanced: [Int32: Instance] = [:]

  func wasAttempted(_ i: Instance) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return attempted[i.pid] == i.start
  }

  /// Manual first; Enhanced only when allowed and Manual didn't take. Success is judged by read-back
  /// (Chromium's setter answers "not implemented" and still applies); a Manual write that returned success
  /// counts even when it reads back false (Electron's getter compares for complete mode only).
  func enable(_ i: Instance, bundle: String?, allowEnhanced: Bool, _ d: Deadline) -> (on: Bool, enhanced: Bool) {
    lock.lock()
    attempted[i.pid] = i.start
    lock.unlock()
    guard !isOwnBundle(bundle), !d.expired else { return (false, false) }
    let app = AXUIElementCreateApplication(i.pid)
    AXUIElementSetMessagingTimeout(app, d.writeTimeout())
    let w = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    if w == .success || cfBool(axRead(app, "AXManualAccessibility", d).value) == true { return (true, false) }
    guard allowEnhanced else { return (false, false) }
    if cfBool(axRead(app, "AXEnhancedUserInterface", d).value) == true { return (true, false) }  // already on: not ours
    if d.expired { return (false, false) }
    AXUIElementSetMessagingTimeout(app, d.writeTimeout())
    _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    guard cfBool(axRead(app, "AXEnhancedUserInterface", d).value) == true else { return (false, false) }
    lock.lock()
    enhanced[i.pid] = i
    lock.unlock()
    return (true, true)
  }

  /// Writes AXEnhancedUserInterface=false back for every live instance we switched it on for.
  func revertAll() -> [Int32] {
    lock.lock()
    let list = enhanced
    enhanced = [:]
    lock.unlock()
    var out: [Int32] = []
    for (pid, inst) in list.sorted(by: { $0.key < $1.key }) where processInstance(pid) == inst {
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, 0.25)
      _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
      out.append(pid)
    }
    return out
  }
}
