import { stageScope, type StartRunOpts } from '../orchestrator/orchestrator'

/** 提案卡用:从重建后的 StartRunOpts 算出每阶段将启动多少代理(确定性,不靠 LLM)。 */
export function planStages(opts: StartRunOpts): { name: string; agents: number }[] {
  const nProj = Math.max(1, opts.developProjects.length)
  return opts.stages.map(s => ({
    name: s.name,
    agents: stageScope(s) === 'per-project' ? nProj : 1,
  }))
}
