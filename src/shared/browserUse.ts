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
  { id: 'allow', label: '全部放行', desc: '不再逐个询问,适合长时间自动化' },
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
 * ★这里**只报冲突,不自动降级**:悄悄改用户的权限档比让他自己选更危险。
 */
export function browserPermissionConflict(browser: BrowserUseMode, perm: PermissionMode): string | null {
  if (browser !== 'ask') return null
  if (perm !== 'full') return null
  return '「完全访问」档下 CLI 不会升起任何授权门，「每次询问」形同虚设。请把会话改成「自动(工作区)」，或把浏览器改成「全部放行」。'
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

/**
 * 工具卡上显示的标题。不是浏览器工具返回 null,交回原有逻辑。
 *
 * ★兜底用工具名本身而不是整个 `mcp__claude-in-chrome__xxx`:CLI 以后加新工具时,卡片上至少
 *  还是「浏览器 · xxx」,不会变成一行看不懂的长名字。
 */
export function browserToolLabel(toolName: string): string | null {
  if (!toolName.startsWith(BROWSER_TOOL_PREFIX)) return null
  const bare = toolName.slice(BROWSER_TOOL_PREFIX.length)
  return `浏览器 · ${BROWSER_TOOL_LABELS[bare] ?? bare}`
}

// 哪些 provider 的 CLI 自己就能操作浏览器。★这是单一真相:主进程那边 claude.ts 的
// `capabilities.browserUse` 也从这里推导,避免两处各写一份后悄悄漂移。
export const BROWSER_USE_PROVIDERS = ['claude'] as const
export function providerSupportsBrowserUse(providerId: string): boolean {
  return (BROWSER_USE_PROVIDERS as readonly string[]).includes(providerId)
}
