import { describe, it, expect } from 'vitest'
import { buildClaudeChatArgs, makeClaudeProvider } from './claude'
import type { ChatTask } from '../types'

// 2026-10-04 实测:claude 2.1.285 的 `--chrome` 在无头模式下会把 22 个浏览器工具挂进来
// (工具数 26 → 48)。Forge 这边只负责「传不传这个开关」。
const task = (browserUse?: ChatTask['browserUse']): ChatTask =>
  ({ id: 'c1', prompt: 'x', model: 'opus-4.8', cwd: '/tmp', ...(browserUse ? { browserUse } : {}) }) as ChatTask

const argsOf = (browserUse?: ChatTask['browserUse']) =>
  buildClaudeChatArgs(task(browserUse), process.env, 'x')

describe('claude chat() 的浏览器开关', () => {
  it('开关是 ask:传 --chrome', () => {
    expect(argsOf('ask')).toContain('--chrome')
    expect(argsOf('ask')).not.toContain('--no-chrome')
  })

  it('开关是 allow:同样传 --chrome(要不要弹门是权限档的事,不是这里)', () => {
    expect(argsOf('allow')).toContain('--chrome')
  })

  it('★开关是 off:必须【显式】传 --no-chrome', () => {
    expect(argsOf('off')).toContain('--no-chrome')
    expect(argsOf('off')).not.toContain('--chrome')
  })

  it('★没设置过(老会话):也要显式关 —— 用户可能在 ~/.claude/settings.json 里全局开了 chrome,' +
     '靠「不传」等于让那份全局配置说了算,而界面上明明显示是关的', () => {
    expect(argsOf(undefined)).toContain('--no-chrome')
    expect(argsOf(undefined)).not.toContain('--chrome')
  })

  it('开关不影响其它参数(回归保护:--chrome 只是多出来的一个,不许挤掉别的)', () => {
    const off = argsOf('off').filter(a => a !== '--no-chrome')
    const on = argsOf('ask').filter(a => a !== '--chrome')
    expect(on).toEqual(off)
  })
})

describe('能力声明', () => {
  it('claude 声明支持浏览器操作', () => {
    expect(makeClaudeProvider({ bin: 'claude', defaultModels: [] }).capabilities.browserUse).toBe(true)
  })
})
