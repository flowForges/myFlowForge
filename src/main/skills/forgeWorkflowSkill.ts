// The forge-workflow skill, sedimented in-repo as a string constant (NOT a resources file) to
// avoid asar path pitfalls when packaged. ensureWorkspaceSkill writes `content` to `relPath`
// under each workspace; the claude main agent (cwd = workspace) auto-discovers it and decides
// — from the frontmatter description — whether to activate.
export const FORGE_WORKFLOW_SKILL = {
  name: 'forge-workflow',
  relPath: '.claude/skills/forge-workflow/SKILL.md',
  content: `---
name: forge-workflow
description: 当用户要进行需求开发、功能实现、缺陷修复，或说"按工作流/按流程执行""开始执行""跑工作流""给出方案"，或要多项目并行开发时，必须用本技能。先产出技术方案并调用 forge_propose_plan 等待批准，批准后工作流自动启动。仅当用户单纯提问、讨论、查看状态、闲聊时才不使用。
---

# Forge 工作流规划 → 审批 → 启动

> 适用范围：本技能仅用于**交互式对话中响应真人用户的开发请求**。如果你收到的是"当前阶段: X / 执行指令"这类被指派的阶段任务（你是工作流子代理），**不要使用本技能**，直接执行你的阶段工作。

你在一个 Forge 工作区里。这个工作区**已经配置好一套多阶段、多代理工作流**（阶段顺序、各阶段模型、参与项目都已就绪），Forge 引擎会在用户批准后真正执行。**你的职责是：先产出清晰的技术方案，再提交审批 —— 批准后系统自动启动，批准前不要自行执行任何阶段。**

## 标准流程（务必照做）

当用户表达开发意图（实现功能 / 修复缺陷 / 按需求推进 / "按工作流执行" / "开始执行吧" / 多项目并行开发）时，按以下步骤操作：

1. **产出技术方案要点** —— 简洁列出本次工作流的目标、阶段拆解与关键实现思路（3–8 条即可）。
2. **调用 \`forge_propose_plan({approach})\`** —— 把方案要点作为 \`approach\` 参数提交；此调用会阻塞并等待用户在 UI 上点击批准或拒绝。
3. **等待结果**：
   - 若用户**批准**：系统自动启动工作流，你无需再做任何操作，回复一句"已批准，工作流启动中，右侧检查器会展示各阶段进度。"
   - 若工具返回 **feedback**（未批准/需修改）：根据反馈修改方案，重新调用 \`forge_propose_plan\`（最多重试 3 次）。

## 绝对规则
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
