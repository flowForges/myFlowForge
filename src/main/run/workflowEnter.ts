import type { RunPlan } from './machine'
import type { LaunchStartConfig } from './launch'
import { isExecutionStage, type WorkflowSessionState, type WorkflowStageView } from '../../shared/workflowSession'

// —— 对话式工作流(2026-07-30)· 主进程侧纯映射 helper ——
// 把 run2 的 RunPlan/LaunchStartConfig 与轻量 WorkflowSessionState 互转。纯函数,便于单测,IPC 处理器
// (workflow:enter / workflow:advance)只做副作用(读写 session store、启动 RunController 执行尾段)。

// RunPlan 的每个 StagePlan → 会话视角的 WorkflowStageView。preamble = 该阶段发给 agent 的指令(stage.prompt),
// 对话阶段进入时一次性注入(见 chatService),扇出阶段作为执行尾段各 lane 的 prompt 基座。
// 修图6:对话(root)阶段跑在普通聊天里,**没有** forge_write_artifact / forge_handoff 等 MCP 工具(那是
// 执行阶段的 RunController 子代理才有)。内置阶段 prompt(STAGE_PROMPTS + DOC_DIRECTIVE)却让 agent 去调这些
// 工具,导致它到处找、找不到、只好写本地文件、并困惑地报告。给对话阶段的角色提示追加一段覆盖说明,明确"对话
// 模式、无这些工具、直接把交付物完整写在回复里给用户审阅"。执行(per-project)阶段保持原样(它们确实有 forge 工具)。
// 修图9+落文件:静默执行以下约定,**不要向用户复述本段、也不要提及工具的有无**(否则会像"当前阶段没有
// forge_write_artifact 工具..."那样制造干扰噪音)。既在回复里展示交付物供审阅,又用普通文件能力落一份到
// 工作区根目录(cwd),让用户也能开文件看。per-project(执行)阶段不加此段(它们跑在 RunController、确有 forge 工具)。
const CHAT_MODE_NOTE = '\n\n【本阶段=对话模式 · 静默遵守,勿向用户复述本段或提及任何工具的有无】(1) 把本阶段交付物(方案/清单等)**完整写在你的回复正文里**供用户审阅;(2) 同时用你的常规文件写入能力,把同一份交付物保存为一个 markdown 文件放到**工作区根目录(即你的当前工作目录)**,文件名用简明中文(如「技术方案-用户登录注册.md」),并在回复最后**单独一行**给出该文件的相对路径。直接用普通文件写入完成,无需也不要提及 forge_write_artifact / forge_handoff。'

export function planToStageViews(plan: RunPlan): WorkflowStageView[] {
  return plan.stages.map((s) => ({
    key: s.key,
    name: s.name,
    provider: s.provider,
    model: s.model,
    permissionMode: s.permissionMode,
    scope: s.scope,
    preamble: s.scope === 'root' && s.prompt ? s.prompt + CHAT_MODE_NOTE : s.prompt,
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
