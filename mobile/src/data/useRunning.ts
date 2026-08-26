import { useEffect, useMemo, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import { useConn } from '../net/conn'

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
 */
export function useRunningSet(wsPaths: string[]): ReadonlySet<string> {
  const { on, invoke, online, epoch } = useConn()
  // 按工作区分桶存,合并成一个扁平集合对外。分桶是必要的:某个工作区的事件到达时,
  // 只能覆盖它自己那一桶,不能动别的工作区的。
  const [byWs, setByWs] = useState<Record<string, string[]>>({})

  useEffect(() => {
    const off = on(CH.chatQueueEvent, (payload) => {
      const q = payload as QueuePayload
      if (!q?.workspacePath) return
      const ids = q.runningSessionIds ?? (q.runningSessionId ? [q.runningSessionId] : [])
      setByWs((prev) => ({ ...prev, [q.workspacePath!]: ids }))
    })
    return off
  }, [on])

  const key = wsPaths.join(',')
  useEffect(() => {
    if (!online) { setByWs({}); return }
    let alive = true
    for (const wsPath of wsPaths) {
      void (async () => {
        try {
          const q = (await invoke(CH.chatQueueState, [{ workspacePath: wsPath }])) as QueuePayload
          if (!alive) return
          const ids = q?.runningSessionIds ?? (q?.runningSessionId ? [q.runningSessionId] : [])
          // ★只在这一桶**还没有**实时数据时才用快照填。已经有实时数据说明事件比快照先到,
          //  那份实时数据更新,不能被旧快照盖回去。
          setByWs((prev) => (wsPath in prev ? prev : { ...prev, [wsPath]: ids }))
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
