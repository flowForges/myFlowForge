import { useEffect, useRef, useState } from 'react'
import type { ChatEvent } from '@shared/types'
import { markUnread, clearUnread, type Viewing } from './unread'

// Global unread tracker: listens to EVERY workspace's chat stream (not just the active one) and
// marks a session unread when it finishes while the user is looking elsewhere. The session the user
// is currently viewing is always "read" — cleared automatically whenever the view changes. Pure
// mark/clear logic lives in ./unread (unit-tested); this hook is the thin subscription glue.
export function useUnread(viewing: Viewing): ReadonlySet<string> {
  const [unread, setUnread] = useState<Set<string>>(() => new Set())
  const vref = useRef(viewing)
  vref.current = viewing

  useEffect(() => {
    const off = window.forge.onChatEvent((e: ChatEvent) => {
      if (e.type !== 'done') return
      setUnread(s => markUnread(s, e.workspacePath, e.sessionId, vref.current))
    })
    return () => { off() }
  }, [])

  useEffect(() => {
    setUnread(s => (s.size ? clearUnread(s, viewing.wsPath, viewing.sessionId) : s))
  }, [viewing.wsPath, viewing.sessionId])

  return unread
}
