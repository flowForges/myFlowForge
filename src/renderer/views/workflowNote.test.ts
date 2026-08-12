import { describe, it, expect } from 'vitest'
import { workflowPhaseNote } from './workflowNote'

// 真实事故(2026-08-12):合并临时分支失败,可工作流照样显示「已完成」。原因是这句话只看 phase —— 而
// phase 在 run 走到终态时就被置 done 了,ok 和 failed 一视同仁(WorkspaceView 的 workflowFinish effect)。
// 用户于是先看到"完成",关掉流程条,右侧才蹦出合并失败,信息前后打架。
const wf = (phase: 'chatting' | 'executing' | 'done', currentIndex = 0) =>
  ({ phase, currentIndex, stages: [{}, {}, {}, {}], runId: 'r1' }) as Parameters<typeof workflowPhaseNote>[0]

describe('workflowPhaseNote', () => {
  it('对话阶段:报第几步', () => {
    expect(workflowPhaseNote(wf('chatting', 1), null)).toContain('第 2/4 步')
  })

  it('干净跑完:说已完成', () => {
    expect(workflowPhaseNote(wf('done'), { status: 'ok', runId: 'r1' })).toContain('已完成')
  })

  it('收尾失败:不许说"已完成",要说失败并带上原因', () => {
    const note = workflowPhaseNote(wf('done'), { status: 'failed', runId: 'r1', error: '合并临时分支失败 — web: CONFLICT in src/x.ts' })
    expect(note).not.toContain('已完成')
    expect(note).toContain('CONFLICT in src/x.ts')
  })

  it('失败但没给原因时也不能装作完成', () => {
    expect(workflowPhaseNote(wf('done'), { status: 'failed', runId: 'r1' })).not.toContain('已完成')
  })

  it('失败的是**别的** run(runId 对不上)不影响这条工作流的结论', () => {
    expect(workflowPhaseNote(wf('done'), { status: 'failed', runId: '别的run', error: 'x' })).toContain('已完成')
  })

  it('拿不到 run 状态(重启后没有活 run)时按已完成显示,不凭空报错', () => {
    expect(workflowPhaseNote(wf('done'), null)).toContain('已完成')
  })
})
