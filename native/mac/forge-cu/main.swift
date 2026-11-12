// forge-cu — myFlowForge's computer-use helper (spec §7.2, 评审修订 V3/V4/V7/V9/V13).
//
//   forge-cu --owner-pid <pid>          JSON lines on stdin/stdout, one request at a time
//   forge-cu exec -- <abs bin> <args…>  disclaimed exec (Exec.swift)
//
// Request `{id, op, ...}` → reply `{id, ok:true, ...fields}` / `{id, ok:false, code, message?}`.
// SIGUSR1 aborts the post in flight (it answers `code:'stopped'`); when idle the helper answers with an
// unsolicited `{event:'stopped'}` line. Exits on stdin EOF or when the parent changes (checked every 1 s).
import Foundation
import AppKit

private func realPath(_ p: String) -> String {
  guard let r = realpath(p, nil) else { return p }
  defer { free(r) }
  return String(cString: r)
}

private func pidPath(_ pid: pid_t) -> String? {
  var buf = [CChar](repeating: 0, count: 4096) // PROC_PIDPATHINFO_MAXSIZE
  let n = proc_pidpath(pid, &buf, UInt32(buf.count))
  guard n > 0 else { return nil }
  return realPath(String(cString: buf))
}

private let outLock = NSLock()
/// One JSON line to stdout. A closed pipe means the app is gone: exit.
private func emit(_ o: [String: Any]) {
  let d = encodeLine(o)
  outLock.lock(); defer { outLock.unlock() }
  d.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
    var off = 0
    while off < p.count {
      let n = write(1, p.baseAddress! + off, p.count - off)
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { exit(0) }
      off += n
    }
  }
}

private typealias RespFn = @convention(c) (pid_t) -> pid_t

/// `responsibility_get_pid_responsible_for_pid` (private libsystem SPI, present on macOS 10.14+).
private func responsiblePid(_ pid: pid_t) -> Int32? {
  guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
  let r = unsafeBitCast(sym, to: RespFn.self)(pid)
  return r > 0 ? r : nil
}

/// Decided once at start: may this helper show the TCC prompts?
private var mayRequest = false

private func handle(_ r: Request, _ poster: Poster, _ abort: AbortState) -> [String: Any] {
  let b = r.body
  switch r.op {
  case "status": return statusReply()
  case "clearAbort": return ["wasAborted": abort.clear()]
  case "request":
    guard mayRequest else { return errorReply(id: nil, code: "caller_refused") }
    return requestReply(b)
  case "capture": return captureReply(b)
  case "crop": return cropReply(b)
  case "hitTest":
    guard let x = num(b["xPt"]), let y = num(b["yPt"]) else { return errorReply(id: nil, code: "invalid_args") }
    return ["hit": hitTest(CGPoint(x: x, y: y))?.json ?? NSNull()]
  case "front": return frontReply()
  case "post": return poster.post(b)
  case "activate": return activateReply(b)
  case "release": return poster.release(b)
  case "idle": return idleReply(b)
  case "apps": return appsReply()
  default: return errorReply(id: nil, code: "invalid_args", message: "unknown op")
  }
}

/// Exit path for EOF / parent death: stop any post in flight and lift whatever we hold first.
private func leave(_ abort: AbortState, _ poster: Poster) -> Never {
  _ = abort.signal()
  poster.releaseHeld()
  exit(0)
}

private func drive(ownerPid: Int32) -> Never {
  configureAX()
  signal(SIGPIPE, SIG_IGN)
  let abort = AbortState()
  let poster = Poster(abort: abort)
  let sigSrc = installAbortSignal(abort, queue: DispatchQueue(label: "forge-cu.abort")) { emit(["event": "stopped"]) }

  // stdin on a background thread; the main thread keeps RunLoop.main turning so NSWorkspace's
  // frontmostApplication stays current (V7a).
  let reader = Thread {
    let lines = LineBuffer()
    while true {
      let d = FileHandle.standardInput.availableData
      if d.isEmpty { leave(abort, poster) } // EOF: the app closed our stdin
      for line in lines.feed(d) {
        guard let l = line, let req = parseRequest(l) else { emit(errorReply(id: nil, code: "invalid_args", message: "bad request")); continue }
        var reply = handle(req, poster, abort)
        if reply["ok"] == nil { reply["ok"] = true }
        if let id = req.id { reply["id"] = id }
        emit(reply)
      }
    }
  }
  reader.stackSize = 4 << 20
  reader.start()

  let watch = Timer(timeInterval: 1, repeats: true) { _ in if getppid() != ownerPid { leave(abort, poster) } }
  RunLoop.main.add(watch, forMode: .common)
  withExtendedLifetime(sigSrc) { RunLoop.main.run() }
  exit(0)
}

switch parseArgs(CommandLine.arguments) {
case .exec(let path, let args):
  runExec(path: path, args: args)
case .bad(let msg):
  FileHandle.standardError.write(Data("forge-cu: \(msg)\n".utf8))
  exit(CommandLine.arguments.dropFirst().first == "exec" ? 127 : 2)
case .drive(let owner):
  // V4 caller check: the parent must be the owner; inside an .app the parent must be that app's binary.
  let me = pidPath(getpid()) ?? realPath(CommandLine.arguments[0])
  let ppid = getppid()
  let parentPath = pidPath(ppid)
  let respSelf = responsiblePid(getpid())
  guard callerAllowed(selfPath: me, ownerPid: owner, ppid: ppid, parentPath: parentPath),
        responsibilityOK(selfPid: getpid(), respSelf: respSelf, respParent: responsiblePid(ppid)) else {
    FileHandle.standardError.write(Data("forge-cu: caller not allowed\n".utf8))
    exit(2)
  }
  mayRequest = requestAllowed(parentPath: parentPath, ppid: ppid, respSelf: respSelf)
  drive(ownerPid: owner)
}
