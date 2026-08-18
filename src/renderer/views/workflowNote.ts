import type { WorkflowSessionState } from '@shared/workflowSession'

// 右侧面板顶部那句工作流状态说明。
//
// 单独抽出来是因为它曾经说谎(2026-08-12 用户实测):合并临时分支失败,面板照样写「工作流已完成 · 所有阶段
// 已走完」。根因是它只看 phase,而 phase 在 run 走到**任何**终态时就被置成 done —— ok 和 failed 一视同仁
// (见 WorkspaceView 里那个 workflowFinish effect;那样置是对的,否则 ribbon 会永远卡在"执行中")。
// 所以诚实与否只能在这句话里解决:失败时不能装作"已完成",但具体能不能进一步说"阶段都跑完了、只是收尾
// 没成"、以及改动是否还在,取决于是哪一种失败——不是每种 failed 都能这样说,见下面 Task 8 fix round 1。
//
// Task 8:「工作流未正常收尾 · <原始 git 报错>」这句本身被换掉了 —— 但 fix round 1 之前的换法矫枉过正,
// 把它换成了一句对**所有** failed 情形都无条件成立的"工作流已跑完…改动完整保留…未丢失",而这对中途
// 终止/阶段失败(还没到收尾那一步)是假的。真相是:
//   - `run.error` 有值 ⟺ controller.ts 的 runFinalizeGate 真正执行了 merge/discard/park 且至少一个
//     项目失败(该字段只在这条路径上被置,且只有 `machine.stages.every(done) && !aborted` 时才会走到
//     runFinalizeGate——见 RunControllerState.error 的类型注释)。只有这一种情况才能说"阶段都跑完了、
//     只是收尾没成"。而且收尾是按项目分别执行、分别失败的(有的项目可能已经合并/已经被丢弃),所以
//     "改动都还在"也不能无条件断言,只能像 WorkspaceView 收尾横幅的确认文案那样打个折扣。
//   - `run.error` 没有值但状态仍是 failed:可能是中途终止(还没跑到收尾那一步)、阶段失败、或者用户在
//     还没发生过失败尝试的情况下直接选了「知道了，我自己处理」——这几种都不能说"已跑完",也不能打包票
//     地说改动都在,只给一句诚实、不描述细节的收尾提示,原始报错交给 FinalizeFailureCard(Tasks 1-7)。
export interface RunStatusView {
  status: string
  runId: string
  // Task 8 fix round 1:这里只把它当一个「收尾是否真的失败过」的布尔信号用(见上面大段注释),不再把
  // 它的原始文本嵌进 workflowPhaseNote 的返回值——原始报错细节的展示是 FinalizeFailureCard 的职责。
  error?: string
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
  if (run!.error) {
    // 见上方大段注释:error 有值 ⟺ 阶段全部按计划跑完、只是收尾(合并/丢弃/保留)没能自动完成。收尾按
    // 项目分别执行、分别失败——已经成功丢弃的项目其临时分支是真的没了,所以不能无条件断言"改动完整
    // 保留/未丢失",这里跟 WorkspaceView 收尾横幅的确认文案用同一句打折扣的措辞。
    return `工作流已跑完 · 收尾没能自动完成，改动通常还在 forge/run-${wf.runId} 分支上（除非当时选的是「丢弃」且已经生效）`
  }
  // error 缺失但状态仍是 failed:中途终止/阶段失败/无失败记录的 handoff——都还没确定跑到了收尾那步,
  // 不能说"已跑完",也不能打包票地说改动都在,只指路让用户自己去分支上确认。
  return `工作流已停止 · 请检查 forge/run-${wf.runId} 分支确认实际进度`
}
