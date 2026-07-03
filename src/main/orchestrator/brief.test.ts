import { describe, it, expect, vi } from 'vitest'
import { buildStagePrompt, INTERACTION_DIRECTIVE } from './brief'
import type { HandoffBrief } from './brief'
import { createFenceScanner } from '../agents/handoffFence'
import { STAGE_PROMPTS } from '../config/schema'

describe('buildStagePrompt', () => {
  it('includes the stageName and the execute-now directive when no briefs and no textFallback', () => {
    const result = buildStagePrompt('代码开发', [], { textFallback: false })
    expect(result).toContain('代码开发')
    expect(result).toContain('【执行指令】')
  })

  it('includes the stageName when briefs empty and textFallback false', () => {
    const result = buildStagePrompt('设计', [], { textFallback: false })
    expect(result).toContain('设计')
    expect(result).toContain('【执行指令】')
  })

  it('renders briefs section with upstream summaries', () => {
    const briefs: HandoffBrief[] = [
      { agentName: 'Alice', summary: '设计完成', artifacts: [] }
    ]
    const result = buildStagePrompt('代码开发', briefs, { textFallback: false })
    expect(result).toContain('代码开发')
    expect(result).toContain('上游交接:')
    expect(result).toContain('- [Alice] 设计完成')
  })

  it('appends artifacts parenthetical when agent has artifacts', () => {
    const briefs: HandoffBrief[] = [
      { agentName: 'Bob', summary: '方案就绪', artifacts: [{ path: 'a.md', kind: 'md' }, { path: 'b.ts', kind: 'ts' }] }
    ]
    const result = buildStagePrompt('开发', briefs, { textFallback: false })
    expect(result).toContain('（产物: a.md, b.ts）')
  })

  it('multiple briefs all appear in order', () => {
    const briefs: HandoffBrief[] = [
      { agentName: 'Stage1', summary: '第一阶段完成', artifacts: [] },
      { agentName: 'Stage2', summary: '第二阶段完成', artifacts: [{ path: 'out.md', kind: 'md' }] },
    ]
    const result = buildStagePrompt('最终交付', briefs, { textFallback: false })
    expect(result).toContain('- [Stage1] 第一阶段完成')
    expect(result).toContain('- [Stage2] 第二阶段完成')
    expect(result).toContain('（产物: out.md）')
    // Stage1 has no artifacts — no parenthetical for it
    const stage1Line = result.split('\n').find(l => l.includes('[Stage1]'))!
    expect(stage1Line).not.toContain('产物')
  })

  it('appends textFallback instruction containing forge:handoff example when textFallback true and no briefs', () => {
    const result = buildStagePrompt('分析阶段', [], { textFallback: true })
    expect(result).toContain('forge:handoff')
    expect(result).toContain('summary')
    expect(result).toContain('artifacts')
  })

  it('textFallback section is appended even when briefs are present', () => {
    const briefs: HandoffBrief[] = [
      { agentName: 'Agent1', summary: '已完成', artifacts: [] }
    ]
    const result = buildStagePrompt('部署阶段', briefs, { textFallback: true })
    expect(result).toContain('上游交接:')
    expect(result).toContain('forge:handoff')
  })

  it('textFallback example is NOT a valid handoff, so an agent echoing it verbatim triggers no false handoff', () => {
    const result = buildStagePrompt('开发', [], { textFallback: true })
    const onHandoff = vi.fn()
    const scanner = createFenceScanner(onHandoff)
    for (const line of result.split('\n')) scanner.feedLine(line)
    scanner.flush()
    expect(onHandoff).not.toHaveBeenCalled()
  })

  it('no textFallback section when textFallback false even with briefs', () => {
    const briefs: HandoffBrief[] = [
      { agentName: 'Agent1', summary: '已完成', artifacts: [] }
    ]
    const result = buildStagePrompt('部署阶段', briefs, { textFallback: false })
    expect(result).not.toContain('forge:handoff')
  })

  it('includes the task as a goal header when opts.task is provided', () => {
    const result = buildStagePrompt('需求评估', [], { textFallback: false, task: '给blog加评论系统' })
    expect(result).toContain('任务: 给blog加评论系统\n\n当前阶段: 需求评估')
    expect(result).toContain('【执行指令】')
  })

  it('task header coexists with briefs and textFallback', () => {
    const briefs: HandoffBrief[] = [{ agentName: 'A', summary: '已完成', artifacts: [] }]
    const result = buildStagePrompt('代码开发', briefs, { textFallback: true, task: '加搜索' })
    expect(result).toContain('任务: 加搜索\n\n当前阶段: 代码开发')
    expect(result).toContain('上游交接:')
    expect(result).toContain('forge:handoff')
  })

  it('contains the task/stage body unchanged after the directive when task is undefined (regression)', () => {
    const result = buildStagePrompt('需求评估', [], { textFallback: false })
    expect(result).toContain('需求评估')
    expect(buildStagePrompt('需求评估', [], { textFallback: false, task: undefined }))
      .toBe(result)
  })

describe('buildStagePrompt 追加语义', () => {
  it('给了 stageKey 时内置默认正文恒在', () => {
    const p = buildStagePrompt('技术方案设计', [], { textFallback: false, stageKey: 'design' })
    expect(p).toContain(STAGE_PROMPTS.design)
  })
  it('有追加段时拼在默认之后并带【附加要求】框定头', () => {
    const p = buildStagePrompt('技术方案设计', [], { textFallback: false, stageKey: 'design', stageAppend: '必须画时序图' })
    expect(p).toContain(STAGE_PROMPTS.design)
    expect(p).toContain('【附加要求】')
    expect(p).toContain('必须画时序图')
    expect(p.indexOf(STAGE_PROMPTS.design)).toBeLessThan(p.indexOf('必须画时序图'))
  })
  it('追加段为空白时不出现【附加要求】块', () => {
    const p = buildStagePrompt('技术方案设计', [], { textFallback: false, stageKey: 'design', stageAppend: '   ' })
    expect(p).not.toContain('【附加要求】')
  })
  it('执行纪律外壳仍最前置', () => {
    const p = buildStagePrompt('代码开发', [], { textFallback: false, stageKey: 'develop', stageAppend: 'x' })
    expect(p.indexOf('【执行指令】')).toBe(0)
  })
})

describe('interaction directive', () => {
  it('buildStagePrompt 注入 forge_ask 交互铁律', () => {
    const out = buildStagePrompt('代码开发', [], { textFallback: false })
    expect(out).toContain('【交互指令】')
    expect(out).toContain('forge_ask')
    expect(INTERACTION_DIRECTIVE).toContain('forge_ask')
  })
})

  // ── Layer A: authoritative execute-now directive (anti skill-hijack) ──────────
  describe('execute-now directive', () => {
    it('prepends the directive (appears before the task body) — with task', () => {
      const result = buildStagePrompt('代码开发', [], { textFallback: false, task: '加搜索' })
      expect(result.indexOf('【执行指令】')).toBe(0)
      expect(result.indexOf('【执行指令】')).toBeLessThan(result.indexOf('任务: 加搜索'))
    })

    it('prepends the directive (appears before the stage body) — without task', () => {
      const result = buildStagePrompt('代码开发', [], { textFallback: false })
      expect(result.indexOf('【执行指令】')).toBe(0)
    })

    it('directive interpolates the stage name', () => {
      const result = buildStagePrompt('代码开发', [], { textFallback: false })
      // The directive references which stage this sub-agent is assigned to.
      const head = result.slice(0, result.indexOf('\n\n当前阶段') === -1 ? result.length : 200)
      expect(head).toContain('代码开发')
    })

    it.each([
      ['execute-now phrasing', '现在就'],
      ['prohibit waiting for approval', '不要提出方案'],
      ['prohibit forge_propose_plan', 'forge_propose_plan'],
      ['prohibit forge:run fence', 'forge:run'],
    ])('directive %s', (_label, snippet) => {
      const withTask = buildStagePrompt('代码开发', [], { textFallback: false, task: 'x' })
      const noTask = buildStagePrompt('代码开发', [], { textFallback: false })
      expect(withTask).toContain(snippet)
      expect(noTask).toContain(snippet)
    })
  })
})
