// 用户规则与硬拒绝 → 适配器的隔离参数(04 spec §8.4)
import type { PermissionGate } from '../../kernel/permissionGate'
import { OUTSIDE, resolveToolPath } from '../../lib/fs/paths'
import type { ExecPolicy } from '../../lib/tools/types'
import type { ExecutorIsolation } from '../../protocol/tools'

const uniq = (list: string[]) => [...new Set(list)]

export interface TranslatedPolicy {
  /** Codex 的 `none`:黑名单 + 数据目录 + 读规则 */
  denyRead: string[]
  /** Codex 的 `read`:持久化文件 + 写规则 */
  readOnlyPaths: string[]
  /** 沙箱(planExec)的写规则。planExec 的 denyRead 要用 ExecPolicy.ruleDenyRead,不是上面那份:那份会盖住 allowRead 的豁免 */
  denyWrite: string[]
  untranslated: number
}

/** protect:选中的程序所在的目录(binaryDirs)。cwd 盖住它们时,不能让运行改掉下次在沙箱外跑的东西 */
export function translate(p: ExecPolicy, protect: string[] = []): TranslatedPolicy {
  return {
    denyRead: uniq([...p.denyRead, ...p.ruleDenyRead]),
    readOnlyPaths: uniq([...p.persistence, ...p.ruleDenyWrite, ...protect]),
    denyWrite: uniq([...p.ruleDenyWrite, ...protect]),
    untranslated: p.untranslatedRules,
  }
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
