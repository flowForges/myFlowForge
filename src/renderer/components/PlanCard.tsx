import { Markdown } from '../views/chat/markdown'

export interface PlanReq {
  id: string
  approach: string
  stages: { name: string; agents: number }[]
  task?: string
  ts?: string
  workflowId?: string
  workflowName?: string
  workflowOptions?: { id: string; name: string }[]
}

const AD_HOC = ''   // <select> value for "临时/自定义(ad-hoc)" — undefined can't be an <option value>

interface PlanCardProps {
  req: PlanReq
  onResolve: (d: { decision: 'allow' | 'deny' | 'modify'; value?: string }) => void
  // Undefined workflowId = switch to ad-hoc (no named workflow). Optional: cards from callers that
  // haven't wired re-propose yet (Task 12 step 3) simply render the dropdown without a live handler.
  onSwitchWorkflow?: (workflowId?: string) => void
  // "修改方向…" now reflows into the main composer instead of an inline textarea (Task 15) — the
  // parent seeds a quote marker into the composer and routes the next send back to this plan's
  // resolver as a 'modify' decision. Optional so existing callers that haven't wired it yet still
  // render (button becomes a no-op until wired).
  onSupplement?: () => void
}

// .msg-req card for the hard gate — reuses ReqCard's confirm/input markup + the
// ic-stages stage-chip pipeline. approach/task are UNTRUSTED (LLM output) and are
// rendered as plain JSX (auto-escaped), mirroring ReqCard.
export function PlanCard({ req, onResolve, onSwitchWorkflow, onSupplement }: PlanCardProps) {
  return (
    <div className="msg-req k-confirm plan-card" data-req={req.id}>
      <div className="req-head">
        <span className="req-kind">方案待批准</span>
      </div>
      <div className="req-body">
        <div className="req-sub plan-workflow">
          <span>本次识别为【{req.workflowName ?? '临时/自定义流程'}】</span>
          <select
            className="plan-workflow-switch"
            value={req.workflowId ?? AD_HOC}
            onChange={e => onSwitchWorkflow?.(e.target.value === AD_HOC ? undefined : e.target.value)}
          >
            <option value={AD_HOC}>临时/自定义(ad-hoc)</option>
            {(req.workflowOptions ?? []).map(w => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
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
        <div className="req-actions">
          <button className="req-ok" onClick={() => onResolve({ decision: 'allow' })}>批准并执行</button>
          <button onClick={() => onSupplement?.()}>修改方向…</button>
          <button className="req-no" onClick={() => onResolve({ decision: 'deny' })}>取消</button>
        </div>
      </div>
    </div>
  )
}
