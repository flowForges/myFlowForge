// forge-cu · snapshot / resolve / act / waitFor / a11yRevert (spec §6.2–§6.4, §6.7–§6.9). The pure logic
// (walker, ref table, strict resolve, chains) is AXCore.swift; this file binds it to LiveAX and the wire.
import Foundation
import AppKit
import ApplicationServices

/// Refs of the last 8 snapshots. Touched only from the request thread.
let refTable = RefTable<AXUIElement>()

private func ms(_ d: Deadline) -> Int { Int(d.remaining * 1000) }

/// A deadline with `extraS` more than what is left of `d` (activation time doesn't eat the walk).
private func extended(_ d: Deadline, by extraS: Double) -> Deadline { Deadline(ms: ms(d) + Int(min(3, max(0, extraS)) * 1000)) }

private func appInfo(_ pid: Int32) -> (bundleId: String?, name: String?) {
  onMain { (runningApp(pid)?.bundleIdentifier, runningApp(pid)?.localizedName) }
}

/// `{bundleId}` → the one running instance (0 → not_found, ≥2 → ambiguous_target); `{pid}` → that process.
private func targetPid(_ v: Any?) -> Result<Int32, ErrorReply> {
  guard let a = v as? [String: Any] else { return .failure(ErrorReply("invalid_args")) }
  if let pid = int32(a["pid"]) {
    return processInstance(pid) != nil && runningApp(pid) != nil ? .success(pid) : .failure(ErrorReply("not_found"))
  }
  guard let bid = a["bundleId"] as? String, validBundleId(bid) else { return .failure(ErrorReply("invalid_args")) }
  let running = onMain { NSRunningApplication.runningApplications(withBundleIdentifier: bid).filter { !$0.isTerminated } }
  if running.count > 1 {
    let c = running.compactMap { processInstance($0.processIdentifier).map(instanceJSON) }
    return .failure(ErrorReply("ambiguous_target", extra: ["candidates": c]))
  }
  guard let r = running.first else { return .failure(ErrorReply("not_found")) }
  return .success(r.processIdentifier)
}

struct ErrorReply: Error {
  let code: String
  var extra: [String: Any] = [:]
  init(_ code: String, extra: [String: Any] = [:]) { self.code = code; self.extra = extra }
  var reply: [String: Any] { errorReply(id: nil, code: code, extra: extra) }
}

// MARK: - resolve

private struct Resolved {
  let rec: RefRecord<AXUIElement>
  let element: AXUIElement
  let live: Instance
}

/// spec §6.3: table → instance → fast path → (unique at capture only) census of the owning window.
private func resolveLive(_ ref: String, _ d: Deadline) -> Result<Resolved, ErrorReply> {
  guard RefTable<AXUIElement>.parse(ref) != nil else { return .failure(ErrorReply("invalid_args")) }
  guard let rec = refTable.get(ref) else { return .failure(ErrorReply("stale_ref")) }
  let liveInst = processInstance(rec.instance.pid)
  guard let live = liveInst, live == rec.instance else { return .failure(ErrorReply("stale_ref")) }
  let ax = LiveAX(pid: live.pid, deadline: d)
  var out = resolveRef(ax, rec: rec, liveInstance: liveInst, windowRoot: nil, deadline: d)
  if case .stale = out, rec.fingerprint.uniqueAtCapture, let n = rec.window, let win = pickWindow(ax.app, number: n, d) {
    out = resolveRef(ax, rec: rec, liveInstance: liveInst, windowRoot: win, deadline: d)
  }
  switch out {
  case .ok(let e):
    if !CFEqual(e, rec.element) { refTable.rebind(ref, to: e) }
    return .success(Resolved(rec: rec, element: e, live: live))
  case .stale: return .failure(ErrorReply("stale_ref"))
  case .ambiguous: return .failure(ErrorReply("ambiguous_target"))
  case .timeout: return .failure(ErrorReply("timeout"))
  }
}

func resolveOp(_ b: [String: Any]) -> [String: Any] {
  guard let ref = b["ref"] as? String else { return errorReply(id: nil, code: "invalid_args") }
  guard axTrusted() else { return errorReply(id: nil, code: "no_permission") }
  let d = Deadline(ms: requestMs(b["deadlineMs"], max: 15000))
  switch resolveLive(ref, d) {
  case .failure(let e): return e.reply
  case .success(let r):
    let info = appInfo(r.live.pid)
    var o: [String: Any] = ["instance": instanceJSON(r.live), "role": r.rec.fingerprint.role]
    if let v = info.bundleId { o["bundleId"] = v }
    if let v = info.name { o["appName"] = v }
    if let v = r.rec.fingerprint.name { o["name"] = v }
    if let f = LiveAX(pid: r.live.pid, deadline: d).frame(r.element, Deadline(ms: 250)) { o["bounds"] = rectJSON(f) }
    return o
  }
}

// MARK: - snapshot

func snapshotOp(_ b: [String: Any], _ abort: AbortState) -> [String: Any] {
  if abort.requested { return errorReply(id: nil, code: "stopped") }
  guard axTrusted() else { return errorReply(id: nil, code: "no_permission") }
  var d = Deadline(ms: requestMs(b["deadlineMs"], max: 15000))
  let skeleton = (b["mode"] as? String ?? "skeleton") != "full"
  let depth = (b["maxDepth"] as? NSNumber)?.intValue ?? (skeleton ? Budget.skeletonDepth : Budget.fullDepth)
  let interactiveOnly = b["interactiveOnly"] as? Bool ?? true

  // the root: a ref to drill into, else a window of the app
  var pid: Int32
  var root: AXUIElement
  var window: AXUIElement?
  var drill = false
  if let ref = b["root"] as? String {
    if let p = refTable.get(ref)?.instance.pid, ownOrDenied(b, pid: p) { return errorReply(id: nil, code: "own_window") }
    switch resolveLive(ref, d) {
    case .failure(let e): return e.reply
    case .success(let r):
      pid = r.live.pid; root = r.element; drill = true
      let ax = LiveAX(pid: pid, deadline: d)
      window = axElement(root, "AXWindow", d) ?? r.rec.window.flatMap { pickWindow(ax.app, number: $0, d) }
    }
  } else {
    switch targetPid(b["app"]) {
    case .failure(let e): return e.reply
    case .success(let p): pid = p
    }
    if ownOrDenied(b, pid: pid) { return errorReply(id: nil, code: "own_window") }
    guard let w = pickWindow(AXUIElementCreateApplication(pid), number: (b["window"] as? NSNumber)?.intValue, d) else {
      return errorReply(id: nil, code: "not_found", message: "no window")
    }
    root = w; window = w
  }
  guard let inst = processInstance(pid) else { return errorReply(id: nil, code: "stale_ref") }
  let info = appInfo(pid)
  if ownOrDenied(b, pid: pid) { return errorReply(id: nil, code: "own_window") }
  let ax = LiveAX(pid: pid, deadline: d, abort: abort)
  abort.beginPost()
  defer { abort.endPost() }

  // Electron / Chromium: switch accessibility on before the first walk of a known bundle (spec §6.7)
  let renderer = RendererA11y.shared
  var switchedOn = false
  if !renderer.wasAttempted(inst),
     rendererPreOpen(chromium: isChromiumApp(pid), attempted: false, own: isOwnBundle(info.bundleId)) {
    let t0 = ProcessInfo.processInfo.systemUptime
    let r = renderer.enable(inst, bundle: info.bundleId, allowEnhanced: true, d)
    if r.enhanced && !abortableSleep(2000, abort) { return errorReply(id: nil, code: "stopped") }  // Chromium's 2 s debounce
    switchedOn = r.on
    d = extended(d, by: ProcessInfo.processInfo.systemUptime - t0)
  }
  let budget = Budget(maxDepth: depth)
  func walkNow() -> WalkResult<AXUIElement> {
    walkDetailed(ax, root: root, budget: budget, deadline: d, interactiveOnly: interactiveOnly, skeleton: skeleton)
  }
  func sawWebArea(_ w: WalkResult<AXUIElement>) -> Bool { w.visited.contains { $0.0.role == "webarea" } }
  var w = walkNow()
  if !switchedOn, rendererFallback(attempted: renderer.wasAttempted(inst), own: isOwnBundle(info.bundleId),
                                   windowRooted: !drill, sawWebArea: sawWebArea(w), complete: w.complete) {
    // unknown bundle: AXManualAccessibility only (no side effects); AXEnhancedUserInterface is left to known bundles
    let t0 = ProcessInfo.processInfo.systemUptime
    switchedOn = renderer.enable(inst, bundle: info.bundleId, allowEnhanced: false, d).on
    d = extended(d, by: ProcessInfo.processInfo.systemUptime - t0)
  }
  if switchedOn && !drill && !sawWebArea(w) {
    for step in rendererBackoffMs {
      if ms(d) <= step || !abortableSleep(step, abort) { break }
      let again = walkNow()
      w = again
      if sawWebArea(again) || d.expired { break }
    }
  }
  if abort.requested { return errorReply(id: nil, code: "stopped") }

  // uniqueAtCapture needs a complete census of the whole window (identity fields matched exactly once)
  var census: [Fingerprint]? = nil
  if !drill && w.exhaustive {
    census = w.census
  } else if let win = window, !d.expired {
    let cd = Deadline(ms: min(ms(d), 2000))
    let c = walkDetailed(ax, root: win, budget: Budget(maxDepth: 50), deadline: cd, interactiveOnly: false, skeleton: false)
    if c.exhaustive { census = c.census }
  }
  let fps = markUnique(w.nodes.map { $0.2 }, census: census)
  let nodes = zip(w.nodes, fps).map { ($0.0.0, $0.0.1, $0.1) }
  let winNumber = window.flatMap(axWindowNumber)
  let snapId = refTable.put(instance: inst, window: winNumber, nodes: nodes)
  let wire = w.nodes.map { n, e, _ in
    snapNodeJSON(n, ref: e != nil ? n.ref.map { RefTable<AXUIElement>.qualify(snapId: snapId, local: $0) } : nil)
  }
  var win: [String: Any] = [:]
  if let n = winNumber { win["number"] = n }
  if let wv = window, let t = cfString(axRead(wv, "AXTitle", Deadline(ms: 250)).value), !t.isEmpty { win["title"] = t }
  var app: [String: Any] = [:]
  if let v = info.bundleId { app["bundleId"] = v }
  if let v = info.name { app["name"] = v }
  return ["snapId": snapId, "instance": instanceJSON(inst), "app": app, "window": win, "complete": w.complete, "nodes": wire]
}

// MARK: - act

private struct ActGuard {
  var denyPids: [Int32]
  var denyBundlePrefixes: [String]
  var expectInstance: Instance?
}

private func parseActGuard(_ v: Any?) -> ActGuard {
  let g = parseGuard(v)
  return ActGuard(denyPids: g.denyPids, denyBundlePrefixes: g.denyBundlePrefixes,
                  expectInstance: parseInstance((v as? [String: Any])?["expectInstance"]))
}

private func stringArg(_ v: Any?) -> String? {
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return CFGetTypeID(n) == CFBooleanGetTypeID() ? (n.boolValue ? "true" : "false") : n.stringValue }
  return nil
}

/// The `after` wire fields from one final probe (never a secure field's value).
private func afterFields(_ pid: Int32, _ e: AXUIElement) -> [String: Any] {
  let ax = LiveAX(pid: pid, deadline: Deadline(ms: 300))
  let p = ax.probe(e)
  var o: [String: Any] = ["focused": p.focusedKey == ax.key(e)]
  if let a = ax.attrs(e, deadline: Deadline(ms: 250)), let v = a.value { o["value"] = String(v.prefix(4096)) }
  if let s = p.selected { o["selected"] = s }
  if let x = p.expanded { o["expanded"] = x }
  return o
}

func actOp(_ b: [String: Any], _ poster: Poster, _ abort: AbortState) -> [String: Any] {
  if abort.requested { return errorReply(id: nil, code: "stopped", extra: ["delivery": Delivery.notDelivered.rawValue]) }
  guard let ref = b["ref"] as? String, let action = b["action"] as? String else { return errorReply(id: nil, code: "invalid_args") }
  guard axTrusted() else { return errorReply(id: nil, code: "no_permission") }
  let d = Deadline(ms: requestMs(b["deadlineMs"], max: 15000))
  let nd = ["delivery": Delivery.notDelivered.rawValue]
  if let p = refTable.get(ref)?.instance.pid, ownOrDenied(b, pid: p) { return errorReply(id: nil, code: "own_window", extra: nd) }
  let r: Resolved
  switch resolveLive(ref, d) {
  case .failure(let e):
    var x = e
    x.extra["delivery"] = Delivery.notDelivered.rawValue
    return x.reply
  case .success(let v): r = v
  }
  let pid = r.live.pid
  let g = parseActGuard(b["guard"])
  if ownOrDenied(b, pid: pid) { return errorReply(id: nil, code: "own_window", extra: nd) }
  if let want = g.expectInstance, want != r.live { return errorReply(id: nil, code: "target_changed", extra: nd) }
  if (action == "type" || action == "set") && secureInputOn() { return errorReply(id: nil, code: "secure_input", extra: nd) }

  var req = ActRequest(action: action)
  req.value = stringArg(b["value"])
  req.text = b["text"] as? String
  req.replace = b["replace"] as? Bool ?? false
  req.direction = b["direction"] as? String
  req.amount = clampInt(num(b["amount"]), 1, 20)

  abort.beginPost()
  defer { abort.endPost() }
  let ax = LiveAX(pid: pid, deadline: d, abort: abort)
  var o = runChain(ax, r.element, req)
  o = finalizeOutcome(o, expired: ax.hitExpired, aborted: ax.hitAbort || abort.requested, typed: ax.typedPartial)

  if physicalEligible(o, action: action, physical: b["physical"] as? Bool ?? false) {
    return physicalClick(r, g, steps: o.steps, poster, abort, d)
  }
  return actReply(o, after: o.delivery == .notDelivered ? nil : afterFields(pid, r.element))
}

/// spec §6.9: focus the window, take the element's visible rect once it is stable (3 samples, 17 ms,
/// 0.5 pt), pick the first of 5 candidate points whose AX hit is the target or a descendant, re-check
/// front app / main window / instance, then a guarded physical click through Poster.
private func physicalClick(_ r: Resolved, _ g: ActGuard, steps: [(String, Delivery)], _ poster: Poster,
                           _ abort: AbortState, _ d: Deadline) -> [String: Any] {
  let pid = r.live.pid
  let stepsJSON = steps.map { ["name": $0.0, "outcome": $0.1.rawValue] }
  func fail(_ code: String) -> [String: Any] {
    errorReply(id: nil, code: code, extra: ["delivery": Delivery.notDelivered.rawValue, "steps": stepsJSON,
                                             "physical_delivery_started": false])
  }
  if inputBlockedBySession() { return fail("target_changed") }
  if let c = focusWindowImpl(pid: pid, windowNumber: r.rec.window, abort, d) { return fail(c == "not_found" ? "stale_ref" : c) }
  let ax = LiveAX(pid: pid, deadline: d)
  var samples: [CGRect] = []
  for i in 0..<3 {
    guard let f = ax.frame(r.element, d) else { return fail("stale_ref") }
    samples.append(f)
    if let c = postGate(expired: d.expired, aborted: abort.requested) { return fail(c) }
    if i < 2 && !abortableSleep(17, abort) { return fail("stopped") }
  }
  guard boundsStable(samples), let vis = visibleRect(samples[2], clips: ax.clipFrames(r.element, d)) else {
    return fail("target_changed")
  }
  let point = clickCandidates(vis).first { p in
    guard let hit = axElementAt(p, d) else { return false }
    if ax.reaches(hit, r.element, d) { return true }
    // a container swallowed the system-wide hit: ask the app element once
    guard ax.reaches(r.element, hit, d), let inner = axElementAt(p, in: ax.app, d) else { return false }
    return ax.reaches(inner, r.element, d)
  }
  guard let p = point else { return fail("target_changed") }
  // final gate right before the post
  guard processInstance(pid) == r.live, workspaceFront()?.processIdentifier == pid,
        let win = axElement(r.element, "AXWindow", d), cfBool(axRead(win, "AXMain", d).value) == true else {
    return fail("target_changed")
  }
  var gd: [String: Any] = ["denyPids": (g.denyPids + ownPids).map { Int($0) }, "denyBundlePrefixes": g.denyBundlePrefixes + [OWN_BUNDLE_PREFIX],
                           "expectPid": Int(pid)]
  if let n = r.rec.window { gd["expectWindowId"] = n }
  if let c = postGate(expired: d.expired, aborted: abort.requested) { return fail(c) }  // never click after the reply is due
  let res = poster.post(["action": ["kind": "click", "x": Double(p.x), "y": Double(p.y)], "guard": gd])
  if let code = res["code"] as? String { return fail(code) }
  let all = stepsJSON + [["name": "physical.click", "outcome": Delivery.deliveredUnverified.rawValue]]
  return ["delivery": Delivery.deliveredUnverified.rawValue, "steps": all, "after": afterFields(pid, r.element)]
}

// MARK: - waitFor

/// AXObserver on a dedicated run-loop thread; any of the notifications wakes the poll early.
private final class WaitObserver {
  private static let notes = [kAXFocusedUIElementChangedNotification, kAXValueChangedNotification, kAXCreatedNotification,
                              kAXUIElementDestroyedNotification, kAXMenuOpenedNotification, kAXFocusedWindowChangedNotification]
  fileprivate let wake = DispatchSemaphore(value: 0)
  private let ready = DispatchSemaphore(value: 0)
  private let done = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var stopFlag = false
  private let pid: Int32

  init(pid: Int32) { self.pid = pid }

  private var stopping: Bool { lock.lock(); defer { lock.unlock() }; return stopFlag }

  func start() {
    let t = Thread { [self] in
      defer { done.signal() }
      var obs: AXObserver?
      let cb: AXObserverCallback = { _, _, _, refcon in
        guard let refcon else { return }
        Unmanaged<WaitObserver>.fromOpaque(refcon).takeUnretainedValue().wake.signal()
      }
      guard AXObserverCreate(pid, cb, &obs) == .success, let o = obs else { ready.signal(); return }
      let app = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(app, 0.25)
      let me = Unmanaged.passUnretained(self).toOpaque()
      for n in WaitObserver.notes { _ = AXObserverAddNotification(o, app, n as CFString, me) }
      let src = AXObserverGetRunLoopSource(o)
      CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .defaultMode)
      ready.signal()
      while !stopping { _ = CFRunLoopRunInMode(.defaultMode, 0.1, false) }
      for n in WaitObserver.notes { _ = AXObserverRemoveNotification(o, app, n as CFString) }
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), src, .defaultMode)
    }
    t.start()
    _ = ready.wait(timeout: .now() + 0.5)
  }

  /// true = woken by a notification.
  func wait(ms: Int) -> Bool {
    let woke = wake.wait(timeout: .now() + .milliseconds(max(0, ms))) == .success
    while wake.wait(timeout: .now()) == .success {}  // a burst counts once
    return woke
  }

  /// Returns once the thread has removed its notifications (no callback can reach `self` afterwards).
  func stop() {
    lock.lock(); stopFlag = true; lock.unlock()
    done.wait()
  }
}

func waitForOp(_ b: [String: Any], _ abort: AbortState) -> [String: Any] {
  if abort.requested { return errorReply(id: nil, code: "stopped") }
  guard let pid = int32(b["pid"]), let m = b["match"] as? [String: Any] else { return errorReply(id: nil, code: "invalid_args") }
  let role = m["role"] as? String, name = m["name"] as? String, contains = m["nameContains"] as? String
  guard role != nil || name != nil || contains != nil else { return errorReply(id: nil, code: "invalid_args") }
  let gone = b["gone"] as? Bool ?? false
  guard axTrusted() else { return errorReply(id: nil, code: "no_permission") }
  guard let inst = processInstance(pid), runningApp(pid) != nil else { return errorReply(id: nil, code: "not_found") }
  if ownOrDenied(b, pid: pid) { return errorReply(id: nil, code: "own_window") }
  let end = Deadline(ms: clampInt(num(b["timeoutMs"]) ?? 5000, 0, 30000))
  let ax = LiveAX(pid: pid, deadline: end, abort: abort)
  ax.identityOnly = true
  let observer = WaitObserver(pid: pid)
  observer.start()
  abort.beginPost()
  defer { abort.endPost(); observer.stop() }

  while true {
    if abort.requested { return errorReply(id: nil, code: "stopped") }
    guard processInstance(pid) == inst else {
      return gone ? ["found": true] : errorReply(id: nil, code: "not_found", message: "app quit")
    }
    let d = Deadline(ms: max(250, min(ms(end), 2000)))
    let wr = axRead(ax.app, "AXWindows", d)
    let windowsRead = wr.err == .success && wr.value.map { CFGetTypeID($0) == CFArrayGetTypeID() } == true
    let windowCount = windowsRead ? CFArrayGetCount((wr.value as! CFArray)) : -1
    if let win = windowCount == 0 ? nil : pickWindow(ax.app, number: nil, d) {
      let w = walkDetailed(ax, root: win, budget: Budget(maxDepth: 50), deadline: d, interactiveOnly: false, skeleton: false)
      let hits = w.visited.filter { waitMatch($0.0, role: role, name: name, nameContains: contains) }
      if !gone, let (fp, e) = hits.first {
        return foundReply(ax, inst: inst, win: win, fp: fp, e: e, census: w.exhaustive ? w.census : nil)
      }
      if gone && goneConfirmed(windowsRead: windowsRead, windowCount: windowCount, walkExhaustive: w.exhaustive, hits: hits.count) {
        return ["found": true]
      }
    } else if gone && goneConfirmed(windowsRead: windowsRead, windowCount: windowCount, walkExhaustive: false, hits: 0) {
      return ["found": true]  // AXWindows read fine and is empty
    }
    if end.expired { return ["found": false] }
    let t0 = ProcessInfo.processInfo.systemUptime
    _ = observer.wait(ms: min(100, ms(end)))
    let spent = Int((ProcessInfo.processInfo.systemUptime - t0) * 1000)
    if spent < 30 && !abortableSleep(30 - spent, abort) { return errorReply(id: nil, code: "stopped") }  // a burst of notifications
  }
}

/// The hit goes into a fresh one-node snapshot so the model can act on it.
private func foundReply(_ ax: LiveAX, inst: Instance, win: AXUIElement, fp: Fingerprint, e: AXUIElement,
                        census: [Fingerprint]?) -> [String: Any] {
  let a = ax.readAttrs(e, Deadline(ms: 300), actor: true)  // the full read for the one node handed back
  var states: [String] = []
  if a?.enabled == false { states.append("disabled") }
  if a?.focused == true { states.append("focused") }
  if a?.selected == true { states.append("selected") }
  if let x = a?.expanded { states.append(x ? "expanded" : "collapsed") }
  let node = SnapNode(ref: "e1", depth: 0, role: fp.role, name: fp.name, value: a?.value.map { String($0.prefix(4096)) },
                      states: states, actions: a.map(actionVocab) ?? [], childrenCount: nil, truncated: false,
                      bounds: a?.frame, offscreen: false)
  let marked = markUnique([fp], census: census)[0]
  let snapId = refTable.put(instance: inst, window: axWindowNumber(win), nodes: [(node, e, marked)])
  return ["found": true, "snapId": snapId,
          "node": snapNodeJSON(node, ref: RefTable<AXUIElement>.qualify(snapId: snapId, local: "e1"))]
}

// MARK: - a11yRevert

func a11yRevertOp() -> [String: Any] { ["reverted": RendererA11y.shared.revertAll().map { Int($0) }] }
