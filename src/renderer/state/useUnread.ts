import { useEffect, useRef, useState } from 'react'
import type { ChatEvent } from '@shared/types'
import { markUnread, clearUnread, isViewingSession, type Viewing } from '@shared/chat/unread'

// Global unread tracker: listens to EVERY workspace's chat stream (not just the active one) and
// marks a session unread when it finishes while the user is looking elsewhere. The session the user
// is currently viewing is always "read" — cleared automatically whenever the view changes. Pure
// mark/clear logic lives in ./unread (unit-tested); this hook is the thin subscription glue.
export function useUnread(viewing: Viewing): ReadonlySet<string> {
  const [unread, setUnread] = useState<Set<string>>(() => new Set())
  const vref = useRef(viewing)
  vref.current = viewing

  /**
   * 「这条会话我看过了」——**唯一**的上报出口。下面两处都走它:切到一条会话时,以及
   * 正开着的这条**跑完**时。
   *
   * ★`.catch` 不是可有可无的:电脑端连**远程主机**时,这条 invoke 会被 remote/router.ts 路由出去,
   *  而老 daemon(二期以前)的方法表里没有 chat:mark-seen —— router 会直接抛
   *  「「主机名」不提供这个功能(chat:mark-seen)」。`void` 不吞 rejection,不接住的话
   *  每切一次会话就在渲染进程里留一条 unhandledrejection。手机端那侧是靠查方法表跳过的
   *  (那边拿得到 methods),电脑端这里拿不到方法表,所以是「发了就发了,失败当没发生」。
   *  失败的代价只是别的设备那颗圆点晚一点灭,绝不该为它弹错。
   * ★载荷是 channel 的形状 {workspacePath,…},Viewing 那边叫 wsPath,不能直接把 viewing 丢进去。
   */
  const report = useRef((v: Viewing) => {
    // 首页(两个 id 都空)不上报:那不是「在看某条会话」。
    if (!v.wsPath || !v.sessionId) return
    void window.forge.markChatSeen?.({ workspacePath: v.wsPath, sessionId: v.sessionId })?.catch(() => {})
  })

  useEffect(() => {
    // `?.` 不是多余的:preload 换代/测试环境里 onChatEvent 可能不存在,这里一炸整个 App 白屏,而未读圆点
    // 只是个锦上添花的提示 —— 宁可没有它。
    const off = window.forge.onChatEvent?.((e: ChatEvent) => {
      // 'error' 同样是终态。只认 'done' 的话,一轮以错误收尾就永远不会被标未读 —— 而那恰恰是你最需要被
      // 提醒的情况(在别处忙,后台那轮悄无声息地挂了)。chatService 的 finishOk/finishAborted 发 done、
      // finishErr 发 error,两者互斥,所以这里不会重复标。
      if (e.type !== 'done' && e.type !== 'error') return
      // ★★这一轮是在**你已经开着这条会话**时跑完的 → 本机不标未读(下面 markUnread 自己会跳过),
      //  但**必须照样吭一声**。原来只在 viewing **变化**时上报,于是「开着页面看它跑完」这条路
      //  一次都不上报 —— 手机上盯着跑完、走到桌前,电脑端那颗圆点亮着,而且**永远不会灭**
      //  (它要等一个不会再来的 viewing 变化)。设计文档 §4.5 量的就是这件事,
      //  而「开着对话页看它跑完」正是手机的主要姿势。
      if (isViewingSession(vref.current, e.workspacePath, e.sessionId)) report.current(vref.current)
      setUnread(s => markUnread(s, e.workspacePath, e.sessionId, vref.current))
    })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    // 跨设备未读:别的设备(手机)打开了某条会话 → 主机广播 chat:seen → 这边也把它清掉。
    // `?.` 和上面那条同一个理由:preload 换代/测试环境里这个方法可能不存在,而未读只是锦上添花。
    const off = window.forge.onChatSeen?.((e) => {
      // 空 id 直接丢掉。主进程那头已经挡过一道了,这里再挡一次是为了让**两个客户端读同一份契约**
      // ——手机端 mobile/src/data/useUnread.ts 也是这么写的。少了这道,两端对「什么算一条有效的
      // 已读通知」的判断就不一致,以后谁绕过主机直接发这条广播(比如中转/测试桩)就只有一边挡得住。
      if (!e?.workspacePath || !e?.sessionId) return
      setUnread(s => (s.size ? clearUnread(s, e.workspacePath, e.sessionId) : s))
    })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    setUnread(s => (s.size ? clearUnread(s, viewing.wsPath, viewing.sessionId) : s))
    // 反过来也要说一声:本机切到这条会话了 —— 否则手机上那条未读永远不灭。
    report.current(viewing)
  }, [viewing.wsPath, viewing.sessionId])

  return unread
}
