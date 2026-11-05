// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// macOS Seatbelt 配置(spec §8,评审修订 R1–R4、R6)。纯拼字符串;唯一的 I/O 是给每个路径取 realpath 拼写。
// Seatbelt 后写的规则生效,所以顺序即语义:读 = 全放 → 拒 denyRead → 放回 reAllowRead → 放回 traverse 的元数据 → 拒 finalDenyRead;
// 写 = a 放 writable → b 拒 denyWrite 与 git 保护 → c 放回 reAllowWrite → c2 拒 finalDenyWrite → d 拒改名 / 删除 moveBlock → e 拒新建 .git。
//
// 转义(安全关键,已在 macOS 26.6 实测):
// - 一律用普通字符串 "…"(JSON.stringify),SBPL 能正确解码其中的 \" \\ \n \t;
// - 不用 #"…" 正则字面量:它不认 \",路径里的引号能闭合字符串、注入规则;
// - SBPL 不解码 \uXXXX:含控制字符的路径会被 JSON.stringify 写成 \u0001,拼写对不上 → 拒绝规则悄悄失效。
//   所以含 C0 控制字符、DEL、孤立代理项的路径直接抛错(宁可命令跑不了,也不放过);
// - 正则里的路径先转义全部正则元字符,再整体 JSON.stringify。
import { posix } from 'node:path'
import { cleanPath, realSpelling } from './paths'

export interface SeatbeltParams {
  /** a:可写根(cwd、各 gitDir、本会话临时目录);spillDir 不在这里(R2) */
  writable: string[]
  /** 仓库 git 目录:其 hooks / config 等在 b 里拒写,并在 d 里拒改名 */
  gitDirs: string[]
  /** worktree 时 cwd 里的 `.git` 文件 */
  cwdGitFile?: string
  /** 凭据黑名单与数据目录 */
  denyRead: string[]
  /** 本会话 spillDir 与临时目录(在数据目录里) */
  reAllowRead: string[]
  /**
   * 07:拒读的目录里放回来的路径上的各级目录,只放元数据(lstat)。git 对 git 目录取 realpath,逐级 lstat,
   * 上一级拒了元数据它就认不出仓库;列目录、读文件仍然不行
   */
  traverse?: string[]
  /** 凭据黑名单、数据目录、持久化文件 */
  denyWrite: string[]
  /** 本会话临时目录(R3:必须在 denyWrite 之后) */
  reAllowWrite: string[]
  /** 04:在放回之后再拒,放回盖不掉(用户规则、豁免目录里嵌套的凭据) */
  finalDenyRead?: string[]
  finalDenyWrite?: string[]
  /** 04:cwd 里 CLI 会加载的配置目录,不存在也不能建,不分大小写 */
  projectConfig?: string[]
  /** 拒改名 / 删除的路径(literal),调用方已加上它们在可写根内的各级父目录;gitDir 及其 hooks / config / modules / worktrees 由这里自己加 */
  moveBlock: string[]
  /** 本会话代理的 TCP 端口(127.0.0.1);没有 → 网络全断 */
  proxyPort?: number
  /** R6:放行本机回环的出站 / 监听 / 入站 */
  allowLoopback?: boolean
  /** 隐藏运行(09 I4):不放 python 的命名 IPC。名字是全局的,没网的服务写、有网的读,就绕过了逐服务的授权 */
  noNamedIpc?: boolean
}

// sysctl 只读名单(R1 修订,实测 macOS 26.6):hw.* 缺了 node 启动即 abort(LowLevelAlloc arithmetic overflow);
// kern.* 只放具体名字 —— 不放 kern.proc.*(否则能列出整张进程表;查自己的 pid 不受影响)。
// machdep. / vm. / sysctl. 实测非必需,但只是硬件 / 内存参数,给 Go / cargo 等留余量(早上验收)
// net.routetable:getifaddrs(os.networkInterfaces、Go net.Interfaces、ifconfig)要用;只是路由表与网卡地址
const SYSCTL_PREFIXES = ['hw.', 'machdep.', 'vm.', 'sysctl.', 'security.mac.', 'net.routetable']
const SYSCTL_NAMES = [
  'kern.argmax', 'kern.boottime', 'kern.bootargs', 'kern.hostname', 'kern.hv_vmm_present', 'kern.iossupportversion',
  'kern.maxfiles', 'kern.maxfilesperproc', 'kern.maxproc', 'kern.maxprocperuid', 'kern.ngroups', 'kern.num_files',
  'kern.osproductversion', 'kern.osproductversioncompat', 'kern.osrelease', 'kern.ostype', 'kern.osvariant_status',
  'kern.osversion', 'kern.secure_kernel', 'kern.tcsm_available', 'kern.tcsm_enable', 'kern.usrstack64', 'kern.version',
  'kern.willshutdown',
]

// mach 服务:getpwuid、日志、通知、TMPDIR 辅助、trustd(TLS 校验)。不含 LaunchServices / Apple Events,
// 不含 SecurityServer / securityd(钥匙串 API;git / node / python / npm 都不需要,Go / cargo 留给早上验收)
const MACH_SERVICES = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.logd',
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.bsd.dirhelper',
  'com.apple.trustd.agent',
]

// /dev/tty 可写但不给 ioctl(TIOCSTI 能往父终端注入按键);调用方以 detached:true(setsid)起进程,本来就没有控制终端
const WRITABLE_DEVICES = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/dtracehelper']
const IOCTL_DEVICES = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper']

// 命名 POSIX IPC 是全局命名空间:不限名字就能读本机其他进程的共享内存(I1)。
// 只放 python 的 shared_memory(/psm_)与 multiprocessing(/mp-),以及 libnotify 的共享页
const SHM_PREFIXES = ['/psm_']
const SHM_NAMES = ['apple.shm.notification_center']
const SEM_PREFIXES = ['/mp-']

const clean = (p: string) => cleanPath(p, 'seatbelt')

/** 每个路径的原样 + realpath 拼写,去重 */
function spellings(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of paths) {
    const p = clean(raw)
    out.add(p)
    out.add(clean(realSpelling(p)))
  }
  return [...out]
}

const str = (s: string) => JSON.stringify(s)
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const filters = (kind: 'literal' | 'subpath', paths: readonly string[]) => paths.map(p => `(${kind} ${str(p)})`).join(' ')
const regexes = (res: readonly string[]) => res.map(r => `(regex ${str(r)})`).join(' ')

function rule(action: 'allow' | 'deny', ops: string, parts: string[]): string[] {
  const body = parts.filter(Boolean).join(' ')
  return body ? [`(${action} ${ops} ${body})`] : []
}

/** 拼写不分大小写:APFS 上 `.CODEX` 就是 `.codex`,而 Seatbelt 按字面比 */
const anyCase = (name: string) => name.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`).replace(/\./g, '\\.')

export function seatbeltProfile(p: SeatbeltParams): string {
  if (p.proxyPort !== undefined && !(Number.isInteger(p.proxyPort) && p.proxyPort > 0 && p.proxyPort < 65536)) {
    throw new Error(`seatbelt: bad proxy port ${p.proxyPort}`)
  }
  const gitDirs = spellings(p.gitDirs)
  const cwdGitFile = p.cwdGitFile === undefined ? [] : spellings([p.cwdGitFile])

  // commondir:git 目录里多一个这个文件,git 就读它指的那个目录的配置(final review C-1)
  const gitLiteral = gitDirs.flatMap(g => [`${g}/config`, `${g}/config.worktree`, `${g}/commondir`])
  const gitSubpath = gitDirs.map(g => `${g}/hooks`)
  const gitRegex = gitDirs.flatMap(g => {
    const e = reEscape(g)
    return [
      `^${e}/worktrees/[^/]+/(config\\.worktree|commondir|gitdir)$`,
      `^${e}/modules/(.+/)?(hooks(/|$)|config$)`,
    ]
  })

  // 子模块 / worktree 各自的 git 目录(modules/<名>、worktrees/<名>,子模块里嵌套的 modules/<名>)不能被换掉:
  // 目录改名时其中的内容不过 b 的检查,先在别处备好带钩子的目录再挪进来就能绕过(review C1)。
  // 代价:沙箱里 git submodule add / worktree add / prune 不可用(本来就写不了 config)
  const gitMoveRegex = gitDirs.flatMap(g => {
    const e = reEscape(g)
    return [`^${e}/(modules|worktrees)/[^/]+$`, `^${e}/modules/(.+/)?modules/[^/]+$`]
  })

  const moveBlock = [...new Set([
    ...spellings(p.moveBlock),
    // modules / worktrees 也不能改名:b 里的正则按这两个目录名写死,改名后其下的 hooks / config / commondir 就能写(review C1)
    ...gitDirs.flatMap(g => [g, `${g}/hooks`, `${g}/config`, `${g}/modules`, `${g}/worktrees`]),
    ...cwdGitFile,
  ])]

  const out: string[] = [
    '(version 1)',
    '(deny default)',

    // 进程
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',

    // 系统
    `(allow sysctl-read ${SYSCTL_PREFIXES.map(n => `(sysctl-name-prefix ${str(n)})`).join(' ')} ${SYSCTL_NAMES.map(n => `(sysctl-name ${str(n)})`).join(' ')})`,
    `(allow mach-lookup ${MACH_SERVICES.map(n => `(global-name ${str(n)})`).join(' ')})`,
    `(allow ipc-posix-shm ${[...(p.noNamedIpc ? [] : SHM_PREFIXES.map(n => `(ipc-posix-name-prefix ${str(n)})`)), ...SHM_NAMES.map(n => `(ipc-posix-name ${str(n)})`)].join(' ')})`,
    ...(p.noNamedIpc ? [] : [`(allow ipc-posix-sem ${SEM_PREFIXES.map(n => `(ipc-posix-name-prefix ${str(n)})`).join(' ')})`]),
    `(allow file-ioctl ${filters('literal', IOCTL_DEVICES)})`,

    // 读
    '(allow file-read*)',
    ...rule('deny', 'file-read*', [filters('subpath', spellings(p.denyRead))]),
    ...rule('allow', 'file-read*', [filters('subpath', spellings(p.reAllowRead))]),
    ...rule('allow', 'file-read-metadata', [filters('literal', spellings(p.traverse ?? []))]),
    ...rule('deny', 'file-read*', [filters('subpath', spellings(p.finalDenyRead ?? []))]),

    // 写 a
    ...rule('allow', 'file-write*', [filters('subpath', spellings(p.writable)), filters('literal', WRITABLE_DEVICES)]),
    // 写 b
    ...rule('deny', 'file-write*', [
      filters('subpath', [...spellings(p.denyWrite), ...gitSubpath]),
      filters('literal', [...gitLiteral, ...cwdGitFile]),
      regexes([...gitRegex, '/\\.git/(hooks|config|commondir)(/|$)']),
    ]),
    // 写 c
    ...rule('allow', 'file-write*', [filters('subpath', spellings(p.reAllowWrite))]),
    // 写 c2
    ...rule('deny', 'file-write*', [
      filters('subpath', spellings(p.finalDenyWrite ?? [])),
      regexes((p.projectConfig ?? []).flatMap(d => spellings([posix.dirname(d)]).map(parent => `^${reEscape(parent)}/${anyCase(posix.basename(d))}(/|$)`))),
    ]),
    // 写 d
    ...rule('deny', 'file-write-unlink file-write-create', [filters('literal', moveBlock), regexes(gitMoveRegex)]),
    // 写 e:任何地方都不能新建叫 .git 的东西(文件、目录、链接、改名过来):下一个会话和用户自己的 git 都会认它(re-review R1-I1)。
    // git init、clone 本来就因为写不了 .git/config 跑不成
    `(deny file-write-create (regex ${str(`/${anyCase('.git')}$`)}))`,
  ]

  // 网络:只有代理端口;R6 时整个回环。任何情况都不放 AF_UNIX
  if (p.proxyPort !== undefined) out.push(`(allow network-outbound (remote ip ${str(`localhost:${p.proxyPort}`)}))`)
  if (p.allowLoopback) {
    out.push(
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
    )
  }
  return out.join('\n') + '\n'
}

export function sandboxExecArgs(profile: string, command: string): { file: '/usr/bin/sandbox-exec'; args: string[] } {
  return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command] }
}
