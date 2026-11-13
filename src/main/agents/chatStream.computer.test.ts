import { describe, it, expect } from 'vitest'
import { parseChatStreamActions } from './chatStream'

const toolUse = (name: string, input: unknown) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] },
})
const title = (name: string, input: unknown) => {
  const a = parseChatStreamActions(toolUse(name, input)).find((x) => x.kind === 'tool' || x.kind === 'file') as { text: string }
  return a.text
}

describe('computer tool card titles (V11)', () => {
  it('computer_type shows only the length, never the text: titles land in sessions.json and go to remote clients', () => {
    const t = title('mcp__forge__computer_type', { text: 'hunter2-SECRET-MARKER', path: 'SECRET-PATH', command: 'SECRET-CMD' })
    expect(t).toBe('电脑 · 输入 21 字')
    expect(t).not.toContain('SECRET')
  })

  it('other computer tools get their 电脑 · label instead of the raw mcp name', () => {
    expect(title('mcp__forge__computer_click', { x: 10.4, y: 20 })).toBe('电脑 · 点击 (10, 20)')
    expect(title('mcp__forge__computer_screenshot', {})).toBe('电脑 · 截图')
    expect(title('mcp__forge__computer_key', { combo: 'cmd+s', path: '/x' })).not.toContain('/x')
  })

  it('a non-computer forge tool keeps the generic title', () => {
    expect(title('Read', { file_path: 'a.ts' })).toBe('调用 Read a.ts')
  })
})
