// forge-cu · ScreenCaptureKit capture of the main display, self-mask, vision code, JPEG; gate crops.
import Foundation
import CoreGraphics
import ScreenCaptureKit

private final class Box<T> { var v: T?; init() {} }

/// Captures `srcPt` (global points on the main display) at outW×outH pixels. Error = reply code.
private func captureMain(srcPt: CGRect, outW: Int, outH: Int) -> Result<CGImage, CaptureError> {
  guard #available(macOS 14.0, *) else { return .failure(CaptureError("os")) }
  // Never let capture be the thing that shows the Screen Recording prompt: only `request` may.
  guard CGPreflightScreenCaptureAccess() else { return .failure(CaptureError("no_permission")) }
  let sem = DispatchSemaphore(value: 0)
  let out = Box<CGImage>()
  let mainId = CGMainDisplayID()
  SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
    guard let display = content?.displays.first(where: { $0.displayID == mainId }) else { sem.signal(); return }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.width = outW
    cfg.height = outH
    cfg.showsCursor = true
    cfg.sourceRect = srcPt.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { img, _ in
      out.v = img
      sem.signal()
    }
  }
  guard sem.wait(timeout: .now() + 4) == .success, let img = out.v else { return .failure(CaptureError("helper_failed")) }
  return .success(img)
}

struct CaptureError: Error { let code: String; init(_ c: String) { code = c } }

private func masks(_ body: [String: Any]) -> [CGRect] {
  let pids = (body["maskPids"] as? [Any] ?? []).compactMap(int32)
  let prefixes = body["maskBundlePrefixes"] as? [String] ?? []
  return maskRects(onScreenWindows(), bundleOf: bundleOf, maskPids: pids, prefixes: prefixes)
}

private func cursorPt() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

func captureReply(_ body: [String: Any]) -> [String: Any] {
  let main = mainDisplayBounds()
  let src = rect(body["region"]).map { $0.intersection(main) } ?? main
  guard !src.isNull, src.width >= 1, src.height >= 1 else { return errorReply(id: nil, code: "invalid_args") }
  let backing = backingScale()
  let maxW = (body["maxW"] as? NSNumber)?.intValue ?? 1280, maxH = (body["maxH"] as? NSNumber)?.intValue ?? 1280
  let (w, h) = fitSize(srcW: Int(src.width * backing), srcH: Int(src.height * backing), maxW: maxW, maxH: maxH)
  let before = masks(body)
  let img: CGImage
  switch captureMain(srcPt: src, outW: w, outH: h) {
  case .failure(let e): return errorReply(id: nil, code: e.code)
  case .success(let i): img = i
  }
  // windows listed before and after the capture: one that moved or opened in between is still covered
  let all = before + masks(body)
  let blocked = all.map { $0.intersection(src) }.filter { !$0.isNull && !$0.isEmpty }
  var out = paintMasks(img, rectsPx: all.map { ptRectToPx($0, src: src, outW: img.width, outH: img.height) }) ?? img
  if let code = body["code"] as? String, !code.isEmpty { out = drawCode(out, code: code) ?? out }
  let q = num(body["quality"]) ?? 0.75
  guard let jpeg = jpegData(out, quality: q) else { return errorReply(id: nil, code: "helper_failed") }
  let c = cursorPt()
  var uniq: [CGRect] = []
  for r in blocked where !uniq.contains(r) { uniq.append(r) }
  return [
    "width": out.width, "height": out.height, "jpegBase64": jpeg.base64EncodedString(),
    "display": displaySig(), "cursor": ["x": Double(c.x), "y": Double(c.y)], "blocked": uniq.map(rectJSON),
  ]
}

/// Gate crop at physical resolution, own windows masked, markers drawn; `sig` = 32×32 gray of the
/// masked crop before markers (V9).
func cropReply(_ body: [String: Any]) -> [String: Any] {
  let main = mainDisplayBounds()
  guard let r = rect(body["rectPt"]) else { return errorReply(id: nil, code: "invalid_args") }
  let src = r.intersection(main)
  guard !src.isNull, src.width >= 1, src.height >= 1 else { return errorReply(id: nil, code: "invalid_args") }
  let backing = backingScale()
  let w = max(1, Int((src.width * backing).rounded())), h = max(1, Int((src.height * backing).rounded()))
  let before = masks(body)
  let img: CGImage
  switch captureMain(srcPt: src, outW: w, outH: h) {
  case .failure(let e): return errorReply(id: nil, code: e.code)
  case .success(let i): img = i
  }
  let all = before + masks(body)
  let masked = paintMasks(img, rectsPx: all.map { ptRectToPx($0, src: src, outW: img.width, outH: img.height) }) ?? img
  let sig = graySig(masked)
  let sx = CGFloat(img.width) / src.width, sy = CGFloat(img.height) / src.height
  let markers = (body["marker"] as? [Any] ?? []).compactMap(point).map { CGPoint(x: ($0.x - src.minX) * sx, y: ($0.y - src.minY) * sy) }
  let marked = paintMarkers(masked, pointsPx: markers) ?? masked
  guard let jpeg = jpegData(marked, quality: 0.85) else { return errorReply(id: nil, code: "helper_failed") }
  return ["jpegBase64": jpeg.base64EncodedString(), "sig": sig.base64EncodedString()]
}
