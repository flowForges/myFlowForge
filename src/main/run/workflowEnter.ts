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
// 图14:落盘到 app 指定的**固定路径**(而非 agent 自由命名),app 因此能在右侧进度卡给一个可靠的「打开」按钮。
// 固定路径必须与渲染侧一致 —— 见 WorkspaceView 里 `forge-docs/${key}.md` 的构造。
export function stageDocRelPath(stageKey: string): string { return `forge-docs/${stageKey}.md` }
function chatModeNote(stageKey: string): string {
  return `\n\n【本阶段=对话模式 · 静默遵守,勿向用户复述本段或提及任何工具的有无】(1) 把本阶段交付物(方案/清单等)**完整写在你的回复正文里**供用户审阅;(2) 同时用你的常规文件写入能力,把同一份交付物保存为 markdown 文件到工作区根目录下的固定路径 **${stageDocRelPath(stageKey)}**(目录不存在就先创建),无需在回复里再报告该路径。直接用普通文件写入完成,无需也不要提及 forge_write_artifact / forge_handoff。`
}

export function planToStageViews(plan: RunPlan): WorkflowStageView[] {
  return plan.stages.map((s) => ({
    key: s.key,
    name: s.name,
    provider: s.provider,
    model: s.model,
    permissionMode: s.permissionMode,
    scope: s.scope,
    preamble: s.scope === 'root' && s.prompt ? s.prompt + chatModeNote(s.key) : s.prompt,
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
    // 尾段之前已完成的对话阶段(技术方案设计等)→ 供面板/运行历史按完整工作流显示进度(1/4 而非 0/3)。
    leadStages: stages.slice(0, fromIndex).map((sv) => ({ key: sv.key, name: sv.name, provider: sv.provider, model: sv.model })),
  }
}

// —— Change 2(2026-07-31,doc-as-contract):从技术方案文档里抽出「各项目任务分工」下每个项目那一节 ——
// design 阶段被要求产出一节 `## 各项目任务分工`,其下每个项目一个 `### <项目名>` 子节(见 STAGE_PROMPTS.design)。
// 进入代码开发前,把每个项目那一节抽出来预填「任务简报」——让用户逐项目审阅/编辑该项目要做什么(来源=方案文档,
// 而非盲蒸馏),同时代码 lane 仍会读整份文档(见 controller.buildPrompt)。纯字符串解析,便于单测。
//  - 优先在「## …分工…」小节内按 `### <名>` 切;找不到分工小节时,退而在全文任意层级标题里找匹配项目名的一节。
//  - 标题匹配:与项目名完全相等,或标题文本包含项目名(容忍「### go-blog（前端）」这类)。
export function extractProjectBriefs(md: string, projectNames: string[]): { found: boolean; sections: Record<string, string> } {
  const sections: Record<string, string> = {}
  if (!md || !md.trim() || !projectNames.length) return { found: false, sections }
  const lines = md.split('\n')
  // 定位「## …分工…」小节的行区间 [start, end)(end = 下一个同级或更高级 ## 标题,或 EOF)。找不到则用全文。
  let blockStart = 0
  let blockEnd = lines.length
  const fenIdx = lines.findIndex((l) => /^##\s+.*分工/.test(l))
  if (fenIdx >= 0) {
    blockStart = fenIdx + 1
    blockEnd = lines.length
    for (let i = blockStart; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i]) && !/^###/.test(lines[i])) { blockEnd = i; break }
    }
  }
  const scope = fenIdx >= 0 ? lines.slice(blockStart, blockEnd) : lines
  // 在 scope 内按任意 ### / #### 标题切段,标题文本匹配项目名的收集其正文。
  const norm = (s: string) => s.trim().toLowerCase()
  let curName: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (curName && buf.length) {
      const text = buf.join('\n').trim()
      if (text) sections[curName] = sections[curName] ? `${sections[curName]}\n\n${text}` : text
    }
    buf = []
  }
  for (const line of scope) {
    const h = line.match(/^#{2,4}\s+(.+?)\s*$/)
    if (h) {
      const title = norm(h[1])
      // 匹配优先级:①标题正好等于项目名;②否则取"标题包含其名"的项目里名字最长的那个。②很关键——
      // "go-blog" 是 "go-blog-backend" 的前缀,若用 find 取第一个包含项,"### 📦 go-blog-backend" 会被错分给
      // go-blog,导致 backend 丢了自己的节(→空简报→被误判无需改动而跳过)。取最长名保证归到最具体的项目。
      const exact = projectNames.find((p) => norm(p) === title)
      const matched = exact
        ?? projectNames.filter((p) => title.includes(norm(p))).sort((a, b) => b.length - a.length)[0]
      if (matched) { flush(); curName = matched; continue }
      // 非项目标题:结束当前项目节(避免把别的小节吞进来)。
      flush(); curName = null; continue
    }
    if (curName) buf.push(line)
  }
  flush()
  return { found: Object.keys(sections).length > 0, sections }
}
