import { stageScope, type StartRunOpts } from '../orchestrator/orchestrator'

export interface PlanStageInfo {
  key: string
  name: string
  agents: number
  perProject: boolean       // true → the approval card can let the user pick which projects this stage scans
  projects: string[]        // the project NAMES this stage will run on (subset or all), for per-project stages
}

// A hook (Plugin) surfaced on the approval card so the user can toggle it off (skip it this run).
// `after` places it in the woven sequence: a stage key, or '__start' (before all) / '__wf' (at end).
export interface PlanHookInfo { id: string; name: string; after: string }

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

/** 提案卡用:列出本次将执行的 hook(工作流织入阶段间的 plugins + 末尾 __wf 的 stepPlugins),供用户勾选去掉。 */
export function planHooks(opts: StartRunOpts): PlanHookInfo[] {
  const woven = (opts.plugins ?? []).map(p => ({ id: p.id, name: p.name, after: p.after }))
  const wf = (opts.stepPlugins ?? []).filter(p => p.after === '__wf').map(p => ({ id: p.id, name: p.name, after: p.after }))
  return [...woven, ...wf]
}
