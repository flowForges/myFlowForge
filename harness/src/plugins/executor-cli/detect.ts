// 安装、版本、登录、Codex 自检(04 spec §11、§8.1)。探测不抛错;拿不准的一律往窄的方向算
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { runCli } from '../../lib/proc/runCli'
import type { SandboxStatus } from '../../protocol/index'
import type { ExecutorIsolation } from '../../protocol/tools'
import type { Adapter, BuildInput } from './adapters/types'

export const PROBE_TIMEOUT_MS = 10_000
const MAX_PROBE_OUTPUT = 64 * 1024
const MAX_VERSION = 100
/** 连接事件和子进程退出可能落在同一拍,读计数前让它先到 */
const LISTENER_SETTLE_MS = 50

const SELFTEST_FAILED = 'codex_selftest'
const NETWORK_ON = 'codex_network'

type Level = SandboxStatus['level']

export interface ExecutorInfo {
  id: string
  installed: boolean
  version?: string
  auth: 'ok' | 'missing' | 'unknown'
  isolation: ExecutorIsolation
  missing: string[]
  path?: string
}

/** code null = 没跑完(起不来、超时、被信号杀) */
export interface ProbeResult {
  code: number | null
  out: string
}

export interface DetectConfig {
  disabled?: string[]
  codex?: { network?: boolean }
}

export interface DetectDeps {
  /** shellEnv + adapter.passEnv */
  env: NodeJS.ProcessEnv
  run(file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<ProbeResult>
  sandboxLevel(): Level
  platform: NodeJS.Platform
  /** 自检临时目录的上级;不能在 denyRead 里面 */
  tmp(): string
  policy(): { denyRead: string[] }
  config(): DetectConfig
}

/** PATH 上第一个可执行文件的绝对路径。相对条目相对工作目录解析,仓库里放一个就会被执行 */
export function findBin(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return undefined
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue
    const file = join(dir, name)
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK)
        return file
      }
    } catch {
      // 没有,或不可执行:接着找
    }
  }
  return undefined
}

/**
 * 默认的 run:stdout 和 stderr 合在一起(`codex login status` 写 stderr),超时走短梯。
 * cwd 用根目录:探测跑在沙箱外,不能受仓库里的文件影响
 */
export async function runProbe(file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  let out = ''
  const add = (line: string) => {
    if (out.length < MAX_PROBE_OUTPUT) out += `${line}\n`
  }
  const r = await runCli({ file, args, env }, {
    cwd: '/',
    timeoutMs,
    idleMs: timeoutMs,
    signal: new AbortController().signal,
    fast: () => true,
    onLine: add,
    onStderrLine: add,
  })
  const finished = !r.timedOut && !r.stalled && !r.cancelled && !r.killFailed && r.spawnError === undefined
  return { code: finished ? r.code : null, out }
}

async function probe(deps: DetectDeps, file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  try {
    return await deps.run(file, args, PROBE_TIMEOUT_MS, env)
  } catch {
    return { code: null, out: '' }
  }
}

/**
 * 参数:$1 假凭据、$2 同目录的对照文件、$3 cwd 外的目录、$4 本机监听端口。路径不拼进脚本,不用引用。
 * 对照文件读不了时报 r=0:什么都读不了不等于凭据被挡住。
 * 重定向失败在 POSIX sh 的内建命令上会让 shell 退出,所以写操作都放进子 shell。
 * curl 不读 ~/.curlrc、不走代理:连接要落到监听方那里才算数;没有 curl 时这行只看监听方(C14)
 */
export const SELF_TEST_SCRIPT = [
  'if /bin/cat "$2" >/dev/null 2>&1; then /bin/cat "$1" >/dev/null 2>&1; echo "secret_read r=$?"; else echo "secret_read r=0"; fi',
  '(echo x > ./mffai-probe) 2>/dev/null; echo "cwd_write r=$?"',
  '(echo x > "$3/mffai-probe") 2>/dev/null; echo "outside_write r=$?"',
  '(echo x >> .git/config) 2>/dev/null; echo "git_write r=$?"',
  '(echo x > "$TMPDIR/mffai-probe") 2>/dev/null; echo "tmp_write r=$?"',
  'curl -q -s -o /dev/null --noproxy "*" --connect-timeout 2 "http://127.0.0.1:$4/" >/dev/null 2>&1; echo "net_connect r=$?"',
].join('\n')

function openListener(): Promise<{ server: Server; port: number; connections(): number }> {
  return new Promise((resolve, reject) => {
    let seen = 0
    const server = createServer(socket => {
      seen++
      socket.destroy()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      resolve({ server, port: address.port, connections: () => seen })
    })
  })
}

const closeServer = (server: Server) => new Promise<void>(res => server.close(() => res()))

export interface SelfTestResult {
  /** 没过的行;测不了时是 `setup` 或 `exit` */
  failed: string[]
  /** 确实跑完了。超时或临时目录建不了不算结论,不进缓存 */
  conclusive: boolean
}

/**
 * 跑的就是真实运行的权限档。secret 的路径取 realpath:权限档不解析链接,macOS 的 /var 是链接。
 * TMPDIR 单独一个目录:`:tmpdir` 可写,cwd 外的探针不能落在它下面
 */
export async function runSelfTest(adapter: Adapter, file: string, deps: DetectDeps): Promise<SelfTestResult> {
  let root: string | undefined
  let server: Server | undefined
  try {
    if (!adapter.selfTest) return { failed: ['setup'], conclusive: true }
    const made = mkdtempSync(join(deps.tmp(), 'mffai-selftest-'))
    root = made
    const base = realpathSync(made)
    const [dir, tmp, home, outside] = ['cwd', 'tmp', 'home', 'outside'].map(d => join(base, d))
    for (const d of [join(dir, '.git'), tmp, home, outside]) mkdirSync(d, { recursive: true })
    writeFileSync(join(dir, '.git', 'config'), '[core]\n')
    const secret = join(base, 'secret')
    const control = join(base, 'control')
    writeFileSync(secret, 'SECRET\n', { mode: 0o600 })
    writeFileSync(control, 'control\n', { mode: 0o600 })

    const listener = await openListener()
    server = listener.server
    const test = adapter.selfTest({ dir, secret, flags: [], denyRead: deps.policy().denyRead })
    const args = [...test.args, '/bin/sh', '-c', SELF_TEST_SCRIPT, 'mffai-selftest', secret, control, outside, String(listener.port)]
    const r = await probe(deps, file, args, { ...deps.env, CODEX_HOME: home, TMPDIR: tmp })
    await new Promise(res => setTimeout(res, LISTENER_SETTLE_MS))

    const failed = test.parse(r.out)
    if (listener.connections() > 0 && !failed.includes('net_connect')) failed.push('net_connect')
    if (r.code !== 0) failed.push('exit')
    return { failed, conclusive: r.code !== null }
  } catch {
    return { failed: ['setup'], conclusive: false }
  } finally {
    if (server) await closeServer(server)
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // 清不掉只留一个空的探针目录,不影响结论
      }
    }
  }
}

/** path + 版本 → 过了没有 */
const selfTests = new Map<string, boolean>()

async function selfTestPassed(adapter: Adapter, file: string, version: string | undefined, deps: DetectDeps): Promise<boolean> {
  const key = `${file}\0${version}`
  const known = version === undefined ? undefined : selfTests.get(key)
  if (known !== undefined) return known
  const { failed, conclusive } = await runSelfTest(adapter, file, deps)
  const passed = failed.length === 0
  if (conclusive && version !== undefined) selfTests.set(key, passed)
  return passed
}

/** 第一行非空输出,去掉控制字符:这个值会进 RPC 结果 */
function versionLine(out: string): string | undefined {
  const line = out.split('\n').map(l => l.replace(/\p{C}/gu, '').trim()).find(l => l !== '')
  return line?.slice(0, MAX_VERSION)
}

const absent = (id: string, ...missing: string[]): ExecutorInfo => ({ id, installed: false, auth: 'unknown', isolation: 'none', missing })

/** 这次运行的隔离。paths 只有探测本身可以不给:权限档落不落得实要看 cwd 和这次的规则路径 */
export function isolationOf(
  adapter: Adapter,
  info: ExecutorInfo,
  level: Level,
  config: DetectConfig,
  paths: Pick<BuildInput, 'cwd' | 'denyRead' | 'readOnlyPaths'> | undefined,
): { isolation: ExecutorIsolation; missing: string[] } {
  const result = (isolation: ExecutorIsolation, ...codes: string[]) => ({ isolation, missing: [...new Set([...info.missing, ...codes])] })
  if (!info.installed) return result('none')
  if (adapter.isolationKind === 'wrap') return result(level === 'none' ? 'none' : 'wrapped')
  if (config.codex?.network) return result('none', NETWORK_ON)
  // 开着网络探测时没跑自检:现在关了也不算通过,要重新探测
  if (info.missing.includes(SELFTEST_FAILED) || info.missing.includes(NETWORK_ON)) return result('none', SELFTEST_FAILED)
  const gaps = (paths && adapter.profileGaps?.(paths)) ?? []
  return gaps.length > 0 ? result('none', ...gaps) : result('own')
}

export async function detectExecutor(adapter: Adapter, deps: DetectDeps): Promise<ExecutorInfo> {
  try {
    const config = deps.config()
    if (deps.platform === 'win32') return absent(adapter.id, 'unsupported')
    if (config.disabled?.includes(adapter.id)) return absent(adapter.id, 'disabled')
    const path = findBin(adapter.bin, deps.env, deps.platform)
    if (!path) return absent(adapter.id, 'not_installed')

    const v = await probe(deps, path, ['--version'], deps.env)
    if (v.code !== 0) return { ...absent(adapter.id, 'not_runnable'), path }
    const version = versionLine(v.out)

    const login = await probe(deps, path, adapter.loginArgs, deps.env)
    const parsed = login.code === null ? 'unknown' : adapter.parseLogin(login.out)
    // 退出码说失败、文字说登录了:读不懂
    const auth = parsed === 'ok' && login.code !== 0 ? 'unknown' : parsed

    const missing: string[] = []
    if (adapter.isolationKind === 'translate' && !config.codex?.network && !(await selfTestPassed(adapter, path, version, deps))) missing.push(SELFTEST_FAILED)
    const info: ExecutorInfo = { id: adapter.id, installed: true, ...(version === undefined ? {} : { version }), auth, isolation: 'none', missing, path }
    return { ...info, ...isolationOf(adapter, info, deps.sandboxLevel(), config, undefined) }
  } catch {
    return absent(adapter.id, 'detect_failed')
  }
}
