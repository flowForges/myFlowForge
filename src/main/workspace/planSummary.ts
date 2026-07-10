import { stageScope, type StartRunOpts } from '../orchestrator/orchestrator'

/** 提案卡用:从重建后的 StartRunOpts 算出每阶段将启动多少代理(确定性,不靠 LLM)。 */
export function planStages(opts: StartRunOpts): { name: string; agents: number }[] {
  const nAll = Math.max(1, opts.developProjects.length)
  return opts.stages.map(s => {
    if (stageScope(s) !== 'per-project') return { name: s.name, agents: 1 }
    // Reflect per-stage project scoping so the approval card shows the real agent count (e.g. 分析 5,
    // 开发 2). An unset or all-missing scope means every project.
    const scoped = s.projects?.length ?? 0
    return { name: s.name, agents: Math.max(1, scoped > 0 ? Math.min(scoped, nAll) : nAll) }
  })
}
