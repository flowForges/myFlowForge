// forge-cu · launch / focusWindow / windows / appKey (spec §6.5, §6.6). No SkyLight front-process SPI, no
// private activation: NSRunningApplication.activate, then LaunchServices, then AX raise + a double-read check.
import Foundation
import AppKit
import ApplicationServices

// MARK: - shared waits

/// Sleeps `ms` in 5 ms slices; false = aborted.
func abortableSleep(_ ms: Int, _ abort: AbortState?) -> Bool {
  var left = ms
  while left > 0 {
    if abort?.requested == true { return false }
    let s = min(5, left)
    usleep(useconds_t(s * 1000))
    left -= s
  }
  return abort?.requested != true
}

/// Polls `cond` every `stepMs` for at most `ms` and never past `d`; true as soon as it holds.
func pollUntil(ms: Int, stepMs: Int = 10, _ abort: AbortState?, _ d: Deadline, _ cond: () -> Bool) -> Bool {
  var t = 0
  while true {
    if cond() { return true }
    if t >= ms || d.expired || !abortableSleep(stepMs, abort) { return false }
    t += stepMs
  }
}

/// myFlowForge's own processes: this helper and its owner (added in main.swift before any request).
var ownPids: Set<Int32> = [getpid()]

/// Own pid / own bundle / guard-denied: refused whether or not the caller sent a guard.
func ownOrDenied(_ body: [String: Any], pid: Int32) -> Bool {
  ownTarget(parseGuard(body["guard"]), pid: pid, bundle: bundleOf(pid), ownPids: ownPids)
}

private func axFrontmost(_ pid: Int32, _ d: Deadline) -> Bool {
  cfBool(axRead(AXUIElementCreateApplication(pid), "AXFrontmost", d).value) == true
}

/// Opens `url` with LaunchServices; the completion (which may arrive late, harmlessly) is awaited ≤ `ms`.
private func openApp(_ url: URL, activate: Bool, ms: Int) -> (app: NSRunningApplication?, error: Error?, timedOut: Bool) {
  let cfg = NSWorkspace.OpenConfiguration()
  cfg.activates = activate
  cfg.promptsUserIfNeeded = false
  cfg.allowsRunningApplicationSubstitution = false
  cfg.addsToRecentItems = false
  final class Box: @unchecked Sendable { var app: NSRunningApplication?; var error: Error? }
  let box = Box()
  let sem = DispatchSemaphore(value: 0)
  NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, err in
    box.app = app
    box.error = err
    sem.signal()
  }
  let timedOut = sem.wait(timeout: .now() + .milliseconds(max(0, ms))) == .timedOut
  return (box.app, box.error, timedOut)
}

/// Two-step activation (spec §6.5): already AXFrontmost → done; activate(options: []) and poll ≤500 ms;
/// else LaunchServices activation of this very bundle (activates a running instance, never relaunches
/// one that is still running) and poll ≤500 ms.
func bringToFront(_ app: NSRunningApplication, _ abort: AbortState?, _ d: Deadline) -> Bool {
  let pid = app.processIdentifier
  if axFrontmost(pid, d) { return true }
  if postGate(expired: d.expired, aborted: abort?.requested ?? false) != nil { return false }
  _ = onMain { app.activate(options: []) }
  if pollUntil(ms: 500, abort, d, { axFrontmost(pid, d) }) { return true }
  guard postGate(expired: d.expired, aborted: abort?.requested ?? false) == nil,
        !onMain({ app.isTerminated }), let url = onMain({ app.bundleURL }) else { return false }
  _ = openApp(url, activate: true, ms: min(250, Int(d.remaining * 1000)))
  return pollUntil(ms: 500, abort, d, { axFrontmost(pid, d) })
}

/// spec §6.5 focusWindow, never past the request deadline `d`. nil = focused; else the error code.
func focusWindowImpl(pid: Int32, windowNumber: Int?, _ abort: AbortState?, _ d: Deadline) -> String? {
  guard let app = runningApp(pid), !onMain({ app.isTerminated }) else { return "not_found" }
  func late() -> String? { postGate(expired: d.expired, aborted: abort?.requested ?? false) }
  guard bringToFront(app, abort, d) else { return late() ?? "focus_failed" }
  let axApp = AXUIElementCreateApplication(pid)
  guard let win = pickWindow(axApp, number: windowNumber, d) else { return late() ?? (windowNumber == nil ? nil : "not_found") }
  let isMain = { cfBool(axRead(win, "AXMain", d).value) == true }
  if !isMain() {
    if let c = late() { return c }
    AXUIElementSetMessagingTimeout(win, d.writeTimeout())
    let raised = AXUIElementPerformAction(win, "AXRaise" as CFString)
    if axResult(raised) == .notSupported {
      AXUIElementSetMessagingTimeout(win, d.writeTimeout())
      _ = AXUIElementSetAttributeValue(win, "AXMain" as CFString, kCFBooleanTrue)
    }
    _ = pollUntil(ms: 500, abort, d, isMain)
  }
  // system-wide AXFocusedApplication → AXFocusedWindow: two reads in a row, 50 ms apart, within 750 ms
  var reads: [Bool] = []
  for _ in 0..<15 {
    if let c = late() { return c }
    let f = axFocusedAppWindow(d)
    reads.append(f?.pid == pid && f?.window.map { CFEqual($0, win) } == true)
    if consecutiveHits(reads, need: 2) { return nil }
    _ = abortableSleep(50, abort)
  }
  return late() ?? "focus_failed"
}

func focusWindowOp(_ b: [String: Any], _ abort: AbortState) -> [String: Any] {
  if abort.requested { return errorReply(id: nil, code: "stopped") }
  guard let pid = int32(b["pid"]) else { return errorReply(id: nil, code: "invalid_args") }
  guard axTrusted() else { return errorReply(id: nil, code: "no_permission") }
  if ownOrDenied(b, pid: pid) { return errorReply(id: nil, code: "own_window") }
  let d = Deadline(ms: requestMs(b["deadlineMs"], max: 10000))
  if let c = focusWindowImpl(pid: pid, windowNumber: (b["windowNumber"] as? NSNumber)?.intValue, abort, d) {
    return errorReply(id: nil, code: c)
  }
  return [:]
}

// MARK: - launch

func launchOp(_ b: [String: Any], _ abort: AbortState) -> [String: Any] {
  if abort.requested { return errorReply(id: nil, code: "stopped") }
  let activate = b["activate"] as? Bool ?? false
  let d = Deadline(ms: requestMs(b["deadlineMs"], max: 30000))
  var url: URL?
  var bundleId = b["bundleId"] as? String
  if let bid = bundleId {
    guard validBundleId(bid) else { return errorReply(id: nil, code: "invalid_args") }
    url = onMain { NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid) }
  } else if let name = b["name"] as? String {
    let dirs = ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"]
    url = findAppBundle(name: name, dirs: dirs, exists: { FileManager.default.fileExists(atPath: $0) }).map { URL(fileURLWithPath: $0) }
    bundleId = url.flatMap { Bundle(url: $0)?.bundleIdentifier }
  } else {
    return errorReply(id: nil, code: "invalid_args")
  }
  guard let appURL = url, let bid = bundleId else { return errorReply(id: nil, code: "not_found") }
  if isOwnBundle(bid) || matchesPrefix(bid, parseGuard(b["guard"]).denyBundlePrefixes) { return errorReply(id: nil, code: "own_window") }

  abort.beginPost()
  defer { abort.endPost() }
  let running = onMain { NSRunningApplication.runningApplications(withBundleIdentifier: bid).filter { !$0.isTerminated } }
  if running.count > 1 {
    let cands = running.compactMap { processInstance($0.processIdentifier).map(instanceJSON) }
    return errorReply(id: nil, code: "ambiguous_target", extra: ["candidates": cands])
  }
  let app: NSRunningApplication
  let attached = running.count == 1
  if attached {
    app = running[0]
    if ownPids.contains(app.processIdentifier) { return errorReply(id: nil, code: "own_window") }
    if activate { _ = bringToFront(app, abort, d) }
  } else {
    let r = openApp(appURL, activate: activate, ms: Int(d.remaining * 1000))
    if r.timedOut { return errorReply(id: nil, code: "timeout", extra: ["delivery": Delivery.uncertain.rawValue]) }
    guard let a = r.app else { return errorReply(id: nil, code: "not_found", message: r.error.map { "\($0.localizedDescription)" }) }
    app = a
  }
  let pid = app.processIdentifier
  guard let inst = processInstance(pid) else { return errorReply(id: nil, code: "app_unresponsive") }

  // activate:false → isFinishedLaunching + 1.5 s grace (no window is fine); activate:true → a window of
  // this instance (or the deadline). An instance we only attached to doesn't wait unless activated.
  var windows = appWindowList(pid, Deadline(ms: 500))
  var finishedAt: Double?
  let graceS = 1.5
  while windows.isEmpty && !(attached && !activate) {
    if abort.requested { return errorReply(id: nil, code: "stopped") }
    if onMain({ app.isTerminated }) || processInstance(pid) != inst { return errorReply(id: nil, code: "app_unresponsive") }
    let now = ProcessInfo.processInfo.systemUptime
    if finishedAt == nil && onMain({ app.isFinishedLaunching }) { finishedAt = now }
    if let f = finishedAt, (!activate || attached), now - f >= graceS { break }
    if d.expired { break }
    _ = abortableSleep(50, abort)
    windows = appWindowList(pid, Deadline(ms: 250))
  }
  let name = onMain { app.localizedName } ?? bid
  return ["instance": instanceJSON(inst), "bundleId": bid, "name": name, "windows": windows]
}

// MARK: - windows

private func cgWindows(pid: Int32?) -> [[String: Any]] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.filter { w in
    (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 && (pid == nil || int32(w[kCGWindowOwnerPID as String]) == pid)
  }
}

func windowsOp(_ b: [String: Any]) -> [String: Any] {
  let d = Deadline(ms: requestMs(b["deadlineMs"], max: 10000))
  var pids: [Int32] = []
  if let p = int32(b["pid"]) {
    pids = [p]
  } else {
    var seen = Set<Int32>()
    for w in cgWindows(pid: nil) {
      guard let p = int32(w[kCGWindowOwnerPID as String]), seen.insert(p).inserted,
            onMain({ runningApp(p)?.activationPolicy == .regular }) else { continue }
      pids.append(p)
    }
  }
  var out: [[String: Any]] = []
  for pid in pids {
    let app = runningApp(pid)
    let bid = onMain { app?.bundleIdentifier }, name = onMain { app?.localizedName }
    var list = axTrusted() && !d.expired ? appWindowList(pid, Deadline(ms: min(500, Int(d.remaining * 1000)))) : []
    if list.isEmpty {
      list = cgWindows(pid: pid).compactMap { w in
        guard let n = (w[kCGWindowNumber as String] as? NSNumber)?.intValue else { return nil }
        var o: [String: Any] = ["number": n]
        if let t = w[kCGWindowName as String] as? String, !t.isEmpty { o["title"] = t }
        return o
      }
    }
    for var w in list {
      w["pid"] = Int(pid)
      if let bid { w["bundleId"] = bid }
      if let name { w["name"] = name }
      out.append(w)
    }
  }
  return ["windows": out]
}

// MARK: - appKey

private let menuSearchNodes = 2048, menuSearchDepth = 8
private let menuAttrs = ["AXRole", "AXMenuItemCmdChar", "AXMenuItemCmdModifiers", "AXEnabled"] as CFArray

/// Breadth-first over the app's menu bar (≤2048 nodes, depth 8) for an enabled item with this shortcut.
private func findMenuItem(_ app: AXUIElement, mods: [String], key: String, _ d: Deadline) -> AXUIElement? {
  guard let bar = axElement(app, "AXMenuBar", d) else { return nil }
  var queue: [(AXUIElement, Int)] = [(bar, 0)], head = 0
  var seen = Set<AXKey>()
  while head < queue.count, head < menuSearchNodes, !d.expired {
    let (x, depth) = queue[head]
    head += 1
    guard seen.insert(AXKey(e: x)).inserted else { continue }
    AXUIElementSetMessagingTimeout(x, d.readTimeout())
    var out: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(x, menuAttrs, AXCopyMultipleAttributeOptions(rawValue: 0), &out) == .success,
          let raw = out, CFArrayGetCount(raw) == 4 else { continue }
    let arr = (raw as [AnyObject]).map { $0 as CFTypeRef }
    if cfString(arr[0]) == "AXMenuItem",
       menuMatch(cmdChar: cfString(arr[1]), cmdModifiers: cfInt(arr[2]), enabled: cfBool(arr[3]), mods: Set(mods), key: key) {
      return x
    }
    if depth < menuSearchDepth { queue += axElements(x, "AXChildren", d).map { ($0, depth + 1) } }
  }
  return nil
}

private func pressDelivery(_ r: AXResult) -> Delivery {
  switch r {
  case .success: return .deliveredUnverified
  case .notSupported, .invalidElement, .apiDisabled: return .notDelivered
  case .cannotComplete, .other: return .uncertain
  }
}

/// Keycode + whether the layout needs shift for it: letters through the current layout, the rest ANSI.
private func charKeycode(_ ch: Character) -> (code: UInt16, shift: Bool)? {
  if ch.isLetter, let k = layoutKeycode(ch) { return k }
  return ansiKeycode(ch)
}

func appKeyOp(_ b: [String: Any], _ abort: AbortState) -> [String: Any] {
  if abort.requested { return errorReply(id: nil, code: "stopped") }
  guard let pid = int32(b["pid"]), let mods = canonicalMods(b["mods"] as? [String] ?? []),
        let k = b["key"] as? [String: Any] else { return errorReply(id: nil, code: "invalid_args") }
  let named = (k["named"] as? String)?.lowercased()
  let char = k["char"] as? String
  guard let keyName = named ?? char, !keyName.isEmpty, named == nil || namedKeycode(keyName) != nil,
        char == nil || char!.count == 1 else { return errorReply(id: nil, code: "invalid_args") }
  if isBlockedCombo(mods: Set(mods), key: keyName) { return errorReply(id: nil, code: "blocked_combo") }
  guard axTrusted() else { return errorReply(id: nil, code: "no_permission") }
  guard processInstance(pid) != nil, runningApp(pid) != nil else { return errorReply(id: nil, code: "not_found") }
  if ownOrDenied(b, pid: pid) { return errorReply(id: nil, code: "own_window") }
  let repeatN = clampInt(num(b["repeat"]), 1, 100)
  let d = Deadline(ms: requestMs(b["deadlineMs"], max: 10000))
  let app = AXUIElementCreateApplication(pid)
  abort.beginPost()
  defer { abort.endPost() }

  /// Runs `once` up to repeatN times. nil = the first press provably did nothing (try the next path);
  /// a later failure after a delivery never reads as not delivered.
  func repeated(_ via: String, _ once: () -> Delivery) -> [String: Any]? {
    var delivered = false
    for i in 0..<repeatN {
      if let c = postGate(expired: d.expired, aborted: abort.requested) {
        return errorReply(id: nil, code: c, extra: ["via": via, "delivery": (delivered ? Delivery.deliveredUnverified : .notDelivered).rawValue])
      }
      let r = once()
      if r == .notDelivered {
        if i == 0 { return nil }
        break
      }
      if r == .uncertain { return ["via": via, "delivery": Delivery.uncertain.rawValue] }
      delivered = true
      if i < repeatN - 1 { _ = abortableSleep(30, abort) }
    }
    return ["via": via, "delivery": Delivery.deliveredUnverified.rawValue]
  }

  // 1. a menu item that answers the combo (never for plain keys)
  if !mods.isEmpty, let item = findMenuItem(app, mods: mods, key: keyName, d) {
    if let r = repeated("menu", {
      AXUIElementSetMessagingTimeout(item, d.writeTimeout())
      return pressDelivery(axResult(AXUIElementPerformAction(item, "AXPress" as CFString)))
    }) { return r }
  }
  // 2. return / escape → AXConfirm / AXCancel on the focused element
  if mods.isEmpty, keyName == "return" || keyName == "escape", let f = axElement(app, "AXFocusedUIElement", d) {
    let action = keyName == "return" ? "AXConfirm" : "AXCancel"
    var names: CFArray?
    AXUIElementSetMessagingTimeout(f, d.readTimeout())
    if AXUIElementCopyActionNames(f, &names) == .success, (names as? [String] ?? []).contains(action) {
      if let r = repeated(keyName == "return" ? "confirm" : "cancel", {
        AXUIElementSetMessagingTimeout(f, d.writeTimeout())
        return pressDelivery(axResult(AXUIElementPerformAction(f, action as CFString)))
      }) { return r }
    }
  }
  // 3. key events to the pid (no focus change)
  if secureInputOn() { return errorReply(id: nil, code: "secure_input", extra: ["delivery": Delivery.notDelivered.rawValue]) }
  if inputBlockedBySession() { return errorReply(id: nil, code: "target_changed", extra: ["delivery": Delivery.notDelivered.rawValue]) }
  var code: UInt16
  var flagsMods = mods
  if let n = named {
    code = namedKeycode(n)!
  } else {
    guard let ch = char?.first, let kc = charKeycode(ch) else { return errorReply(id: nil, code: "invalid_args") }
    code = kc.code
    if kc.shift && !flagsMods.contains("shift") { flagsMods.append("shift") }
  }
  let flags = modifierFlags(flagsMods)
  let src = CGEventSource(stateID: .hidSystemState)
  var sent = 0
  for i in 0..<repeatN {
    if let c = postGate(expired: d.expired, aborted: abort.requested) {
      return errorReply(id: nil, code: c, extra: ["via": "pid", "delivery": (sent > 0 ? Delivery.deliveredUnverified : .notDelivered).rawValue])
    }
    let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    down?.postToPid(pid)
    usleep(4000)
    up?.postToPid(pid)
    sent += 1
    if i < repeatN - 1 { _ = abortableSleep(30, abort) }
  }
  return ["via": "pid", "delivery": Delivery.deliveredUnverified.rawValue]
}
