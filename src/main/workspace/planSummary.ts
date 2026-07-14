import { stageScope, type StartRunOpts } from '../orchestrator/orchestrator'

export interface PlanStageInfo {
  key: string
  name: string
  agents: number
  perProject: boolean       // true → the approval card can let the user pick which projects this stage scans
  projects: string[]        // the project NAMES this stage will run on (subset or all), for per-project stages
}

/** 提案卡用:从重建后的 StartRunOpts 算出每阶段将启动多少代理 + 会扫哪些项目(确定性,不靠 LLM)。 */
export function planStages(opts: StartRunOpts): PlanStageInfo[] {
  const all = opts.developProjects.map(p => p.name)
  return opts.stages.map(s => {
    if (stageScope(s) !== 'per-project') return { key: s.key, name: s.name, agents: 1, perProject: false, projects: [] }
    // Reflect per-stage project scoping so the card shows the real projects/agents (e.g. 分析 5, 开发 2).
    // An unset or all-missing scope means every project.
    const scoped = s.projects?.length ? all.filter(n => s.projects!.includes(n)) : all
    const projects = scoped.length ? scoped : all
    return { key: s.key, name: s.name, agents: Math.max(1, projects.length), perProject: true, projects }
  })
}
