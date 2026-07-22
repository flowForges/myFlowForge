import { useState, useEffect, startTransition, memo } from 'react'
import type { ChatMessage, DesignDocRef } from '@shared/types'
import { fmtMsgTime, fmtMsgTimeFull } from '@shared/relTime'
import { ThinkBlock } from './ThinkBlock'
import { SubagentCards } from './SubagentCards'
import { DelegateBlock } from './DelegateBlock'
import { TurnTimer } from './TurnTimer'
import { Markdown } from './markdown'

// ---- module-level SVG consts (1:1 with the prototype markup) ----
const FILE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
)
const COPY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
)

function fmtSize(bytes: number): string {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

interface Props {
  msg: ChatMessage
  streaming: boolean
  index?: number
  onViewChanges?: () => void
  onOpenDoc?: (doc: DesignDocRef) => void
}

function MessageImpl({ msg, streaming, index, onViewChanges, onOpenDoc }: Props) {
  const isUser = msg.who === 'user'
  const showAnswer = !isUser && (!!msg.text || !streaming)
  const [copied, setCopied] = useState(false)

  // A live-only delegate-batch message carries a `delegate` block and no text — render just the block
  // (no answer eyebrow / copy meta / empty bubble). It rides in the timeline right below the main agent's
  // 「已派发」reply. See DelegateBlock / useChat's delegate-* cases.
  if (!isUser && msg.delegate) {
    return <div className="msg ai msg-delegate"><DelegateBlock batch={msg.delegate} /></div>
  }

  // Switching into a session whose messages are large parses every body's Markdown synchronously in
  // one commit → the app freezes (beachball). For a big, settled (non-streaming) reply, show the raw
  // text first (cheap) and upgrade to parsed Markdown in a low-priority transition, so the switch
  // stays responsive. Small replies (the common case) parse immediately — no flash. Streaming replies
  // always render live so tokens appear as they arrive.
  const heavy = !isUser && !streaming && msg.text.length > 4000
  const [rich, setRich] = useState(!heavy)
  useEffect(() => {
    if (heavy && !rich) startTransition(() => setRich(true))
  }, [heavy, rich])
  const copy = () => {
    navigator.clipboard?.writeText(msg.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => { /* clipboard unavailable */ })
  }
  return (
    <div className={`msg ${msg.who}`} {...(isUser ? { 'data-user-msg': index } : {})}>
      {/* Only two roles (you vs the agent) and the layout already distinguishes them — drop the
         「你」/「主代理」avatar + label. Keep just the model tag on AI replies. The real-time log
         still attributes each line to its agent. */}
      {!isUser && (msg.model || streaming || (msg.startedAt != null && msg.endedAt != null)) && (
        <div className="msg-head">
          {msg.model && <span className="msg-model">{msg.model}</span>}
          <TurnTimer startedAt={msg.startedAt} endedAt={msg.endedAt} streaming={streaming} />
        </div>
      )}
      {msg.think && <ThinkBlock think={msg.think} streaming={streaming} />}
      {!isUser && msg.subagents?.length ? <SubagentCards subagents={msg.subagents} /> : null}
      {isUser ? (
        <div className="msg-body user-body">
          <div className="user-bubble">{msg.text}</div>
        </div>
      ) : (
        <div className={`answer-block${showAnswer ? ' show' : ''}`}>
          {showAnswer && (
            <div className="ans-eyebrow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3"><path d="M12 3l2.2 5.6L20 9.8l-4.4 3.6L17 19l-5-3.2L7 19l1.4-5.6L4 9.8l5.8-1.2z" /></svg>
              {streaming ? '回答中' : '回答'}
            </div>
          )}
          {/* AI replies are Markdown (headings/lists/code/bold); user input stays literal. A large,
             settled reply renders as raw text for one frame (pre-wrap keeps its height close to the
             parsed version, so the swap barely shifts scroll) then upgrades to Markdown. */}
          <div className="msg-body ans">
            {rich ? <Markdown text={msg.text} /> : <div className="ans-plain">{msg.text}</div>}
            {streaming && <span className="pending" />}
          </div>
        </div>
      )}
      {!isUser && msg.docs?.length ? (
        <div className="msg-docs">
          {msg.docs.map((d, i) => (
            <button className="msg-doc" key={d.cwd + '::' + d.path + '::' + i} onClick={() => onOpenDoc?.(d)} title={d.path}>
              {FILE_ICON}
              <span className="md-name">打开文档{msg.docs!.length > 1 ? ` · ${d.name}` : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
      {!isUser && msg.changes && msg.changes.total > 0 && (
        <div className="msg-changes">
          <button className="txt-btn" onClick={onViewChanges}>
            查看变更({msg.changes.total} 文件 +{msg.changes.add} −{msg.changes.del})
          </button>
        </div>
      )}
      {msg.files?.length ? (
        <div className="msg-files">
          {msg.files.map((f, i) => (
            <span className="attach-chip" key={f.path + '::' + i}>
              {FILE_ICON}
              {f.name} <span className="sz">{fmtSize(f.size)}</span>
            </span>
          ))}
        </div>
      ) : null}
      {/* Hover-reveal meta: a copy button + the output time. Hidden until the message is hovered; not
          shown while the AI reply is still streaming (matches the prototype's `!m.pending`). */}
      {!streaming && (
        <div className="msg-meta">
          <button className={`mm-copy${copied ? ' done' : ''}`} title="复制内容" onClick={copy}>
            {COPY_ICON}
            <span className="mm-lab">{copied ? '已复制' : '复制'}</span>
          </button>
          {msg.ts && <span className="mm-time" title={fmtMsgTimeFull(msg.ts)}>{fmtMsgTime(msg.ts, Date.now())}</span>}
        </div>
      )}
    </div>
  )
}

export const Message = memo(MessageImpl)
