import { describe, it, expect } from 'vitest'
import { summarizeRequirement, buildTranscript, TRANSCRIPT_CHAR_CAP } from './requirementSummary'

// 用户实测(2026-08-12):聊了很多轮后点开启工作流,门里那段 AI 需求总结是**截断的**(断在半句)。
// 根因有两条,这个文件盯死它们:
//  1. 超时/出错时把已经流出来的半截当成果返回。调用方判的是「非空即成功」,于是半句需求被当成
//     「需求原文(以此为准)」发给每个阶段的 agent。
//  2. 整个会话原封不动塞进 prompt(实测单个会话文件到过 1.2 MB)——越是聊得多越慢、越容易撞超时,
//     而聊得多恰恰是最需要总结的场景。
const msgs = [{ who: '用户', text: '把 token 迁到 OKLCH' }, { who: '助手', text: '好的,分三步' }]

describe('summarizeRequirement', () => {
  it('正常跑完就返回总结', async () => {
    const out = await summarizeRequirement(msgs, { summarize: async () => '  把设计 token 迁移到 OKLCH  ' })
    expect(out).toBe('把设计 token 迁移到 OKLCH')
  })

  it('超时(拿不到完整结果)返回空,让调用方回退到原始对话,而不是交出半句', async () => {
    const out = await summarizeRequirement(msgs, { summarize: async () => null })
    expect(out).toBe('')
  })

  it('空对话直接返回空,不去打搅模型', async () => {
    let called = false
    const out = await summarizeRequirement([{ who: '用户', text: '   ' }], {
      summarize: async () => { called = true; return 'x' },
    })
    expect(out).toBe('')
    expect(called).toBe(false)
  })

  it('喂给模型的对话有上限,不把整个会话原样塞进去', async () => {
    let seen = ''
    const huge = [{ who: '用户', text: 'x'.repeat(500_000) }]
    await summarizeRequirement(huge, { summarize: async (p) => { seen = p; return 'ok' } })
    expect(seen.length).toBeLessThan(TRANSCRIPT_CHAR_CAP + 2_000)   // prompt 模板本身几百字
  })
})

describe('buildTranscript', () => {
  it('没超上限就原样拼接', () => {
    expect(buildTranscript(msgs, 1000)).toBe('用户: 把 token 迁到 OKLCH\n助手: 好的,分三步')
  })

  it('超了从尾部截断——保留最近的讨论(最新结论优先),不是保留开头那些已被推翻的想法', () => {
    const out = buildTranscript([{ who: '用户', text: '早期想法AAAA' }, { who: '用户', text: '最终结论BBBB' }], 20)
    expect(out).toContain('最终结论BBBB')
    expect(out).not.toContain('早期想法AAAA')
  })

  it('真截断时显式标注,免得模型把半截当全貌', () => {
    expect(buildTranscript([{ who: '用户', text: 'y'.repeat(100) }], 20)).toContain('省略')
  })
})
