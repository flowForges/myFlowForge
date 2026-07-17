import { useState } from 'react'
import type { RunEvent } from '../../main/run/events'
import type { GateDecision, LaneDecision } from '../../main/run/decisions'
import { Markdown } from '../views/chat/markdown'

interface Run2EventCardProps {
  event: RunEvent
  onGate: (eventId: string, d: GateDecision) => void
  onLane: (eventId: string, d: LaneDecision) => void
}

// Presentational card for one run2 inbox event (auth/question/doubt/failure/gate).
// Mirrors ReqCard's visual language (.msg-req / .req-* classes) — no business state here,
// only local input-box state for question/gate free-text.
export function Run2EventCard({ event, onGate, onLane }: Run2EventCardProps) {
  const [value, setValue] = useState('')
  const [feedback, setFeedback] = useState('')

  return (
    <div className={`msg-req k-${event.kind}`} data-req={event.id}>
      <div className="req-body">
        {event.kind === 'auth' && (
          <>
            <div className="req-title">{event.title}</div>
            {event.where ? <div className="req-sub"><span className="req-file">{event.where}</span></div> : null}
            <div className="req-actions">
              <button className="req-ok" onClick={() => onLane(event.id, { type: 'authorize' })}>批准</button>
              <button className="req-no" onClick={() => onLane(event.id, { type: 'deny' })}>拒绝</button>
            </div>
          </>
        )}

        {event.kind === 'question' && (
          <>
            <div className="req-title">{event.title}</div>
            <div className="req-inrow">
              <input
                type="text"
                placeholder={event.placeholder ?? ''}
                value={value}
                onChange={e => setValue(e.target.value)}
              />
              <button onClick={() => onLane(event.id, { type: 'answer', value })}>提交</button>
            </div>
            <div className="req-actions">
              <button className="req-no" onClick={() => onLane(event.id, { type: 'skipLane' })}>跳过本泳道</button>
              <button className="req-no" onClick={() => onLane(event.id, { type: 'abort' })}>终止</button>
            </div>
          </>
        )}

        {event.kind === 'doubt' && (
          <>
            <div className="req-note">{event.note}</div>
            <div className="req-actions">
              <button className="req-ok" onClick={() => onLane(event.id, { type: 'escalate' })}>升级为方案问题</button>
            </div>
          </>
        )}

        {event.kind === 'failure' && (
          <>
            <div className="req-title">{event.error}</div>
            <div className="req-sub">已重试 {event.attempts} 次</div>
            <div className="req-actions">
              <button className="req-ok" onClick={() => onLane(event.id, { type: 'retry' })}>重跑</button>
              <button className="req-no" onClick={() => onLane(event.id, { type: 'skipLane' })}>跳过</button>
            </div>
          </>
        )}

        {event.kind === 'gate' && (
          <>
            <div className="req-plan"><Markdown text={event.body} /></div>
            {event.docs?.length ? (
              <div className="req-docs">
                {event.docs.map((d, i) => (
                  <div key={`${i}-${d.path}`} className="req-doc" title={d.path}>
                    <span className="req-doc-info">
                      <span className="req-doc-path">{d.path}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="req-actions">
              <button className="req-ok" onClick={() => onGate(event.id, { type: 'advance' })}>通过</button>
              <button className="req-rework" onClick={() => onGate(event.id, { type: 'redo' })}>打回本阶段</button>
              <button className="req-no" onClick={() => onGate(event.id, { type: 'jumpBack', targetKey: 'design' })}>回退到方案</button>
            </div>
            <div className="req-inrow">
              <input
                type="text"
                placeholder="补充意见/反馈…"
                value={feedback}
                onChange={e => setFeedback(e.target.value)}
              />
              <button onClick={() => onGate(event.id, { type: 'redo', feedback })}>提交意见</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
