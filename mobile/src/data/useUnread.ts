import { useEffect, useRef, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import { markUnread, clearUnread, type Viewing } from '@shared/chat/unread'
import { useConn } from '../net/conn'

const NOWHERE: Viewing = { wsPath: '', sessionId: '' }

/**
 * 手机端的全局未读。**语义与电脑端完全一致**(同一份 `@shared/chat/unread`):
 * 一轮**结束时**你没在看这条会话就标未读,切过去就清。
 *
 * ★`error` 必须和 `done` 一样算终态。只认 `done` 的话,后台悄无声息挂掉的那一轮
 *  永远不会提醒你 —— 而那恰恰是最该提醒的。这条注释是从电脑端原样带过来的。
 *
 * ★手机端收得到**所有**工作区的 `chat:event`(网关的 sink 是无差别广播,
 *  `useChat` 是在客户端自己按 ws/session 滤的),所以这里不需要任何新订阅通道。
 *
 * ★纯内存,不持久化 —— 与电脑端一致,杀进程重开就清空。
 */
export function useUnreadSet(viewing: Viewing | null): ReadonlySet<string> {
  const { on } = useConn()
  const [unread, setUnread] = useState<Set<string>>(() => new Set())
  const vref = useRef<Viewing>(viewing ?? NOWHERE)
  vref.current = viewing ?? NOWHERE

  useEffect(() => {
    const off = on(CH.chatEvent, (payload) => {
      const e = payload as { type?: string; workspacePath?: string; sessionId?: string }
      if (!e || (e.type !== 'done' && e.type !== 'error')) return
      if (!e.workspacePath || !e.sessionId) return
      setUnread((s) => markUnread(s, e.workspacePath!, e.sessionId!, vref.current))
    })
    return off
  }, [on])

  useEffect(() => {
    const v = viewing
    if (!v) return
    setUnread((s) => (s.size ? clearUnread(s, v.wsPath, v.sessionId) : s))
  }, [viewing?.wsPath, viewing?.sessionId])

  return unread
}
