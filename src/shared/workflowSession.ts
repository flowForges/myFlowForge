import type { PermissionMode } from './permissions'

// —— 轻量对话式工作流(2026-07-30 重构)——
// 工作流不再是 RunController 自动跑完所有阶段的编排,而是挂在某个聊天 session 上的一层很轻的状态机:
// 用户在会话区正常对话,但 composer 被"偏置"到当前阶段的 provider/model/权限;顶部 ribbon 显示进度与
// [下一步]。单线(对话)阶段 = 普通聊天;扇出阶段 = 交给现有 run2 执行机制(临时分支+内联 lane 卡+汇总)。
//
// 本文件是纯类型 + 纯函数(main 与 renderer 都 import),不得 import electron/react/zod。

// 一个阶段在 session/renderer 视角下的最小面。scope==='per-project' 即"扇出"阶段(交执行机制);
// 'root' 即"对话"阶段(单线聊天)。preamble = 进入该阶段时一次性注入的"角色提示"。
export interface WorkflowStageView {
  key: string
  name: string
  provider: string
  model: string
  permissionMode?: PermissionMode
  scope: 'root' | 'per-project'
  preamble?: string
}

// 'chatting' = 停在某个对话阶段,等用户驱动;'executing' = 已进入扇出尾段,交 RunController 跑;
// 'done' = 全部阶段走完(或执行尾段结束)。
export type WorkflowPhase = 'chatting' | 'executing' | 'done'

export interface WorkflowSessionState {
  flowId: string
  flowName: string
  stages: WorkflowStageView[]
  currentIndex: number
  phase: WorkflowPhase
  // 执行尾段一旦启动,记下对应的 RunController runId(用于 ribbon/面板关联该 run 的 lane 卡)。
  runId?: string
  // 启动时选定、供执行尾段用的项目(名字 + provider/model/权限覆盖)。对话阶段用不到。
  projects: { name: string; provider: string; model: string; permissionMode?: PermissionMode }[]
  supplement?: string
  seed?: string
}

export function currentStage(ws: WorkflowSessionState): WorkflowStageView | undefined {
  return ws.stages[ws.currentIndex]
}

// 从 currentIndex 起,是否已经进入(或即将进入)扇出尾段——即当前及之后存在至少一个 per-project 阶段。
// 执行模型:第一次推进到一个 per-project 阶段时,把"从该阶段起的所有剩余阶段"作为一次 RunController
// 运行的执行尾段(root 阶段被 RunController 当单代理 root lane 处理,扇出阶段按项目并行)。
export function isExecutionStage(s: WorkflowStageView | undefined): boolean {
  return !!s && s.scope === 'per-project'
}

// 纯推进:移到下一阶段并计算新 phase。不产生副作用(启动 RunController 由调用方按 phase 决定)。
//  - 已是最后一阶段 → phase='done'。
//  - 下一阶段是扇出(per-project) → phase='executing'(调用方据此启动执行尾段)。
//  - 否则(下一阶段是对话) → phase='chatting'。
export function advanceWorkflow(ws: WorkflowSessionState): WorkflowSessionState {
  const next = ws.currentIndex + 1
  if (next >= ws.stages.length) return { ...ws, currentIndex: ws.stages.length, phase: 'done' }
  const phase: WorkflowPhase = isExecutionStage(ws.stages[next]) ? 'executing' : 'chatting'
  return { ...ws, currentIndex: next, phase }
}

// 执行尾段要交给 RunController 的阶段子集 = 从 fromIndex 起的所有剩余阶段。
export function executionTail(ws: WorkflowSessionState, fromIndex: number): WorkflowStageView[] {
  return ws.stages.slice(fromIndex)
}

// 推进是否会跨 provider(触发可编辑交接稿):当前阶段与下一阶段 provider 不同。
// 到达末尾(无下一阶段)返回 false。
export function advanceCrossesProvider(ws: WorkflowSessionState): boolean {
  const cur = ws.stages[ws.currentIndex]
  const nxt = ws.stages[ws.currentIndex + 1]
  return !!cur && !!nxt && cur.provider !== nxt.provider
}
