import { useEffect, useRef, useState } from 'react'
import type { ChatEvent } from '@shared/types'
import type { ChatActivity } from './derivePetState'

export function useChatActivity(): ChatActivity {
  const [streaming, setStreaming] = useState<Set<string>>(new Set())
  const [confirms, setConfirms] = useState<Set<string>>(new Set())
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
      } else if (e.type === 'confirm-request') setConfirms(s => new Set(s).add(e.id))
      else if (e.type === 'confirm-resolved') setConfirms(s => { const n = new Set(s); n.delete(e.id); return n })
    })
    return () => { off(); clearTimeout(doneTimer.current) }
  }, [])

  return { busy: streaming.size > 0, confirmPending: confirms.size > 0, justDone }
}
