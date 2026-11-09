import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SOCK_MAX_BYTES = 103 // macOS sun_path 104 含结尾 0

export function dataDir(home: string = homedir()): string {
  return join(home, '.myFlowForge', 'mff-ai')
}

const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)

/** 钥匙串 / Secret Service 里的服务名(kernel/secrets 用同一个) */
export const SECRETS_SERVICE = 'myflowforge-mffai'

/** 主密钥在钥匙串里的账号:数据目录的 sha8。app 的删除全部数据按它删 */
export function secretsAccountOf(dataDir: string): string {
  return sha8(dataDir)
}

/**
 * 开机自启的三个标识(08 §18、评审修订 R12)。home 的默认数据目录 → 今天的固定值,逐字节不变;
 * 别的数据目录(并排的测试包、MFFAI_DATA_DIR)加 sha8,两个包开自启不会互相覆盖
 */
export function autostartIds(dir: string, home: string = homedir()): { launchd: string; systemd: string; winRun: string } {
  if (dir === dataDir(home)) return { launchd: 'com.myflowforge.mffai', systemd: 'mffai.service', winRun: 'myFlowForge-mffai' }
  const h = secretsAccountOf(dir)
  return { launchd: `com.myflowforge.mffai.${h}`, systemd: `mffai-${h}.service`, winRun: `myFlowForge-mffai-${h}` }
}

/** 数据目录和它的三个兄弟目录(和 lib 的 worktreeRootOf、imWorktreeRootOf、pluginStoreRootOf 一致,测试钉住) */
export function dataRoots(dataDir: string): { data: string; worktrees: string; imWorktrees: string; plugins: string } {
  return { data: dataDir, worktrees: `${dataDir}-worktrees`, imWorktrees: `${dataDir}-im-worktrees`, plugins: `${dataDir}-plugins` }
}

export interface RuntimePaths {
  workerAddr: string
  controlAddr: string
  token: string
  supervisorJson: string
  /** app 最后给的代理(0600,可含账号;只给监管进程读写,不进日志和 RPC) */
  proxy: string
  startVbs: string
  db: string
  logs: string
  config: string
}

export function runtimePaths(dir: string, platform: NodeJS.Platform = process.platform): RuntimePaths {
  const run = join(dir, 'run')
  const h = sha8(dir)
  const addr = (name: 'worker' | 'control'): string => {
    if (platform === 'win32') return `\\\\.\\pipe\\mffai-${name}-${h}`
    const p = join(run, `${name}.sock`)
    return Buffer.byteLength(p) > SOCK_MAX_BYTES ? join(tmpdir(), `mffai-${h}-${name}.sock`) : p
  }
  return {
    workerAddr: addr('worker'),
    controlAddr: addr('control'),
    token: join(run, 'token'),
    supervisorJson: join(run, 'supervisor.json'),
    proxy: join(run, 'proxy.json'),
    startVbs: join(run, 'start.vbs'),
    db: join(dir, 'db', 'events.sqlite'),
    logs: join(dir, 'logs'),
    config: join(dir, 'config.json'),
  }
}

const TOKEN_RE = /^[0-9a-f]{64}$/

function readValid(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8').trim()
    return TOKEN_RE.test(t) ? t : null
  } catch {
    return null
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function ensureToken(file: string): string {
  mkdirSync(dirname(file), { recursive: true })
  let t = readValid(file)
  // 可能撞上并发写入的半成品:短暂重试
  for (let i = 0; !t && existsSync(file) && i < 5; i++) {
    sleepSync(20)
    t = readValid(file)
  }
  if (!t) {
    t = randomBytes(32).toString('hex')
    // 临时文件 + rename:读者不会看到半截文件
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, t, { mode: 0o600 })
    renameSync(tmp, file)
    return readValid(file) ?? t
  }
  if (process.platform !== 'win32') {
    try {
      if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600)
    } catch { /* 忽略 */ }
  }
  return t
}
