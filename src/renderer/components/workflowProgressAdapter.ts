// 对话式工作流(2026-07-30)的右侧进度 —— 复用 beta.16 那套 `RunExecPanel`(`.wfo-head`/`.wfo-flow`/
// 分阶段 `.pipe`/`AgentNode`),不再手写卡片。做法照 `runHistoryAdapter.toHistoricalState`:把轻量的
// `WorkflowSessionState` 合成成 `RunExecPanel`/`runExecAdapter.buildStageRuntimes` 期望的只读
// `RunControllerState`。
//
// 对话阶段没有真 run —— 每个工作流阶段映射成一张卡:currentIndex 之前='done',当前='running'(会话
// 阶段用户正在左侧对话推进),之后='pending';进度条按此如实显示(honest,非假数据)。当前对话阶段额外
// 注入一条 liveLane(cwd=工作区根),让它的卡渲染成 'run' 并让 RunExecPanel 的 scanContext(cwd) 加载
// 真实的 skill/rule/mcp chips —— 即 img20 想要的"当前 agent 已加载的上下文",但走的是真实来源而非手传。
//
// 执行尾段(phase==='executing')有真 run2 state 时,WorkspaceView 直接把 live run2 传给 RunExecPanel
// (真分支/实时 lane 日志/运行控制),不走本合成器。
import type { RunControllerState, LiveLane } from '../../main/run/controller'
import type { StagePlan, StageStatus } from '../../main/run/machine'
import type { DevelopProject } from '../../main/run/runTypes'
import type { WorkflowSessionState } from '@shared/workflowSession'

export function toWorkflowProgressState(wf: WorkflowSessionState, wsPath: string): RunControllerState {
  const stages: StagePlan[] = wf.stages.map((s) => ({
    key: s.key,
    name: s.name,
    provider: s.provider,
    model: s.model,
    scope: s.scope,
    gate: false,
    permissionMode: s.permissionMode,
  }))
  const done = wf.phase === 'done'
  const machineStages = wf.stages.map((s, i) => {
    const status: StageStatus =
      done || i < wf.currentIndex ? 'done' : i === wf.currentIndex ? 'running' : 'pending'
    return { key: s.key, status, round: 0 }
  })

  // 当前对话阶段 → 注入 liveLane(带工作区 cwd),使其卡渲染 'run' 且携带 cwd 供加载上下文 chips。
  const liveLanes: Record<string, LiveLane> = {}
  const cur = wf.stages[wf.currentIndex]
  if (!done && cur && cur.scope === 'root') {
    liveLanes[`${cur.key}:root`] = { stageKey: cur.key, cwd: wsPath }
  }

  // 供尚未运行的扇出阶段预览"每项目一张 wait 卡"(buildFanoutAgents 以 state.projects 播种)。cwd 未知
  // 给空串:未运行的 lane 本就不扫上下文,无碍。
  const projects: DevelopProject[] = wf.projects.map((p) => ({
    name: p.name,
    cwd: '',
    provider: p.provider,
    model: p.model,
    permissionMode: p.permissionMode,
    brief: p.brief,
  }))

  return {
    machine: {
      plan: { runId: wf.runId ?? `wf:${wf.flowId}`, stages },
      stages: machineStages,
      currentIndex: Math.min(wf.currentIndex, Math.max(0, wf.stages.length - 1)),
    },
    inbox: [],
    feedback: [],
    outcomes: {},
    status: done ? 'ok' : 'running',
    pendingDirective: {},
    liveLanes,
    stageTimings: {},
    laneTimings: {},
    laneSessions: {},
    paused: false,
    projects,
  }
}
