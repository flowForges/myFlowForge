// forge-cu · status, permission request, idle time. `status` never prompts (preflight APIs only).
import Foundation
import CoreGraphics
import ApplicationServices
import Carbon

func displaySig() -> [String: Any] {
  let id = CGMainDisplayID()
  let b = CGDisplayBounds(id)
  var backing = 1.0
  if let m = CGDisplayCopyDisplayMode(id), m.width > 0 { backing = Double(m.pixelWidth) / Double(m.width) }
  return ["id": Int(id), "widthPt": Double(b.width), "heightPt": Double(b.height), "backing": backing]
}

func backingScale() -> Double { displaySig()["backing"] as? Double ?? 1 }

/// No session dictionary (no window-server session) counts as locked and off console.
func sessionState() -> (locked: Bool, onConsole: Bool) {
  guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return (true, false) }
  let locked = (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
  let onConsole = (d[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue ?? false
  return (locked, onConsole)
}

func displayAsleep() -> Bool { CGDisplayIsAsleep(CGMainDisplayID()) != 0 }

/// Locked, off console or asleep: no input may be posted.
func inputBlockedBySession() -> Bool {
  let s = sessionState()
  return s.locked || !s.onConsole || displayAsleep()
}

func secureInputOn() -> Bool { IsSecureEventInputEnabled() }

func osVersion() -> (String, Bool) {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return ("\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", v.majorVersion >= 14)
}

func statusReply() -> [String: Any] {
  let (ver, ok) = osVersion()
  let s = sessionState()
  return [
    "osVersion": ver, "osOK": ok,
    "screen": CGPreflightScreenCaptureAccess(), "ax": AXIsProcessTrusted(),
    "locked": s.locked, "onConsole": s.onConsole, "asleep": displayAsleep(), "secureInput": secureInputOn(),
    "display": displaySig(), "disclaim": disclaimAvailable(),
  ]
}

/// Only ever sent when the user clicks 授权: these may show the system prompt.
func requestReply(_ body: [String: Any]) -> [String: Any] {
  switch body["kind"] as? String {
  case "screen": _ = CGRequestScreenCaptureAccess(); return [:]
  case "ax":
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
    return [:]
  default: return errorReply(id: nil, code: "invalid_args")
  }
}

func idleReply(_ body: [String: Any]) -> [String: Any] {
  let raw = idleEventTypeRaw(body["kind"] as? String ?? "any")
  guard let t = CGEventType(rawValue: raw) else { return errorReply(id: nil, code: "invalid_args") }
  return ["seconds": CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: t)]
}
