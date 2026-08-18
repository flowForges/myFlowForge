import { describe, it, expect } from 'vitest'
import { workflowPhaseNote } from './workflowNote'
import type { FinalizeFailure } from '../../main/run/controller'

// 真实事故(2026-08-12):合并临时分支失败,可工作流照样显示「已完成」。原因是这句话只看 phase —— 而
// phase 在 run 走到终态时就被置 done 了,ok 和 failed 一视同仁(WorkspaceView 的 workflowFinish effect)。
// 用户于是先看到"完成",关掉流程条,右侧才蹦出合并失败,信息前后打架。
const wf = (phase: 'chatting' | 'executing' | 'done', currentIndex = 0) =>
  ({ phase, currentIndex, stages: [{}, {}, {}, {}], runId: 'r1' }) as Parameters<typeof workflowPhaseNote>[0]

// controller.ts's FinalizeFailure — one entry means "收尾(merge/discard/park)真的对这个项目失败了"。
const mkFinalizeFailure = (): FinalizeFailure[] =>
  [{ project: 'web', target: 'main', tempBranch: 'forge/run-r1', conflictFiles: ['src/x.ts'], detail: 'CONFLICT in src/x.ts' }]

describe('workflowPhaseNote', () => {
  it('对话阶段:报第几步', () => {
    expect(workflowPhaseNote(wf('chatting', 1), null)).toContain('第 2/4 步')
  })

  it('干净跑完:说已完成', () => {
    expect(workflowPhaseNote(wf('done'), { status: 'ok', runId: 'r1' })).toContain('已完成')
  })

  // Task 8:这句改为不再复述原始 git 报错(那是 FinalizeFailureCard 的活),只负责不让人以为"已完成"、
  // 并点名改动保留在哪个分支——具体冲突原因见下面「收尾失败文案」那组测试。
  // Task 8 fix round 2 (C1):判断信号从 `error` 换成了 `finalizeFailure`(见 workflowNote.ts 的类型
  // 注释),这里的 fixture 跟着换。
  it('收尾失败:不许说"已完成"，要点名改动保留的分支', () => {
    const note = workflowPhaseNote(wf('done'), { status: 'failed', runId: 'r1', finalizeFailure: mkFinalizeFailure() })
    expect(note).not.toContain('已完成')
    expect(note).toContain('forge/run-r1')
  })

  it('失败但没有 finalizeFailure 时也不能装作完成', () => {
    expect(workflowPhaseNote(wf('done'), { status: 'failed', runId: 'r1' })).not.toContain('已完成')
  })

  it('失败的是**别的** run(runId 对不上)不影响这条工作流的结论', () => {
    expect(workflowPhaseNote(wf('done'), { status: 'failed', runId: '别的run', finalizeFailure: mkFinalizeFailure() })).toContain('已完成')
  })

  it('拿不到 run 状态(重启后没有活 run)、盘上也没有未收尾记录时按已完成显示,不凭空报错', () => {
    expect(workflowPhaseNote(wf('done'), null)).toContain('已完成')
  })
})

// I4(2026-08-17 全分支终审):重启之后内存里的 run 没了(manager.get() 和 lastStateFor() 都空),
// WorkspaceView 传进来的 run 恒为 null,而盘上的 wf.phase 还是 'done' —— 这句话于是说「工作流已完成 ·
// 所有阶段已走完」,而几像素之外的恢复横幅同时在说「上次的工作流阶段都跑完了,但收尾没能自动完成」。
// 重启恰恰是用户撞得最多的那种情况。盘上那条 resumable 记录(summarizeResumable 的 finalizeOnly)是
// 那一刻唯一的事实源。
describe('I4:重启后只剩盘上的 resumable 记录', () => {
  it('resumable.finalizeOnly 且 runId 对得上 → 说收尾没成,不说已完成', () => {
    const note = workflowPhaseNote(wf('done'), null, { runId: 'r1', finalizeOnly: true })
    expect(note).not.toContain('已完成')
    expect(note).toContain('forge/run-r1')
    // 和活 run 那条分支必须一字不差(同一件事,不能两处说法)。
    expect(note).toBe(workflowPhaseNote(wf('done'), { status: 'failed', runId: 'r1', finalizeFailure: mkFinalizeFailure() }))
  })

  it('resumable 是**别的** run(runId 对不上)→ 不污染这条工作流的结论', () => {
    expect(workflowPhaseNote(wf('done'), null, { runId: '别的run', finalizeOnly: true })).toContain('已完成')
  })

  it('resumable 存在但不是 finalizeOnly(某阶段没跑完)→ 这句话不认领它,由恢复横幅自己说', () => {
    expect(workflowPhaseNote(wf('done'), null, { runId: 'r1' })).toContain('已完成')
  })

  it('这条 run 有活状态且说 ok 时,盘上的旧记录不许把它拽回失败(内存里的更新)', () => {
    // 现实里两者不会同时出现(有活 controller 时 Run2Manager.resumable 恒返回 null),钉住优先级
    // 免得将来被改反:同一个 run,内存状态 > 重启前落的盘。
    expect(workflowPhaseNote(wf('done'), { status: 'ok', runId: 'r1' }, { runId: 'r1', finalizeOnly: true }))
      .toContain('已完成')
  })

  it('活状态属于**别的** run 时,这条工作流仍然认自己盘上的记录', () => {
    const note = workflowPhaseNote(wf('done'), { status: 'ok', runId: '别的run' }, { runId: 'r1', finalizeOnly: true })
    expect(note).toContain('收尾没能自动完成')
  })
})

describe('收尾失败文案', () => {
  // Task 8 fix round 1 (C1 first pass):之前这条断言"未丢失/没丢"是无条件的,但收尾按项目分别执行、
  // 分别失败,已经成功丢弃的项目其临时分支是真的没了——所以这里不能再断言无条件的"未丢失",只能断言
  // 这句话打了折扣(呼应 WorkspaceView 收尾横幅确认文案已经在用的"通常…除非当时选的是丢弃"这句hedge)。
  //
  // Task 8 fix round 2 (C1 second pass — review 指出两处问题):
  //   1. 判断信号换成 `finalizeFailure`(唯一赋值点是 runFinalizeGate 的失败分支)——之前用的 `error`
  //      有第二个赋值点(start() 最外层 catch,对阶段循环任何一处抛错都会兜底赋值),不能区分"阶段都跑
  //      完了、只是收尾没成"和"中途某处直接抛错"这两种性质完全不同的失败(见下一个 describe block 的
  //      "mid-run 抛错" 用例——那正是原来的 bug 会被漏测的那个状态)。
  //   2. 负面断言从"精确钉住旧版整句话"(`/改动完整保留在 forge\/run-a1b2（未丢失）/`,换一种无条件措
  //      辞就绕过去了)改成钉住"无条件断言"这个**语义片段**本身(`/改动完整保留/`、`/未丢失/`);正面
  //      断言从"通常|除非 二选一"(能被一个不相关的"通常"糊弄过去)改成钉住这句 hedge 的实际拼接结果。
  it('阶段全部跑完、只是收尾没能自动完成(finalizeFailure 非空)时:点名分支，不出现「未正常收尾」，但不无条件断言改动完整保留/未丢失', () => {
    const note = workflowPhaseNote(
      { phase: 'done', currentIndex: 2, stages: [{}, {}, {}] as never[], runId: 'a1b2' },
      { status: 'failed', runId: 'a1b2', finalizeFailure: mkFinalizeFailure() },
    )
    expect(note).toMatch(/forge\/run-a1b2/)
    expect(note).not.toMatch(/未正常收尾/)
    // 正面:钉住这句 hedge 真正拼出来的样子,不是"通常|除非"这种任一命中就算过的宽松匹配。
    expect(note).toMatch(/通常还在 forge\/run-a1b2 分支上（除非当时选的是「丢弃」且已经生效）/)
    // 负面:钉住"无条件断言"这个语义片段(而不是整句旧文案),换任何一种说法表达同一个无条件断言都会
    // 被拦下来——这正是 fix round 1 那次改法(只钉整句)会漏过的回归。
    expect(note).not.toMatch(/改动完整保留/)
    expect(note).not.toMatch(/未丢失/)
  })

  // C1 的核心场景(fix round 2 补上——这个状态之前完全没有测试覆盖,是原始 bug 能上线的原因):中途在
  // stage 循环里抛错(例如某个按项目阶段的 buildWorkOrders 返回 [],或 store 写盘失败),会命中
  // controller.ts start() 最外层的 catch-all——它总会把 `error` 置上,但**不会**碰 `finalizeFailure`。
  // 这种状态下阶段未必全部跑完,甚至可能还没建过临时分支,既不能说"已完成"/"已跑完",也不能承诺改动
  // 都还在分支上。
  it('中途在 stage 循环里抛错(finalizeFailure 没有值,阶段未必都跑完)时:不说"已完成"/"已跑完"，不承诺改动都在', () => {
    const note = workflowPhaseNote(
      { phase: 'done', currentIndex: 1, stages: [{}, {}, {}] as never[], runId: 'a1b2' },
      { status: 'failed', runId: 'a1b2' },   // finalizeFailure 缺失——即便后端此时 error 有值,这里也不该收到/依赖它
    )
    expect(note).not.toMatch(/已完成/)
    expect(note).not.toMatch(/已跑完/)
    expect(note).not.toMatch(/改动完整保留/)
    expect(note).not.toMatch(/未丢失/)
  })

  // 边界:一次成功的重试会把 finalizeFailure 清空成空数组(见 controller.ts:823),不是 undefined——
  // 这条状态理论上不该和 status:'failed' 同时出现(失败清零后 status 会是 'ok'),但既然 workflowNote
  // 只认 `.length > 0`,顺手钉住空数组也不会被误判成"收尾失败"。
  it('finalizeFailure 是空数组时按"没有 finalizeFailure"处理', () => {
    const note = workflowPhaseNote(
      { phase: 'done', currentIndex: 1, stages: [{}, {}, {}] as never[], runId: 'a1b2' },
      { status: 'failed', runId: 'a1b2', finalizeFailure: [] },
    )
    expect(note).not.toMatch(/已跑完/)
  })

  it('成功时文案不变', () => {
    const note = workflowPhaseNote(
      { phase: 'done', currentIndex: 2, stages: [{}, {}, {}] as never[], runId: 'a1b2' },
      { status: 'ok', runId: 'a1b2' },
    )
    expect(note).toBe('工作流已完成 · 所有阶段已走完')
  })
})
