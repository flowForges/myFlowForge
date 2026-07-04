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
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // 通用 —— 任何 provider 都可用。工作流是核心的「显式调用」入口。
  { cmd: '/工作流', title: '发起工作流', desc: '按多阶段工作流执行(先出方案,批准后运行)', providers: 'all',
    template: '开启工作流,按以下需求分阶段执行,先给出技术方案等我批准:\n' },
  { cmd: '/架构', title: '梳理仓库架构', desc: '目录结构、核心模块、关键数据流', providers: 'all',
    template: '梳理这个仓库的架构:目录结构、核心模块职责、关键数据流。' },
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
}

// Merge Forge's built-in commands with the provider's dynamic (on-disk) commands, filtered by query.
// Forge commands come first and win on a name clash. Pure — drives the Composer dropdown.
export function mergeCommands(providerId: string, query: string, dynamic: MenuCommand[]): MenuCommand[] {
  const q = query.replace(/^\//, '').trim().toLowerCase()
  const match = (cmd: string, title: string) => !q || cmd.slice(1).toLowerCase().includes(q) || title.toLowerCase().includes(q)
  const forge: MenuCommand[] = commandsForProvider(providerId, query)
    .map(c => ({ cmd: c.cmd, title: c.title, desc: c.desc, template: c.template, kind: 'forge' as const }))
  const seen = new Set(forge.map(c => c.cmd))
  const dyn = dynamic.filter(c => match(c.cmd, c.title) && !seen.has(c.cmd))
  return [...forge, ...dyn]
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
