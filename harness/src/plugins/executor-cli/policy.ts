// 用户规则与硬拒绝 → 适配器的隔离参数(04 spec §8.4)
import { realpathSync } from 'node:fs'
import type { PermissionGate } from '../../kernel/permissionGate'
import { isInside, OUTSIDE, resolveToolPath } from '../../lib/fs/paths'
import type { ExecPolicy } from '../../lib/tools/types'
import type { ExecutorIsolation } from '../../protocol/tools'

export { denyReadCopies, treePolicy } from '../../lib/tools/treePolicy'

const uniq = (list: string[]) => [...new Set(list)]

export interface TranslatedPolicy {
  /** Codex 的 `none`:黑名单 + 数据目录 + 读规则 */
  denyRead: string[]
  /** Codex 的 `read`,在 none 之后写:IM 会话的 worktree 要用的 git 目录 */
  keepRead: string[]
  /** Codex 的 `read`:持久化文件 + 写规则 */
  readOnlyPaths: string[]
  /** 沙箱(planExec)的写规则。planExec 的 denyRead 要用 ExecPolicy.ruleDenyRead,不是上面那份:那份会盖住 allowRead 的豁免 */
  denyWrite: string[]
  untranslated: number
}

/** protect:protectDirs 的结果。cwd 盖住它们时,不能让运行改掉下次在沙箱外跑的东西 */
export function translate(p: ExecPolicy, protect: string[] = []): TranslatedPolicy {
  return {
    denyRead: uniq([...p.denyRead, ...p.ruleDenyRead]),
    keepRead: uniq(p.keepRead ?? []),
    readOnlyPaths: uniq([...p.persistence, ...p.ruleDenyWrite, ...protect]),
    denyWrite: uniq([...p.ruleDenyWrite, ...protect]),
    untranslated: p.untranslatedRules,
  }
}

const spellings = (p: string): string[] => {
  try {
    return [p, realpathSync.native(p)]
  } catch {
    return [p]
  }
}

/**
 * 要写保护的目录:PATH 的所有条目(cwd 里的已经不在运行的 PATH 上,但用户在沙箱外还要用)+ 选中的程序所在的目录。
 * 盖住 keepWritable(cwd、spill、allowWrite)的不能算:那等于把它们变成只读,运行什么都写不了;`/` 还会让 bwrap 拒绝运行。
 * translate(Codex):`:root` 本来就只读,只有 cwd 里的 PATH 条目才需要 read。
 */
export function protectDirs(o: {
  kind: 'translate' | 'wrap'
  pathDirs: string[]
  binary: string[]
  cwd: string
  keepWritable: string[]
  platform: NodeJS.Platform
}): string[] {
  const holds = (dir: string, inner: string) => spellings(inner).some(i => spellings(dir).some(d => isInside(i, d, o.platform)))
  const free = (dir: string) => dir !== '/' && !o.keepWritable.some(w => holds(dir, w))
  const listed = o.kind === 'wrap' ? o.pathDirs : o.pathDirs.filter(d => spellings(d).some(s => isInside(s, o.cwd, o.platform)))
  return uniq([...listed, ...o.binary].filter(free))
}

/** 有 deny / ask 规则这次落实不了;隔离 none 时什么都没落实 */
export function mustAsk(p: Pick<ExecPolicy, 'totalRules' | 'untranslatedRules'>, isolation: ExecutorIsolation): boolean {
  return isolation === 'none' ? p.totalRules > 0 : p.untranslatedRules > 0
}

/**
 * 跑完拿改动文件过门:返回 write 判定不是 allow 的,原样返回传入的写法。
 * files 相对 repoRoot,repoRoot 是规则针对的那棵树:worktree 运行也要传会话的目录,不是 worktree。
 * 解析不了的路径算违规:看不懂的改动不能当没发生
 */
export function checkViolations(gate: Pick<PermissionGate, 'checkMany'>, sessionId: string, files: string[], repoRoot: string): string[] {
  if (files.length === 0) return []
  const resources = files.map(f => resolveToolPath(repoRoot, f))
  const judged = resources.flatMap(r => (r === OUTSIDE ? [] : [r]))
  const decisions = gate.checkMany(judged.map(resource => ({ actor: 'tools', action: 'write', resource, sessionId })))
  let next = 0
  return files.filter((_f, i) => resources[i] === OUTSIDE || decisions[next++] !== 'allow')
}
