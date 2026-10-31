// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// Linux bubblewrap 参数(spec §9,评审修订 R5、R9,Task 8 评审 C1 / I1–I4)。纯函数:文件系统查询可注入,默认读真实文件系统。
// bwrap 按参数顺序挂载,后挂的盖住先挂的,所以顺序即语义:
//   只读根 + 私有 /tmp → [execRoot] → 可写根(cwd、各 gitDir、tmp)与只读 spill → git 保护 → 持久化文件只读 →
//   隐藏(运行时目录、已知 Unix socket、凭据、数据目录)→ 盖回 tmp / spill → 代理 socket → 命令(full 时经中转)。
// - 只挂 realpath:bwrap 先 pivot_root 再 mount(2),目标里的符号链接按新根解析 —— 绝对链接会 ENOENT 让 bwrap 起不来,
//   相对链接落到目标上、链接本身仍可删可换。挂载按 inode 生效,一个 realpath 就覆盖所有拼写(I1)。
// - 持久化文件在隐藏之前挂:它们的源是宿主,挂在隐藏之后会把被隐藏根里的内容读回来(M1)。
// - 不传 --new-session:超时 / 取消杀的是 bwrap 所在的进程组(Task 4 的进程组登记依赖它)。
// - 所有挂载都只给存在的路径(bwrap 对不存在的源直接失败);例外:存在的 gitDir 缺 hooks → 抛错(I3,先调 ensureGitHooksDir)。
// - Unix socket(C1):没有 seccomp,文件系统上的 socket 靠隐藏路径挡(会话总线、systemd 用户管理器、ssh / gpg agent、
//   docker / podman);抽象 socket 按网络命名空间隔离,full 下被 --unshare-net 挡住,partial 下挡不住(§14)。
import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { cleanPath, realSpelling, within } from './paths'
import { RELAY_PORT, RELAY_SOURCE, RELAY_STRIP_ENV } from './relay'

export interface BwrapParams {
  /** full = 文件 + 网络命名空间(经中转连代理);partial = 只有文件限制,网络照常 */
  level: 'full' | 'partial'
  cwd: string
  /** 本会话临时目录(可写,在数据目录里) */
  tmp: string
  /** 本会话 spillDir(只读,在数据目录里) */
  spill: string
  /** 仓库 git 目录:总是单独 --bind(挂载点不能改名),其 hooks / config / config.worktree 只读 */
  gitDirs: string[]
  /** 另外要只读的 git 文件:worktrees/*\/{config.worktree,commondir,gitdir}、worktree 时 cwd 里的 `.git` 文件 */
  gitProtected: string[]
  /** 凭据路径;按真实类型隐藏:目录 → --tmpfs,其他 → --ro-bind /dev/null(两张表合并处理) */
  hideDirs: string[]
  hideFiles: string[]
  /** 数据目录 → --tmpfs(之后盖回 tmp / spill) */
  dataDir: string
  /** 持久化文件 / 目录:在可写根内的只读挂回自己(只拒写) */
  persistence: string[]
  /** 白名单代理的 Unix socket(handle.unixPath);只绑它本身,其父目录在沙箱里不能可写 */
  unixSock?: string
  /** 跑中转的可执行文件(工作进程自己;Electron 以 ELECTRON_RUN_AS_NODE=1 跑) */
  execPath: string
  /** execPath 在 /tmp 下(AppImage 挂载点)时它的根,用 execRootFor 算 */
  execRoot?: string
  command: string
  /** 命令的环境(内核快照):取 HOME、XDG_RUNTIME_DIR 与各 agent / 总线 socket 路径。默认 process.env */
  env?: Record<string, string | undefined>
  /** 默认 process.getuid() */
  uid?: number
  exists?: (p: string) => boolean
  realpath?: (p: string) => string
  /** 跟随符号链接 */
  isDir?: (p: string) => boolean
  /** 不跟随符号链接 */
  isSymlink?: (p: string) => boolean
}

/** 宿主上常见的高权限 Unix socket(文件 → /dev/null,目录 → tmpfs) */
export const KNOWN_SOCKETS = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/podman/podman.sock',
  '/run/dbus/system_bus_socket',
  '/var/run/dbus/system_bus_socket',
  '/run/screen',
  '/var/run/screen',
]

const who = 'bwrap'
const clean = (p: string) => cleanPath(p, who)

/** execPath 在 /tmp 下时 /tmp 的第一层目录(AppImage 挂在 /tmp/.mount_xxx),否则 undefined */
export function execRootFor(execPath: string): string | undefined {
  const p = clean(execPath)
  if (!p.startsWith('/tmp/')) return undefined
  return `/tmp/${p.slice(5).split('/')[0]}`
}

/** hooks 不存在时在宿主上建空目录,好让 bwrapArgs 把它只读挂上(R5)。gitDir 本身不存在就什么都不做 */
export function ensureGitHooksDir(gitDir: string): void {
  const g = clean(gitDir)
  try {
    mkdirSync(posix.join(g, 'hooks'))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'ENOENT') throw e
  }
}

/** 环境变量里的 socket 路径(值不归我们管:坏值跳过,不抛错) */
function envSockets(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  if (env.SSH_AUTH_SOCK) out.push(env.SSH_AUTH_SOCK)
  if (env.GPG_AGENT_INFO) out.push(env.GPG_AGENT_INFO.split(':')[0])
  // tmux:`<socket>,<pid>,<session>`(socket 默认在 /tmp/tmux-<uid>,TMUX_TMPDIR 可挪走)
  if (env.TMUX) out.push(env.TMUX.split(',')[0])
  // docker / podman:只认 unix://(tcp:// 走网络,由命名空间与代理管)
  for (const v of [env.DOCKER_HOST, env.CONTAINER_HOST]) if (v?.startsWith('unix://')) out.push(v.slice('unix://'.length))
  for (const a of (env.DBUS_SESSION_BUS_ADDRESS ?? '').split(';')) {
    if (!a.startsWith('unix:')) continue
    for (const kv of a.slice(5).split(',')) if (kv.startsWith('path=')) out.push(decodeURIComponentSafe(kv.slice(5)))
  }
  return out
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** 外来路径:绝对且无控制字符才用,`..` 按字面折叠(只用于隐藏,多挂不少挂) */
function lenient(p: string | undefined): string | undefined {
  if (!p || !p.startsWith('/')) return undefined
  try { return clean(posix.normalize(p)) } catch { return undefined }
}

export function bwrapArgs(p: BwrapParams): string[] {
  const exists = p.exists ?? existsSync
  const realpath = p.realpath ?? realSpelling
  const isDir = p.isDir ?? ((x: string) => { try { return statSync(x).isDirectory() } catch { return false } })
  const isSymlink = p.isSymlink ?? ((x: string) => { try { return lstatSync(x).isSymbolicLink() } catch { return false } })
  const env = p.env ?? process.env
  const uid = p.uid ?? process.getuid?.()

  /** 校验原样拼写,再取 realpath(也校验) */
  const R = (x: string) => clean(realpath(clean(x)))

  // 先校验全部路径(不管存不存在、用不用得到):坏路径一律抛错,命令不跑
  const cwd = R(p.cwd)
  const tmp = R(p.tmp)
  const spill = R(p.spill)
  const dataDir = R(p.dataDir)
  const execPath = R(p.execPath)
  const gitDirs = p.gitDirs.map(R)
  const gitProtected = p.gitProtected.map(R)
  const hides = [...p.hideDirs, ...p.hideFiles].map(R)
  const persistence = p.persistence.map(clean)
  const unixSock = p.unixSock === undefined ? undefined : R(p.unixSock)
  const execRoot = p.execRoot === undefined ? undefined : R(p.execRoot)

  const writableRoots = [cwd, ...gitDirs, tmp]
  const inWritable = (x: string) => writableRoots.some(r => within(x, r))

  // 可写根不能是 / 或家目录的祖先(纵深防御;会话层已有同样的检查)
  const homeLit = lenient(env.HOME)
  const home = homeLit === undefined ? undefined : clean(realpath(homeLit))
  for (const r of writableRoots) {
    if (r === '/' || (home !== undefined && r !== home && within(home, r))) {
      throw new Error(`${who}: writable root is too broad: ${JSON.stringify(r)}`)
    }
  }

  if (unixSock !== undefined && inWritable(posix.dirname(unixSock))) {
    throw new Error(`${who}: proxy socket's parent is writable inside the sandbox: ${JSON.stringify(unixSock)}`)
  }

  const relay = p.level === 'full' && unixSock !== undefined && exists(unixSock)
  if (execRoot !== undefined && (!execRoot.startsWith('/tmp/') || !within(execPath, execRoot))) {
    throw new Error(`${who}: execRoot must be under /tmp and contain execPath: ${JSON.stringify(execRoot)}`)
  }
  if (relay && execRoot === undefined && within(execPath, '/tmp')) {
    throw new Error(`${who}: execPath under /tmp needs an execRoot: ${JSON.stringify(execPath)}`)
  }

  // git 保护的三个路径是符号链接(悬空的也算)→ 不跑:绝对链接让 bwrap 起不来;相对链接时只读挂落在目标上,
  // 链接本身是可写 gitDir 里的普通条目,删掉换成真目录就能种钩子(R1-I1)。链接所在目录就是 gitDir,只读挂不了
  for (const g of gitDirs) {
    for (const f of ['hooks', 'config', 'config.worktree']) {
      if (isSymlink(`${g}/${f}`)) throw new Error(`${who}: ${JSON.stringify(`${g}/${f}`)} is a symlink; the sandbox can't protect it (replace it with a real ${f === 'hooks' ? 'directory' : 'file'} or set core.hooksPath)`)
    }
  }
  // I3:存在的 gitDir 必须有 hooks 才能只读挂上;没有就不跑(调用方先 ensureGitHooksDir)
  for (const g of gitDirs) {
    if (exists(g) && !exists(`${g}/hooks`)) throw new Error(`${who}: ${JSON.stringify(g)} has no hooks dir; call ensureGitHooksDir first`)
  }

  const out: string[] = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc']
  if (p.level === 'full') out.push('--unshare-net')
  out.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp')

  const seen = new Set<string>()
  /** 同一条挂载只出现一次;路径不存在就不挂 */
  const mount = (flag: '--bind' | '--ro-bind' | '--tmpfs', ...xs: string[]) => {
    const target = xs[xs.length - 1]
    if (!exists(target)) return
    const key = [flag, ...xs].join('\0')
    if (seen.has(key)) return
    seen.add(key)
    out.push(flag, ...xs)
  }
  const self = (flag: '--bind' | '--ro-bind', x: string) => mount(flag, x, x)

  if (relay && execRoot !== undefined) self('--ro-bind', execRoot)

  // 可写根与只读 spill
  self('--bind', cwd)
  for (const g of gitDirs) self('--bind', g)
  self('--bind', tmp)
  self('--ro-bind', spill)

  // git 保护:在 gitDir 的 --bind 之后
  for (const g of gitDirs) for (const f of ['hooks', 'config', 'config.worktree']) self('--ro-bind', `${g}/${f}`)
  for (const f of gitProtected) self('--ro-bind', f)

  // 持久化文件:目标在可写根内 → 只读挂 realpath。路径上任一段是可写根里的符号链接 → 链接本身可删可换,
  // 改为只读挂链接所在的目录;那个目录本身是(或包含)可写根时挂不了,只剩 realpath 那一条(§14)
  for (const lit of persistence) {
    const parts = lit.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      const pre = `/${parts.slice(0, i).join('/')}`
      if (!isSymlink(pre)) continue
      const parent = R(posix.dirname(pre))
      if (!inWritable(parent)) continue
      if (writableRoots.some(w => within(w, parent))) continue
      self('--ro-bind', parent)
    }
    const r = R(lit)
    if (inWritable(r)) self('--ro-bind', r)
  }

  // 隐藏:运行时目录(会话总线、systemd 用户管理器、各 agent)、环境里点名的 socket、已知 socket、凭据、数据目录
  const runtime = [uid === undefined ? undefined : `/run/user/${uid}`, lenient(env.XDG_RUNTIME_DIR)]
  const candidates = [
    ...runtime,
    ...envSockets(env).map(lenient),
    ...KNOWN_SOCKETS,
    ...hides,
    dataDir,
  ].filter((x): x is string => x !== undefined).map(x => clean(realpath(x)))
  const targets: { path: string; dir: boolean }[] = []
  for (const t of candidates) {
    if (!exists(t) || targets.some(o => o.path === t)) continue
    targets.push({ path: t, dir: isDir(t) })
  }
  // 已在某个被隐藏目录里的不再单独挂(目标在 tmpfs 里已不存在)
  const hiddenDirs = targets.filter(t => t.dir).map(t => t.path)
  for (const t of targets) {
    if (hiddenDirs.some(d => d !== t.path && within(t.path, d))) continue
    if (t.dir) mount('--tmpfs', t.path)
    else mount('--ro-bind', '/dev/null', t.path)
  }

  // 盖回数据目录里本会话的两个目录(bwrap 允许同一路径再挂一次,所以这里不去重)
  seen.delete(['--bind', tmp, tmp].join('\0'))
  seen.delete(['--ro-bind', spill, spill].join('\0'))
  self('--bind', tmp)
  self('--ro-bind', spill)

  // 代理 socket:只绑文件本身;只读挂载上 connect() 照样可用(EROFS 只针对普通文件 / 目录 / 符号链接)
  if (relay) self('--ro-bind', unixSock!)

  for (const k of RELAY_STRIP_ENV) out.push('--unsetenv', k)
  if (relay) out.push('--setenv', 'ELECTRON_RUN_AS_NODE', '1')
  else out.push('--unsetenv', 'ELECTRON_RUN_AS_NODE')
  out.push('--chdir', cwd, '--')

  if (relay) out.push(execPath, '-e', RELAY_SOURCE, String(RELAY_PORT), unixSock!, '/bin/sh', '-c', p.command)
  else out.push('/bin/sh', '-c', p.command)
  return out
}
