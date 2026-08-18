import type { WorkflowSessionState } from '@shared/workflowSession'

// 右侧面板顶部那句工作流状态说明。
//
// 单独抽出来是因为它曾经说谎(2026-08-12 用户实测):合并临时分支失败,面板照样写「工作流已完成 · 所有阶段
// 已走完」。根因是它只看 phase,而 phase 在 run 走到**任何**终态时就被置成 done —— ok 和 failed 一视同仁
// (见 WorkspaceView 里那个 workflowFinish effect;那样置是对的,否则 ribbon 会永远卡在"执行中")。
// 所以诚实与否只能在这句话里解决:阶段确实都走完了,但收尾没成,就得直说,并把原因摆出来。
//
// Task 8:「工作流未正常收尾 · <原始 git 报错>」这句被换掉了。「未正常收尾」这四个字用户读出来的意思是
// "这次白跑了、东西可能没了"——但事实恰恰相反:阶段全部按计划跑完,agent 写的每一行代码都还在,只是最后
// 一步(把临时分支合回目标分支)没能自动完成。原始 git 报错(冲突文件、哪个项目)也不该复述在这一句里:
// 那是 FinalizeFailureCard(Tasks 1-7)的职责,这里只负责一件事——不让人被"未正常收尾"吓到、并直接点名
// 改动还在哪个分支上,所以永远说 forge/run-<runId>,不再嵌入 run.error 的原文。
export interface RunStatusView {
  status: string
  runId: string
  // 收尾失败的可读原因(RunControllerState.error),例如「合并临时分支失败 — web: CONFLICT …」。
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
  return `工作流已跑完 · 收尾需手工合并，改动完整保留在 forge/run-${wf.runId}（未丢失）`
}
