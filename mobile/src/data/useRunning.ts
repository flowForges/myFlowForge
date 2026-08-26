import { useEffect, useMemo, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import { useConn } from '../net/conn'
import { applyEvent, mergeSnapshot, type RunningByWs } from './runningMerge'

type QueuePayload = { workspacePath?: string; runningSessionIds?: string[]; runningSessionId?: string | null }

/**
 * 哪些会话正在跑。按 `sessionId` 收(会话 id 在一台主机上唯一,不需要再拼工作区)。
 *
 * ★★**必须主动拉快照,不能只订阅事件。**
 *  手机是**半路加入**的:连上的时候那一轮多半已经在跑了,而 `chat:queue-event`
 *  是「状态变了才播」—— 那条事件早在我们连上之前就播完了。只订阅的话,连上之后
 *  所有会话都显示成「不在跑」,直到下一次状态变化才纠正。
 *  这个坑本仓库已经栽过一次(见 `useChat.ts` 里停止键那段注释)。
 *
 * ★顺序:**先订阅再拉快照**。反过来的话,拉快照那几百毫秒里到达的实时事件会被
 *  随后 resolve 的旧快照盖掉。晚到的快照按工作区**合并**而不是整体替换,
 *  因为多个工作区的快照是并行拉的。
 *
 * 合并规则本身(哪个覆盖哪个)拆到了 `runningMerge.ts` —— 一个零依赖的纯函数模块,
 * 好在 node 环境下单测钉住,不用起 React 环境。
 */
export function useRunningSet(wsPaths: string[]): ReadonlySet<string> {
  const { on, invoke, online, epoch } = useConn()
  // 按工作区分桶存,合并成一个扁平集合对外。分桶是必要的:某个工作区的事件到达时,
  // 只能覆盖它自己那一桶,不能动别的工作区的。
  const [byWs, setByWs] = useState<RunningByWs>({})

  useEffect(() => {
    const off = on(CH.chatQueueEvent, (payload) => {
      const q = payload as QueuePayload
      if (!q?.workspacePath) return
      const ids = q.runningSessionIds ?? (q.runningSessionId ? [q.runningSessionId] : [])
      setByWs((prev) => applyEvent(prev, q.workspacePath!, ids))
    })
    return off
  }, [on])

  // join 只是给 effect 一个稳定的原始值当依赖,不是给人读的展示字符串,所以用 NUL 分隔
  // (转义写成 '\0',源文件本身仍是纯 ASCII,不会重演之前「文件被写成二进制」那次事故)——
  // 逗号或其它可打印字符都可能真的出现在某个工作区目录名里,NUL 不会。
  const key = wsPaths.join('\0')
  useEffect(() => {
    // ★这一下清空能兜住「切主机后陈旧数据残留」,前提是它能可靠地在每次切主机时触发一次 —— 而
    //  它能,是因为 `hostClient.ts` 的 connectHost 每次都从 `{ status: 'connecting' }` 起步
    //  (从不是直接 'ready'),所以切主机时 `online` 必然会先假一瞬,这个分支必然会跑到。
    if (!online) { setByWs({}); return }
    let alive = true
    for (const wsPath of wsPaths) {
      void (async () => {
        try {
          const q = (await invoke(CH.chatQueueState, [{ workspacePath: wsPath }])) as QueuePayload
          if (!alive) return
          const ids = q?.runningSessionIds ?? (q?.runningSessionId ? [q.runningSessionId] : [])
          // ★这个「先到先得」的判断只在 `on` 的订阅**全程没被重建**时才站得住 —— 而它没有,
          //  因为 `useConn()` 的 `on` 是套在 ref 上的,identity 稳定(`mobile/src/net/conn.tsx`)。
          //  要是 `on` 哪天变得不稳定,重新订阅那个窗口期里漏掉的事件,快照永远补不回来,
          //  而且不会报错,只会悄悄显示错的运行态。
          setByWs((prev) => mergeSnapshot(prev, wsPath, ids))
        } catch {
          // 拉不到就算了 —— 少一个绿点,好过整屏报错。
        }
      })()
    }
    return () => { alive = false }
  }, [key, online, epoch, invoke])

  const flat = useMemo(() => {
    const s = new Set<string>()
    for (const ids of Object.values(byWs)) for (const id of ids) s.add(id)
    return s
  }, [byWs])
  return flat
}
