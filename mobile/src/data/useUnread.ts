import { useEffect, useRef, useState } from 'react'
import { CH } from '../../../src/main/ipc/channels'
import { markUnread, clearUnread, isViewingSession, type Viewing } from '@shared/chat/unread'
import { useConn } from '../net/conn'
import { shouldReportSeen } from './reportSeen'

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

  /**
   * 「这条会话我看过了」——**唯一**的上报出口。下面两处都走它:切到一条会话时,以及
   * 正开着的这条**跑完**时。
   *
   * ★放在 ref 里而不是直接闭进订阅:订阅那个 effect 的依赖只有 `[on]`(它必须只装一次,
   *  重装一次就会漏掉重装那一瞬的事件),而 `methods` / `invoke` 每次重连都是新的。
   *  闭进去的话查的是**连上那一刻**的方法表,重连之后就是一份过期快照。
   */
  const report = useRef<(v: Viewing) => void>(() => {})
  report.current = (v) => {
    // 上报与否的三条判断(空 id / 查方法表)抽在 ./reportSeen 里单测 —— 这个 hook 依赖 useConn(),
    // 一路 import 到 react-native,vitest 的 mobile project(node 环境)渲染不了它。
    if (!shouldReportSeen(v, methods, CH.chatMarkSeen)) return
    void invoke(CH.chatMarkSeen, [{ workspacePath: v.wsPath, sessionId: v.sessionId }]).catch(() => {
      // 上报失败无所谓 —— 顶多是别的设备那颗圆点晚一点灭。绝不因此弹错。
    })
  }

  useEffect(() => {
    const off = on(CH.chatEvent, (payload) => {
      const e = payload as { type?: string; workspacePath?: string; sessionId?: string }
      if (!e || (e.type !== 'done' && e.type !== 'error')) return
      if (!e.workspacePath || !e.sessionId) return
      // ★★这一轮是在**你已经开着这条会话**时跑完的 → 本机不标未读(markUnread 自己会跳过),
      //  但**必须照样吭一声**。原来只在 viewing **变化**时上报,于是「开着对话页看它跑完」
      //  这条路一次都不上报 —— 而那正是手机的主要姿势。现象:手机上盯着跑完、走到桌前,
      //  电脑端那颗圆点亮着,而且**永远不会灭**(它在等一个不会再来的 viewing 变化)。
      //  这是用户报的那个 bug 的**反向**,设计文档 §4.5 量的是同一件事。
      if (isViewingSession(vref.current, e.workspacePath, e.sessionId)) report.current(vref.current)
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
    report.current(v)
  }, [viewing?.wsPath, viewing?.sessionId, invoke, methods])

  return unread
}
