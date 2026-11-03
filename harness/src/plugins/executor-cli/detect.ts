// 安装、版本、登录、Codex 自检(04 spec §11、§8.1)。探测不抛错;拿不准的一律往窄的方向算
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { isInside } from '../../lib/fs/paths'
import type { PgidRegistry } from '../../lib/proc/pgids'
import { runCli } from '../../lib/proc/runCli'
import { redact } from '../../lib/tools/redact'
import type { SandboxStatus } from '../../protocol/index'
import type { ExecutorIsolation } from '../../protocol/tools'
import type { Adapter, BuildInput } from './adapters/types'

export const PROBE_TIMEOUT_MS = 10_000
const MAX_PROBE_OUTPUT = 64 * 1024
/** 整行都得像版本号:这个值会进 RPC 结果,不能是 `warn: proxy http://user:pass@…` 这种碰巧排第一的行 */
const VERSION_LINE = /^(?:[A-Za-z][A-Za-z0-9._-]{0,40} ){0,2}v?\d+\.\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.+-]{1,60})?$/
/** 比它旧的才算崩溃留下的:同时可能有另一次探测在用 */
const STALE_SELFTEST_MS = 10 * 60_000
/** 连接事件和子进程退出可能落在同一拍,读计数前让它先到 */
const LISTENER_SETTLE_MS = 50

const SELFTEST_FAILED = 'codex_selftest'
const NETWORK_ON = 'codex_network'
const UNTRUSTED = 'untrusted_binary'

type Level = SandboxStatus['level']

export interface ExecutorInfo {
  id: string
  installed: boolean
  version?: string
  auth: 'ok' | 'missing' | 'unknown'
  isolation: ExecutorIsolation
  missing: string[]
  path?: string
  /** 探测之前取的 binaryKey:运行前比对,自检只对这个文件算数 */
  binaryKey?: string
}

/** code null = 没跑完(起不来、超时、被信号杀) */
export interface ProbeResult {
  code: number | null
  /** stdout 与 stderr 合在一起,只给解析用,不外传 */
  out: string
  /** 只有 stdout:版本号只从这里取 */
  stdout: string
}

/** 交给 run:进程登记(崩溃后能回收)与取消 */
export interface ProbeContext {
  signal?: AbortSignal
  pgids?: Pick<PgidRegistry, 'add' | 'settle'>
}

export interface DetectConfig {
  disabled?: string[]
  codex?: { network?: boolean }
}

export interface DetectDeps {
  /** shellEnv + adapter.passEnv */
  env: NodeJS.ProcessEnv
  run(file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv, context?: ProbeContext): Promise<ProbeResult>
  sandboxLevel(): Level
  platform: NodeJS.Platform
  /** 自检临时目录的上级;不能在 denyRead 里面 */
  tmp(): string
  policy(): { denyRead: string[] }
  config(): DetectConfig
  /** 内核关闭、插件停用时中止:杀掉在跑的探测,不再起新的 */
  signal?: AbortSignal
  pgids?: ProbeContext['pgids']
  /** executor.refresh:不用缓存的自检结果 */
  force?: boolean
  /** 只给测试:默认 process.getuid() */
  uid?: number
}

export interface TrustOpts {
  /** 会话的 cwd:里面的东西模型写得到。探测本身没有 cwd,运行前才给 */
  cwd?: string
  uid?: number
}

const realOr = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const ownerOk = (s: Stats, o: TrustOpts) => s.uid === (o.uid ?? process.getuid?.()) || s.uid === 0
const worldWritable = (s: Stats) => (s.mode & 0o002) !== 0
const inCwd = (p: string, o: TrustOpts) => o.cwd !== undefined && isInside(p, realOr(o.cwd), process.platform)

/** PATH 条目能不能信:绝对路径、存在、属主是用户或 root、其他人写不了、不在 cwd 里。组可写放行:Intel Mac 的 Homebrew 就是 */
function entryTrusted(entry: string, o: TrustOpts): boolean {
  if (!isAbsolute(entry)) return false
  try {
    const real = realpathSync(entry)
    const s = statSync(real)
    return s.isDirectory() && ownerOk(s, o) && !worldWritable(s) && !inCwd(entry, o) && !inCwd(real, o)
  } catch {
    return false
  }
}

/** 给探测的 PATH 用同样的条件:`#!/usr/bin/env node` 的包装脚本会走 PATH 找 node */
export function trustedPath(path: string | undefined, o: TrustOpts = {}): string {
  return (path ?? '').split(':').filter(e => entryTrusted(e, o)).join(':')
}

/**
 * 程序的 realpath 与它到 PATH 条目之间的每一层目录。程序一旦起来就在沙箱外,自检也骗得过(它控制自己的输出),
 * 所以选程序这一步是唯一的防线。realpath 不在条目下时一直查到根;中途的粘滞目录(/tmp)别人改不了里面的东西,放行
 */
export function binaryTrusted(file: string, entry: string, o: TrustOpts = {}): boolean {
  if (!entryTrusted(entry, o)) return false
  try {
    const stop = realpathSync(entry)
    const real = realpathSync(file)
    const s = statSync(real)
    if (!s.isFile() || !ownerOk(s, o) || worldWritable(s) || inCwd(real, o) || inCwd(file, o)) return false
    for (let dir = dirname(real); dir !== stop; dir = dirname(dir)) {
      const d = statSync(dir)
      if (!ownerOk(d, o) || (worldWritable(d) && (d.mode & 0o1000) === 0)) return false
      if (dir === dirname(dir)) break
    }
    return true
  } catch {
    return false
  }
}

/** 第一个能信的;都不能信时 untrusted 说明确实有这个程序 */
function locateBin(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, o: TrustOpts): { path?: string; untrusted: boolean } {
  let untrusted = false
  if (platform === 'win32') return { untrusted }
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!isAbsolute(dir)) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
    } catch {
      continue // 没有,或不可执行:接着找
    }
    if (binaryTrusted(file, dir, o)) return { path: file, untrusted: false }
    untrusted = true
  }
  return { untrusted }
}

/** PATH 上第一个能信的可执行文件的绝对路径 */
export function findBin(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, o: TrustOpts = {}): string | undefined {
  return locateBin(name, env, platform, o).path
}

/** 自检结果跟文件走,不跟程序自己报的版本号走:realpath + 大小 + 修改时间。读不了 → undefined */
export function binaryKey(file: string): string | undefined {
  try {
    const real = realpathSync(file)
    const s = statSync(real)
    return `${real}\0${s.size}\0${s.mtimeMs}`
  } catch {
    return undefined
  }
}

/** 运行前比对。true:Task 10 要在后台重新探测,这期间 isolationOf 已按没验证算 */
export function binaryChanged(info: Pick<ExecutorInfo, 'path' | 'binaryKey'>): boolean {
  return info.path === undefined || info.binaryKey === undefined || binaryKey(info.path) !== info.binaryKey
}

/** 选中的程序所在的目录(链接所在、realpath 所在),给 translate 的 protect */
export function binaryDirs(info: Pick<ExecutorInfo, 'path'>): string[] {
  return info.path === undefined ? [] : [...new Set([dirname(info.path), dirname(realOr(info.path))])]
}

/**
 * 默认的 run:stdout 和 stderr 合在一起(`codex login status` 写 stderr),超时走短梯。
 * cwd 用根目录:探测跑在沙箱外,不能受仓库里的文件影响
 */
export async function runProbe(file: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv, context: ProbeContext = {}): Promise<ProbeResult> {
  let out = ''
  let stdout = ''
  const add = (line: string) => {
    if (out.length < MAX_PROBE_OUTPUT) out += `${line}\n`
  }
  const r = await runCli({ file, args, env }, {
    cwd: '/',
    timeoutMs,
    idleMs: timeoutMs,
    signal: context.signal ?? new AbortController().signal,
    fast: () => true,
    onSpawn: pid => context.pgids?.add(pid),
    onClose: pid => context.pgids?.settle(pid),
    onLine: line => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += `${line}\n`
      add(line)
    },
    onStderrLine: add,
  })
  const finished = !r.timedOut && !r.stalled && !r.cancelled && !r.killFailed && r.spawnError === undefined
  return { code: finished ? r.code : null, out, stdout }
}

/** PATH 只留能信的条目:探测跑在沙箱外 */
async function probe(deps: DetectDeps, file: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  try {
    return await deps.run(file, args, PROBE_TIMEOUT_MS, { ...env, PATH: trustedPath(env.PATH, { uid: deps.uid }) }, { signal: deps.signal, pgids: deps.pgids })
  } catch {
    return { code: null, out: '', stdout: '' }
  }
}

/**
 * 参数:$1 假凭据、$2 同目录的对照文件、$3 cwd 外的目录、$4 列成 none 的目录、$5 本机监听端口。路径不拼进脚本,不用引用。
 * 对照文件读不了时报 r=0:什么都读不了不等于凭据被挡住。
 * rule_write、rule_read 是 cwd 里的 read、none 条目,secret_dir_read 是目录上的 none:`deny write(src/gen/**)` 这类规则在 own 下不问人,全靠它们。
 * 重定向失败在 POSIX sh 的内建命令上会让 shell 退出,所以写操作都放进子 shell。
 * curl 用绝对路径,不读 ~/.curlrc、不走代理:连接要落到监听方那里才算数;没有 curl 时这行只看监听方(C14)
 */
export const SELF_TEST_SCRIPT = [
  'if /bin/cat "$2" >/dev/null 2>&1; then /bin/cat "$1" >/dev/null 2>&1; echo "secret_read r=$?"; else echo "secret_read r=0"; fi',
  '(echo x > ./mffai-probe) 2>/dev/null; echo "cwd_write r=$?"',
  '(echo x > "$3/mffai-probe") 2>/dev/null; echo "outside_write r=$?"',
  '(echo x >> .git/config) 2>/dev/null; echo "git_write r=$?"',
  '(echo x > ./vendor/.git/hooks/mffai-probe) 2>/dev/null; echo "nested_git_hook r=$?"',
  '(echo x >> ./vendor/.git/config) 2>/dev/null; echo "nested_git_config r=$?"',
  '(/bin/mkdir -p ./.codex && echo x > ./.codex/config.toml) 2>/dev/null; echo "codex_config_write r=$?"',
  '(/bin/mkdir -p ./.qoder && echo x > ./.qoder/settings.json) 2>/dev/null; echo "qoder_config_write r=$?"',
  '(echo x > "$TMPDIR/mffai-probe") 2>/dev/null; echo "tmp_write r=$?"',
  '(echo x > ./ro/x) 2>/dev/null; echo "rule_write r=$?"',
  'if /bin/cat ./visible >/dev/null 2>&1; then /bin/cat ./hidden/x >/dev/null 2>&1; echo "rule_read r=$?"; else echo "rule_read r=0"; fi',
  'if /bin/cat "$2" >/dev/null 2>&1; then /bin/cat "$4/x" >/dev/null 2>&1; echo "secret_dir_read r=$?"; else echo "secret_dir_read r=0"; fi',
  '/usr/bin/curl -q -s -o /dev/null --noproxy "*" --connect-timeout 2 "http://127.0.0.1:$5/" >/dev/null 2>&1; echo "net_connect r=$?"',
].join('\n')

/** 从仓库子目录跑(`-C <cwd>/sub`):$1 是 cwd 外的目录,确认这一遍的写真的按 -C 算 */
export const SELF_TEST_SUBDIR_SCRIPT = [
  '(echo x > ./mffai-probe-sub) 2>/dev/null; echo "sub_cwd_write r=$?"',
  '(echo x > ../mffai-probe-parent) 2>/dev/null; echo "parent_write r=$?"',
  '(echo x > ../vendor/mffai-probe-sibling) 2>/dev/null; echo "sibling_write r=$?"',
].join('\n')

/** 只读运行那份档:cwd 写不了,但读得了 */
export const SELF_TEST_READ_ONLY_SCRIPT = [
  '(echo x > ./mffai-probe-ro) 2>/dev/null; echo "ro_cwd_write r=$?"',
  '/bin/cat ./visible >/dev/null 2>&1; echo "ro_cwd_read r=$?"',
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

/** 崩溃留下的:进程死了,finally 没跑到 */
function sweepStale(parent: string): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith('mffai-selftest-')) continue
    const dir = join(parent, name)
    if (Date.now() - statSync(dir).mtimeMs > STALE_SELFTEST_MS) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 真实运行用的同一张表,带上规则翻译依赖的条目,写模式和只读各跑一遍;前一遍没过就不跑后一遍。
 * 路径取 realpath:权限档不解析链接,macOS 的 /var 是链接。
 * TMPDIR 单独一个目录:`:tmpdir` 可写,cwd 外的探针不能落在它下面
 */
export async function runSelfTest(adapter: Adapter, file: string, deps: DetectDeps): Promise<SelfTestResult> {
  let root: string | undefined
  let server: Server | undefined
  try {
    if (!adapter.selfTest) return { failed: ['setup'], conclusive: true }
    sweepStale(deps.tmp())
    const made = mkdtempSync(join(deps.tmp(), 'mffai-selftest-'))
    root = made
    const base = realpathSync(made)
    const [dir, tmp, home, outside, secretDir] = ['cwd', 'tmp', 'home', 'outside', 'secret-dir'].map(d => join(base, d))
    const [readOnlyDir, hidden, sub] = [join(dir, 'ro'), join(dir, 'hidden'), join(dir, 'sub')]
    // cwd 要像真的仓库顶层(HEAD、objects、refs):子目录那一遍问的就是 Codex 认不认这个顶层
    const gits = [join(dir, '.git'), join(dir, 'vendor', '.git')]
    for (const d of [...gits.flatMap(g => [join(g, 'hooks'), join(g, 'objects'), join(g, 'refs')]), readOnlyDir, hidden, sub, tmp, home, outside, secretDir]) mkdirSync(d, { recursive: true })
    for (const g of gits) {
      writeFileSync(join(g, 'config'), '[core]\n')
      writeFileSync(join(g, 'HEAD'), 'ref: refs/heads/main\n')
    }
    const secret = join(base, 'secret')
    const control = join(base, 'control')
    for (const f of [secret, join(secretDir, 'x'), join(hidden, 'x')]) writeFileSync(f, 'SECRET\n', { mode: 0o600 })
    for (const f of [control, join(dir, 'visible')]) writeFileSync(f, 'control\n', { mode: 0o600 })

    const listener = await openListener()
    server = listener.server
    const denyRead = [...deps.policy().denyRead, secretDir, hidden]
    const env = { ...deps.env, CODEX_HOME: home, TMPDIR: tmp }
    const test = adapter.selfTest({ dir, secret, flags: [], denyRead, readOnlyPaths: [readOnlyDir] })
    const args = [...test.args, '/bin/sh', '-c', SELF_TEST_SCRIPT, 'mffai-selftest', secret, control, outside, secretDir, String(listener.port)]
    const r = await probe(deps, file, args, env)
    await new Promise(res => setTimeout(res, LISTENER_SETTLE_MS))

    const failed = test.parse(r.out)
    if (listener.connections() > 0 && !failed.includes('net_connect')) failed.push('net_connect')
    if (r.code !== 0) failed.push('exit')
    if (failed.length > 0) return { failed, conclusive: r.code !== null }

    const nested = adapter.selfTest({ dir: sub, secret, flags: [], denyRead, readOnlyPaths: [readOnlyDir], subdir: true })
    const nestedRun = await probe(deps, file, [...nested.args, '/bin/sh', '-c', SELF_TEST_SUBDIR_SCRIPT, 'mffai-selftest'], env)
    const nestedFailed = nested.parse(nestedRun.out)
    if (nestedRun.code !== 0) nestedFailed.push('exit')
    if (nestedFailed.length > 0) return { failed: nestedFailed, conclusive: nestedRun.code !== null }

    const readOnly = adapter.selfTest({ dir, secret, flags: [], denyRead, readOnlyPaths: [readOnlyDir], readOnly: true })
    const ro = await probe(deps, file, [...readOnly.args, '/bin/sh', '-c', SELF_TEST_READ_ONLY_SCRIPT, 'mffai-selftest'], env)
    const roFailed = readOnly.parse(ro.out)
    if (ro.code !== 0) roFailed.push('exit')
    return { failed: roFailed, conclusive: ro.code !== null }
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

/** binaryKey → 过了没有 */
const selfTests = new Map<string, boolean>()

async function selfTestPassed(adapter: Adapter, file: string, key: string | undefined, deps: DetectDeps): Promise<boolean> {
  const known = key === undefined || deps.force ? undefined : selfTests.get(key)
  if (known !== undefined) return known
  const { failed, conclusive } = await runSelfTest(adapter, file, deps)
  const passed = failed.length === 0
  if (conclusive && key !== undefined) selfTests.set(key, passed)
  return passed
}

/** stdout 里第一行整行像版本号的;没有就是不知道 */
function versionLine(stdout: string): string | undefined {
  const line = stdout.split('\n').map(l => l.trim()).find(l => VERSION_LINE.test(l))
  return line === undefined ? undefined : redact(line)
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
  if (!info.installed || info.missing.includes(UNTRUSTED)) return result('none')
  // 运行前再看一次:探测之后程序可能变了权限,这次的 cwd 也可能盖住它
  if (paths && info.path !== undefined && !binaryTrusted(info.path, dirname(info.path), { cwd: paths.cwd })) return result('none', UNTRUSTED)
  if (adapter.isolationKind === 'wrap') return result(level === 'none' ? 'none' : 'wrapped')
  if (config.codex?.network) return result('none', NETWORK_ON)
  // 开着网络探测时没跑自检:现在关了也不算通过,要重新探测
  if (info.missing.includes(SELFTEST_FAILED) || info.missing.includes(NETWORK_ON)) return result('none', SELFTEST_FAILED)
  // 自检只对探测时那个文件算数
  if (info.path === undefined || info.binaryKey === undefined || (paths && binaryChanged(info))) return result('none', SELFTEST_FAILED)
  const gaps = (paths && adapter.profileGaps?.(paths)) ?? []
  return gaps.length > 0 ? result('none', ...gaps) : result('own')
}

/** 只探登录。跑不起来、读不懂 → unknown,照跑 */
export async function checkAuth(adapter: Adapter, file: string, deps: DetectDeps): Promise<ExecutorInfo['auth']> {
  const login = await probe(deps, file, adapter.loginArgs, deps.env)
  const parsed = login.code === null ? 'unknown' : adapter.parseLogin(login.out)
  // 退出码说失败、文字说登录了:读不懂
  return parsed === 'ok' && login.code !== 0 ? 'unknown' : parsed
}

export async function detectExecutor(adapter: Adapter, deps: DetectDeps): Promise<ExecutorInfo> {
  try {
    const config = deps.config()
    if (deps.platform === 'win32') return absent(adapter.id, 'unsupported')
    if (config.disabled?.includes(adapter.id)) return absent(adapter.id, 'disabled')
    if (deps.signal?.aborted) return absent(adapter.id, 'cancelled')
    const { path, untrusted } = locateBin(adapter.bin, deps.env, deps.platform, { uid: deps.uid })
    // 不给 path,也一次都不跑:装了,但不能信
    if (!path) return untrusted ? { ...absent(adapter.id, UNTRUSTED), installed: true } : absent(adapter.id, 'not_installed')
    const key = binaryKey(path)

    const v = await probe(deps, path, ['--version'], deps.env)
    if (deps.signal?.aborted) return absent(adapter.id, 'cancelled')
    if (v.code !== 0) return { ...absent(adapter.id, 'not_runnable'), path }
    const version = versionLine(v.stdout)

    const auth = await checkAuth(adapter, path, deps)
    if (deps.signal?.aborted) return absent(adapter.id, 'cancelled')

    const missing: string[] = []
    if (adapter.isolationKind === 'translate' && !config.codex?.network && !(await selfTestPassed(adapter, path, key, deps))) missing.push(SELFTEST_FAILED)
    if (deps.signal?.aborted) return absent(adapter.id, 'cancelled')
    const info: ExecutorInfo = { id: adapter.id, installed: true, ...(version === undefined ? {} : { version }), auth, isolation: 'none', missing, path, ...(key === undefined ? {} : { binaryKey: key }) }
    return { ...info, ...isolationOf(adapter, info, deps.sandboxLevel(), config, undefined) }
  } catch {
    return absent(adapter.id, 'detect_failed')
  }
}
