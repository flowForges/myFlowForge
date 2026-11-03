// worktree 运行的规则根(04 spec §10)。运行管理器和内核的崩溃恢复都要算,所以在 lib
import { join, relative } from 'node:path'
import { isInside } from '../fs/paths'
import type { ExecPolicy } from './types'

const uniq = (list: string[]) => [...new Set(list)]

/**
 * 一棵树的策略;worktree 运行时规则要同时盖住两棵树。`deny read(hidden/**)` 按 cwd 解析,只算会话的 cwd 就保护不到 worktree 里那份;
 * 绝对路径的规则两边算出来都是会话那棵树,所以落在会话 cwd 里的根再映射一份到 worktree。
 * tops:会话在仓库子目录时,整棵仓库都检出到了 worktree,cwd 之外的根也有一份,要按仓库根再映射。
 * 按两边较大的算翻译不了的条数:哪边落实不了都得问人
 */
export function treePolicy(policyOf: (cwd: string) => ExecPolicy, sessionCwd: string, runCwd: string, tops?: { session: string; run: string }): ExecPolicy {
  const session = policyOf(sessionCwd)
  if (runCwd === sessionCwd) return session
  const tree = policyOf(runCwd)
  const bases: [string, string][] = [[sessionCwd, runCwd], ...(tops ? [[tops.session, tops.run] as [string, string]] : [])]
  const mapped = (roots: string[]) => roots.flatMap(r => {
    const hit = bases.find(([from]) => isInside(r, from, process.platform))
    return hit ? [join(hit[1], relative(hit[0], r))] : []
  })
  const both = (a: string[], b: string[]) => uniq([...a, ...b, ...mapped(a)])
  return {
    ...session,
    ruleDenyRead: both(session.ruleDenyRead, tree.ruleDenyRead),
    ruleDenyWrite: both(session.ruleDenyWrite, tree.ruleDenyWrite),
    untranslatedRules: Math.max(session.untranslatedRules, tree.untranslatedRules),
  }
}

/** 落在 worktree 里的 `deny read` 根 */
export const denyReadCopies = (policy: Pick<ExecPolicy, 'ruleDenyRead'>, path: string, platform: NodeJS.Platform = process.platform) =>
  policy.ruleDenyRead.filter(r => r !== path && isInside(r, path, platform))
