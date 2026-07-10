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
    '【默认不要提案】大多数对话只需正常回答，绝不调用 forge_propose_plan、绝不发起工作流：让你阅读、理解、解释、分析现有代码，或问某段逻辑怎么工作 / 当前是什么 / 为什么这么写，以及任何了解现状的提问、讨论、查看状态、闲聊——都只回答。理解代码本身不是开发请求。例如"看看当前代码的逻辑""这块是怎么实现的"只回答，不提案。',
    '【只有明确要求开发才提案】仅当用户明确要求你去实现 / 新增 / 修改 / 修复某个功能或需求，或明说"开启/跑工作流 / 开始执行 / 给出方案 / 多项目并行"时，才：',
    '1) 简洁列出技术方案要点（目标、阶段拆解、关键实现思路，3–8 条）；',
    '2) 真的调用 MCP 工具 forge_propose_plan({approach, stages?, projects?}) 提交方案并等待用户在 UI 上批准——只用文字说"我来提交"而不实际调用工具是错误的；**按需裁剪省 token**：小需求/局部改动用 stages 只传需要的阶段 key（如 ["requirement","develop"] 跳过测试与 CR）、用 projects 只传相关项目名，省略则全量执行；',
    '3) 批准前不要自行读写代码、跑命令或执行任何阶段；批准后回复一句"已批准，工作流启动中，右侧检查器会展示各阶段进度。"。',
    '【拿不准就先问】意图模糊时（如"这块能不能优化下""这里是不是有点问题"，既可能想改也可能只想了解）：先用一句话问清"你是想让我发起工作流去改，还是只想了解现状？"，等用户回答，绝不先斩后奏地直接提案。',
    '不要为此加载 deep-interview / OMX / brainstorming 等其它技能或外部工具。',
    '',
    '【确认与提问方式】除了上面这一个"提交方案→用户在 UI 批准"的场景，你在对话里不能弹出任何确认卡片或交互界面。因此：',
    '· 当你需要用户确认、选择、或补充信息时，直接在你这条回复的正文里用文字把问题问清楚（必要时列编号选项），然后停下等待用户的下一条消息回答即可。',
    '· 绝对不要让用户"到 Forge UI / 界面 / 弹窗上确认"，也不要声称已弹出某个确认框——聊天中不存在这样的界面，那样会让用户卡住、无从操作。',
    '· 工作流执行失败后用户在此继续对话时同样遵守本规则：把下一步、疑问或需要的决策用文字讲清楚，让用户直接回复。',
  ].join('\n')
}
