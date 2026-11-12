// forge-cu exec -- <abs bin> <args…>   (spec V3)
//
// Replaces this process with <bin> (POSIX_SPAWN_SETEXEC: same pid, same fds, same environ) with the
// responsibility disclaimed, so <bin> and its whole tree stop borrowing myFlowForge's Accessibility /
// Screen Recording grant. No caller check: this mode can only ever drop privileges.
import Foundation

/// Exit code when the disclaim SPI is missing (the app reads `status.disclaim` to refuse computer use).
let EXIT_NO_DISCLAIM: Int32 = 125

func disclaimAvailable() -> Bool { dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") != nil }

private typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

private func die(_ msg: String) -> Never {
  FileHandle.standardError.write(Data("forge-cu exec: \(msg)\n".utf8))
  exit(127)
}

func runExec(path: String, args: [String]) -> Never {
  let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { strdup($0) } + [nil]
  let RTLD_DEFAULT_HANDLE = UnsafeMutableRawPointer(bitPattern: -2)
  guard let sym = dlsym(RTLD_DEFAULT_HANDLE, "responsibility_spawnattrs_setdisclaim") else {
    // Fail closed: never start the CLI undisclaimed (it would inherit the app's grants).
    FileHandle.standardError.write(Data("forge-cu exec: disclaim unavailable\n".utf8))
    exit(EXIT_NO_DISCLAIM)
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
