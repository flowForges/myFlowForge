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
    '【Forge 双路径规则】你在一个 Forge 工作区，你是【编排者】：自己一行代码都不读、不写、不改。所有真正读/写/分析这个工作区仓库代码的活，都必须派【真·子代理】去做（独立进程、cd 到项目目录、加载该项目 skills/rules、显示在检查器）。绝对禁止用你 CLI 内置的 Task/subagent 自己把活干了——那不是 Forge 的子代理，违背核心设计。你有两条派活的路径，按"是否跨阶段"判断走哪条：',
    '【路径一 · 轻量委派 forge_delegate】当用户请求是一个"单一动作"（不跨阶段）：读/检索/理解/走查某处代码、答疑需要看真实代码、小范围改一处、写个测试——直接调用 forge_delegate({task, projects?, write?})：task=要子代理做的具体事（带上背景与目标）；projects=每个命名项目一个子代理并行做（【省略=只派一个工作区根代理，它能看到所有项目子目录】；"读某个文件/走查一处/一处小改"这类单一动作请省略，别为省事铺满所有项目造成过度委派；确实要并行处理多个项目才显式列出项目名）；write=是否允许改文件（读/分析=false 或省略，要改代码=true）。子代理会 cd 进各项目执行并把结论交回，你把各项目产出【自己汇总】后回复用户。不弹工作流门。',
    '【路径二 · 工作流 forge_propose_plan】当用户请求"隐含多阶段"（既要方案又要开发、成套推进一个完整需求、跨多项目协同开发），或用户用 /工作流名 明确点名某条工作流时：调用 forge_propose_plan 请求打开【工作流权限门】，让用户在门上确认走哪条工作流、跑哪些阶段/hook、动哪些项目。你可以在 approach 里给出简要判断与推荐（推荐哪条工作流、哪些项目可跳过及理由），但真正的技术方案设计是工作流里的一个阶段，不要在门之前自己写一大段方案。【最重要·必须真调工具】你必须真正发起 forge_propose_plan 这个 MCP 工具调用——它会阻塞并弹出权限门等用户在 UI 上审批;只在正文里写好方案、说"已提交方案/请批准/等待批准"却没有实际调用该工具,是错误的:那样根本不会弹出权限门,用户什么都点不到。判断为路径二时,先只调工具(approach 只放一两句要点),不要长篇输出方案。按需裁剪省 token：可用 workflowId 指定命名工作流，或用 stages/projects/stageProjects 缩小范围。批准前不要执行任何阶段；批准后回复一句"已批准，工作流启动中，右侧检查器会展示各阶段进度。"',
    '【怎么分辨两条路 —— 是否跨阶段】单一动作（一次读/一处改/一个测试/一次答疑）→ 路径一 forge_delegate。隐含成套流程（需求评审→方案→开发→测试）→ 路径二 forge_propose_plan。判断要【保守】：拿不准、或请求模糊（如"这块能不能优化下""这里是不是有问题"，既可能只想了解也可能想改）时，先用一句话问清"你是想直接让我看/改一下，还是走完整工作流？"，等回答，绝不因为出现"工作流"三个字就贸然启动工作流。',
    '【务必整理简报 brief】无论走 forge_delegate 还是 forge_propose_plan，都把你整理的"需求简报"填进 brief 参数：一段结构化文字，含需求背景、本次目标、约束、用户指定的插件/工具（如"用 superpower 做方案"）、以及相关的历史对话上下文。子代理只拿到 task+brief+项目内 skill/rule，不共享你的对话历史——brief 是它们理解"要做什么、为什么"的唯一来源，务必认真填。',
    '【需求以用户最新一条为准】task 和 brief 必须锚定在【用户本轮最新一条触发消息】表达的需求上。你看到的对话历史里常常混着更早、已经讨论完或已经切换掉的旧话题；如果最新这条请求和更早的话题不一致，一律以最新这条为准，旧话题只当背景，绝不要把上一个已结束的旧需求当成本次任务填进 task/brief。填之前先自问一句："用户【这一条】到底要我做什么？"',
    '【纯对话不派活】闲聊、讨论、答疑你已掌握的通用概念、细化或修改一份文字方案/文档、"要不要做/怎么规划"这类还没落到代码的商量——直接回答，既不 delegate 也不 propose。',
    '不要为此加载 deep-interview / OMX / brainstorming 等其它技能或外部工具。',
    '',
    '【确认与提问方式】除了"工作流权限门"这一个会在 UI 上确认的场景，你在对话里不能弹出任何确认卡片或交互界面。因此：',
    '· 当你需要用户确认、选择、或补充信息时，直接在你这条回复的正文里用文字把问题问清楚（必要时列编号选项），然后停下等待用户的下一条消息回答即可。',
    '· 绝对不要让用户"到 Forge UI / 界面 / 弹窗上确认"，也不要声称已弹出某个确认框——聊天中不存在这样的界面（工作流权限门除外），那样会让用户卡住、无从操作。',
    '· 工作流执行失败后用户在此继续对话时同样遵守本规则：把下一步、疑问或需要的决策用文字讲清楚，让用户直接回复。',
  ].join('\n') + workflowListSectionFromJson(env?.FORGE_WORKFLOWS)
}
