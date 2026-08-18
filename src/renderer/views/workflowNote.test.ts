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

  // Task 8:这句改为不再复述原始 git 报错(那是 FinalizeFailureCard 的活),只负责不让人以为"已完成"、
  // 并点名改动保留在哪个分支——具体冲突原因见下面「收尾失败文案」那组测试。
  it('收尾失败:不许说"已完成"，要点名改动保留的分支', () => {
    const note = workflowPhaseNote(wf('done'), { status: 'failed', runId: 'r1', error: '合并临时分支失败 — web: CONFLICT in src/x.ts' })
    expect(note).not.toContain('已完成')
    expect(note).toContain('forge/run-r1')
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

describe('收尾失败文案', () => {
  // Task 8 fix round 1 (C1 — 之前这条断言"未丢失/没丢"是无条件的,但收尾按项目分别执行、分别失败,
  // 已经成功丢弃的项目其临时分支是真的没了——所以这里不能再断言无条件的"未丢失",只能断言这句话打了
  // 折扣(呼应 WorkspaceView 收尾横幅确认文案已经在用的"通常…除非当时选的是丢弃"这句hedge)。
  it('阶段全部跑完、只是收尾没能自动完成(error 有值)时:点名分支，不出现「未正常收尾」，但不无条件断言改动完整保留/未丢失', () => {
    const note = workflowPhaseNote(
      { phase: 'done', currentIndex: 2, stages: [{}, {}, {}] as never[], runId: 'a1b2' },
      { status: 'failed', runId: 'a1b2', error: 'CONFLICT' },
    )
    expect(note).toMatch(/forge\/run-a1b2/)
    expect(note).not.toMatch(/未正常收尾/)
    expect(note).toMatch(/通常|除非/)
    // 唯一的自动化刹车:不能出现无条件的"改动完整保留…未丢失"式断言(fix round 1 之前的版本就是这样,
    // 对中途终止/阶段失败也无条件成立,但那两种情形下是假的——见下一条用例)。
    expect(note).not.toMatch(/改动完整保留在 forge\/run-a1b2（未丢失）/)
  })

  // C1 的核心场景:中途终止(还没跑到收尾那一步)时,既不能说"已完成",也不能说"已跑完 · 收尾需手工合并"
  // ——没有跑完、也没有东西要手工合并。error 缺失是这种情形(以及阶段失败/无失败记录的 handoff)的信号。
  it('中途终止/阶段失败(error 没有值)时:不说"已完成"，也不假装"已跑完"或无条件断言改动都还在', () => {
    const note = workflowPhaseNote(
      { phase: 'done', currentIndex: 2, stages: [{}, {}, {}] as never[], runId: 'a1b2' },
      { status: 'failed', runId: 'a1b2' },
    )
    expect(note).not.toMatch(/已完成/)
    expect(note).not.toMatch(/已跑完/)
    expect(note).toMatch(/forge\/run-a1b2/)
  })

  it('成功时文案不变', () => {
    const note = workflowPhaseNote(
      { phase: 'done', currentIndex: 2, stages: [{}, {}, {}] as never[], runId: 'a1b2' },
      { status: 'ok', runId: 'a1b2' },
    )
    expect(note).toBe('工作流已完成 · 所有阶段已走完')
  })
})
