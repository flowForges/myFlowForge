import { describe, it, expect } from 'vitest'
import {
  BROWSER_USE_MODES, DEFAULT_BROWSER_USE, browserUseLabel, isBrowserUseMode,
  browserPermissionConflict, browserToolLabel, BROWSER_TOOL_PREFIX,
  providerSupportsBrowserUse,
} from './browserUse'

describe('浏览器开关的档位', () => {
  it('默认是关的 —— 它要连用户已登录的浏览器,是明确的授权行为', () => {
    expect(DEFAULT_BROWSER_USE).toBe('off')
  })
  it('三档齐全且顺序是 关 → 每次询问 → 全部放行', () => {
    expect(BROWSER_USE_MODES.map(m => m.id)).toEqual(['off', 'ask', 'allow'])
  })
  it('标签有中文,未知值原样回显', () => {
    expect(browserUseLabel('ask')).toContain('询问')
    expect(browserUseLabel('nope' as never)).toBe('nope')
  })
  it('isBrowserUseMode 只认这三个', () => {
    expect(isBrowserUseMode('off')).toBe(true)
    expect(isBrowserUseMode('ask')).toBe(true)
    expect(isBrowserUseMode('allow')).toBe(true)
    expect(isBrowserUseMode('yes')).toBe(false)
    expect(isBrowserUseMode(undefined)).toBe(false)
  })
})

describe('browserPermissionConflict —— 挡住会让授权门失效的组合', () => {
  it('★「完全访问」+「每次询问」:实测这时 bypassPermissions 会吃掉所有门,等于静默放行', () => {
    const msg = browserPermissionConflict('ask', 'full')
    expect(msg).toBeTruthy()
    expect(msg).toContain('完全访问')
  })
  it('「完全访问」+「全部放行」:用户已经明确表示不要门,放行', () => {
    expect(browserPermissionConflict('allow', 'full')).toBeNull()
  })
  it('浏览器关着时,任何权限档都不冲突', () => {
    expect(browserPermissionConflict('off', 'full')).toBeNull()
    expect(browserPermissionConflict('off', 'auto')).toBeNull()
  })
  it('自动 / 只读档下「每次询问」正常工作 —— 实测门能拦住', () => {
    expect(browserPermissionConflict('ask', 'auto')).toBeNull()
    expect(browserPermissionConflict('ask', 'readonly')).toBeNull()
  })
})

describe('browserToolLabel —— 把 mcp__claude-in-chrome__* 翻译成人话', () => {
  it('已知工具给出中文标题', () => {
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'navigate')).toBe('浏览器 · 打开页面')
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'read_console_messages')).toBe('浏览器 · 读控制台')
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'computer')).toBe('浏览器 · 截图/点击/输入')
  })
  it('★没见过的工具也要有兜底 —— CLI 以后加新工具时不能把原始长名糊在卡片上', () => {
    expect(browserToolLabel(BROWSER_TOOL_PREFIX + 'brand_new_thing')).toBe('浏览器 · brand_new_thing')
  })
  it('不是浏览器工具就返回 null,让原有逻辑接手', () => {
    expect(browserToolLabel('Bash')).toBeNull()
    expect(browserToolLabel('mcp__forge__forge_delegate')).toBeNull()
  })
})

describe('providerSupportsBrowserUse —— 渲染进程判断要不要显示浏览器开关', () => {
  it('claude 的 CLI 自带浏览器集成', () => {
    expect(providerSupportsBrowserUse('claude')).toBe(true)
  })
  it('codex 没有浏览器集成', () => {
    expect(providerSupportsBrowserUse('codex')).toBe(false)
  })
  it('空字符串不是合法 provider id,自然不支持', () => {
    expect(providerSupportsBrowserUse('')).toBe(false)
  })
})
