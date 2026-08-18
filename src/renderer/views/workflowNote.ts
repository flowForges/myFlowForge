import type { WorkflowSessionState } from '@shared/workflowSession'
import type { FinalizeFailure } from '../../main/run/controller'

// 右侧面板顶部那句工作流状态说明。
//
// 单独抽出来是因为它曾经说谎(2026-08-12 用户实测):合并临时分支失败,面板照样写「工作流已完成 · 所有阶段
// 已走完」。根因是它只看 phase,而 phase 在 run 走到**任何**终态时就被置成 done —— ok 和 failed 一视同仁
// (见 WorkspaceView 里那个 workflowFinish effect;那样置是对的,否则 ribbon 会永远卡在"执行中")。
// 所以诚实与否只能在这句话里解决:失败时不能装作"已完成",但具体能不能进一步说"阶段都跑完了、只是收尾
// 没成"、以及改动是否还在,取决于是哪一种失败——不是每种 failed 都能这样说,见下面 Task 8 fix round 2。
//
// Task 8:「工作流未正常收尾 · <原始 git 报错>」这句本身被换掉了 —— 但换法先后踩了两次坑:
//   - fix round 1 之前的版本对**所有** failed 情形都无条件说"工作流已跑完…改动完整保留…未丢失",这对
//     中途终止/阶段失败(还没到收尾那一步)是假的。
//   - fix round 1 改成按 `run.error` 是否有值分支,自以为"error 有值 ⟺ 阶段都跑完、只是收尾没成"——这
//     个判断本身就是错的(下面 RunStatusView.finalizeFailure 的注释解释了为什么),只是换了个地方继续
//     误判同一批场景,而不是真的分开了它们。
// 真正能区分"阶段都跑完了、只是收尾没成"和其它一切失败的,是 `finalizeFailure`,不是 `error`——见其
// 类型注释。
export interface RunStatusView {
  status: string
  runId: string
  // Task 8 fix round 2 (C1):`error`(RunControllerState.error,controller.ts)有两个赋值点——①收尾
  // (runFinalizeGate)的 merge/discard/park 失败;②start() 最外层 catch,对**整个 stage 循环任何一处
  // 抛错**都会兜底赋值(某阶段 buildWorkOrders 返回 []、store 写盘失败、emitUpdate 订阅者抛错……),
  // 这条路径完全不要求阶段跑完、甚至可能连临时分支都没建过。所以 `error` truthy 不能当作"收尾真的失败
  // 过"的信号——fix round 1 就是被 controller.ts 当时那条(已修正的)错误文档注释误导,拿它当了信号。
  //
  // `finalizeFailure`(controller.ts 的 RunControllerState.finalizeFailure)只有收尾(runFinalizeGate)
  // 真正执行 merge/discard/park 且至少一个项目失败那一处会**产出**值(另有一次 rehydrate 回放和一次
  // 成功重试后的清空,见该字段注释)——这才是"阶段都跑完了、只是收尾没成"唯一可靠的信号,所以这里改用
  // 它而不是 `error`。
  finalizeFailure?: FinalizeFailure[]
}

export function workflowPhaseNote(
  wf: Pick<WorkflowSessionState, 'phase' | 'currentIndex' | 'stages' | 'runId'>,
  run: RunStatusView | null,
): string {
  if (wf.phase !== 'done') {
    const total = wf.stages.length
    const cur = Math.min(wf.currentIndex + 1, total)
    return `对话阶段 · 第 ${cur}/${total} 步，在左侧会话区与当前 provider 对话推进`
  }
  // 只认这条工作流自己那个 run 的失败 —— 工作区里别的 run 失败了与这条无关。
  const failed = !!run && run.status === 'failed' && run.runId === wf.runId
  if (!failed) return '工作流已完成 · 所有阶段已走完'
  if (run!.finalizeFailure && run!.finalizeFailure.length > 0) {
    // 见上方 RunStatusView.finalizeFailure 的注释:这是"阶段全部按计划跑完、只是收尾(合并/丢弃/保留)
    // 没能自动完成"唯一可靠的信号。收尾按项目分别执行、分别失败——已经成功丢弃的项目其临时分支是真的
    // 没了,所以不能无条件断言"改动完整保留/未丢失",这里跟 WorkspaceView 收尾横幅的确认文案用同一句
    // 打折扣的措辞。
    return `工作流已跑完 · 收尾没能自动完成，改动通常还在 forge/run-${wf.runId} 分支上（除非当时选的是「丢弃」且已经生效）`
  }
  // finalizeFailure 缺失但状态仍是 failed:中途终止(还没跑到收尾那一步)、阶段本身失败(如某阶段
  // buildWorkOrders 返回 [] 而抛错)、或者没有失败记录的 handoff——这些都还没确定"阶段全部跑完",甚至
  // 可能压根没建过临时分支,所以既不能说"已跑完",也不能打包票说改动都在,只指路让用户自己去分支上确认。
  return `工作流已停止 · 请检查 forge/run-${wf.runId} 分支确认实际进度`
}
