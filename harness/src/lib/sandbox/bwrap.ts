// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// Linux bubblewrap 参数(spec §9,评审修订 R5、R9)。纯函数:exists / realpath 可注入,默认读文件系统。
// bwrap 按参数顺序挂载,后挂的盖住先挂的,所以顺序即语义:
//   只读根 + 私有 /tmp → [execRoot] → 可写根(cwd、各 gitDir、tmp)与只读 spill → git 保护 →
//   凭据 / 数据目录隐藏 → 盖回 tmp / spill → 持久化文件只读 → 代理 socket → 命令(full 时经中转)。
// 不传 --new-session:超时 / 取消杀的是 bwrap 所在的进程组(Task 4 的进程组登记依赖它)。
// 所有挂载都只给存在的路径(bwrap 对不存在的源直接失败)。
import { existsSync, mkdirSync } from 'node:fs'
import { posix } from 'node:path'
import { cleanPath, realSpelling, within } from './paths'
import { RELAY_PORT, RELAY_SOURCE } from './relay'

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
  /** 凭据目录 → --tmpfs */
  hideDirs: string[]
  /** 凭据文件 → --ro-bind /dev/null */
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
  exists?: (p: string) => boolean
  realpath?: (p: string) => string
}

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

export function bwrapArgs(p: BwrapParams): string[] {
  const exists = p.exists ?? existsSync
  const real = p.realpath ?? realSpelling

  // 先校验全部路径(不管存不存在、用不用得到):坏路径一律抛错,命令不跑
  const cwd = clean(p.cwd)
  const tmp = clean(p.tmp)
  const spill = clean(p.spill)
  const dataDir = clean(p.dataDir)
  const execPath = clean(p.execPath)
  const gitDirs = p.gitDirs.map(clean)
  const gitProtected = p.gitProtected.map(clean)
  const hideDirs = p.hideDirs.map(clean)
  const hideFiles = p.hideFiles.map(clean)
  const persistence = p.persistence.map(clean)
  const unixSock = p.unixSock === undefined ? undefined : clean(p.unixSock)
  const execRoot = p.execRoot === undefined ? undefined : clean(p.execRoot)

  /** 原样 + realpath 两种拼写,去重 */
  const spell = (x: string) => [...new Set([x, clean(real(x))])]
  const writableRoots = [cwd, ...gitDirs, tmp].flatMap(spell)
  const inWritable = (x: string) => spell(x).some(s => writableRoots.some(r => within(s, r)))

  if (unixSock !== undefined && spell(unixSock).some(s => inWritable(posix.dirname(s)))) {
    throw new Error(`${who}: proxy socket's parent is writable inside the sandbox: ${JSON.stringify(unixSock)}`)
  }

  const relay = p.level === 'full' && unixSock !== undefined && exists(unixSock)
  if (execRoot !== undefined && (!execRoot.startsWith('/tmp/') || !within(execPath, execRoot))) {
    throw new Error(`${who}: execRoot must be under /tmp and contain execPath: ${JSON.stringify(execRoot)}`)
  }
  if (relay && execRoot === undefined && within(execPath, '/tmp')) {
    throw new Error(`${who}: execPath under /tmp needs an execRoot: ${JSON.stringify(execPath)}`)
  }

  const out: string[] = ['--die-with-parent', '--unshare-user', '--unshare-pid']
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

  // 凭据与数据目录:两种拼写都挂
  for (const d of hideDirs.flatMap(spell)) mount('--tmpfs', d)
  for (const f of hideFiles.flatMap(spell)) mount('--ro-bind', '/dev/null', f)
  for (const d of spell(dataDir)) mount('--tmpfs', d)

  // 盖回数据目录里本会话的两个目录(bwrap 允许同一路径再挂一次,所以这里不去重)
  seen.delete(['--bind', tmp, tmp].join('\0'))
  seen.delete(['--ro-bind', spill, spill].join('\0'))
  self('--bind', tmp)
  self('--ro-bind', spill)

  // 持久化文件:只在可写根内才需要(根本来就只读)
  for (const f of persistence) if (inWritable(f)) for (const s of spell(f)) self('--ro-bind', s)

  // 代理 socket:只绑文件本身;只读挂载上 connect() 照样可用(EROFS 只针对普通文件 / 目录 / 符号链接)
  if (relay) self('--ro-bind', unixSock!)

  if (relay) out.push('--setenv', 'ELECTRON_RUN_AS_NODE', '1')
  else out.push('--unsetenv', 'ELECTRON_RUN_AS_NODE')
  out.push('--chdir', cwd, '--')

  if (relay) out.push(execPath, '-e', RELAY_SOURCE, String(RELAY_PORT), unixSock!, '/bin/sh', '-c', p.command)
  else out.push('/bin/sh', '-c', p.command)
  return out
}
