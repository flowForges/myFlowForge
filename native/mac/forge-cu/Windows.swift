// forge-cu · windows, front app, activate, running apps.
import AppKit
import ApplicationServices

/// Runs `f` on the main thread (AppKit / TIS state lives there; the main thread runs RunLoop.main, V7a).
func onMain<T>(_ f: () -> T) -> T {
  Thread.isMainThread ? f() : DispatchQueue.main.sync(execute: f)
}

func onScreenWindows() -> [WinInfo] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return winInfos(from: list)
}

func runningApp(_ pid: Int32) -> NSRunningApplication? { NSRunningApplication(processIdentifier: pid) }
func bundleOf(_ pid: Int32) -> String? { runningApp(pid)?.bundleIdentifier }

func mainDisplayBounds() -> CGRect { CGDisplayBounds(CGMainDisplayID()) }

/// Height of the menu bar strip on the main display (notched screens are taller than 24).
func menuBarHeight() -> CGFloat {
  onMain {
    if let s = NSScreen.screens.first {
      let h = s.frame.maxY - s.visibleFrame.maxY
      if h > 0 { return h }
    }
    return NSStatusBar.system.thickness
  }
}

/// Front-to-back first visible window containing `p` (global points), with V7 fields.
func hitTest(_ p: CGPoint, wins: [WinInfo] = onScreenWindows()) -> Hit? {
  guard let w = hitWindow(wins, at: p) else { return nil }
  let app = runningApp(w.pid)
  return Hit(pid: w.pid, bundleId: app?.bundleIdentifier, name: w.ownerName ?? app?.localizedName, layer: w.layer,
             windowId: w.windowId, inMenuBar: inMenuBar(p, mainBounds: mainDisplayBounds(), menuBarHeight: menuBarHeight()))
}

private let axSystem = AXUIElementCreateSystemWide()

/// A hung app must not stall a post: AX calls give up after 0.3 s (then the guard fails closed).
func configureAX() { AXUIElementSetMessagingTimeout(axSystem, 0.3) }

/// pid owning the AX element at a global point (what a click there would actually reach).
func axPidAt(_ p: CGPoint) -> Int32? {
  var el: AXUIElement?
  guard AXUIElementCopyElementAtPosition(axSystem, Float(p.x), Float(p.y), &el) == .success, let e = el else { return nil }
  var pid: pid_t = 0
  return AXUIElementGetPid(e, &pid) == .success ? pid : nil
}

/// Every on-screen window containing `p`, front to back (alpha 0 included).
func windowsUnder(_ p: CGPoint, _ wins: [WinInfo]) -> [WinInfo] { wins.filter { $0.bounds.contains(p) } }

/// pid of the system-wide AX element's focused application (nil when AX is unavailable / untrusted).
func axFocusedPid() -> Int32? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(axSystem, kAXFocusedApplicationAttribute as CFString, &v) == .success, let el = v,
        CFGetTypeID(el) == AXUIElementGetTypeID() else { return nil }
  var pid: pid_t = 0
  guard AXUIElementGetPid(el as! AXUIElement, &pid) == .success else { return nil }
  return pid
}

func workspaceFront() -> NSRunningApplication? { onMain { NSWorkspace.shared.frontmostApplication } }

/// `front` op: AX focus and NSWorkspace must agree (V7a).
func frontReply() -> [String: Any] {
  let ws = workspaceFront()
  if let ax = axFocusedPid(), let w = ws, ax != w.processIdentifier { return errorReply(id: nil, code: "target_changed") }
  guard let w = ws else { return ["front": NSNull()] }
  var f: [String: Any] = ["pid": Int(w.processIdentifier), "layer": 0]
  if let b = w.bundleIdentifier { f["bundleId"] = b }
  if let n = w.localizedName { f["name"] = n }
  return ["front": f]
}

func activateReply(_ body: [String: Any]) -> [String: Any] {
  guard let pid = int32(body["pid"]) else { return errorReply(id: nil, code: "invalid_args") }
  let ok: Bool = onMain {
    guard let app = runningApp(pid) else { return false }
    return app.activate(options: [.activateIgnoringOtherApps])
  }
  return ok ? [:] : errorReply(id: nil, code: "target_changed")
}

func appsReply() -> [String: Any] {
  let apps: [[String: Any]] = onMain {
    var seen = Set<String>()
    return NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .compactMap { a -> [String: Any]? in
        guard let b = a.bundleIdentifier, seen.insert(b).inserted else { return nil }
        return ["bundleId": b, "name": a.localizedName ?? b]
      }
      .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
  }
  return ["apps": apps]
}
