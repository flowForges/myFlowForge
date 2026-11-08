import { posix, win32 } from 'node:path'
import { dataRoots, secretsAccountOf, SECRETS_SERVICE, type MffaiState } from '@mffai/protocol'

// 删除全部数据(08 §12.5、评审修订 R7)。★不 import electron、不加载 host、不拉起后台:
// 一切副作用都由调用方注入(ipc.ts 传真的 fs / 控制口 / 子进程,测试传假的)。

export interface WipeDeps {
  dataDir: string
  /** 设置里是否启用(调用方在置上 wiping 标记之后读的) */
  enabled: boolean
  platform: NodeJS.Platform
  home: string
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
}

/** 四个根和钥匙串条目(评审修订 R14:渲染层不算)。host 的状态和 ipc.ts 的停用状态都用它 */
export function rootsOf(dir: string): NonNullable<MffaiState['roots']> {
  return { ...dataRoots(dir), keychain: `${SECRETS_SERVICE}/${secretsAccountOf(dir)}` }
}

export type WipeResult = { ok: true; removed: string[] } | { ok: false; reason: 'enabled' | 'running' | 'bad_path' }

/** 三个兄弟根的后缀,和 dataRoots 一一对应;算出来的不逐字相等就不删 */
const SIBLINGS = { worktrees: '-worktrees', imWorktrees: '-im-worktrees', plugins: '-plugins' } as const

/** 数据目录能不能删:绝对路径、已规范化、不是根、不是家目录或它的上级、最后一级是 mff-ai 或等于 MFFAI_DATA_DIR */
export function wipeablePath(d: Pick<WipeDeps, 'dataDir' | 'platform' | 'home' | 'envDataDir'>): boolean {
  const P = d.platform === 'win32' ? win32 : posix
  const dir = d.dataDir
  if (!dir || !P.isAbsolute(dir) || P.normalize(dir) !== dir) return false
  if (P.parse(dir).root === dir) return false
  const fold = (s: string) => (d.platform === 'win32' || d.platform === 'darwin' ? s.toLowerCase() : s)
  const home = fold(P.normalize(d.home).replace(/[\\/]+$/, ''))
  const at = fold(dir)
  if (at === home || home.startsWith(at + P.sep)) return false
  if (P.basename(dir) !== 'mff-ai' && dir !== d.envDataDir) return false
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
  if (await d.controlAlive()) return { ok: false, reason: 'running' }

  const roots = dataRoots(d.dataDir)
  const removed: string[] = []
  for (const p of [roots.data, roots.worktrees, roots.imWorktrees, roots.plugins]) {
    if (!d.exists(p)) continue
    await d.rm(p)
    removed.push(p)
  }

  // 主密钥。共用的探测账号 mffai-probe 不删(两个包共用);Windows 的 DPAPI 密文在数据目录里,已随之删掉
  const account = secretsAccountOf(d.dataDir)
  const cmd: [string, string[]] | undefined =
    d.platform === 'darwin' ? ['security', ['delete-generic-password', '-a', account, '-s', SECRETS_SERVICE]]
      : d.platform === 'linux' ? ['secret-tool', ['clear', 'service', SECRETS_SERVICE, 'account', account]]
        : undefined
  if (cmd) {
    // 找不到条目(macOS 44)、没装 secret-tool / security:都当没有可删的,不算失败。
    // secret-tool clear 不区分"删了"和"本来没有",只有 macOS 的 0 确实删掉了一条
    const code = await d.run(cmd[0], cmd[1]).catch(() => -1)
    if (code === 0 && d.platform === 'darwin') removed.push(`${SECRETS_SERVICE}/${account}`)
  }
  return { ok: true, removed }
}
