import { useEffect, useState } from 'react'
import type { ChatEvent } from '@shared/types'
import type { ChatActivity } from './derivePetState'

export function useChatActivity(): ChatActivity {
  const [streaming, setStreaming] = useState<Set<string>>(new Set())
  const [confirms, setConfirms] = useState<Set<string>>(new Set())

  useEffect(() => {
    const off = window.forge.onChatEvent((e: ChatEvent) => {
      if (e.type === 'assistant-start') setStreaming(s => new Set(s).add(e.id))
      else if (e.type === 'done') setStreaming(s => { const n = new Set(s); n.delete(e.message.id); return n })
      else if (e.type === 'error') setStreaming(s => { const n = new Set(s); n.delete(e.id); return n })
      else if (e.type === 'confirm-request') setConfirms(s => new Set(s).add(e.id))
      else if (e.type === 'confirm-resolved') setConfirms(s => { const n = new Set(s); n.delete(e.id); return n })
    })
    return () => { off() }
  }, [])

  return { busy: streaming.size > 0, confirmPending: confirms.size > 0 }
}
