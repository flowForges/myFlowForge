import { useEffect, useRef, useState } from 'react'
import type { ChatEvent } from '@shared/types'
import type { ChatActivity } from './derivePetState'

export function useChatActivity(): ChatActivity {
  const [streaming, setStreaming] = useState<Set<string>>(new Set())
  // 记住每个待确认门的**位置**,不只是它存在。原先这里是 `Set<id>`,工作区/会话被丢掉了,于是宠物气泡
  // 的「去 app 处理」只能跳到当前工作区 —— 而发起确认的往往是另一个后台会话,点了就跳错地方。
  const [confirms, setConfirms] = useState<Map<string, { wsPath: string; sessionId: string }>>(new Map())
  // Transient "a chat turn just finished" flag so the pet flashes a done reaction on a plain chat
  // reply; auto-clears after a few seconds (or immediately when the next turn starts).
  const [justDone, setJustDone] = useState(false)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const off = window.forge.onChatEvent((e: ChatEvent) => {
      if (e.type === 'assistant-start') {
        setStreaming(s => new Set(s).add(e.id))
        setJustDone(false)
        clearTimeout(doneTimer.current)
      } else if (e.type === 'done') {
        setStreaming(s => { const n = new Set(s); n.delete(e.message.id); return n })
        setJustDone(true)
        clearTimeout(doneTimer.current)
        doneTimer.current = setTimeout(() => setJustDone(false), 4000)
      } else if (e.type === 'error') {
        setStreaming(s => { const n = new Set(s); n.delete(e.id); return n })
      } else if (e.type === 'confirm-request') {
        setConfirms(s => new Map(s).set(e.id, { wsPath: e.workspacePath, sessionId: e.sessionId }))
      } else if (e.type === 'confirm-resolved') {
        setConfirms(s => { const n = new Map(s); n.delete(e.id); return n })
      }
    })
    return () => { off(); clearTimeout(doneTimer.current) }
  }, [])

  // 多个门同时挂着时取最近加入的那个 —— Map 保持插入序,最后一项就是最新到达的确认。
  const latest = confirms.size ? Array.from(confirms.values())[confirms.size - 1] : null
  return { busy: streaming.size > 0, confirmPending: confirms.size > 0, justDone, confirmAt: latest }
}
