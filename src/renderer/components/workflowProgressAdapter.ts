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
import type { WorkOrderOutcome } from '../../main/run/workOrder'
import type { WorkflowSessionState } from '@shared/workflowSession'

// currentStreaming:当前对话步的 AI 是否正在流式输出。true → 该步卡片显示「执行中」;false(输出完、空闲)
// → 显示「已完成」。用户在同一步继续对话、AI 再次输出时会重新变回 true(执行中)。进度条(已完成 N/M)始终
// 按 currentIndex 计,不随流式状态来回跳(当前步在推进前不计入 done)。
export function toWorkflowProgressState(wf: WorkflowSessionState, wsPath: string, currentStreaming = true): RunControllerState {
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

  // 当前对话阶段:流式中 → 注入 liveLane(卡片 'run'=执行中);空闲 → 注入一个 ok 结果(卡片 'ok'=已完成)。
  // 两者都带工作区 cwd,供加载 skill/rule/mcp chips。machineStatus 仍为 'running'(不计入进度条 done),所以
  // 进度条稳定不随流式来回跳。
  const liveLanes: Record<string, LiveLane> = {}
  const outcomes: Record<string, WorkOrderOutcome[]> = {}
  const cur = wf.stages[wf.currentIndex]
  if (!done && cur && cur.scope === 'root') {
    const laneId = `${cur.key}:root`
    if (currentStreaming) {
      liveLanes[laneId] = { stageKey: cur.key, cwd: wsPath }
    } else {
      outcomes[cur.key] = [{
        order: { id: laneId, stageKey: cur.key, name: cur.name, provider: cur.provider, model: cur.model, cwd: wsPath, prompt: '' },
        status: 'ok',
        attempts: 1,
      }]
    }
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
    outcomes,
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
