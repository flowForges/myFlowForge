// forge-cu · accessibility core, pure logic. Foundation / CoreGraphics only: no ApplicationServices AX
// calls, no event posting. The real AX binding implements `AXSource` (AXLive.swift); the self-test
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
