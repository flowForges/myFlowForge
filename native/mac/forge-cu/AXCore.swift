// forge-cu · accessibility core, pure logic. Foundation / CoreGraphics only: no ApplicationServices AX
// calls, no event posting. The real AX binding implements `AXSource` / `AXActor` (AXLive.swift); the self-test
// (tests/main.swift) drives everything here through an in-memory fake tree.
import Foundation
import CoreGraphics

// MARK: - Deadline

/// One absolute deadline per request. Every AX call sets its messaging timeout from it first
/// (spec C2): reads `min(remaining, 0.25 s)`, mutations `max(remaining / 2, 0.25 s)` but never more
/// than what is left. The clock is injectable so tests never sleep.
struct Deadline {
  private let end: Double
  private let now: () -> Double

  init(ms: Int, now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) {
    self.now = now
    end = now() + Double(max(0, ms)) / 1000
  }

  var remaining: Double { max(0, end - now()) }
  var expired: Bool { remaining <= 0 }

  /// A messaging timeout of 0 means "the system default" (seconds), so an expired deadline still
  /// yields a tiny positive slice; callers check `expired` before calling at all.
  private static let minSlice = 0.001
  func readTimeout() -> Float { Float(max(Deadline.minSlice, min(remaining, 0.25))) }
  func writeTimeout() -> Float {
    let r = remaining
    return Float(max(Deadline.minSlice, min(max(r / 2, 0.25), r)))
  }
}

// MARK: - Node attributes and the source protocol

/// One node's attributes as read in a batch. `nil` = absent or unreadable.
struct NodeAttrs {
  var role: String?
  var subrole: String?
  var title: String?
  var description: String?
  var help: String?
  var identifier: String?
  var domIdentifier: String?
  var placeholder: String?
  var value: String?
  /// CF type of the raw AXValue (CFNumber / CFBoolean / CFString): `set` writes the same type back.
  var valueKind: AXValueKind?
  var enabled: Bool?
  var focused: Bool?
  var selected: Bool?
  var expanded: Bool?
  var frame: CGRect?
  var actions: [String] = []
  var settable: Set<String> = []
  var numberOfCharacters: Int?
  /// Text of the AXTitleUIElement (its title, else a non-secure static text value, else description).
  var titleUIText: String?
}

enum AXValueKind { case string, number, bool }

/// The tree the walker reads. The live implementation wraps AXUIElement; `key` must identify the
/// remote element (CFHash + CFEqual), not the local CF object pointer.
protocol AXSource {
  associatedtype E
  /// nil = the element is dead or the read failed / timed out.
  func attrs(_ e: E, deadline: Deadline) -> NodeAttrs?
  /// `role` is the raw AX role; the source picks the attribute (AXApplication → AXWindows,
  /// AXBrowser → AXColumns, else AXChildren → AXChildrenInNavigationOrder → AXContents).
  /// `changed` = the count moved during the paged read. nil = timeout / failure.
  func children(_ e: E, role: String, deadline: Deadline) -> (items: [E], changed: Bool)?
  func key(_ e: E) -> AnyHashable
}

// MARK: - Roles

private let roleTable: [String: String] = [
  "AXApplication": "application", "AXWindow": "window", "AXSheet": "sheet", "AXDialog": "dialog",
  "AXDrawer": "drawer", "AXPopover": "popover", "AXHelpTag": "helptag", "AXMatte": "matte",
  "AXButton": "button", "AXMenuButton": "menubutton", "AXLink": "link",
  "AXTextField": "textfield", "AXTextArea": "textfield", "AXSearchField": "textfield", "AXSecureTextField": "textfield",
  "AXComboBox": "combobox", "AXPopUpButton": "combobox",
  "AXCheckBox": "checkbox", "AXSwitch": "switch", "AXToggle": "switch", "AXRadioButton": "radiobutton",
  "AXRadioGroup": "radiogroup", "AXSlider": "slider", "AXIncrementor": "incrementor", "AXStepper": "incrementor",
  "AXValueIndicator": "handle", "AXHandle": "handle", "AXColorWell": "colorwell", "AXDockItem": "dockitem",
  "AXDisclosureTriangle": "disclosure", "AXTimeField": "timefield", "AXDateField": "datefield",
  "AXMenu": "menu", "AXMenuBar": "menu", "AXMenuItem": "menuitem", "AXMenuBarItem": "menuitem",
  "AXTab": "tab", "AXTabGroup": "tablist", "AXToolbar": "toolbar",
  "AXList": "list", "AXTable": "table", "AXOutline": "outline", "AXGrid": "grid", "AXBrowser": "browser",
  "AXRow": "row", "AXOutlineRow": "treeitem", "AXColumn": "column", "AXCell": "cell",
  "AXGroup": "group", "AXGenericElement": "group", "AXSplitGroup": "group",
  "AXLayoutArea": "layoutitem", "AXLayoutItem": "layoutitem",
  "AXScrollArea": "scrollarea", "AXScrollBar": "scrollbar", "AXSplitter": "splitter", "AXSeparator": "separator",
  "AXStaticText": "statictext", "AXHeading": "heading", "AXParagraph": "paragraph", "AXImage": "image",
  "AXWebArea": "webarea", "AXDocument": "document", "AXPage": "page",
  "AXProgressIndicator": "progressbar", "AXBusyIndicator": "progressbar", "AXLevelIndicator": "levelindicator",
  "AXRelevanceIndicator": "relevanceindicator", "AXRuler": "ruler", "AXRulerMarker": "rulermarker",
  "AXStatus": "status", "AXToolTip": "tooltip",
]

/// Subroles that override the base role (Chromium puts ARIA landmarks / widgets on AXGroup).
private let subroleTable: [String: String] = [
  "AXApplicationAlert": "alert", "AXApplicationAlertDialog": "alertdialog", "AXApplicationDialog": "dialog",
  "AXApplicationLog": "log", "AXApplicationMarquee": "marquee", "AXApplicationStatus": "status",
  "AXApplicationTimer": "timer",
  "AXDocumentArticle": "article", "AXDocumentMath": "math", "AXDocumentNote": "note", "AXDocumentRegion": "region",
  "AXLandmarkBanner": "banner", "AXLandmarkComplementary": "complementary", "AXLandmarkContentInfo": "contentinfo",
  "AXLandmarkForm": "form", "AXLandmarkMain": "main", "AXLandmarkNavigation": "navigation",
  "AXLandmarkSearch": "search",
  "AXDefinition": "definition", "AXTerm": "term", "AXTabPanel": "tabpanel", "AXUserInterfaceTooltip": "tooltip",
  "AXOutlineRow": "treeitem", "AXTableRow": "row",
  "AXSecureTextField": "textfield", "AXSearchField": "textfield",
  "AXDialog": "dialog", "AXSystemDialog": "dialog",
  "AXCloseButton": "button", "AXMinimizeButton": "button", "AXZoomButton": "button",
  "AXFullScreenButton": "button", "AXToolbarButton": "button", "AXSortButton": "button",
  "AXToggle": "switch", "AXSwitch": "switch",
  "AXContentList": "list", "AXDefinitionList": "list", "AXDescriptionList": "list",
  "AXSeparatorDockItem": "separator",
]

/// AX role (+ subrole) → lowercase ARIA-like vocabulary; the subrole wins; anything else → "unknown".
func normalizeRole(role: String, subrole: String?) -> String {
  let base = roleTable[role] ?? "unknown"
  guard let sub = subrole else { return base }
  if sub == "AXToggleButton" { return ["checkbox", "switch", "radiobutton"].contains(base) ? base : "button" }
  return subroleTable[sub] ?? base
}

/// Roles that receive a ref on their own.
private let interactiveRoles: Set<String> = [
  "button", "cell", "checkbox", "colorwell", "combobox", "dockitem", "incrementor", "link", "listbox",
  "menubutton", "menuitem", "option", "radiobutton", "slider", "switch", "tab", "textfield", "treeitem",
]

/// Roles whose value changes under the user: a name equal to the value is not a name (nor identity).
private let mutableValueRoles: Set<String> = [
  "textfield", "combobox", "checkbox", "switch", "radiobutton", "slider", "incrementor", "listbox", "scrollbar", "handle",
]

/// Roles whose frame narrows the clip rect carried down the walk (never AXTopLevelUIElement).
private let clipRoles: Set<String> = ["AXWindow", "AXScrollArea", "AXWebArea", "AXSheet", "AXPopover"]

// MARK: - Actions

/// AX actions / settable attributes → our vocabulary, in the order `click menu set type focus expand`.
func actionVocab(_ a: NodeAttrs) -> [String] {
  let acts = Set(a.actions)
  let role = a.role ?? ""
  let textual = normalizeRole(role: role, subrole: a.subrole) == "textfield" || role == "AXComboBox"
  var v: [String] = []
  if !acts.isDisjoint(with: ["AXPress", "AXOpen", "AXConfirm"]) { v.append("click") }
  if acts.contains("AXShowMenu") { v.append("menu") }
  if !acts.isDisjoint(with: ["AXIncrement", "AXDecrement"]) || a.settable.contains("AXValue") { v.append("set") }
  if textual && !a.settable.isDisjoint(with: ["AXSelectedText", "AXValue"]) { v.append("type") }
  if a.settable.contains("AXFocused") { v.append("focus") }
  if a.settable.contains("AXExpanded") { v.append("expand") }
  return v
}

/// Web runtimes put context-menu / focus on nearly every node, so those alone don't count.
func isInteractive(role: String, vocab: [String]) -> Bool {
  interactiveRoles.contains(role) || vocab.contains { $0 != "menu" && $0 != "focus" }
}

// MARK: - Names

private func nonEmpty(_ s: String?) -> String? {
  guard let s, !s.isEmpty else { return nil }
  return s
}

/// Name precedence: AXTitleUIElement text → AXTitle → static text value → AXDescription →
/// ≤5 unique child texts (interactive nodes and rows only) → AXPlaceholderValue.
/// For mutable-value roles a candidate equal to the value is skipped.
func displayName(_ a: NodeAttrs, childTexts: [String]) -> String? {
  let rawRole = a.role ?? ""
  let role = normalizeRole(role: rawRole, subrole: a.subrole)
  let value = rawRole == "AXSecureTextField" ? nil : nonEmpty(a.value)
  let mutable = mutableValueRoles.contains(role)
  func usable(_ s: String?) -> String? {
    guard let s = nonEmpty(s) else { return nil }
    if mutable, let value, s == value { return nil }
    return s
  }
  if let n = usable(a.titleUIText) ?? usable(a.title) { return n }
  if rawRole == "AXStaticText", let v = value { return v }
  if let n = usable(a.description) { return n }
  if isInteractive(role: role, vocab: actionVocab(a)) || role == "row" {
    var seen = Set<String>(), picked: [String] = []
    for t in childTexts where !t.isEmpty && seen.insert(t).inserted {
      picked.append(t)
      if picked.count == 5 { break }
    }
    if let n = usable(picked.isEmpty ? nil : picked.joined(separator: " ")) { return n }
  }
  return usable(a.placeholder)
}

// MARK: - Snapshot model and budgets

struct SnapNode {
  /// Local id `eN` from the walker; qualified to `@<snapId>:eN` with `RefTable.qualify`.
  var ref: String?
  /// Logical depth (transparent wrappers don't count).
  var depth: Int
  var role: String
  var name: String?
  var value: String?
  var states: [String]
  var actions: [String]
  var childrenCount: Int?
  var truncated: Bool
  var bounds: CGRect?
  var offscreen: Bool
}

struct Budget {
  static let skeletonDepth = 3
  static let fullDepth = 10
  let maxDepthHard = 50
  var maxDepth: Int
  var maxNodes = 50_000
  var maxChildren = 4096
  var maxField = 65_536

  init(maxDepth: Int) { self.maxDepth = min(max(0, maxDepth), 50) }
}

struct Instance: Equatable {
  var pid: Int32
  /// "<sec>.<usec>" from proc_pidinfo(PROC_PIDTBSDINFO).
  var start: String
}

/// Identity of a ref. Bounds and values never take part.
struct Fingerprint: Equatable {
  var role: String
  var subrole: String?
  var name: String?
  var description: String?
  /// AXDOMIdentifier, else AXIdentifier.
  var nativeId: String?
  var uniqueAtCapture: Bool

  /// role ∧ nativeId ∧ name ∧ description, exact Optional equality: an absent field only matches an
  /// absent field (no wildcard, spec §6.3).
  func matches(_ live: Fingerprint) -> Bool {
    live.role == role && live.nativeId == nativeId && live.name == name && live.description == description
  }

  /// Nothing but the role to go on: such a ref can never be re-found by a census.
  var hasIdentity: Bool { name != nil || description != nil || nativeId != nil }
}

// MARK: - Walker

private func capField(_ s: String?, _ max: Int) -> String? {
  guard let s, s.utf8.count > max else { return s }
  var out = String.UnicodeScalarView(), bytes = 0
  for u in s.unicodeScalars {
    let n = String(u).utf8.count
    if bytes + n > max { break }
    bytes += n
    out.append(u)
  }
  return String(out)
}

private func sanitize(_ a: NodeAttrs, maxField m: Int) -> NodeAttrs {
  var a = a
  a.role = capField(a.role, m); a.subrole = capField(a.subrole, m)
  a.title = capField(a.title, m); a.description = capField(a.description, m); a.help = capField(a.help, m)
  a.identifier = capField(a.identifier, m); a.domIdentifier = capField(a.domIdentifier, m)
  a.placeholder = capField(a.placeholder, m); a.titleUIText = capField(a.titleUIText, m)
  a.value = a.role == "AXSecureTextField" ? nil : capField(a.value, m)
  if let f = a.frame, !(f.origin.x.isFinite && f.origin.y.isFinite && f.width.isFinite && f.height.isFinite
                        && f.width >= 0 && f.height >= 0) {
    a.frame = nil
  }
  return a
}

/// Label text a child contributes to its parent's name (never a secure value).
private func childText(_ a: NodeAttrs) -> String? {
  switch a.role {
  case "AXStaticText": return nonEmpty(a.value)
  case "AXCell", "AXGroup": return nonEmpty(a.title)
  default: return nil
  }
}

struct WalkResult<E> {
  /// Emitted nodes in pre-order; the element is present only for nodes with a ref.
  var nodes: [(SnapNode, E?, Fingerprint)]
  var complete: Bool
  /// complete and nothing was cut at a depth boundary: the whole subtree under the root was seen.
  var exhaustive: Bool
  /// Fingerprints of every visited node when exhaustive (input to `markUnique`), else nil.
  var census: [Fingerprint]?
  /// Every visited node (emitted or not), for the resolve census.
  var visited: [(Fingerprint, E)]
}

private final class Walker<S: AXSource> {
  let s: S, budget: Budget, deadline: Deadline, interactiveOnly: Bool, skeleton: Bool
  var out: [(SnapNode, S.E?, Fingerprint)] = []
  var visited: [(Fingerprint, S.E)] = []
  var seen = Set<AnyHashable>()
  var count = 0, nextRef = 1
  var complete = true, cut = false

  init(_ s: S, _ budget: Budget, _ deadline: Deadline, _ interactiveOnly: Bool, _ skeleton: Bool) {
    self.s = s; self.budget = budget; self.deadline = deadline; self.interactiveOnly = interactiveOnly; self.skeleton = skeleton
  }

  var stopped: Bool { deadline.expired || count >= budget.maxNodes }

  /// `parentLogical` is ignored for the root (raw 0).
  func visit(_ e: S.E, pre: NodeAttrs?, raw: Int, parentLogical: Int, clip: CGRect?) {
    if stopped { complete = false; return }
    guard seen.insert(s.key(e)).inserted else { return }  // cycle or shared node: once only
    guard let read = pre ?? s.attrs(e, deadline: deadline) else { complete = false; return }
    count += 1
    let a = sanitize(read, maxField: budget.maxField)
    let rawRole = a.role ?? ""
    let role = normalizeRole(role: rawRole, subrole: a.subrole)
    let vocab = actionVocab(a)
    let ownName = displayName(a, childTexts: [])
    let transparent = role == "group" && ownName == nil && nonEmpty(a.value) == nil && nonEmpty(a.description) == nil
      && nonEmpty(a.identifier) == nil && nonEmpty(a.domIdentifier) == nil && vocab.allSatisfy { $0 == "menu" || $0 == "focus" }
    let logical = raw == 0 ? 0 : parentLogical + (transparent ? 0 : 1)

    let bounds = a.frame
    let offscreen = bounds.map { b in clip.map { $0.intersection(b).isNull } ?? false } ?? false
    var childClip = clip
    if clipRoles.contains(rawRole), let b = bounds { childClip = clip.map { $0.intersection(b) } ?? b }

    var kids: [S.E] = []
    var truncated = false
    if let r = s.children(e, role: rawRole, deadline: deadline) {
      kids = r.items
      if r.changed { truncated = true; complete = false }
    } else {
      truncated = true; complete = false
    }
    let realCount = kids.count
    if kids.count > budget.maxChildren { kids = Array(kids.prefix(budget.maxChildren)); truncated = true; complete = false }

    let atBoundary = logical >= budget.maxDepth
    let atHard = raw + 1 >= budget.maxDepthHard
    let descend = !atBoundary && !atHard
    var childrenCount: Int?
    if !descend && realCount > 0 {
      truncated = true; childrenCount = realCount; cut = true
      if !atBoundary { complete = false }
    }

    let interactive = role != "unknown" && isInteractive(role: role, vocab: vocab)
    let boundaryLabel = skeleton && childrenCount != nil
    var name = ownName
    var preKids: [NodeAttrs?] = []
    if name == nil && (interactive || role == "row" || boundaryLabel) && !kids.isEmpty {
      preKids = kids.prefix(5).map { seen.contains(s.key($0)) ? nil : s.attrs($0, deadline: deadline) }
      let texts = preKids.compactMap { $0.flatMap { childText(sanitize($0, maxField: budget.maxField)) } }
      name = displayName(a, childTexts: texts)
      if name == nil && boundaryLabel && !texts.isEmpty {
        var seenT = Set<String>()
        name = texts.filter { seenT.insert($0).inserted }.joined(separator: " ")
      }
    }

    let nativeId = nonEmpty(a.domIdentifier) ?? nonEmpty(a.identifier)
    let anchor = boundaryLabel && (name != nil || nonEmpty(a.description) != nil || nativeId != nil || bounds != nil)
    var ref: String?
    if interactive || anchor { ref = "e\(nextRef)"; nextRef += 1 }

    var value = a.value
    if value == nil, role == "textfield", rawRole != "AXSecureTextField", a.numberOfCharacters == 0 { value = "" }
    var states: [String] = []
    if a.enabled == false { states.append("disabled") }
    if a.focused == true { states.append("focused") }
    if a.selected == true { states.append("selected") }
    if let x = a.expanded { states.append(x ? "expanded" : "collapsed") }

    let fp = Fingerprint(role: role, subrole: a.subrole, name: name, description: nonEmpty(a.description),
                         nativeId: nativeId, uniqueAtCapture: false)
    visited.append((fp, e))
    var index: Int?
    if !interactiveOnly || raw == 0 || ref != nil || name != nil || childrenCount != nil {
      index = out.count
      out.append((SnapNode(ref: ref, depth: logical, role: role, name: name, value: value, states: states, actions: vocab,
                           childrenCount: childrenCount, truncated: truncated, bounds: bounds, offscreen: offscreen),
                  ref != nil ? e : nil, fp))
    }

    guard descend else { return }
    for (i, k) in kids.enumerated() {
      if stopped {
        complete = false
        if let index { out[index].0.truncated = true }
        return
      }
      visit(k, pre: i < preKids.count ? preKids[i] : nil, raw: raw + 1, parentLogical: logical, clip: childClip)
    }
  }
}

/// DFS pre-order snapshot. Never fails: budgets and the deadline yield a partial tree with
/// `complete == false` and `truncated` on the nodes whose children were cut.
func walkDetailed<S: AXSource>(_ s: S, root: S.E, budget: Budget, deadline: Deadline, interactiveOnly: Bool,
                               skeleton: Bool) -> WalkResult<S.E> {
  let w = Walker(s, budget, deadline, interactiveOnly, skeleton)
  w.visit(root, pre: nil, raw: 0, parentLogical: 0, clip: nil)
  let exhaustive = w.complete && !w.cut
  return WalkResult(nodes: w.out, complete: w.complete, exhaustive: exhaustive,
                    census: exhaustive ? w.visited.map { $0.0 } : nil, visited: w.visited)
}

func walk<S: AXSource>(_ s: S, root: S.E, budget: Budget, deadline: Deadline, interactiveOnly: Bool,
                       skeleton: Bool) -> (nodes: [(SnapNode, S.E?)], complete: Bool) {
  let r = walkDetailed(s, root: root, budget: budget, deadline: deadline, interactiveOnly: interactiveOnly, skeleton: skeleton)
  return (r.nodes.map { ($0.0, $0.1) }, r.complete)
}

/// uniqueAtCapture = has identity beyond the role and exactly one match in an exhaustive whole-window
/// census; no census → none unique. Uses the same `matches` as the resolve census.
func markUnique(_ fps: [Fingerprint], census: [Fingerprint]?) -> [Fingerprint] {
  fps.map { fp in
    var f = fp
    f.uniqueAtCapture = fp.hasIdentity && (census.map { c in c.lazy.filter { fp.matches($0) }.count == 1 } ?? false)
    return f
  }
}

// MARK: - Ref table

struct RefRecord<E> {
  var element: E
  var instance: Instance
  var window: Int?
  var fingerprint: Fingerprint
  /// Diagnostics only; never identity.
  var bounds: CGRect?
}

/// In-memory refs per snapshot, LRU over the last 8 snapshots. Ref format `@s<k>:e<N>`; bare `eN` is refused.
final class RefTable<E> {
  let capacity = 8
  private var snaps: [Int: [Int: RefRecord<E>]] = [:]
  private var order: [Int] = []  // least recently used first
  private var next = 1

  /// Stores every node that has a local ref and an element; returns the new snapshot id `s<k>`.
  func put(instance: Instance, window: Int?, nodes: [(SnapNode, E?, Fingerprint)]) -> String {
    let k = next
    next += 1
    var recs: [Int: RefRecord<E>] = [:]
    for (node, e, fp) in nodes {
      guard let e, let local = node.ref, local.hasPrefix("e"), let n = RefTable.number(local.dropFirst()) else { continue }
      recs[n] = RefRecord(element: e, instance: instance, window: window, fingerprint: fp, bounds: node.bounds)
    }
    snaps[k] = recs
    order.append(k)
    while order.count > capacity { snaps[order.removeFirst()] = nil }
    return "s\(k)"
  }

  func get(_ ref: String) -> RefRecord<E>? {
    guard let (k, n) = RefTable.parse(ref), let rec = snaps[k]?[n] else { return nil }
    if let i = order.firstIndex(of: k) { order.remove(at: i); order.append(k) }
    return rec
  }

  /// After a slow-path resolve found the element again.
  func rebind(_ ref: String, to e: E) {
    guard let (k, n) = RefTable.parse(ref), snaps[k]?[n] != nil else { return }
    snaps[k]?[n]?.element = e
  }

  static func qualify(snapId: String, local: String) -> String { "@\(snapId):\(local)" }

  static func parse(_ ref: String) -> (snap: Int, n: Int)? {
    guard ref.hasPrefix("@s") else { return nil }
    let body = ref.dropFirst(2)
    guard let colon = body.firstIndex(of: ":") else { return nil }
    let rest = body[body.index(after: colon)...]
    guard rest.hasPrefix("e"), let snap = number(body[..<colon]), let n = number(rest.dropFirst()) else { return nil }
    return (snap, n)
  }

  /// Plain ASCII digits, no sign, no leading zero, bounded length.
  private static func number(_ s: Substring) -> Int? {
    guard !s.isEmpty, s.count <= 9, s.allSatisfy({ $0 >= "0" && $0 <= "9" }), s.first != "0" || s.count == 1 else { return nil }
    return Int(s)
  }
}

// MARK: - Strict resolve

enum ResolveOutcome<E> {
  case ok(E)
  case stale
  case ambiguous
  case timeout
}

/// spec §6.3, fail-closed, no fuzzy matching: instance check → fast path on the retained element
/// (role + nativeId) → only for refs unique at capture, an identity census of the window:
/// 1 match → ok (caller rebinds), 0 → stale, ≥2 → ambiguous, unfinished census → timeout.
func resolveRef<S: AXSource>(_ s: S, rec: RefRecord<S.E>, liveInstance: Instance?, windowRoot: S.E?,
                             deadline: Deadline) -> ResolveOutcome<S.E> {
  guard let live = liveInstance, live == rec.instance else { return .stale }
  let want = rec.fingerprint
  if let a = s.attrs(rec.element, deadline: deadline) {
    let nativeId = nonEmpty(a.domIdentifier) ?? nonEmpty(a.identifier)
    if normalizeRole(role: a.role ?? "", subrole: a.subrole) == want.role && (want.nativeId == nil || nativeId == want.nativeId) {
      return .ok(rec.element)
    }
  } else if deadline.expired {
    return .timeout
  }
  guard want.uniqueAtCapture, want.hasIdentity, let root = windowRoot else { return .stale }
  let w = walkDetailed(s, root: root, budget: Budget(maxDepth: 50), deadline: deadline, interactiveOnly: false, skeleton: false)
  let hits = w.visited.filter { want.matches($0.0) }
  if hits.count >= 2 { return .ambiguous }
  if !w.exhaustive { return .timeout }
  return hits.first.map { .ok($0.1) } ?? .stale
}

// MARK: - Delivery and grading

/// How far a mutation provably got (spec §6.4, research 2 §1.1–1.2). Same names on the wire everywhere.
enum Delivery: String {
  case notDelivered = "not_delivered"
  case uncertain
  case deliveredUnverified = "delivered_unverified"
  case deliveredWithoutEffect = "delivered_without_effect"
  case deliveredVerified = "delivered_verified"

  /// Every outcome but these two ends a chain: a second mutation could double-act on an effect nobody saw.
  var terminates: Bool { self != .notDelivered && self != .deliveredWithoutEffect }
  /// Only a proven non-delivery may be retried.
  var retrySafe: Bool { self == .notDelivered }
}

/// AXError, folded. notSupported = ActionUnsupported / NotImplemented / AttributeUnsupported / IllegalArgument;
/// `other` = Failure, NoValue and anything unmapped (ambiguous: the action may have run).
enum AXResult: Equatable {
  case success, notSupported, cannotComplete, invalidElement, apiDisabled
  case other(Int32)
}

/// What the actor can observe around one mutation of a target.
struct EffectProbe: Equatable {
  /// Key (CFHash + CFEqual) of the app's AXFocusedUIElement.
  var focusedKey: AnyHashable?
  /// The target's AXSelected.
  var selected: Bool?
  /// Any AXMenu of the app is open (visible, non-zero bounds).
  var menuOpen: Bool
  /// The target still answers.
  var exists: Bool
  /// AXValue of the focused element (never a secure field's).
  var value: String?
  /// The target's AXExpanded.
  var expanded: Bool?
}

/// Focus or the focused value moved, selection went on, a menu opened, the target vanished or (un)folded.
func observedEffect(before: EffectProbe, after: EffectProbe) -> Bool {
  if after.focusedKey != before.focusedKey { return true }
  if after.value != before.value { return true }
  if before.selected != true && after.selected == true { return true }
  if !before.menuOpen && after.menuOpen { return true }
  if before.exists && !after.exists { return true }
  if let b = before.expanded, let a = after.expanded, a != b { return true }
  return false
}

/// One step's grade. `stateChecked` = a readable state was checked (true: reached, false: unchanged);
/// `readbackRole` = row-like target whose AXSelected decides. Success with no observed effect is
/// `delivered_unverified` (stops the chain); `delivered_without_effect` only from a checked state that
/// didn't change AND no other effect was seen (callers pass `false` only for row/cell AXSelected,
/// toggle value and AXExpanded, spec §6.4).
func gradeStep(_ r: AXResult, before: EffectProbe, after: EffectProbe, readbackRole: Bool, stateChecked: Bool?) -> Delivery {
  switch r {
  case .notSupported, .invalidElement, .apiDisabled:
    return .notDelivered
  case .cannotComplete:
    return .uncertain
  case .other:
    return stateChecked == true || observedEffect(before: before, after: after) ? .deliveredVerified : .uncertain
  case .success:
    if stateChecked == true { return .deliveredVerified }
    let effect = observedEffect(before: before, after: after)
    if stateChecked == false { return effect ? .deliveredUnverified : .deliveredWithoutEffect }
    if readbackRole, let sel = after.selected {
      if sel { return .deliveredVerified }
      return effect ? .deliveredUnverified : .deliveredWithoutEffect  // something visibly happened: never again
    }
    return effect ? .deliveredVerified : .deliveredUnverified
  }
}

// MARK: - Actor protocol and requests

/// The live side of `act`. Every call sets its own messaging timeout from the request deadline (spec C2).
/// Values handed to `set`: String, NSNumber (CFNumber / CFBoolean), `[E]` (→ CFArray of elements),
/// NSValue(range:) (→ AXValue CFRange).
protocol AXActor {
  associatedtype E
  func attrs(_ e: E) -> NodeAttrs?
  func perform(_ e: E, _ action: String) -> AXResult
  func set(_ e: E, _ attr: String, _ v: Any) -> AXResult
  func children(_ e: E) -> [E]
  func parent(_ e: E) -> E?
  /// Same identity as `EffectProbe.focusedKey` (CFHash + CFEqual).
  func key(_ e: E) -> AnyHashable
  func probe(_ e: E) -> EffectProbe
  /// All waits go through here so the self-test never sleeps.
  func sleep(ms: Int)
  /// Web-area typing: AXFocused → wait for focus (≤500 ms) → Unicode key events to the pid in 32-UTF-16
  /// chunks, focus re-checked before each chunk. Replaces the current selection.
  func typeViaKeys(_ e: E, _ text: String) -> AXResult
  /// An AXWebArea among the ancestors (browsers, Electron).
  func inWebArea(_ e: E) -> Bool
}

struct ActRequest {
  var action: String
  var value: String? = nil
  var text: String? = nil
  var replace = false
  var direction: String? = nil
  var amount = 1
}

struct ActOutcome {
  var delivery: Delivery
  var steps: [(String, Delivery)]
  /// unsupported / secure_input / stale_ref / no_permission / invalid_args / not_found
  var code: String?
}

enum ActTiming {
  static let pollMs = 40
  static let settleMs = 400
  static let menuMs = 600
  static let toggleMs = 600
  static let expandMs = 200
  static let maxIncrements = 1024
  static let childAttempts = 4
  static let selectAncestors = 6
  static let menuSelectAncestors = 4
  static let scrollAreaAncestors = 5
  static let focusDescent = 3
  static let menuSearchNodes = 2048
  static let menuSearchDepth = 8
}

// MARK: - Chain runner

private let rowLikeRoles: Set<String> = ["row", "treeitem", "cell", "tab", "option"]
private let toggleRoles: Set<String> = ["checkbox", "switch", "radiobutton"]

private func parseBool(_ s: String?) -> Bool? {
  switch s?.lowercased() {
  case "1", "true", "on", "yes", "checked": return true
  case "0", "false", "off", "no", "unchecked": return false
  default: return nil
  }
}

private func sameNumber(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-6 * max(1, abs(a), abs(b)) }

private func sameValue(_ got: String?, _ want: String, kind: AXValueKind?) -> Bool {
  guard let got else { return false }
  switch kind {
  case .number?: if let g = Double(got), let w = Double(want) { return sameNumber(g, w) }
  case .bool?: if let g = parseBool(got), let w = parseBool(want) { return g == w }
  default: break
  }
  return got == want
}

private final class ChainRunner<A: AXActor> {
  typealias Step = () -> (String, Delivery)?
  let a: A, e: A.E
  var steps: [(String, Delivery)] = []
  var code: String?
  var halted = false

  init(_ a: A, _ e: A.E) { self.a = a; self.e = e }

  func advertises(_ x: A.E, _ action: String) -> Bool { a.attrs(x)?.actions.contains(action) ?? false }
  func settable(_ x: A.E, _ attr: String) -> Bool { a.attrs(x)?.settable.contains(attr) ?? false }

  /// One mutation, then poll the target (40 ms, ≤ capMs) until the state is reached / an effect shows.
  /// `effect: false` = only `state` can verify (value writes, typing, submit).
  func attempt(capMs: Int, readback: Bool = false, effect: Bool = true, state: (() -> Bool?)? = nil,
               _ op: () -> AXResult) -> Delivery {
    let before = a.probe(e)
    let r = op()
    switch r {
    case .invalidElement: code = "stale_ref"; halted = true
    case .apiDisabled: code = "no_permission"; halted = true
    default: break
    }
    var ran = r == .success
    if case .other = r { ran = true }
    guard ran else { return gradeStep(r, before: before, after: before, readbackRole: false, stateChecked: nil) }
    var after = before, s: Bool? = nil, t = 0
    while true {
      after = a.probe(e)
      s = state?()
      if s == true || (readback && after.selected == true) || (effect && observedEffect(before: before, after: after)) { break }
      if t >= capMs { break }
      a.sleep(ms: ActTiming.pollMs)
      t += ActTiming.pollMs
    }
    return gradeStep(r, before: before, after: effect ? after : before, readbackRole: readback, stateChecked: s)
  }

  func run(_ chain: [Step]) -> ActOutcome {
    for step in chain {
      if halted { break }
      guard let (name, d) = step() else { continue }
      steps.append((name, d))
      if d.terminates { return ActOutcome(delivery: d, steps: steps, code: code) }
    }
    if steps.contains(where: { $0.1 == .deliveredWithoutEffect }) {
      return ActOutcome(delivery: .deliveredWithoutEffect, steps: steps, code: code)
    }
    return ActOutcome(delivery: .notDelivered, steps: steps, code: code ?? "unsupported")
  }

  /// A later sub-call of a composite step failed after an earlier one was delivered: never not_delivered.
  func afterPartial(_ r: AXResult) -> Delivery {
    switch r {
    case .success: return .deliveredUnverified
    case .cannotComplete, .other: return .uncertain
    case .invalidElement: code = "stale_ref"; halted = true; return .deliveredUnverified
    case .apiDisabled: code = "no_permission"; halted = true; return .deliveredUnverified
    case .notSupported: return .deliveredUnverified
    }
  }

  func fail(_ c: String) -> ActOutcome { ActOutcome(delivery: .notDelivered, steps: [], code: c) }

  func performStep(_ x: A.E, _ action: String, name: String? = nil, cap: Int, readback: Bool = false,
                   effect: Bool = true, state: (() -> Bool?)? = nil) -> Step {
    { [unowned self] in
      guard self.advertises(x, action) else { return nil }
      return (name ?? action, self.attempt(capMs: cap, readback: readback, effect: effect, state: state) { self.a.perform(x, action) })
    }
  }

  func setStep(_ x: A.E, _ attr: String, _ v: @escaping () -> Any, name: String? = nil, cap: Int, effect: Bool = true,
               state: (() -> Bool?)? = nil) -> Step {
    { [unowned self] in
      guard self.settable(x, attr) else { return nil }
      return (name ?? attr, self.attempt(capMs: cap, effect: effect, state: state) { self.a.set(x, attr, v()) })
    }
  }

  func ancestors(_ n: Int) -> [A.E] {
    var out: [A.E] = [], x = a.parent(e)
    while let p = x, out.count < n { out.append(p); x = a.parent(p) }
    return out
  }

  // MARK: click

  /// AXPress (row-like: AXSelected read back) → AXOpen → first 4 children AXPress/AXOpen →
  /// AXSelected / container selection → AXConfirm. `state` replaces the effect grading (toggle).
  func clickSteps(state: (() -> Bool?)? = nil, cap: Int = ActTiming.settleMs) -> [Step] {
    let at = a.attrs(e)
    let raw = at?.role ?? ""
    let rowLike = state == nil && rowLikeRoles.contains(normalizeRole(role: raw, subrole: at?.subrole))
    let press = performStep(e, "AXPress", cap: cap, readback: rowLike, state: state)
    if raw == "AXMenuItem" || raw == "AXMenuBarItem" { return [press] }
    var chain = [press, performStep(e, "AXOpen", cap: cap, state: state)]
    var kids: [A.E]?
    for i in 0..<ActTiming.childAttempts {
      chain.append { [unowned self] in
        if kids == nil { kids = Array(self.a.children(self.e).prefix(ActTiming.childAttempts)) }
        guard let ks = kids, i < ks.count else { return nil }
        let k = ks[i]
        guard let act = ["AXPress", "AXOpen"].first(where: { self.advertises(k, $0) }) else { return nil }
        return ("child\(i + 1).\(act)", self.attempt(capMs: cap, state: state) { self.a.perform(k, act) })
      }
    }
    let selected: () -> Bool? = state ?? { [unowned self] in self.a.probe(self.e).selected }
    chain.append { [unowned self] in
      if self.settable(self.e, "AXSelected") {
        return ("AXSelected", self.attempt(capMs: cap, state: selected) { self.a.set(self.e, "AXSelected", NSNumber(value: true)) })
      }
      let prefer: [String]
      switch raw {
      case "AXCell": prefer = ["AXSelectedCells", "AXSelectedRows", "AXSelectedChildren"]
      case "AXRow", "AXOutlineRow": prefer = ["AXSelectedRows", "AXSelectedChildren", "AXSelectedCells"]
      default: prefer = ["AXSelectedChildren", "AXSelectedRows", "AXSelectedCells"]
      }
      for p in self.ancestors(ActTiming.selectAncestors) {
        guard let attr = prefer.first(where: { self.settable(p, $0) }) else { continue }
        return (attr, self.attempt(capMs: cap, state: selected) { self.a.set(p, attr, [self.e]) })
      }
      return nil
    }
    chain.append(performStep(e, "AXConfirm", cap: cap, state: state))
    return chain
  }

  // MARK: menu

  func menuSteps() -> [Step] {
    let open: () -> Bool? = { [unowned self] in self.a.probe(self.e).menuOpen ? true : nil }
    let show = performStep(e, "AXShowMenu", cap: ActTiming.menuMs, state: open)
    let selectThenShow: Step = { [unowned self] in
      let item = self.settable(self.e, "AXSelected") ? self.e
        : self.ancestors(ActTiming.menuSelectAncestors).first(where: { self.settable($0, "AXSelected") })
      guard let item else { return nil }
      let target = self.advertises(item, "AXShowMenu") ? item : self.e
      guard self.advertises(target, "AXShowMenu") else { return nil }
      var later: AXResult?
      let d = self.attempt(capMs: ActTiming.menuMs, state: open) {
        let r = self.a.set(item, "AXSelected", NSNumber(value: true))
        guard r == .success else { return r }
        let m = self.a.perform(target, "AXShowMenu")
        if m != .success { later = m }
        return .success
      }
      return ("AXSelected+AXShowMenu", later.map { self.afterPartial($0) } ?? d)
    }
    return [show, selectThenShow]
  }

  // MARK: type

  func typeSteps(_ text: String, replace: Bool) -> [Step] {
    let before = a.attrs(e)?.value
    let expect = replace ? text : (before ?? "") + text
    let contains: () -> Bool? = { [unowned self] in
      guard let v = self.a.attrs(self.e)?.value else { return nil }
      return (replace ? v == text : v.contains(text)) ? true : nil
    }
    if a.inWebArea(e) {
      return [{ [unowned self] in
        if replace {
          guard self.settable(self.e, "AXSelectedTextRange") else { return nil }
          let n = self.a.attrs(self.e)?.numberOfCharacters ?? (before ?? "").utf16.count
          let r = self.a.set(self.e, "AXSelectedTextRange", NSValue(range: NSRange(location: 0, length: n)))
          if r != .success {
            if r == .invalidElement { self.code = "stale_ref"; self.halted = true }
            if r == .apiDisabled { self.code = "no_permission"; self.halted = true }
            let p = self.a.probe(self.e)
            let d = gradeStep(r, before: p, after: p, readbackRole: false, stateChecked: nil)
            return ("AXSelectedTextRange", d == .notDelivered ? .notDelivered : .uncertain)
          }
        }
        let focusedHere: () -> Bool? = {
          guard contains() == true, self.a.probe(self.e).focusedKey == self.a.key(self.e) else { return nil }
          return true
        }
        var keys = AXResult.success
        let d = self.attempt(capMs: ActTiming.settleMs, effect: false, state: focusedHere) {
          keys = self.a.typeViaKeys(self.e, text)
          return keys
        }
        if replace && d == .notDelivered && keys != .invalidElement { return ("keys", self.afterPartial(keys)) }
        return ("keys", d)
      }]
    }
    let exact: () -> Bool? = { [unowned self] in self.a.attrs(self.e)?.value == expect ? true : nil }
    var chain: [Step] = []
    if !replace { chain.append(setStep(e, "AXSelectedText", { text }, cap: ActTiming.settleMs, effect: false, state: contains)) }
    chain.append(setStep(e, "AXValue", { expect }, cap: ActTiming.settleMs, effect: false, state: exact))
    return chain
  }

  // MARK: set

  func setSteps(_ want: String, kind: AXValueKind?) -> [Step]? {
    let v: Any
    switch kind {
    case .number?:
      guard let d = Double(want) else { return nil }
      v = d == d.rounded() && abs(d) < 1e15 ? NSNumber(value: Int64(d)) : NSNumber(value: d)
    case .bool?:
      guard let b = parseBool(want) else { return nil }
      v = NSNumber(value: b)
    default:
      v = want
    }
    let readback: () -> Bool? = { [unowned self] in
      let now = self.a.attrs(self.e)?.value
      return sameValue(now, want, kind: kind) ? true : nil
    }
    let write = setStep(e, "AXValue", { v }, cap: ActTiming.settleMs, effect: false, state: readback)
    let increments: Step = { [unowned self] in
      guard let target = Double(want), var cur = self.a.attrs(self.e)?.value.flatMap(Double.init) else { return nil }
      var moved = false
      for _ in 0..<ActTiming.maxIncrements {
        if sameNumber(cur, target) { break }
        let up = target > cur
        let act = up ? "AXIncrement" : "AXDecrement"
        guard self.advertises(self.e, act) else { break }
        let from = cur
        let d = self.attempt(capMs: ActTiming.settleMs, effect: false, state: {
          guard let n = self.a.attrs(self.e)?.value.flatMap(Double.init) else { return nil }
          return n != from ? true : nil
        }) { self.a.perform(self.e, act) }
        guard d == .deliveredVerified, let n = self.a.attrs(self.e)?.value.flatMap(Double.init) else {
          if !moved { return (act, d) }
          return (act, d == .uncertain ? .uncertain : .deliveredUnverified)
        }
        moved = true
        cur = n
        if (up && n > target && !sameNumber(n, target)) || (!up && n < target && !sameNumber(n, target)) {
          return (act, .deliveredUnverified)  // overshot: stop, never walk back
        }
      }
      if sameNumber(cur, target) { return (moved ? "AXIncrement/AXDecrement" : "already", .deliveredVerified) }
      return moved ? ("AXIncrement/AXDecrement", .deliveredUnverified) : nil
    }
    return [write, increments]
  }

  // MARK: focus

  func focusedWithin() -> Bool {
    if a.attrs(e)?.focused == true { return true }
    guard let f = a.probe(e).focusedKey else { return false }
    var level = [e], budget = 64
    for _ in 0...ActTiming.focusDescent {
      var next: [A.E] = []
      for x in level {
        if a.key(x) == f { return true }
        budget -= 1
        if budget <= 0 { return false }
        next += a.children(x)
      }
      level = next
    }
    return false
  }

  // MARK: toggle

  func toggleState() -> Bool? {
    guard let at = a.attrs(e) else { return nil }
    if let b = parseBool(at.value) { return b }
    return nil
  }

  // MARK: expand

  func expandSteps(_ want: Bool) -> [Step] {
    let current = a.attrs(e)?.expanded
    let state: () -> Bool? = { [unowned self] in self.a.attrs(self.e)?.expanded.map { $0 == want } }
    var chain = [performStep(e, want ? "AXExpand" : "AXCollapse", cap: ActTiming.expandMs, state: state),
                 setStep(e, "AXExpanded", { NSNumber(value: want) }, cap: ActTiming.expandMs, state: state)]
    if current == !want { chain.append(performStep(e, "AXPress", cap: ActTiming.expandMs, state: state)) }
    return chain
  }

  // MARK: select (dropdown)

  func findMenuItem(_ want: String) -> (item: A.E?, menu: A.E?) {
    var queue: [(A.E, Int)] = [(e, 0)], seen = Set<AnyHashable>(), n = 0, menu: A.E?
    while !queue.isEmpty, n < ActTiming.menuSearchNodes {
      let (x, d) = queue.removeFirst()
      guard seen.insert(a.key(x)).inserted, let at = a.attrs(x) else { continue }
      n += 1
      if at.role == "AXMenu" && menu == nil { menu = x }
      if at.role == "AXMenuItem", at.actions.contains("AXPress"),
         [at.title, at.description].contains(where: { $0?.caseInsensitiveCompare(want) == .orderedSame }) {
        return (x, menu)
      }
      if d < ActTiming.menuSearchDepth { queue += a.children(x).map { ($0, d + 1) } }
    }
    return (nil, menu)
  }

  func selectSteps(_ want: String) -> [Step] {
    let valueIs: () -> Bool = { [unowned self] in
      self.a.attrs(self.e)?.value?.caseInsensitiveCompare(want) == .orderedSame
    }
    let write = setStep(e, "AXValue", { want }, cap: ActTiming.menuMs, effect: false, state: {
      valueIs() ? true : nil
    })
    let viaMenu: Step = { [unowned self] in
      guard let open = ["AXShowMenu", "AXPress"].first(where: { self.advertises(self.e, $0) }) else { return nil }
      let d = self.attempt(capMs: ActTiming.menuMs, effect: false, state: { self.a.probe(self.e).menuOpen ? true : nil }) {
        self.a.perform(self.e, open)
      }
      guard d == .deliveredVerified else { return (open, d) }  // no menu seen: unverified, stop
      let (item, menu) = self.findMenuItem(want)
      let cancel = {
        if let m = menu, self.advertises(m, "AXCancel") { _ = self.a.perform(m, "AXCancel") }
        else if self.advertises(self.e, "AXCancel") { _ = self.a.perform(self.e, "AXCancel") }
      }
      guard let item else {
        cancel()
        self.code = "not_found"
        return ("\(open)+pick", .deliveredUnverified)
      }
      let p = self.attempt(capMs: ActTiming.menuMs, effect: false, state: {
        valueIs() || !self.a.probe(self.e).menuOpen ? true : nil
      }) { self.a.perform(item, "AXPress") }
      if p == .notDelivered { cancel(); return ("\(open)+pick", .deliveredUnverified) }
      return ("\(open)+pick", p)
    }
    return a.attrs(e)?.role == "AXComboBox" ? [write, viaMenu] : [viaMenu]
  }

  // MARK: scroll

  func scrollBar(vertical: Bool) -> A.E? {
    let at = a.attrs(e)
    if at?.role == "AXScrollBar" { return e }
    let area = at?.role == "AXScrollArea" ? e
      : ancestors(ActTiming.scrollAreaAncestors).first(where: { a.attrs($0)?.role == "AXScrollArea" })
    guard let area else { return nil }
    return a.children(area).first { k in
      guard let ka = a.attrs(k), ka.role == "AXScrollBar", let f = ka.frame else { return false }
      return (f.height > f.width) == vertical
    }
  }

  func scrollSteps(_ dir: String, _ n: Int) -> [Step]? {
    guard ["up", "down", "left", "right"].contains(dir) else { return nil }
    let forward = dir == "down" || dir == "right"
    guard let bar = scrollBar(vertical: dir == "up" || dir == "down") else { return [] }
    let before = a.attrs(bar)?.value
    let moved: () -> Bool? = { [unowned self] in
      guard let v = self.a.attrs(bar)?.value, before != nil, v != before else { return nil }
      return true
    }
    let act = forward ? "AXIncrement" : "AXDecrement"
    let steps: Step = { [unowned self] in
      guard self.advertises(bar, act) else { return nil }
      var later: AXResult?
      let d = self.attempt(capMs: ActTiming.settleMs, effect: false, state: moved) {
        let first = self.a.perform(bar, act)
        guard first == .success else { return first }
        for _ in 1..<max(n, 1) {
          let r = self.a.perform(bar, act)
          if r != .success { later = r; break }
        }
        return .success
      }
      return (act, later.map { self.afterPartial($0) } ?? d)  // partial: never verified, never retry-safe
    }
    let value: Step = { [unowned self] in
      guard self.settable(bar, "AXValue"), let cur = before.flatMap(Double.init) else { return nil }
      let next = min(1, max(0, cur + (forward ? 0.1 : -0.1) * Double(n)))
      return ("AXValue", self.attempt(capMs: ActTiming.settleMs, effect: false, state: moved) {
        self.a.set(bar, "AXValue", NSNumber(value: next))
      })
    }
    return [steps, value]
  }
}

// MARK: - Action chains

/// Runs one semantic action as a fallback chain (spec §6.4). Never calls an action the element doesn't
/// advertise nor writes an attribute that isn't settable; only not_delivered / delivered_without_effect
/// fall through to the next step, so nothing is ever done twice.
func runChain<A: AXActor>(_ a: A, _ e: A.E, _ r: ActRequest) -> ActOutcome {
  let c = ChainRunner(a, e)
  guard let at = a.attrs(e) else { return c.fail("stale_ref") }
  let raw = at.role ?? ""
  let role = normalizeRole(role: raw, subrole: at.subrole)
  let secure = raw == "AXSecureTextField" || at.subrole == "AXSecureTextField"

  switch r.action {
  case "click":
    return c.run(c.clickSteps())

  case "menu":
    return c.run(c.menuSteps())

  case "type":
    guard role == "textfield" || raw == "AXComboBox" else { return c.fail("unsupported") }
    if secure { return c.fail("secure_input") }
    guard let text = r.text, !text.isEmpty else { return c.fail("invalid_args") }
    return c.run(c.typeSteps(text, replace: r.replace))

  case "set":
    if secure { return c.fail("secure_input") }
    guard let want = r.value, let chain = c.setSteps(want, kind: at.valueKind) else { return c.fail("invalid_args") }
    return c.run(chain)

  case "focus":
    return c.run([c.setStep(e, "AXFocused", { NSNumber(value: true) }, cap: ActTiming.settleMs, effect: false,
                            state: { c.focusedWithin() })])

  case "toggle":
    let toggleable = toggleRoles.contains(role) || at.subrole == "AXToggleButton"
    guard toggleable else { return c.fail("unsupported") }
    let current = c.toggleState()
    var target: Bool?
    if let v = r.value {
      guard let b = parseBool(v) else { return c.fail("invalid_args") }
      target = b
    } else {
      target = current.map { !$0 }
    }
    if let t = target, current == t { return ActOutcome(delivery: .deliveredVerified, steps: [("already", .deliveredVerified)], code: nil) }
    if role == "radiobutton" && target == false { return c.fail("unsupported") }
    guard let want = target else { return c.run(c.clickSteps(cap: ActTiming.toggleMs)) }
    let state: () -> Bool? = {
      guard let now = c.toggleState() else { return nil }
      if now == want { return true }
      return now == current ? false : nil
    }
    let numeric = at.valueKind == .number
    let write = c.setStep(e, "AXValue", { numeric ? NSNumber(value: want ? 1 : 0) : NSNumber(value: want) },
                          cap: ActTiming.toggleMs, effect: false, state: state)
    return c.run([write] + c.clickSteps(state: state, cap: ActTiming.toggleMs))

  case "expand", "collapse":
    let want = r.action == "expand"
    if at.expanded == want { return ActOutcome(delivery: .deliveredVerified, steps: [("already", .deliveredVerified)], code: nil) }
    return c.run(c.expandSteps(want))

  case "select":
    guard let want = r.value, !want.isEmpty else { return c.fail("invalid_args") }
    return c.run(c.selectSteps(want))

  case "scroll":
    guard let chain = c.scrollSteps(r.direction ?? "", min(max(r.amount, 1), 20)) else { return c.fail("invalid_args") }
    return c.run(chain)

  case "scrollTo":
    return c.run([c.performStep(e, "AXScrollToVisible", cap: ActTiming.settleMs)])

  case "submit":
    // AXConfirm or nothing (never a sneaky Return); the effect is not judged.
    return c.run([c.performStep(e, "AXConfirm", cap: 0, effect: false)])

  default:
    return c.fail("unsupported")
  }
}

// MARK: - Keys: menu shortcuts and blocked combos

private func canonicalMod(_ m: String) -> String? {
  switch m.lowercased() {
  case "cmd", "command", "meta": return "cmd"
  case "shift": return "shift"
  case "alt", "opt", "option": return "alt"
  case "ctrl", "control": return "ctrl"
  default: return nil
  }
}

private func canonicalKey(_ k: String) -> String {
  let l = k.lowercased()
  switch l {
  case "esc": return "escape"
  case "backspace": return "delete"
  case "enter": return "return"
  default: return l
  }
}

/// A menu item answers the combo: enabled, same AXMenuItemCmdChar (case-insensitive) and an
/// AXMenuItemCmdModifiers mask equal to the combo's (shift=1, opt=2, ctrl=4, no-cmd=8; absent = 0).
/// Plain keys (no modifier) never go to the menu bar.
func menuMatch(cmdChar: String?, cmdModifiers: Int?, enabled: Bool?, mods: Set<String>, key: String) -> Bool {
  guard enabled == true, !mods.isEmpty, let ch = cmdChar, !ch.isEmpty else { return false }
  var m = Set<String>()
  for x in mods {
    guard let c = canonicalMod(x) else { return false }
    m.insert(c)
  }
  let k = canonicalKey(key)
  let keyChar = k == "space" ? " " : k
  guard keyChar.count == 1, ch.lowercased() == keyChar else { return false }
  let want = (m.contains("shift") ? 1 : 0) | (m.contains("alt") ? 2 : 0) | (m.contains("ctrl") ? 4 : 0) | (m.contains("cmd") ? 0 : 8)
  return (cmdModifiers ?? 0) == want
}

/// Quit / log out / force quit / empty trash (spec §6.6). Aliases folded, order-free, superset match.
/// No override exists.
private let blockedCombos: [(mods: Set<String>, key: String)] = [
  (["cmd"], "q"), (["cmd", "shift"], "q"), (["cmd", "alt"], "escape"), (["ctrl", "cmd"], "q"),
  (["cmd", "shift"], "delete"), (["cmd", "alt", "shift"], "q"),
]

func isBlockedCombo(mods: Set<String>, key: String) -> Bool {
  let m = Set(mods.compactMap(canonicalMod))
  let k = canonicalKey(key)
  return blockedCombos.contains { $0.key == k && m.isSuperset(of: $0.mods) }
}
