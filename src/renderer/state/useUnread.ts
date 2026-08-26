import { useEffect, useRef, useState } from 'react'
import type { ChatEvent } from '@shared/types'
import { markUnread, clearUnread, type Viewing } from '@shared/chat/unread'

// Global unread tracker: listens to EVERY workspace's chat stream (not just the active one) and
// marks a session unread when it finishes while the user is looking elsewhere. The session the user
// is currently viewing is always "read" — cleared automatically whenever the view changes. Pure
// mark/clear logic lives in ./unread (unit-tested); this hook is the thin subscription glue.
export function useUnread(viewing: Viewing): ReadonlySet<string> {
  const [unread, setUnread] = useState<Set<string>>(() => new Set())
  const vref = useRef(viewing)
  vref.current = viewing

  useEffect(() => {
    // `?.` 不是多余的:preload 换代/测试环境里 onChatEvent 可能不存在,这里一炸整个 App 白屏,而未读圆点
    // 只是个锦上添花的提示 —— 宁可没有它。
    const off = window.forge.onChatEvent?.((e: ChatEvent) => {
      // 'error' 同样是终态。只认 'done' 的话,一轮以错误收尾就永远不会被标未读 —— 而那恰恰是你最需要被
      // 提醒的情况(在别处忙,后台那轮悄无声息地挂了)。chatService 的 finishOk/finishAborted 发 done、
      // finishErr 发 error,两者互斥,所以这里不会重复标。
      if (e.type !== 'done' && e.type !== 'error') return
      setUnread(s => markUnread(s, e.workspacePath, e.sessionId, vref.current))
    })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    // 跨设备未读:别的设备(手机)打开了某条会话 → 主机广播 chat:seen → 这边也把它清掉。
    // `?.` 和上面那条同一个理由:preload 换代/测试环境里这个方法可能不存在,而未读只是锦上添花。
    const off = window.forge.onChatSeen?.((e) => {
      setUnread(s => (s.size ? clearUnread(s, e.workspacePath, e.sessionId) : s))
    })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    setUnread(s => (s.size ? clearUnread(s, viewing.wsPath, viewing.sessionId) : s))
    // 反过来也要说一声:本机切到这条会话了 —— 否则手机上那条未读永远不灭。
    // 首页(两个 id 都空)不上报:那不是「在看某条会话」。
    // ★载荷是 channel 的形状 {workspacePath,…},Viewing 那边叫 wsPath,不能直接把 viewing 丢进去。
    if (viewing.wsPath && viewing.sessionId) {
      void window.forge.markChatSeen?.({ workspacePath: viewing.wsPath, sessionId: viewing.sessionId })
    }
  }, [viewing.wsPath, viewing.sessionId])

  return unread
}
