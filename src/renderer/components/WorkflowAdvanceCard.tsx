import './workflowAdvanceCard.css'

// D3/D4(2026-07-30):推进工作流时的"可编辑交接"卡。两种模式:
//  - 'handoff'(跨 provider 推进):一段可编辑交接稿(自动蒸馏当前对话,用户可改)→ 作为下一(对话)阶段
//    给新 provider 的地面真相。
//  - 'briefs'(进入执行):每个项目一段可编辑任务简报 → 作为该项目 lane 的最高优先指令。
export interface WorkflowAdvanceCardProps {
  mode: 'handoff' | 'briefs'
  toStageName: string
  toProvider: string
  loading?: boolean
  // Change 2:进代码开发前若没找到技术方案文档等,给一条警告(不阻断,提醒用户)。
  warn?: string
  handoff: string
  briefs: { project: string; text: string; skip?: boolean }[]
  onChangeHandoff: (v: string) => void
  onChangeBrief: (project: string, v: string) => void
  // #2:勾"本次跳过"的项目不进执行(不起 lane、省 token)。无需改动的项目默认勾上。
  onToggleSkip?: (project: string, skip: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}

export function WorkflowAdvanceCard({
  mode, toStageName, toProvider, loading, warn, handoff, briefs,
  onChangeHandoff, onChangeBrief, onToggleSkip, onConfirm, onCancel,
}: WorkflowAdvanceCardProps) {
  const isHandoff = mode === 'handoff'
  return (
    <div className="wf-adv" data-mode={mode}>
      <div className="wf-adv-head">
        <span className="wf-adv-kind">{isHandoff ? '交接给下一步' : '开始执行前 · 任务简报'}</span>
        <span className="wf-adv-to">→ {toStageName}{toProvider ? ` · ${toProvider}` : ''}</span>
      </div>
      <div className="wf-adv-body">
        {warn && <div className="wf-adv-warn">{warn}</div>}
        {isHandoff ? (
          <>
            <div className="wf-adv-hint">这份交接稿会作为下一步 provider 的起点，跑偏的删掉、要点补上。</div>
            {loading ? (
              <div className="wf-adv-loading"><span className="wf-adv-spin" />正在蒸馏当前对话为交接稿…</div>
            ) : (
              <textarea className="wf-adv-ta" rows={5} value={handoff} placeholder="交接给下一步的要点…" onChange={(e) => onChangeHandoff(e.target.value)} />
            )}
          </>
        ) : (
          <>
            <div className="wf-adv-hint">每个项目要做什么，改成你想要的；这会作为该项目执行 agent 的首要指令。</div>
            {loading ? (
              <div className="wf-adv-loading"><span className="wf-adv-spin" />正在把技术方案整理成各项目任务简报…</div>
            ) : (
              <>
                {briefs.map((b) => (
                  <div key={b.project} className={`wf-adv-brief${b.skip ? ' skipped' : ''}`}>
                    <div className="wf-adv-brief-nm">
                      <span>{b.project}</span>
                      {onToggleSkip && (
                        <label className="wf-adv-skip" title="勾选后本项目不进代码开发,不启动它的 agent(省 token)">
                          <input type="checkbox" checked={!!b.skip} onChange={(e) => onToggleSkip(b.project, e.target.checked)} />
                          本次跳过
                        </label>
                      )}
                    </div>
                    {!b.skip && (
                      <textarea className="wf-adv-ta" rows={3} value={b.text} placeholder={`${b.project} 要做的…`} onChange={(e) => onChangeBrief(b.project, e.target.value)} />
                    )}
                  </div>
                ))}
                {briefs.length === 0 ? <div className="wf-adv-hint">（没有选定的执行项目）</div> : null}
              </>
            )}
          </>
        )}
      </div>
      <div className="wf-adv-actions">
        <button className="wf-adv-no" onClick={onCancel}>取消</button>
        <button className="wf-adv-ok" disabled={loading} onClick={onConfirm}>{isHandoff ? '带这份交接稿继续' : '开始执行'}</button>
      </div>
    </div>
  )
}
