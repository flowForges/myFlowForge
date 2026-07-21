import { describe, it, expect } from 'vitest'
import { composeRunDigest, buildSummaryPrompt, runRunSummary } from './runSummary'
import type { AgentProvider } from '../agents/types'
import type { StagePlan } from './machine'
import type { WorkOrderOutcome } from './workOrder'

function stage(key: string, name: string): StagePlan {
  return { key, name, provider: 'claude', model: 'm', scope: 'per-project', gate: false }
}
function okLane(stageKey: string, project: string | undefined, over: Partial<WorkOrderOutcome['result']> = {}): WorkOrderOutcome {
  return {
    order: { id: `${stageKey}:${project ?? 'root'}`, stageKey, name: 'a', project, provider: 'claude', model: 'm', cwd: '/w', prompt: '' },
    status: 'ok', attempts: 1,
    result: { summary: 'did X', filesChanged: [], blockers: [], doubts: [], artifacts: [], ...over },
  }
}
function failLane(stageKey: string, project: string | undefined, error: string): WorkOrderOutcome {
  return {
    order: { id: `${stageKey}:${project ?? 'root'}`, stageKey, name: 'a', project, provider: 'claude', model: 'm', cwd: '/w', prompt: '' },
    status: 'failed', attempts: 3, error,
  }
}

function chatProvider(text: string): AgentProvider {
  return {
    id: 'cp', displayName: 'CP',
    capabilities: { structuredOutput: false, permissionHook: false, pty: false, mcpTools: false } as any,
    async detect() { return true },
    async listModels() { return [] },
    run(task) { return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true, summary: '' }) } },
    chat(task, cb) {
      const done = (async () => { cb.onAssistantDelta(text); cb.onDone({ elapsed: 0 }); return { ok: true, summary: '' } })()
      return { id: task.id, cancel() {}, done }
    },
  }
}

describe('composeRunDigest', () => {
  it('按阶段顺序分组，列出每个泳道的 summary/改动文件/测试', () => {
    const stages = [stage('design', '技术方案'), stage('develop', '编码开发')]
    const outcomes: Record<string, WorkOrderOutcome[]> = {
      design: [okLane('design', 'A', { summary: '设计 A' }), okLane('design', 'B', { summary: '设计 B' })],
      develop: [okLane('develop', 'A', { summary: '写了 A', filesChanged: ['a.ts', 'b.ts'], testsRun: { passed: true } })],
    }
    const d = composeRunDigest(stages, outcomes, [])
    // stage headings present, in plan order
    expect(d.indexOf('技术方案')).toBeLessThan(d.indexOf('编码开发'))
    expect(d).toContain('**A** ✅ 设计 A')
    expect(d).toContain('**B** ✅ 设计 B')
    expect(d).toContain('改动文件：a.ts、b.ts')
    expect(d).toContain('测试：通过')
  })

  it('失败泳道显示错误与尝试次数；根阶段无 project 用（根阶段）', () => {
    const stages = [stage('root', '需求分析')]
    const outcomes = { root: [failLane('root', undefined, '连不上')] }
    const d = composeRunDigest(stages, outcomes, [])
    expect(d).toContain('**（根阶段）** ❌ 失败：连不上（尝试 3 次）')
  })

  it('测试未通过带 detail；有 blockers 时列出', () => {
    const stages = [stage('dev', '开发')]
    const outcomes = { dev: [okLane('dev', 'A', { testsRun: { passed: false, detail: '2 failing' }, blockers: ['缺 key'] })] }
    const d = composeRunDigest(stages, outcomes, [])
    expect(d).toContain('测试：未通过（2 failing）')
    expect(d).toContain('阻塞：缺 key')
  })

  it('跳过没有产出的阶段；全空时给占位文案', () => {
    const stages = [stage('a', 'A'), stage('b', 'B')]
    expect(composeRunDigest(stages, { a: [] }, [])).toBe('本次运行没有可汇总的产出。')
    const d = composeRunDigest(stages, { b: [okLane('b', 'X')] }, [])
    expect(d).toContain('B')
    expect(d).not.toContain('### A')
  })
})

describe('buildSummaryPrompt', () => {
  it('含清单，且提供 task 时含需求原文', () => {
    const p = buildSummaryPrompt('DIGEST', '把登录改成 OAuth')
    expect(p).toContain('DIGEST')
    expect(p).toContain('把登录改成 OAuth')
    expect(p).toContain('本次运行总结')
  })
  it('无 task 时不含需求原文小节', () => {
    const p = buildSummaryPrompt('DIGEST')
    expect(p).not.toContain('本次需求原文')
  })
})

describe('runRunSummary', () => {
  const base = { digest: 'D', model: 'm', cwd: '/w', env: {} }

  it('provider 无 chat → 回退到 digest', async () => {
    const noChat = { ...chatProvider('x') }
    delete (noChat as any).chat
    expect(await runRunSummary(noChat as AgentProvider, base)).toBe('D')
  })

  it('provider undefined → 回退到 digest', async () => {
    expect(await runRunSummary(undefined, base)).toBe('D')
  })

  it('拿到叙述文本 → 返回叙述(trim)', async () => {
    expect(await runRunSummary(chatProvider('  本次总结  '), base)).toBe('本次总结')
  })

  it('叙述为空 → 回退到 digest', async () => {
    expect(await runRunSummary(chatProvider('   '), base)).toBe('D')
  })

  it('chat 抛错 → 回退到 digest', async () => {
    const throwing: AgentProvider = { ...chatProvider('x'), chat() { throw new Error('boom') } }
    expect(await runRunSummary(throwing, base)).toBe('D')
  })

  it('超时 → 回退到 digest', async () => {
    // A provider whose chat never resolves; inject a synchronous timer that fires immediately.
    const hang: AgentProvider = {
      ...chatProvider('x'),
      chat(task) { return { id: task.id, cancel() {}, done: new Promise(() => {}) } },
    }
    const immediate = (fn: () => void) => { fn(); return { clear: () => {} } }
    expect(await runRunSummary(hang, { ...base, setTimer: immediate })).toBe('D')
  })
})
