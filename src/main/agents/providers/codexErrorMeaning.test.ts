import { describe, it, expect } from 'vitest'
import { explainCodexError, isCodexWarning } from './codexErrorMeaning'

describe('codex 报上来的「错误」是什么意思', () => {
  it('★★警告不是失败 —— 这两条在一次**完全成功**的调用里就会出现(2026-09-17 实测)', () => {
    expect(isCodexWarning('`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.')).toBe(true)
    expect(isCodexWarning('Skill descriptions were shortened to fit the skills context budget.')).toBe(true)
  })

  it('★真失败不许被当成警告', () => {
    expect(isCodexWarning('Reconnecting... 2/5')).toBe(false)
    expect(isCodexWarning('stream error: connection reset')).toBe(false)
    expect(isCodexWarning("The 'gpt-5.6-sol' model requires a newer version of Codex.")).toBe(false)
  })

  it('★★重试计数器翻成能照着做的话 —— 「Reconnecting... 2/5」对人什么也没说', () => {
    const s = explainCodexError('Reconnecting... 2/5')!
    expect(s).toContain('连不上模型接口')
    expect(s).toContain('代理')
    // ★原话要留着:翻译是给人看的,原话是排查用的,少了哪个都不行。
    expect(s).toContain('Reconnecting... 2/5')
  })

  it('CLI 太旧那条也翻,并给出具体命令', () => {
    const s = explainCodexError("The 'gpt-5.6-sol' model requires a newer version of Codex.")!
    expect(s).toContain('npm i -g @openai/codex@latest')
  })

  it('★★翻不了就返回 null,由调用方原样显示 —— 一句猜错的「原因」比原文更糟', () => {
    expect(explainCodexError('some brand new failure nobody has seen')).toBeNull()
    expect(explainCodexError('')).toBeNull()
  })

  it('各种写法的重试计数器都认得', () => {
    for (const s of ['Reconnecting 1/5', 'Reconnecting... 5/5', 'reconnecting…  3 / 5'.replace('…', '...')]) {
      expect(explainCodexError(s), s).not.toBeNull()
    }
  })
})
