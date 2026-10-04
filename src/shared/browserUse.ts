import type { PermissionMode } from './permissions'

/**
 * 会话能不能操作浏览器,以及要不要逐个动作问人。
 *
 * ★★为什么要和「权限档」分开一档:权限档管的是文件和网络,浏览器管的是**用户已经登录的那个
 *  Chrome** —— agent 在里面点一下可能是发邮件、下单、改后台配置。这是另一个量级的授权,
 *  不该被「自动(工作区)」这种听起来很温和的档位顺带包含进去。
 */
export type BrowserUseMode = 'off' | 'ask' | 'allow'

export interface BrowserUseModeSpec { id: BrowserUseMode; label: string; desc: string }

/** 顺序 = 最谨慎 → 最放任(选择器按这个顺序列)。 */
export const BROWSER_USE_MODES: BrowserUseModeSpec[] = [
  { id: 'off', label: '关闭', desc: 'agent 不能操作浏览器' },
  { id: 'ask', label: '每次询问', desc: '每个会改变页面的动作都要你批准' },
  // ★★这条文案是**刻意**绑在「完全访问」上的,别「顺手简化」回「不再逐个询问,适合长时间自动化」:
  //  'ask' 和 'allow' 拼出来的 argv 一模一样(都只是 `--chrome`),一个浏览器动作弹不弹门**完全**
  //  由会话的权限档决定(handlers.ts 的 toolConfirm 只在 full 档自动放行)。所以在「自动(工作区)」
  //  档下选这一档,每个会改变状态的动作照样会问你 —— 它此刻唯一的实效是不再报那条冲突提示。
  //  ★真正的修法:把那 22 个浏览器工具名预先塞进 `--allowedTools`(claude.ts 给 forge MCP 工具开路
  //   用的就是这个机制)。但本设计其余每条结论都是真 CLI 实测来的,这条也必须实测过才敢写,而本机
  //   Chrome 扩展尚未连接(见设计 §2.5),现在验证不了 —— 所以先把文案改成**如实**的,不动行为。
  { id: 'allow', label: '放行(需完全访问)', desc: '只有会话权限档也是「完全访问」时才真的不弹门;其它档仍逐个询问' },
]

/** ★默认关:它要连你已登录的浏览器,是明确的授权行为,不该默认打开。 */
export const DEFAULT_BROWSER_USE: BrowserUseMode = 'off'

export function browserUseLabel(mode: BrowserUseMode): string {
  return BROWSER_USE_MODES.find(m => m.id === mode)?.label ?? mode
}

export function isBrowserUseMode(v: unknown): v is BrowserUseMode {
  return v === 'off' || v === 'ask' || v === 'allow'
}

/**
 * 这个「浏览器档 + 权限档」的组合能不能用。不能用就返回给用户看的原因,能用返回 null。
 *
 * ★★2026-10-04 实测(用 Forge 同款控制协议跑真 claude):
 *  `--permission-mode acceptEdits` 下 `navigate` 会升起 can_use_tool 门,拒绝真的拦住了;
 *  `--permission-mode bypassPermissions` 下**一道门都没有**,直接连调两次。
 *  也就是说「完全访问 + 每次询问」这个组合里的「每次询问」是**假的** —— 用户以为每步都会问他,
 *  实际上 agent 在他登录着的浏览器里点什么都不会出声。
 * ★这里**只报冲突,不自动降级**:悄悄改用户的权限档比让他自己选更危险。调用方(Composer)拿到
 *  非 null 就**挡住发送**并把这句话显示出来 —— 设计 §4.3 的原话是「Forge 拒绝这个组合」,只提示
 *  不拦住的话,用户以为每步都会问他,实际这一轮已经带着零道门的浏览器工具跑出去了。
 */
export function browserPermissionConflict(browser: BrowserUseMode, perm: PermissionMode): string | null {
  if (browser !== 'ask') return null
  if (perm !== 'full') return null
  // 出路的那两个档名从档表里取,避免改了标签这句话还指着一个界面上已经不存在的选项。
  return `「完全访问」档下 CLI 不会升起任何授权门，「每次询问」形同虚设。请把会话改成「自动(工作区)」，或把浏览器改成「${browserUseLabel('allow')}」。`
}

/** claude 的 Chrome 集成挂在这个 MCP 服务下(`claude -p --chrome` 实测)。 */
export const BROWSER_TOOL_PREFIX = 'mcp__claude-in-chrome__'

// 2026-10-04 实测 claude 2.1.285 `--chrome` 暴露的 22 个工具。
const BROWSER_TOOL_LABELS: Record<string, string> = {
  navigate: '打开页面', read_page: '读页面', get_page_text: '取页面文字', find: '查找元素',
  computer: '截图/点击/输入', form_input: '填表单', file_upload: '上传文件', upload_image: '上传图片',
  tabs_create_mcp: '新建标签页', tabs_close_mcp: '关闭标签页', tabs_context_mcp: '标签页信息',
  resize_window: '调整窗口', read_console_messages: '读控制台', read_network_requests: '读网络请求',
  javascript_tool: '执行 JS', list_connected_browsers: '列出浏览器', select_browser: '选择浏览器',
  switch_browser: '切换浏览器', browser_batch: '批量动作', gif_creator: '录制动图',
  shortcuts_list: '列出快捷操作', shortcuts_execute: '执行快捷操作',
}

/** 目标超过这个长度就只留 host —— 卡片和授权门都是一行,带 query 的长 URL 会把它撑爆。 */
const BROWSER_TARGET_MAX = 48

/**
 * 浏览器工具的「动在哪」。只认 `url`:22 个工具的输入里只有它回答得了「哪个页面」这个问题,
 * selector / 坐标对人没有信息量。
 *
 * ★★为什么非要有它:`toolTarget()` 原来只读 file_path/path/command,于是 `navigate` 的授权门
 *  长成「mcp__claude-in-chrome__navigate 请求执行」+ 一个空的 where —— 用户正要授权 agent 在他
 *  **已登录**的浏览器里动手,却看不到动的是哪个站点。这是本设计里最不能含糊的一处。
 * ★长了就退回 host:「在哪个站点上动手」才是用户要判断的事,完整 query 对这个判断没有帮助,
 *  而一行塞不下的标题会把真正重要的那半截挤掉。
 */
export function browserToolTarget(input: unknown): string | undefined {
  const raw = typeof (input as any)?.url === 'string' ? ((input as any).url as string).trim() : ''
  if (!raw) return undefined
  // 协议和结尾的斜杠对人是噪音:https://example.com/ → example.com。
  const short = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!short) return raw
  if (short.length <= BROWSER_TARGET_MAX) return short
  try { const h = new URL(raw).host; if (h) return h } catch { /* 不是合法 URL(相对路径等),下面按长度截 */ }
  return short.slice(0, BROWSER_TARGET_MAX) + '…'
}

/**
 * 工具卡上显示的标题。不是浏览器工具返回 null,交回原有逻辑。
 *
 * ★兜底用工具名本身而不是整个 `mcp__claude-in-chrome__xxx`:CLI 以后加新工具时,卡片上至少
 *  还是「浏览器 · xxx」,不会变成一行看不懂的长名字。
 * ★★带上目标(`浏览器 · 打开页面 example.com`):原来这里先 return 人话标题,直接跨过了
 *  `toolStep()` 后面那条 `input.url` 分支 —— 翻译完标题反而把**唯一有信息量的那半截**丢了,
 *  URL 在界面上哪儿都看不见。`input` 不给 / 没有 url 时(授权门标题那条路)就只出标题。
 */
export function browserToolLabel(toolName: string, input?: unknown): string | null {
  if (!toolName.startsWith(BROWSER_TOOL_PREFIX)) return null
  const bare = toolName.slice(BROWSER_TOOL_PREFIX.length)
  const head = `浏览器 · ${BROWSER_TOOL_LABELS[bare] ?? bare}`
  const target = input === undefined ? undefined : browserToolTarget(input)
  return target ? `${head} ${target}` : head
}

// 哪些 provider 的 CLI 自己就能操作浏览器。★这是单一真相:主进程那边 claude.ts 的
// `capabilities.browserUse` 也从这里推导,避免两处各写一份后悄悄漂移。
export const BROWSER_USE_PROVIDERS = ['claude'] as const
export function providerSupportsBrowserUse(providerId: string): boolean {
  return (BROWSER_USE_PROVIDERS as readonly string[]).includes(providerId)
}
