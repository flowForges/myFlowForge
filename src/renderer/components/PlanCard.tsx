import { useState } from 'react'
import { Markdown } from '../views/chat/markdown'

export interface PlanReq {
  id: string
  approach: string
  stages: { key: string; name: string; agents: number; perProject: boolean; projects: string[] }[]
  hooks?: { id: string; name: string; after: string }[]
  allProjects: string[]
  task?: string
  ts?: string
  workflowId?: string
  workflowName?: string
  workflowOptions?: { id: string; name: string }[]
}
export type PlanSelection = { stages: string[]; stageProjects: Record<string, string[]>; hooks: string[] }

const AD_HOC = ''   // <select> value for "临时/自定义(ad-hoc)" — undefined can't be an <option value>

interface PlanCardProps {
  req: PlanReq
  onResolve: (d: { decision: 'allow' | 'deny' | 'modify'; value?: string; selection?: PlanSelection }) => void
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
  // Editable selection: which stages to run, and which projects each per-project stage scans. Seeded from
  // the agent's proposal; unticking a stage or a project trims THIS run (saves tokens) without changing
  // the saved workflow config.
  const [onStages, setOnStages] = useState<Record<string, boolean>>(() => Object.fromEntries(req.stages.map(s => [s.key, true])))
  const [stageProj, setStageProj] = useState<Record<string, string[]>>(() => Object.fromEntries(req.stages.map(s => [s.key, s.projects])))
  const toggleStage = (k: string) => setOnStages(m => ({ ...m, [k]: !m[k] }))
  const toggleProj = (k: string, p: string) => setStageProj(m => {
    const cur = m[k] ?? []
    return { ...m, [k]: cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p] }
  })
  // Hook (plugin) selection: ticked by default; unticking skips that hook this run (saves tokens).
  const [onHooks, setOnHooks] = useState<Record<string, boolean>>(() => Object.fromEntries((req.hooks ?? []).map(h => [h.id, true])))
  const toggleHook = (id: string) => setOnHooks(m => ({ ...m, [id]: !m[id] }))
  const hooksAfter = (key: string) => (req.hooks ?? []).filter(h => h.after === key)
  const renderHook = (h: { id: string; name: string; after: string }) => {
    const on = !!onHooks[h.id]
    return (
      <div key={`hook-${h.id}`} className={`plan-stage-row plan-hook-row${on ? '' : ' off'}`}>
        <label className="plan-stage-head">
          <input type="checkbox" checked={on} onChange={() => toggleHook(h.id)} />
          <span className="plan-stage-name">{h.name}</span>
          <span className="plan-stage-meta">HOOK</span>
        </label>
      </div>
    )
  }
  const approve = () => {
    const stages = req.stages.filter(s => onStages[s.key]).map(s => s.key)
    const stageProjects: Record<string, string[]> = {}
    for (const s of req.stages) {
      if (onStages[s.key] && s.perProject) stageProjects[s.key] = stageProj[s.key] ?? s.projects
    }
    const hooks = (req.hooks ?? []).filter(h => onHooks[h.id]).map(h => h.id)
    onResolve({ decision: 'allow', selection: { stages, stageProjects, hooks } })
  }
  const anyStage = req.stages.some(s => onStages[s.key])
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
              <option key={w.id} value={w.id}>{w.name}{w.id === req.workflowId ? ' (推荐)' : ''}</option>
            ))}
          </select>
        </div>
        {req.task ? <div className="req-sub plan-task"><span>任务</span>{req.task}</div> : null}
        <div className="req-title plan-approach"><Markdown text={req.approach} /></div>
        {req.stages.length ? (
          <div className="plan-stages">
            <span className="plan-stages-label">执行步骤(可勾选:去掉不需要的阶段/hook/项目以省 token)</span>
            <div className="plan-stage-list">
              {hooksAfter('__start').map(renderHook)}
              {req.stages.flatMap((s) => {
                const on = !!onStages[s.key]
                return [
                  <div key={s.key} className={`plan-stage-row${on ? '' : ' off'}`}>
                    <label className="plan-stage-head">
                      <input type="checkbox" checked={on} onChange={() => toggleStage(s.key)} />
                      <span className="plan-stage-name">{s.name}</span>
                      {s.perProject
                        ? <span className="plan-stage-meta">{(stageProj[s.key] ?? s.projects).length}/{req.allProjects.length} 个项目</span>
                        : <span className="plan-stage-meta">单代理</span>}
                    </label>
                    {on && s.perProject && req.allProjects.length > 0 && (
                      <div className="plan-proj-chips">
                        {req.allProjects.map(p => {
                          const picked = (stageProj[s.key] ?? []).includes(p)
                          return (
                            <button
                              key={p}
                              type="button"
                              className={`plan-proj-chip${picked ? ' on' : ''}`}
                              onClick={() => toggleProj(s.key, p)}
                              title={picked ? `不扫 ${p}` : `扫 ${p}`}
                            >{p}</button>
                          )
                        })}
                      </div>
                    )}
                  </div>,
                  ...hooksAfter(s.key).map(renderHook),
                ]
              })}
              {hooksAfter('__wf').map(renderHook)}
            </div>
          </div>
        ) : null}
        <div className="req-actions">
          <button className="req-ok" disabled={!anyStage} onClick={approve}>批准并执行</button>
          <button onClick={() => onSupplement?.()}>修改方向…</button>
          <button className="req-no" onClick={() => onResolve({ decision: 'deny' })}>取消</button>
        </div>
      </div>
    </div>
  )
}
