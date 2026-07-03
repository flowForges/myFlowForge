import { useState } from 'react'
import { Markdown } from '../views/chat/markdown'

export interface PlanReq {
  id: string
  approach: string
  stages: { name: string; agents: number }[]
  task?: string
  ts?: string
}

interface PlanCardProps {
  req: PlanReq
  onResolve: (d: { decision: 'allow' | 'deny' | 'modify'; value?: string }) => void
}

// .msg-req card for the hard gate — reuses ReqCard's confirm/input markup + the
// ic-stages stage-chip pipeline. approach/task are UNTRUSTED (LLM output) and are
// rendered as plain JSX (auto-escaped), mirroring ReqCard.
export function PlanCard({ req, onResolve }: PlanCardProps) {
  const [editing, setEditing] = useState(false)
  const [fb, setFb] = useState('')

  return (
    <div className="msg-req k-confirm plan-card" data-req={req.id}>
      <div className="req-head">
        <span className="req-kind">方案待批准</span>
      </div>
      <div className="req-body">
        {req.task ? <div className="req-sub plan-task"><span>任务</span>{req.task}</div> : null}
        <div className="req-title plan-approach"><Markdown text={req.approach} /></div>
        {req.stages.length ? (
          <div className="plan-stages">
            <span className="plan-stages-label">执行阶段</span>
            <div className="ic-stages">
              {req.stages.map((s, i) => (
                <span key={i} className="ic-stage">
                  {i > 0 && <span className="ar">→</span>}
                  {s.name} · {s.agents > 1 ? `并行${s.agents}代理` : '单代理'}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {!editing ? (
          <div className="req-actions">
            <button className="req-ok" onClick={() => onResolve({ decision: 'allow' })}>批准并执行</button>
            <button onClick={() => setEditing(true)}>修改方向…</button>
            <button className="req-no" onClick={() => onResolve({ decision: 'deny' })}>取消</button>
          </div>
        ) : (
          <div className="req-inrow">
            <input
              type="text"
              placeholder="说明要改的方向"
              value={fb}
              onChange={e => setFb(e.target.value)}
            />
            <button onClick={() => onResolve({ decision: 'modify', value: fb })}>提交修改</button>
            <button className="req-no" onClick={() => { setFb(''); setEditing(false) }}>返回</button>
          </div>
        )}
      </div>
    </div>
  )
}
