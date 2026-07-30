import type { RunPlan } from './machine'
import type { LaunchStartConfig } from './launch'
import { isExecutionStage, type WorkflowSessionState, type WorkflowStageView } from '../../shared/workflowSession'

// —— 对话式工作流(2026-07-30)· 主进程侧纯映射 helper ——
// 把 run2 的 RunPlan/LaunchStartConfig 与轻量 WorkflowSessionState 互转。纯函数,便于单测,IPC 处理器
// (workflow:enter / workflow:advance)只做副作用(读写 session store、启动 RunController 执行尾段)。

// RunPlan 的每个 StagePlan → 会话视角的 WorkflowStageView。preamble = 该阶段发给 agent 的指令(stage.prompt),
// 对话阶段进入时一次性注入(见 chatService),扇出阶段作为执行尾段各 lane 的 prompt 基座。
export function planToStageViews(plan: RunPlan): WorkflowStageView[] {
  return plan.stages.map((s) => ({
    key: s.key,
    name: s.name,
    provider: s.provider,
    model: s.model,
    permissionMode: s.permissionMode,
    scope: s.scope,
    preamble: s.prompt,
  }))
}

// 从启动配置解析出的 plan + 选定项目,构建初始 WorkflowSessionState(停在阶段0)。
export function buildWorkflowSession(args: {
  flowId: string
  flowName: string
  plan: RunPlan
  projects: { name: string; provider: string; model: string; permissionMode?: WorkflowStageView['permissionMode']; brief?: string }[]
  supplement?: string
  seed?: string
}): WorkflowSessionState {
  const stages = planToStageViews(args.plan)
  return {
    flowId: args.flowId,
    flowName: args.flowName,
    stages,
    currentIndex: 0,
    // 阶段0通常是对话(root);若某个流首阶段就是扇出,则直接进执行。
    phase: isExecutionStage(stages[0]) ? 'executing' : 'chatting',
    projects: args.projects,
    supplement: args.supplement,
    seed: args.seed,
  }
}

// 进入执行尾段时,构造交给 run2 launch-start 机制的 LaunchStartConfig:只启用 fromIndex 起的阶段,
// 每阶段带回它在会话里配好的 provider/model/权限/范围(perProject 显式复原 scope,确定性)。
export function tailLaunchConfig(
  base: { workspacePath: string; flowId: string; sessionId?: string; supplement?: string; seed?: string; projects: { name: string; provider: string; model: string; permissionMode?: WorkflowStageView['permissionMode']; brief?: string }[] },
  stages: WorkflowStageView[],
  fromIndex: number,
): LaunchStartConfig {
  return {
    workspacePath: base.workspacePath,
    workflowId: base.flowId,
    projects: base.projects,
    supplement: base.supplement ?? '',
    seed: base.seed ?? '',
    sessionId: base.sessionId,
    stages: stages.map((sv, i) => ({
      key: sv.key,
      enabled: i >= fromIndex,
      provider: sv.provider,
      model: sv.model,
      permissionMode: sv.permissionMode,
      // 显式复原每阶段范围:扇出→per-project,对话→root。buildLaunchPlan 对显式 perProject 恒生效。
      perProject: sv.scope === 'per-project',
    })),
  }
}
