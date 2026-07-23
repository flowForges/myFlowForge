// 会话输入框的斜杠命令。各 CLI 的交互式 slash 命令(/help /clear…)在我们的非交互模式(codex exec /
// claude -p)下不适用,所以这里是 Forge 自己定义的一套快捷命令:选中后把 template 填入输入框,用户补充
// 后发送。工作流命令对所有 provider 可用(template 含触发词,命中现有 workflowIntent 识别 → 走
// forge_propose_plan 硬门控),是「显式调用工作流」的入口。
export interface SlashCommand {
  cmd: string                       // '/工作流'(展示 + 匹配用,不含参数)
  title: string
  desc: string
  providers: 'all' | string[]       // 'all' 或适用的 provider id 列表
  template: string                  // 选中后替换输入框内容;末尾留好让用户续写
  // Set only on the built-in /工作流 command: picking it opens the run2 launcher (Composer.chooseSlash)
  // instead of filling `template` into the chat box. Chat is pure chat now — it never auto-triggers a
  // workflow from a seeded phrase, so seeding one here was dead (and misleading) since P4-B.
  openLauncher?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // 通用 —— 任何 provider 都可用。工作流是核心的「显式调用」入口:选中直接打开 run2 启动器,不再往
  // 聊天框塞触发短语(聊天是纯聊天,不会从文字里自动识别并启动工作流)。
  { cmd: '/开启工作流', title: '开启工作流', desc: '按多阶段工作流执行(先出方案,批准后运行)', providers: 'all',
    template: '', openLauncher: true },
  { cmd: '/架构', title: '梳理仓库架构', desc: '目录结构、核心模块、关键数据流', providers: 'all',
    template: '梳理这个仓库的架构:目录结构、核心模块职责、关键数据流。' },
  { cmd: '/概览', title: '工作区概览', desc: '梳理所有项目,生成一份概览文档落到工作区', providers: 'all',
    template: '梳理当前工作区下的所有项目:逐个说明每个仓库/项目的用途、技术栈、核心模块与目录结构,以及项目之间的关系;汇总成一份整体概览,并写入当前工作区根目录下的 `WORKSPACE_OVERVIEW.md`。' },
  { cmd: '/定位', title: '定位相关代码', desc: '按功能/关键词定位代码位置', providers: 'all',
    template: '定位与以下功能相关的代码位置(给出文件与行号):' },
  { cmd: '/解释', title: '解释代码', desc: '解释一段代码的作用与实现', providers: 'all',
    template: '解释这段代码的作用与实现思路:\n' },
  { cmd: '/修复', title: '修复问题', desc: '定位根因后再改,附验证', providers: 'all',
    template: '修复以下问题,先定位根因再改,并说明如何验证:\n' },
  // Claude 专属
  { cmd: '/深思', title: '深度思考', desc: '让 Claude 深入分析后再作答', providers: ['claude'],
    template: '请深入分析(ultrathink)后再作答:\n' },
  // Codex 专属
  { cmd: '/计划', title: '先出计划', desc: '让 Codex 先给实现计划再动手', providers: ['codex'],
    template: '先给出详细的实现计划,等我确认后再改代码:\n' },
]

// A row in the "/" menu: Forge's own commands ('forge') plus the user's real on-disk commands
// ('command') and skills ('skill') scanned from the provider's dirs (via IPC).
export interface MenuCommand {
  cmd: string
  title: string
  desc: string
  template: string
  kind: 'forge' | 'command' | 'skill'
  // Set only for a workspace-workflow entry (Task 13): picking it names this workflow instead of
  // filling `template` verbatim — Composer.chooseSlash special-cases this field.
  workflowId?: string
  // Carried from SlashCommand.openLauncher (built-in /工作流 only): picking it opens the run2 launcher
  // with no preselected workflow, instead of filling `template` — see Composer.chooseSlash.
  openLauncher?: boolean
}

// One "/" entry per workspace workflow (Task 11's WsWorkflow list), so the user can name a workflow
// explicitly instead of relying on the agent's auto-detection. `template` is intentionally empty —
// picking one doesn't fill boilerplate text, it hands the pick off to Composer's onPickWorkflow
// (which seeds a workflow-scoped trigger phrase; see Composer.chooseSlash). Pure — drives the
// Composer dropdown alongside mergeCommands.
export function workflowMenuCommands(workflows: { id: string; name: string }[]): MenuCommand[] {
  return workflows.map(wf => ({
    cmd: `/${wf.name}`, title: wf.name, desc: '按此工作流发起', template: '', kind: 'forge', workflowId: wf.id,
  }))
}

// Merge Forge's built-in commands with the provider's dynamic (on-disk) commands, filtered by query.
// Forge commands come first and win on a name clash. Pure — drives the Composer dropdown.
export function mergeCommands(providerId: string, query: string, dynamic: MenuCommand[]): MenuCommand[] {
  const q = query.replace(/^\//, '').trim().toLowerCase()
  const match = (cmd: string, title: string) => !q || cmd.slice(1).toLowerCase().includes(q) || title.toLowerCase().includes(q)
  const forge: MenuCommand[] = commandsForProvider(providerId, query)
    .map(c => ({ cmd: c.cmd, title: c.title, desc: c.desc, template: c.template, kind: 'forge' as const, openLauncher: c.openLauncher }))
  const seen = new Set(forge.map(c => c.cmd))
  // Workspace-workflow entries (identified by workflowId) are NEVER swallowed by a built-in name
  // clash — a workflow literally named e.g. "工作流" (the ensureWorkspaceWorkflows default, or a
  // user-chosen name colliding with a built-in slash cmd) would otherwise be deduped out and vanish
  // from the menu. On-disk command entries still dedupe against built-ins as before.
  const dyn = dynamic.filter(c => match(c.cmd, c.title) && (c.workflowId != null || !seen.has(c.cmd)))
  // Order: this workspace's own named workflows first (they're the most specific, user-facing choice),
  // then Forge's built-in commands, then on-disk commands/skills.
  const workflows = dyn.filter(c => c.workflowId != null)
  const rest = dyn.filter(c => c.workflowId == null)
  return [...workflows, ...forge, ...rest]
}

// Commands available for a provider, filtered by the current '/query' typed. Query matches the
// command token or its title (case-insensitive). Pure — drives the Composer dropdown.
export function commandsForProvider(providerId: string, query: string): SlashCommand[] {
  const q = query.replace(/^\//, '').trim().toLowerCase()
  return SLASH_COMMANDS
    .filter(c => c.providers === 'all' || c.providers.includes(providerId))
    .filter(c => !q || c.cmd.slice(1).toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
}

// True when the textarea content is still "typing a slash command": starts with '/' and has no
// whitespace yet (once the user types a space they're writing the argument, so the menu closes).
export function isSlashQuery(text: string): boolean {
  return text.startsWith('/') && !/\s/.test(text)
}
