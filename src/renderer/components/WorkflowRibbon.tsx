import './workflowRibbon.css'
import type { WorkflowPhase } from '@shared/workflowSession'

// P2.3: 常驻在对话区顶部的工作流状态条(滚动时钉住)。纯展示 + 回调,状态由 WorkspaceView 持有的
// WorkflowSessionState 驱动。紫色以区别普通会话。左:流名 + ②阶段/共N + 当前 provider;右:[下一步 →]
// (对话阶段可点;执行中/末阶段禁用)。退出按钮 ×。
export interface WorkflowRibbonProps {
  flowName: string
  stageIndex: number     // 0-based
  stageCount: number
  stageName: string
  provider: string       // display name
  phase: WorkflowPhase
  // 推进按钮是否禁用(如当前轮次还在跑,或正处于执行尾段)。
  advanceDisabled?: boolean
  advanceHint?: string
  // 重启后:phase 仍冻结在 'executing' 但进程已死(有可恢复断点、无活的 run2)。此时不该继续显示"执行中…"
  // (会和下面"从 X 继续"的恢复提示打架),改显示"已中断·可恢复",并把阶段对齐到真实断点。
  interrupted?: boolean
  // 推进按钮文案会随"下一阶段是否切 provider / 是否进入执行"变化,由父组件算好传入。
  advanceLabel?: string
  onAdvance: () => void
  onExit: () => void
}

const NEXT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
const X_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>'

export function WorkflowRibbon({
  flowName, stageIndex, stageCount, stageName, provider, phase,
  advanceDisabled, advanceHint, advanceLabel, onAdvance, onExit, interrupted,
}: WorkflowRibbonProps) {
  const done = phase === 'done'
  // 中断态优先于"执行中":进程已死,别再显示流动的执行态。
  const interruptedNow = !!interrupted && !done
  const executing = phase === 'executing' && !interruptedNow
  return (
    <div className={`wf-ribbon${executing ? ' executing' : ''}${interruptedNow ? ' interrupted' : ''}${done ? ' done' : ''}`} data-phase={interruptedNow ? 'interrupted' : phase}>
      <span className="wf-ribbon-dot" />
      <span className="wf-ribbon-name" title={flowName}>{flowName}</span>
      <span className="wf-ribbon-sep">·</span>
      <span className="wf-ribbon-stage">
        <b>{done ? '已完成' : `${stageIndex + 1}/${stageCount}`}</b> {done ? '' : stageName}
      </span>
      {!done ? (
        <>
          <span className="wf-ribbon-sep">·</span>
          <span className="wf-ribbon-prov">{provider}</span>
        </>
      ) : null}
      <span className="wf-ribbon-spacer" />
      {interruptedNow ? <span className="wf-ribbon-exec wf-ribbon-broken">已中断 · 可恢复</span> : null}
      {executing ? <span className="wf-ribbon-exec">执行中…</span> : null}
      {!done && !executing && !interruptedNow ? (
        <button
          type="button"
          className="wf-ribbon-next"
          disabled={advanceDisabled}
          title={advanceDisabled ? advanceHint : undefined}
          onClick={onAdvance}
        >
          <span>{advanceLabel || '下一步'}</span>
          <span className="wf-ribbon-next-ic" dangerouslySetInnerHTML={{ __html: NEXT_SVG }} />
        </button>
      ) : null}
      <button type="button" className="wf-ribbon-exit" title="退出工作流" onClick={onExit}>
        <span dangerouslySetInnerHTML={{ __html: X_SVG }} />
      </button>
    </div>
  )
}
