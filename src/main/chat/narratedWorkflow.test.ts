import { describe, it, expect } from 'vitest'
import { looksLikeNarratedWorkflow } from './narratedWorkflow'

describe('looksLikeNarratedWorkflow', () => {
  // 正样本:主代理「叙述式假执行」的真实话术(取自用户截图) —— 假称已提交方案 / 正在按工作流执行,
  // 但并没有真的调用 forge_propose_plan 工具。这些必须被识别。
  it.each([
    '已收到并会按这套 Forge 工作流规则执行。当前这条消息只是规则说明。',
    'Forge 方案已提交，但工具返回：user cancelled MCP tool call。需要你在 Forge UI 里批准方案后，工作流才能启动。',
    '按 Forge 规则切换：我会停止本地直接执行，把评论系统实施方案提交给 Forge，等待你在 UI 批准。',
    '我会调用 forge_propose_plan 提交方案，等待你确认。',
    '当前不会继续读写代码或执行阶段。需要你在 Forge UI 里批准方案后，工作流才能启动。',
  ])('识别叙述式假执行: %s', (text) => {
    expect(looksLikeNarratedWorkflow(text)).toBe(true)
  })

  // 负样本:正常的对话回答 / 对工作流概念的解释 —— 绝不能误伤(误伤会凭空弹出确认门)。
  it.each([
    '我直接去查这次 run 的真实状态和产出——不猜。',
    '需求评估阶段会分析你的需求，技术方案设计阶段产出设计文档，这是工作流的前两步。',
    '我来帮你读一下当前文件夹下的代码，然后回答你的问题。',
    '好的，这个 bug 我先看一下根因，稍等。',
    '这份概览我已经写好了，放在 README 里，你看下。',
    '',
  ])('不误伤正常回答: %s', (text) => {
    expect(looksLikeNarratedWorkflow(text)).toBe(false)
  })

  it('null / undefined 安全', () => {
    expect(looksLikeNarratedWorkflow(undefined)).toBe(false)
    expect(looksLikeNarratedWorkflow(null)).toBe(false)
  })
})
