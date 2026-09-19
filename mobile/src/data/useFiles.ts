import { useCallback, useEffect, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import type { FilePreview, TreeNode } from '../../../src/shared/types'
import { useConn } from '../net/conn'

/**
 * 一个项目工作树的文件浏览。**只读** —— 手机端不提供任何写入口。
 *
 * 用的是服务端**已有**的两个 channel:`fs:tree`(整棵树,git 已经跑过 ls-files 并标好改动)
 * 和 `git:file`(读一个文件的正文)。两个都不在 `CLIENT_ONLY` 也不在 `DAEMON_UNSUPPORTED` 里,
 * 所以 daemon 一直就在提供它们 —— 这一屏不需要服务端加任何东西。
 *
 * ★树是**一次全拿**的(服务端本来就是一次性构建整棵)。所以进这一屏会有一次几百 KB 的往返,
 *  之后翻目录是纯本地的,不再打服务端。
 */
export function useFiles(cwd: string | null) {
  const { invoke, online } = useConn()
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 重新拉一次的计数器。
   * ★★为什么必须有:树是**进这一屏那一刻**读的一份快照,之后翻目录全是本地的(见文件头)。
   *  于是你在电脑上新建的文件/文件夹,手机上**永远**看不到 —— 除非退出这一屏再进来。
   *  用户 2026-09-19 原话:「我电脑端早就新增了文件,但是手机端看不出来,我新增了文件夹,都看不出来」。
   *  `useChanges` 早就有这个 refresh 了,只是没人接到界面上;这边连有都没有。
   */
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!cwd || !online) {
      setTree(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const t = (await invoke(CH.fsTree, [cwd])) as TreeNode[]
        if (!alive) return
        setTree(Array.isArray(t) ? t : [])
        setLoading(false)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [cwd, online, invoke, tick])

  /** 读一个文件的正文。`file` 是相对 `cwd` 的路径。 */
  const read = useCallback(
    async (file: string): Promise<FilePreview> =>
      (await invoke(CH.gitFile, [{ cwd, file }])) as FilePreview,
    [invoke, cwd],
  )

  /**
   * 重新读一次整棵树。★**不碰当前目录**(`dir` 在调用方那儿):刷新之后还站在原地才叫刷新,
   *  跳回根目录那叫重来一次 —— 人是为了看「我刚加的那个文件在不在」才刷的。
   */
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  return { tree, loading, error, read, refresh }
}
