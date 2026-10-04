import { describe, it, expect } from 'vitest'
import { parseChatStreamActions } from './chatStream'
import { BROWSER_TOOL_PREFIX } from '@shared/browserUse'

const assistantToolUse = (name: string, input: unknown) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] },
})

describe('浏览器工具在工具卡上的标题', () => {
  it('★不再显示成 mcp__claude-in-chrome__navigate 这种原始长名', () => {
    const actions = parseChatStreamActions(assistantToolUse(BROWSER_TOOL_PREFIX + 'navigate', { url: 'https://example.com' }))
    const a = actions.find(x => x.kind === 'tool') as Extract<typeof actions[number], { kind: 'tool' }>
    expect(a.text).toContain('浏览器 · 打开页面')
    expect(a.text).not.toContain('mcp__claude-in-chrome__')
  })

  it('★URL 必须留在卡片上:翻完标题就 return 的话,打开的是哪个页面在界面上哪儿都看不到了', () => {
    const actions = parseChatStreamActions(assistantToolUse(BROWSER_TOOL_PREFIX + 'navigate', { url: 'https://example.com/login' }))
    const a = actions.find(x => x.kind === 'tool') as Extract<typeof actions[number], { kind: 'tool' }>
    expect(a.text).toBe('浏览器 · 打开页面 example.com/login')
  })

  it('★长 URL 只留站点名 —— 一行工具卡塞不下整串 query', () => {
    const url = 'https://mail.example.com/u/0/#inbox?compose=new&to=someone@example.com&su=hello&body=xxxxxxxxxx'
    const actions = parseChatStreamActions(assistantToolUse(BROWSER_TOOL_PREFIX + 'navigate', { url }))
    const a = actions.find(x => x.kind === 'tool') as Extract<typeof actions[number], { kind: 'tool' }>
    expect(a.text).toBe('浏览器 · 打开页面 mail.example.com')
  })

  it('读控制台这类调试工具也翻译(它是做前端时最常用的)', () => {
    const actions = parseChatStreamActions(assistantToolUse(BROWSER_TOOL_PREFIX + 'read_console_messages', {}))
    const a = actions.find(x => x.kind === 'tool') as Extract<typeof actions[number], { kind: 'tool' }>
    expect(a.text).toContain('读控制台')
  })

  it('★没见过的浏览器工具有兜底,不会糊一行长名字', () => {
    const actions = parseChatStreamActions(assistantToolUse(BROWSER_TOOL_PREFIX + 'future_tool', {}))
    const a = actions.find(x => x.kind === 'tool') as Extract<typeof actions[number], { kind: 'tool' }>
    expect(a.text).toBe('浏览器 · future_tool')
  })

  it('普通工具的标题一个字都不变(回归保护)', () => {
    const actions = parseChatStreamActions(assistantToolUse('Bash', { command: 'npm test' }))
    const a = actions.find(x => x.kind === 'tool') as Extract<typeof actions[number], { kind: 'tool' }>
    expect(a.text).toBe('调用 Bash: npm test')
  })
})
