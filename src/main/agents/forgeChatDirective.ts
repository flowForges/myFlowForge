import { stageName } from '../config/schema'

// Same workflow list markdown as forgeWorkflowSkill.ts's workflowListSection, but built from the
// JSON in env.FORGE_WORKFLOWS ([{id,name,stages:{key,name?}[]}] — see handlers.ts where the chat
// agent env is assembled) since non-claude CLIs never read workspace.json directly. Each stage
// carries its optional custom display name alongside the key so stageName(key,name) here matches
// forgeWorkflowSkill.ts's workflowListSection exactly (claude and non-claude agents see the same
// labels). Fails open (returns '') on missing/invalid JSON.
function workflowListSectionFromJson(raw: string | undefined): string {
  if (!raw) return ''
  let parsed: Array<{ id: string; name: string; stages: Array<{ key: string; name?: string }> }>
  try { parsed = JSON.parse(raw) } catch { return '' }
  if (!Array.isArray(parsed) || parsed.length === 0) return ''
  const lines = parsed.map(wf => {
    const seq = wf.stages.map(s => stageName(s.key, s.name)).join(' → ')
    return `- **${wf.name}** (id: \`${wf.id}\`): ${seq}`
  })
  return [
    '',
    '## 本工作区可选工作流',
    '用户用自然语言描述需求时,判断它最匹配下面哪条工作流:',
    ...lines,
    '',
    '匹配到某条 → 调 `forge_propose_plan` 时把该条 id 传给 `workflowId`。',
    '和任何一条都对不上(比如用户明确只要其中几个阶段) → 不传 workflowId,用 `stages` 列出要跑的阶段(ad-hoc)。',
    '拿不准是哪条 → 先在对话里反问用户确认,别瞎猜。',
  ].join('\n')
}

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
    '【"评估需求/做技术方案设计"也要提案(即使说不写代码)】当用户要你评估一个需求、调研现状、给出技术方案设计——哪怕明说"先别写代码/只出方案"——这就是一次工作流请求：照下面的流程调用 forge_propose_plan，但只选设计类阶段 stages:["requirement","design"](或只 ["design"]),不带 develop/test/review。这样探查现状交给 Forge 引擎编排的真·子代理(显示在检查器/日志、可返工)，绝不能用你 CLI 内置的 Task/子代理去只读地摸现状——那样用户什么都看不到。每阶段跑完会弹评审门控(继续/打回重做带修改方向/终止)，用户打回时引擎会带着方向重跑该阶段，你不必自己动手。',
    '【只有明确要求开发才提案】仅当用户明确要求你去实现 / 新增 / 修改 / 修复某个功能或需求，或明说"开启/跑工作流 / 开始执行 / 给出方案 / 多项目并行"时，才：',
    '1) 简洁列出技术方案要点（目标、阶段拆解、关键实现思路，3–8 条）；',
    '2) 真的调用 MCP 工具 forge_propose_plan({approach, stages?, projects?, stageProjects?}) 提交方案并等待用户在 UI 上批准——只用文字说"我来提交"而不实际调用工具是错误的；**按需裁剪省 token**：stages 只传要跑的阶段 key（如 ["requirement","develop"] 跳过测试与 CR）；projects 让所有逐项目阶段只作用于这些项目名；stageProjects 按阶段分别指定项目子集（如 {"design":["p1..p5"],"develop":["p1","p2"]} = 分析全部、只在 p1/p2 写代码）；全省略则全量执行；用户用自然语言说范围、你翻译成参数，并在方案里写清跑哪些阶段/每阶段动哪些项目；',
    '3) 批准前不要自行读写代码、跑命令或执行任何阶段；批准后回复一句"已批准，工作流启动中，右侧检查器会展示各阶段进度。"。',
    '【你是编排者，不是执行者 —— 最重要的铁律】开发这件事，你自己一行代码都不写、不改，也不亲自读代码去实现。所有"分析代码 / 写代码 / 改文件 / 跑构建测试"这类实际动手的活，都只能通过 forge_propose_plan 交给 Forge 引擎编排的【真·子代理】(独立进程，会显示在右侧检查器里)去做。**绝对禁止**用你自己 CLI 内置的 Task / 子代理 / subagent 之类能力去起一个内部子代理把活干了——那不是 Forge 的子代理，违背了 Forge 的核心设计。当用户说"让一个子代理读代码、另一个子代理写代码"时，意思就是：你把这些拆成阶段、调用 forge_propose_plan(用 stages 选对应阶段) 让 Forge 编排真子代理执行，而不是你自己动手或起内置子代理。你的职责只有：拆解任务、通过 forge_propose_plan 编排/串联子代理、把用户反馈转达给子代理。',
    '【拿不准就先问】意图模糊时（如"这块能不能优化下""这里是不是有点问题"，既可能想改也可能只想了解）：先用一句话问清"你是想让我发起工作流去改，还是只想了解现状？"，等用户回答，绝不先斩后奏地直接提案。',
    '不要为此加载 deep-interview / OMX / brainstorming 等其它技能或外部工具。',
    '',
    '【确认与提问方式】除了上面这一个"提交方案→用户在 UI 批准"的场景，你在对话里不能弹出任何确认卡片或交互界面。因此：',
    '· 当你需要用户确认、选择、或补充信息时，直接在你这条回复的正文里用文字把问题问清楚（必要时列编号选项），然后停下等待用户的下一条消息回答即可。',
    '· 绝对不要让用户"到 Forge UI / 界面 / 弹窗上确认"，也不要声称已弹出某个确认框——聊天中不存在这样的界面，那样会让用户卡住、无从操作。',
    '· 工作流执行失败后用户在此继续对话时同样遵守本规则：把下一步、疑问或需要的决策用文字讲清楚，让用户直接回复。',
  ].join('\n') + workflowListSectionFromJson(env?.FORGE_WORKFLOWS)
}
