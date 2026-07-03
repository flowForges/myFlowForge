import { useEffect, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { Message } from './Message'

interface Props {
  messages: ChatMessage[]
  streamingIds: Set<string>
  onViewChanges?: () => void
  windowSize?: number
}

export function MessageStream({ messages, streamingIds, onViewChanges, windowSize }: Props) {
  const [shown, setShown] = useState(windowSize ?? Infinity)

  // Reset window when switching sessions (first message id changes) or windowSize changes
  useEffect(() => { setShown(windowSize ?? Infinity) }, [windowSize, messages[0]?.id])

  const start = Math.max(0, messages.length - shown)
  const vis = start > 0 ? messages.slice(start) : messages

  return (
    <>
      {start > 0 && (
        <button
          className="msg-load-earlier"
          type="button"
          onClick={() => setShown(s => s + 50)}
        >
          加载更早 {start} 条
        </button>
      )}
      {vis.map((m, i) => (
        <Message
          key={m.id}
          msg={m}
          index={start + i}
          streaming={streamingIds.has(m.id)}
          onViewChanges={onViewChanges}
        />
      ))}
    </>
  )
}
