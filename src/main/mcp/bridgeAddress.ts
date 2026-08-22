import { tmpdir } from 'node:os'
import { posix } from 'node:path'

// Where a run's forge bridge listens, and where its per-agent MCP config files go.
//
// These are TWO answers, not one, because on Windows they diverge. Windows has no filesystem
// sockets: `net.listen(path)` there creates a NAMED PIPE, and the name must live under `\\.\pipe\`.
// Since the config file used to be written to dirname(socketPath), a pipe address would have sent it
// to `\\.\pipe` — not a writable directory — so the file has to be placed explicitly.

export interface BridgeAddress {
  /** What net.createServer().listen() / net.createConnection() takes. */
  socketPath: string
  /** A real, writable directory for the per-agent `mcp.<agent>.json` files. */
  configDir: string
  /** True when socketPath is a Windows named pipe: nothing to unlink, nothing on disk. */
  isPipe: boolean
}

// darwin's sun_path is 104 bytes and bind() TRUNCATES rather than failing, so an over-long path
// yields a socket the MCP child can never connect to. Stay well under it.
const SUN_PATH_LIMIT = 100

export function bridgeAddress(runDir: string, runId: string, platform: NodeJS.Platform = process.platform): BridgeAddress {
  if (platform === 'win32') {
    // Pipe names may not contain the path separators or the other reserved filename characters.
    const safeId = runId.replace(/[\\/:*?"<>|]/g, '_')
    return { socketPath: `\\\\.\\pipe\\forge-${safeId}`, configDir: runDir, isPipe: true }
  }
  // 用【目标平台】的规则拼,不用宿主的 —— 否则在 Windows 上给 POSIX 分支拼路径会拼出反斜杠。
  // (和 usage/claude.ts 里读凭据文件是同一条规则。)
  const candidate = posix.join(runDir, 'forge.sock')
  if (candidate.length <= SUN_PATH_LIMIT) return { socketPath: candidate, configDir: runDir, isPipe: false }
  return { socketPath: posix.join(tmpdir(), `forge-${runId}.sock`), configDir: tmpdir(), isPipe: false }
}
