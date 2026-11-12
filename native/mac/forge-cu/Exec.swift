// forge-cu exec -- <abs bin> <args…>   (spec V3)
//
// Replaces this process with <bin> (POSIX_SPAWN_SETEXEC: same pid, same fds, same environ) with the
// responsibility disclaimed, so <bin> and its whole tree stop borrowing myFlowForge's Accessibility /
// Screen Recording grant. No caller check: this mode can only ever drop privileges.
import Foundation

private typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

private func die(_ msg: String) -> Never {
  FileHandle.standardError.write(Data("forge-cu exec: \(msg)\n".utf8))
  exit(127)
}

func runExec(path: String, args: [String]) -> Never {
  let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { strdup($0) } + [nil]
  let RTLD_DEFAULT_HANDLE = UnsafeMutableRawPointer(bitPattern: -2)
  guard let sym = dlsym(RTLD_DEFAULT_HANDLE, "responsibility_spawnattrs_setdisclaim") else {
    // no disclaim on this system: plain exec keeps behaviour (the CLI still starts)
    execv(path, argv)
    die("execv \(path) failed (errno \(errno))")
  }
  let disclaim = unsafeBitCast(sym, to: DisclaimFn.self)
  var attr: posix_spawnattr_t?
  guard posix_spawnattr_init(&attr) == 0 else { die("posix_spawnattr_init failed") }
  guard posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC)) == 0 else { die("setflags failed") }
  guard disclaim(&attr, 1) == 0 else { die("disclaim failed") }
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, path, nil, &attr, argv, environ)
  // with SETEXEC posix_spawn only returns on failure
  die("posix_spawn \(path) failed (\(rc))")
}
