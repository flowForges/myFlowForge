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
 *  `useChat` 是在客户端自己按 ws/session 滤的),所以「标未读」这一侧不需要任何新订阅通道。
 *
 * ★二期加了**跨设备未读**:打开一条会话就 `chat:mark-seen` 说一声,主机原样广播 `chat:seen`,
 *  别的设备(电脑端窗口、另一台手机)收到就清掉自己那份 —— 无状态、不落盘。老主机没有这条,
 *  查方法表跳过即可,退化成一期「各看各的」。
 *
 * ★纯内存,不持久化 —— 与电脑端一致,杀进程重开就清空。
 */
export function useUnreadSet(viewing: Viewing | null): ReadonlySet<string> {
  const { on, invoke, methods } = useConn()
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

  // 别的设备说「这条看过了」→ 清掉本机这份。★这条广播是二期新增的,老主机没有,
  //  收不到就退化成一期的行为(各看各的),不会出错。
  useEffect(() => {
    const off = on(CH.chatSeen, (payload) => {
      const e = payload as { workspacePath?: string; sessionId?: string }
      if (!e?.workspacePath || !e?.sessionId) return
      setUnread((s) => (s.size ? clearUnread(s, e.workspacePath!, e.sessionId!) : s))
    })
    return off
  }, [on])

  useEffect(() => {
    const v = viewing
    if (!v) return
    setUnread((s) => (s.size ? clearUnread(s, v.wsPath, v.sessionId) : s))
    // ★上报之前必须查方法表(决策 B-2):老主机没有 `chat:mark-seen`,不查的话每打开一条
    //  会话就多一个被拒的 promise —— 功能上无害,但那是一条会一直刷屏的假错误。
    if (v.wsPath && v.sessionId && methods.has(CH.chatMarkSeen)) {
      void invoke(CH.chatMarkSeen, [{ workspacePath: v.wsPath, sessionId: v.sessionId }]).catch(() => {
        // 上报失败无所谓 —— 顶多是别的设备那颗圆点晚一点灭。绝不因此弹错。
      })
    }
  }, [viewing?.wsPath, viewing?.sessionId, invoke, methods])

  return unread
}
