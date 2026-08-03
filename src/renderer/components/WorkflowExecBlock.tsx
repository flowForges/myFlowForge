import './workflowExecBlock.css'

// D1(2026-07-30 修 · 图2):执行(扇出)阶段把各项目 lane 实时画在**对话区**(此前只在右侧执行面板)。
// 数据来自 run2 的 liveLanes,只读镜像:每条 lane 一行(项目/阶段 + 状态点 + 最近一步)。右侧面板仍是
// 完整仪表盘;这里是会话内的轻量同步展示,呼应 forge_delegate 的 DelegateBlock 观感。
export interface WorkflowExecLane {
  laneId: string
  label: string       // project name, or stage name for a root lane
  stageName: string
  state?: string      // 'run' | 'done' | 'ok' | 'err' | …
  activity?: string
}

function dotClass(state?: string): string {
  if (state === 'err' || state === 'failed') return 'err'
  if (state === 'done' || state === 'ok') return 'done'
  return 'run'
}

export function WorkflowExecBlock({ stageName, lanes }: { stageName: string; lanes: WorkflowExecLane[] }) {
  if (lanes.length === 0) return null
  return (
    <div className="wf-exec">
      <div className="wf-exec-head">
        <span className="wf-exec-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 8.1L22 12l-8.1 1.9L12 22l-1.9-8.1L2 12l8.1-1.9z" /></svg>
        </span>
        <span className="wf-exec-title">执行中 · {stageName}</span>
        <span className="wf-exec-count">{lanes.length} 个项目并行</span>
      </div>
      <div className="wf-exec-lanes">
        {lanes.map((l) => (
          <div key={l.laneId} className="wf-exec-lane" data-state={dotClass(l.state)}>
            <span className={'wf-exec-lane-dot ' + dotClass(l.state)} />
            <span className="wf-exec-lane-nm">{l.label}</span>
            <span className="wf-exec-lane-act">{l.activity || (dotClass(l.state) === 'done' ? '完成' : dotClass(l.state) === 'err' ? '失败' : '执行中…')}</span>
          </div>
        ))}
      </div>
      <div className="wf-exec-hint">右侧「执行」面板有完整过程、输出与合并/丢弃。</div>
    </div>
  )
}
