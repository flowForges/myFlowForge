import { useEffect, useRef, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import { useConn } from '../net/conn'

type WsInfo = { projects?: { name?: string; repoId?: string }[] }

/**
 * 每个工作区**第一个项目**当前所在的分支。分组头上显示它。
 *
 * 为什么要:会话标题是第一次输入截的 30 字,同一个区里的几条彼此很像;
 * 认不出来的时候「哪个区 · 哪条分支」才是人真正在找的东西。
 *
 * ★为什么只取第一个项目:一个工作区可能有好几个项目、各在各的分支上。分组头只有一行,
 *  堆三个分支名反而读不出来。多于一个时后面加 `+N`,想看全的进去看。
 *
 * ★为什么不用 `run2:base-info`(它一次就能拿到全部项目的分支):它每个项目还要跑一次
 *  `git status --porcelain`。列表屏上 N 个工作区 × M 个项目全跑一遍 status,是白花的钱 ——
 *  这里只要分支名,`git:branch` 就是一次 `rev-parse`。
 *
 * ★为什么不用 `ws.projects[].branch`:那是**存盘的**字段,会过时 ——
 *  2026-08-17 那个 bug 就是从它来的(见 `run2Handlers.ts` 的注释)。分支一律实测。
 *
 * ★`asked` 用 ref 记「问过了」,所以**不会**因为列表重渲染反复打请求;但也意味着
 *  分支变了不会自己更新 —— 切主机 / 重开 app 才会。这是有意的取舍:分组头上的分支名是
 *  「认出这是哪个区」的辅助,不是实时状态。
 *
 * 失败一律静默:少一个分支名,好过整屏报错。
 */
export function useBranches(wsPaths: string[]): ReadonlyMap<string, string> {
  const { invoke, online, epoch } = useConn()
  const [map, setMap] = useState<ReadonlyMap<string, string>>(() => new Map())
  // 已经问过的(不管成没成)。列表每次重渲染都会传进一个新数组,不记住就会反复问。
  const asked = useRef(new Set<string>())

  // 切主机:上一台机器的路径在这台机器上不存在,全部作废重来。
  useEffect(() => { asked.current = new Set(); setMap(new Map()) }, [epoch])

  // 依赖用拼出来的串而不是数组本身(每次渲染都是新引用)。分隔符用 NUL —— 空格和逗号
  // 都是 POSIX 路径的合法字符,拿它们当分隔符会让两组不同的路径拼成同一个串。
  const key = wsPaths.join('\0')
  useEffect(() => {
    if (!online) return
    let alive = true
    for (const wsPath of wsPaths) {
      if (asked.current.has(wsPath)) continue
      asked.current.add(wsPath)
      void (async () => {
        try {
          const info = (await invoke(CH.workspaceGet, [wsPath])) as WsInfo
          const names = (info?.projects ?? []).map((p) => p.name || p.repoId || '').filter(Boolean)
          if (!names.length) return
          // 项目工作树就是 `<工作区>/<项目名>` —— 和 useChanges / run2Handlers 同一套推法,
          // 别再发明第二套。
          const branch = (await invoke(CH.gitBranch, [`${wsPath}/${names[0]}`])) as string
          if (!alive || !branch) return
          const label = names.length > 1 ? `${branch} +${names.length - 1}` : branch
          setMap((m) => new Map(m).set(wsPath, label))
        } catch {
          // 读不出来(目录被删了 / detached HEAD / 不是 git 仓库)就不显示。
        }
      })()
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wsPaths 走 key(见上),数组本身每帧都是新引用
  }, [key, online, epoch, invoke])

  return map
}
