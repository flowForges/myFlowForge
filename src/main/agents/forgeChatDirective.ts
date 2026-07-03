// Non-claude CLIs (codex reads .codex/skills, qoder reads .qoder/skills) never auto-load the
// workspace's .claude/skills/forge-workflow skill the way the claude main agent does, so they
// never learn they should propose a plan via the forge_propose_plan MCP tool — they just keep
// asking clarifying questions. When the chat bridge exposes that tool (env.FORGE_TOOLS), inline
// the same guidance so the CLI proposes a plan instead. Mirrors src/main/skills/forgeWorkflowSkill.ts,
// condensed. Fail-open: returns '' when the tool isn't exposed, so behavior is unchanged.
export function forgeChatDirective(env: NodeJS.ProcessEnv): string {
  if (!String(env?.FORGE_TOOLS ?? '').includes('forge_propose_plan')) return ''
  return [
    '【Forge 工作流规则】你在一个 Forge 工作区，这里已配置好一套多阶段、多代理工作流，引擎会在用户批准后真正执行。',
    '当用户表达开发意图（实现功能 / 修复缺陷 / 按需求推进 / "开启工作流" / "给出方案" / 多项目并行开发）时，必须：',
    '1) 简洁列出技术方案要点（目标、阶段拆解、关键实现思路，3–8 条）；',
    '2) 真的调用 MCP 工具 forge_propose_plan({approach}) 提交方案并等待用户在 UI 上批准——只用文字说"我来提交"而不实际调用工具是错误的；',
    '3) 批准前不要自行读写代码、跑命令或执行任何阶段；批准后回复一句"已批准，工作流启动中，右侧检查器会展示各阶段进度。"。',
    '不要为此加载 deep-interview / OMX / brainstorming 等其它技能或外部工具。若用户只是提问、讨论、查看状态、闲聊，则正常回答，不要调用该工具。',
  ].join('\n')
}
