import { posix, win32 } from 'node:path'
import { autostartIds, dataRoots, DEFAULT_AUTOSTART_IDS, launchdPlistOwnedBy, secretsAccountOf, SECRETS_SERVICE, type MffaiState } from '@mffai/protocol'

// 删除全部数据(08 §12.5、评审修订 R7)。★不 import electron、不加载 host、不拉起后台:
// 一切副作用都由调用方注入(ipc.ts 传真的 fs / 控制口 / 子进程,测试传假的)。

export interface WipeDeps {
  dataDir: string
  /** 设置里是否启用(调用方在置上 wiping 标记之后读的) */
  enabled: boolean
  platform: NodeJS.Platform
  home: string
  /** 系统临时目录:MFFAI_DATA_DIR 不能是它或它的上级 */
  tmpDir: string
  /** MFFAI_DATA_DIR:等于它的数据目录不要求最后一级是 mff-ai */
  envDataDir?: string
  /** 控制口问得到监管(含旧协议后台的 unauthorized) */
  controlAlive(): Promise<boolean>
  /** 删一个根:目录递归删,符号链接只删链接本身 */
  rm(p: string): Promise<void>
  /** 按 lstat 判断:悬空的符号链接也算在 */
  exists(p: string): boolean
  /** 跑一条命令,回退出码;argv 里没有任何秘密 */
  run(cmd: string, args: string[]): Promise<number>
  /** 读一个 plist(读不到 → undefined)。给了就只删 MFFAI_DATA_DIR 指向这个数据目录的 plist */
  readFile?(p: string): string | undefined
  /** app 的数据目录(SYS_DIR):MFFAI_DATA_DIR 不能是它或它的上级 */
  sysDir?: string
}

/** 四个根和钥匙串条目(评审修订 R14:渲染层不算)。host 的状态和 ipc.ts 的停用状态都用它 */
export function rootsOf(dir: string): NonNullable<MffaiState['roots']> {
  return { ...dataRoots(dir), keychain: `${SECRETS_SERVICE}/${secretsAccountOf(dir)}` }
}

export type WipeResult = { ok: true; removed: string[] } | { ok: false; reason: 'enabled' | 'running' | 'bad_path' }

/** 四个根里还剩任何一个(按 lstat)。停用状态的 dataExists 用它:删到一半失败时按钮还在 */
export function anyRootExists(dir: string, exists: (p: string) => boolean): boolean {
  return Object.values(dataRoots(dir)).some((p) => exists(p))
}

/**
 * 这个数据目录的 LaunchAgent 标签(Task 15):和 harness/src/platform/autostart.ts 一样按 autostartIds 派生。
 * 默认数据目录仍是 com.myflowforge.mffai;别的目录带 sha8,并排的测试包删不到正式版的自启
 */
export function launchdLabelOf(dir: string, home: string): string {
  return autostartIds(dir, home).launchd
}

/** 只认系统路径上的程序,不经 PATH */
const SECURITY = '/usr/bin/security'
const SECRET_TOOL = ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool', '/bin/secret-tool']

/** 连接错误里表示"那里没人在听"的码;win32 的命名管道不在也是 ENOENT */
const NOTHING_LISTENING = new Set(['ENOENT', 'ECONNREFUSED'])
const nothingListening = (err: unknown) => NOTHING_LISTENING.has(String((err as { code?: unknown })?.code))

export interface ProbeDeps {
  /** 控制口 status(带 token 认证) */
  call(): Promise<unknown>
  /** 不认证、只连一下控制口地址(有期限,超时 reject) */
  connect(): Promise<void>
  /** run/supervisor.json 里的 pid */
  supervisorPid(): number | undefined
  isAlive(pid: number): boolean
}

/**
 * 后台在不在,往"在"那边错(fail closed):只有 ENOENT / ECONNREFUSED 而且 supervisor.json 里的 pid 不在,才算不在。
 * 卡住、连接中断、unauthorized、别的错误一律算在。token 读不出来时自己连一下地址
 */
export async function probeControl(d: ProbeDeps): Promise<boolean> {
  const pid = d.supervisorPid()
  if (pid !== undefined && d.isAlive(pid)) return true
  try {
    await d.call()
    return true
  } catch (err) {
    if (nothingListening(err)) return false
    if ((err as Error)?.message !== 'no token') return true
  }
  try {
    await d.connect()
    return true
  } catch (err) {
    return !nothingListening(err)
  }
}

/** 三个兄弟根的后缀,和 dataRoots 一一对应;算出来的不逐字相等就不删 */
const SIBLINGS = { worktrees: '-worktrees', imWorktrees: '-im-worktrees', plugins: '-plugins' } as const

/** 数据目录能不能删:绝对路径、已规范化、不是根、不是家目录或它的上级、最后一级是 mff-ai 或等于 MFFAI_DATA_DIR */
export function wipeablePath(d: Pick<WipeDeps, 'dataDir' | 'platform' | 'home' | 'envDataDir' | 'tmpDir' | 'sysDir'>): boolean {
  const P = d.platform === 'win32' ? win32 : posix
  const dir = d.dataDir
  if (!dir || !P.isAbsolute(dir) || P.normalize(dir) !== dir) return false
  if (P.parse(dir).root === dir) return false
  const fold = (s: string) => (d.platform === 'win32' || d.platform === 'darwin' ? s.toLowerCase() : s)
  const home = fold(P.normalize(d.home).replace(/[\\/]+$/, ''))
  const at = fold(dir)
  if (at === home || home.startsWith(at + P.sep)) return false
  if (P.basename(dir) !== 'mff-ai') {
    if (dir !== d.envDataDir) return false
    // 豁免的目录不能是 ~/.myFlowForge、系统临时目录或它们的上级
    for (const keep of [P.join(d.home, '.myFlowForge'), d.tmpDir, ...(d.sysDir ? [d.sysDir] : [])]) {
      const k = fold(P.normalize(keep).replace(/[\\/]+$/, ''))
      if (at === k || k.startsWith(at + P.sep)) return false
    }
  }
  const roots = dataRoots(dir)
  if (roots.data !== dir) return false
  for (const [k, suffix] of Object.entries(SIBLINGS) as Array<[keyof typeof SIBLINGS, string]>) {
    const r = roots[k]
    if (P.dirname(r) !== P.dirname(dir) || P.basename(r) !== P.basename(dir) + suffix) return false
  }
  return true
}

export async function wipeData(d: WipeDeps): Promise<WipeResult> {
  if (d.enabled) return { ok: false, reason: 'enabled' }
  if (!wipeablePath(d)) return { ok: false, reason: 'bad_path' }

  const P = d.platform === 'win32' ? win32 : posix
  const roots = dataRoots(d.dataDir)
  // 豁免的目录要像个数据目录:里面有 db/ 或 run/(已经删掉了就只删兄弟根)
  if (P.basename(d.dataDir) !== 'mff-ai' && d.exists(roots.data) &&
    !d.exists(P.join(roots.data, 'db')) && !d.exists(P.join(roots.data, 'run'))) return { ok: false, reason: 'bad_path' }
  if (await d.controlAlive()) return { ok: false, reason: 'running' }

  const removed: string[] = []
  // 数据根最后删:中途失败时 dataExists 仍为真(按钮还在),标记也还在,可以重试
  for (const p of [roots.worktrees, roots.imWorktrees, roots.plugins, roots.data]) {
    if (!d.exists(p)) continue
    await d.rm(p)
    removed.push(p)
  }

  // 旧的 LaunchAgent plist(后台不在时它只是个残留文件)。只删这个数据目录自己的标签
  const label = d.platform === 'darwin' ? launchdLabelOf(d.dataDir, d.home) : undefined
  if (label) {
    const plist = posix.join(d.home, 'Library', 'LaunchAgents', `${label}.plist`)
    // 给了 readFile(ipc.ts 总给):只删 MFFAI_DATA_DIR 指向这个数据目录的,别的、读不出来的都不碰。
    // 没给:只认默认标签(Task 4 的行为)
    const owned = d.readFile ? launchdPlistOwnedBy(d.readFile(plist) ?? '', d.dataDir) : label === DEFAULT_AUTOSTART_IDS.launchd
    if (d.exists(plist) && owned) {
      await d.rm(plist)
      removed.push(plist)
    }
  }

  // 主密钥。共用的探测账号 mffai-probe 不删(两个包共用);Windows 的 DPAPI 密文在数据目录里,已随之删掉
  const account = secretsAccountOf(d.dataDir)
  const secretTool = d.platform === 'linux' ? SECRET_TOOL.find((p) => d.exists(p)) : undefined
  const cmd: [string, string[]] | undefined =
    d.platform === 'darwin' ? [SECURITY, ['delete-generic-password', '-a', account, '-s', SECRETS_SERVICE]]
      : secretTool ? [secretTool, ['clear', 'service', SECRETS_SERVICE, 'account', account]]
        : undefined
  if (cmd) {
    // 找不到条目(macOS 44)、程序跑不起来:都当没有可删的,不算失败。
    // secret-tool clear 不区分"删了"和"本来没有",只有 macOS 的 0 确实删掉了一条
    const code = await d.run(cmd[0], cmd[1]).catch(() => -1)
    if (code === 0 && d.platform === 'darwin') removed.push(`${SECRETS_SERVICE}/${account}`)
  }
  return { ok: true, removed }
}
