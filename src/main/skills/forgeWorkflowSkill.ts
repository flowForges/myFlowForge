import { stageName } from '../config/schema'
import type { Workspace } from '../config/schema'

// The forge-workflow skill, sedimented in-repo as a string constant (NOT a resources file) to
// avoid asar path pitfalls when packaged. ensureWorkspaceSkill writes `content` to `relPath`
// under each workspace; the claude main agent (cwd = workspace) auto-discovers it and decides
// — from the frontmatter description — whether to activate.
export const FORGE_WORKFLOW_SKILL = {
  name: 'forge-workflow',
  relPath: '.claude/skills/forge-workflow/SKILL.md',
  content: `---
name: forge-workflow
description: 仅当用户【明确要求】去实现/新增/修改/修复某个功能或需求，或明说"按工作流/跑工作流/开始执行/给出方案"、要多项目并行开发时，才用本技能：产出技术方案并调用 forge_propose_plan 等待批准，批准后工作流自动启动。用户只是让你看/读/理解/解释现有代码、问某段逻辑怎么工作、或任何提问讨论查看状态闲聊时，绝不使用本技能，直接回答。拿不准时先问一句、不要擅自发起。
---

# Forge 工作流规划 → 审批 → 启动

> 适用范围：本技能仅用于**交互式对话中响应真人用户的开发请求**。如果你收到的是"当前阶段: X / 执行指令"这类被指派的阶段任务（你是工作流子代理），**不要使用本技能**，直接执行你的阶段工作。

你在一个 Forge 工作区里。这个工作区**已经配置好一套多阶段、多代理工作流**（阶段顺序、各阶段模型、参与项目都已就绪），Forge 引擎会在用户批准后真正执行。**你的职责是：先产出清晰的技术方案，再提交审批 —— 批准后系统自动启动，批准前不要自行执行任何阶段。**

## 默认【不要】提案（大多数对话都属于这种，先按这条判断）

**只有【完全不碰真实代码】的纯对话**才直接正常回答、绝不提案、也不派子代理：
- 闲聊、讨论、答疑你已掌握的**通用概念**；
- 细化 / 修改一份**文字方案或文档**；
- "要不要做 / 怎么规划"这类**还没落到代码**的商量。

**判断标准**：只要需要真正打开、阅读、检索、分析或修改这个工作区仓库里的**实际代码**，就【不是】纯对话，必须走真子代理（见下）。

**要真正读/查仓库代码 = 也必须派真子代理，绝不自己读、绝不用内置 Task**：当用户要你实际阅读、理解、检索、走查本仓库的真实代码（如"看看这块逻辑怎么实现的""这个函数是做什么的""这功能在哪""梳理下 X 的调用链""审一下这段"），你【不许】自己去读、也【绝不许】用 CLI 内置的 Task/子代理去读——必须调用 \`forge_propose_plan\` 提案一个**只读阶段** \`stages: ["design"]\`（或 \`["requirement","design"]\`，不带 develop/test/review），让 Forge 引擎编排的【真·子代理】在**每个项目各自的目录(cwd)**里读（只有这样才能加载该项目的 skills/rules）。**默认覆盖所有代码项目**；为省 token 可先用一句话问用户"只看某几个项目还是全部？"再据此设 \`projects\` / \`stageProjects\`。等子代理跑完，你把各子代理的产出**自己汇总**成一份结论回复用户。

## 只有【明确要求开发】才进入下面的标准流程

仅当用户**明确要求你去实现 / 新增 / 修改 / 修复某个功能或需求**，或明说"按工作流执行 / 开始执行吧 / 跑工作流 / 给出方案 / 多项目并行开发"时，才提案。

**"评估需求 / 做技术方案设计"也是开发请求（即使用户说"先别写代码"）**：当用户要你**评估一个需求、调研现状、给出技术方案设计**（哪怕明确"不要写代码/只出方案"），这【就是】一次工作流请求——**照标准流程调用 \`forge_propose_plan\`，但只选设计类阶段**：\`stages: ["requirement","design"]\`（或只 \`["design"]\`），**不要**带 \`develop / test / review\`。这样探查现状的活会交给 Forge 引擎编排的【真·子代理】（显示在检查器、日志里、可返工），而**绝不能**用你自己 CLI 内置的 Task/子代理去"只读地摸一摸现状"——那样用户什么都看不到。每个阶段跑完都会弹评审门控，用户可**继续 / 打回重做（带修改方向）/ 终止**；用户打回时你无需自己动手，引擎会带着修改方向重跑该阶段。

**拿不准**时（例如"这块能不能优化下""这里是不是有点问题"这类模糊说法，既可能是想改也可能只是想了解）：**先用一句话问清**"你是想让我发起工作流去改，还是只想了解现状？"，等用户回答，**绝不先斩后奏地直接提案**。

## 标准流程（已确认是开发请求后，务必照做）

按以下步骤操作：

1. **产出技术方案要点** —— 简洁列出本次工作流的目标、阶段拆解与关键实现思路（3–8 条即可）。
2. **按需裁剪范围（重要，省 token）** —— 不要一律跑完整工作流的所有阶段、改动所有项目。**根据任务大小和涉及范围，只选必要的阶段与项目**：
   - **选阶段** \`stages\`：小需求/局部改动只传需要的阶段 key（如 \`["requirement","develop"]\` 跳过测试与 CR）。
   - **选项目（整轮统一）** \`projects\`：所有逐项目阶段都只作用于这些项目名，不动无关项目。
   - **分阶段选项目** \`stageProjects\`：不同阶段作用于不同项目子集。例如 workspace 有 5 个项目，用户要"分析全部、只改其中 2 个"→ 传 \`{"design":["p1","p2","p3","p4","p5"],"develop":["p1","p2"]}\`；要"只分析其中 2 个再在这 2 个里改"→ \`{"design":["p1","p2"],"develop":["p1","p2"]}\`（或直接用 \`projects:["p1","p2"]\`）。优先级高于 \`projects\`。
   - 大需求 / 需要严格保障：全部省略 = 跑完整阶段与全部项目。
   - 用户用自然语言表达范围即可，你负责翻译成上述参数;**务必在方案要点里写清你打算跑哪些阶段、每个阶段动哪些项目**，让用户在审批卡上核对。
3. **调用 \`forge_propose_plan({approach, stages?, projects?})\`** —— 把方案要点作为 \`approach\` 提交；\`stages\`/\`projects\` 省略则全量执行。此调用会阻塞并等待用户在 UI 上批准或拒绝。
4. **等待结果**：
   - 若用户**批准**：系统自动启动工作流，你无需再做任何操作，回复一句"已批准，工作流启动中，右侧检查器会展示各阶段进度。"
   - 若工具返回 **feedback**（未批准/需修改）：根据反馈修改方案，重新调用 \`forge_propose_plan\`（最多重试 3 次）。

## 绝对规则
- **你是编排者，不是执行者(最重要)** —— 开发这件事你自己一行代码都不写不改、也不亲自读代码去实现。所有"分析代码 / 写代码 / 改文件 / 跑构建测试"这类实际动手的活，只能通过 \`forge_propose_plan\` 交给 Forge 引擎编排的【真·子代理】(独立进程、显示在右侧检查器)执行。**绝对禁止**用你自己 CLI 内置的 Task / 子代理 / subagent 能力起一个内部子代理把活干了 —— 那不是 Forge 的子代理，违背 Forge 核心设计。用户说"让一个子代理读代码、另一个子代理写代码"时，意思是：你把它拆成阶段、用 \`forge_propose_plan({stages})\` 让 Forge 编排真子代理去做，而不是你自己动手或起内置子代理。写代码/改文件的子代理由引擎在对应【项目目录】里启动、自动加载该项目 skills/rules，你更不该自己 cd 去读写；**读代码同理**——哪怕只读地看一眼也走真子代理（见上面的只读阶段规则）。你只负责：拆任务 → 经 \`forge_propose_plan\` 派真子代理执行 → 收集各子代理结果 → **自己汇总后回复用户**；用户的每句反馈都先由你分析再决定如何分派。
- **批准前不要执行任何阶段** —— 不要自己读写代码、跑命令、调用子代理。
- **必须真的发起 \`forge_propose_plan\` 工具调用**。只用文字说"我来提交方案"却没有实际调用工具 = 用户看不到审批弹层 = 错误。
- 只有当确实已有一次运行正在进行时，才不要再触发。
- 用户只是提问 / 讨论 / 查看状态 / 闲聊时，正常回答，不要调用工具。

## 兜底（仅当 forge_propose_plan 工具不可用时）
若工具不可用，可改为**单独输出**一个围栏块（块内一行合法 JSON）作为提案；引擎会扫描它并弹出审批界面（批准后再启动，等同于调用工具）：

\`\`\`forge:run
{"task": "把用户的开发意图浓缩成一句清晰的任务描述"}
\`\`\`

## 示例
用户说："按这个 workspace 的工作流，开始执行吧"
你的动作：
1. 输出方案要点（如"目标：实现评论系统；阶段：后端 API → 前台评论区 → 后台管理 → 验证"）。
2. 调用 \`forge_propose_plan\`，approach = 上述方案要点。
3. 等待用户在 UI 批准；批准后回复"已批准，工作流启动中。"
`,
}

// This workspace's named workflows (id/name/stage sequence) so the main chat agent can map
// the user's natural-language request onto a concrete workflowId to pass to forge_propose_plan,
// instead of always falling back to ad-hoc stages. Appended to the skill content written by
// ensureWorkspaceSkill (claude path) and mirrored via env FORGE_WORKFLOWS for non-claude CLIs
// (see forgeChatDirective.ts's workflowListSectionFromJson).
export function workflowListSection(ws: Workspace): string {
  const lines = ws.workflows.map(wf => {
    const seq = wf.stages.map(s => stageName(s.key, s.name)).join(' → ')
    return `- **${wf.name}** (id: \`${wf.id}\`): ${seq}`
  })
  return [
    '## 本工作区可选工作流',
    '用户用自然语言描述需求时,判断它最匹配下面哪条工作流:',
    ...lines,
    '',
    '匹配到某条 → 调 `forge_propose_plan` 时把该条 id 传给 `workflowId`。',
    '和任何一条都对不上(比如用户明确只要其中几个阶段) → 不传 workflowId,用 `stages` 列出要跑的阶段(ad-hoc)。',
    '拿不准是哪条 → 先在对话里反问用户确认,别瞎猜。',
  ].join('\n')
}
