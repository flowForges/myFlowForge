import { buildStageChoice, stageAllowsAgentPick, stageAllowsPerProject, isPerProjectStage } from '../../../src/shared/launchStages'
import type { StageInfo } from './useWorkflow'

/**
 * 启动屏里「逐阶段临时改」的那份草稿状态,以及它怎么变成发给服务端的 `stages`。
 *
 * ★★纯函数放这儿,不放组件里 —— 组件在 jsdom 里量不了、也测不动,而这一层恰恰是
 *  「错了在屏幕上看不出来」的地方(见 `@shared/launchStages` 顶上的注释:多发一个
 *  `perProject: false` 会把代码开发的逐项目扇出压成单代理,界面上只显示「跑了一个 lane」)。
 * ★**临时**:改的只是这一次运行,工作流本身一个字节都不动。下次启动回到默认。
 */
export type StageDraft = {
  enabled: boolean
  provider: string
  model: string
  perProject: boolean
  /** 这个阶段逐项目指定的编码代理。空 = 没改过,由主进程回落到工作区里配好的那份。 */
  projectAgents: Record<string, { provider: string; model: string }>
}
export type StageDrafts = Record<string, StageDraft>

/** 一条流程的初始草稿:全部启用、代理用阶段自己的默认、不强制按项目。 */
export function initDrafts(stages: StageInfo[]): StageDrafts {
  const out: StageDrafts = {}
  for (const s of stages) {
    out[s.key] = {
      enabled: true,
      provider: s.provider,
      model: s.model,
      perProject: false,
      // 工作区里本来就配过的逐项目代理要**带进草稿**,否则用户什么都没动、
      // 一提交却把它们清空了(空 projects 不下发 ⇒ 回落 ⇒ 其实没清空,但界面上看不见,人会以为丢了)。
      projectAgents: Object.fromEntries(
        (s.projectAgents ?? []).map((a) => [a.name, { provider: a.provider, model: a.model }]),
      ),
    }
  }
  return out
}

/** 改一个阶段的某几项。★不认识的 key 原样返回 —— 切工作流那一刻旧 key 还在,不该崩。 */
export function patchDraft(d: StageDrafts, key: string, patch: Partial<StageDraft>): StageDrafts {
  const cur = d[key]
  if (!cur) return d
  return { ...d, [key]: { ...cur, ...patch } }
}

/** 给某个阶段的某个项目指定代理。provider 传空 = 清掉这条覆盖(回落到项目自己的代理)。 */
export function setStageProjectAgent(
  d: StageDrafts, key: string, project: string, agent: { provider: string; model: string } | null,
): StageDrafts {
  const cur = d[key]
  if (!cur) return d
  const next = { ...cur.projectAgents }
  if (agent && agent.provider) next[project] = agent
  else delete next[project]
  return { ...d, [key]: { ...cur, projectAgents: next } }
}

/**
 * 变成 `LaunchStartConfig.stages`。
 * ★逐项目代理只带**当前选中的项目** —— 用户先给 api 指了代理、又把 api 取消勾选,
 *  那条覆盖就不该跟着发出去(它会挂在一个根本不跑的项目上,纯噪音)。
 */
export function toStageChoices(stages: StageInfo[], d: StageDrafts, pickedProjects: string[]) {
  const picked = new Set(pickedProjects)
  return stages.map((s) => {
    const st = d[s.key] ?? { enabled: true, provider: s.provider, model: s.model, perProject: false, projectAgents: {} }
    const agents = Object.entries(st.projectAgents)
      .filter(([name]) => picked.has(name))
      .map(([name, a]) => ({ name, provider: a.provider, model: a.model }))
    return buildStageChoice(s, st, agents)
  })
}

/** 这个阶段这次会不会按项目扇出(决定要不要显示那组逐项目代理)。 */
export const stageFansOut = (s: StageInfo, d: StageDrafts) =>
  isPerProjectStage(s, d[s.key]?.perProject ?? false)

export { stageAllowsAgentPick, stageAllowsPerProject }

/**
 * 能不能按「启动」。★三条都是**服务端会拒**或者**跑起来没意义**的情况,在这儿说清楚,
 *  而不是让人点下去吃一句报错(这一屏原本就是这么设计的,见文件顶上的注释)。
 */
export function launchBlocker(
  stages: StageInfo[], d: StageDrafts, pickedProjects: string[], requirement: string,
): string | null {
  if (!requirement.trim()) return '先说一句这次要做什么'
  const on = stages.filter((s) => d[s.key]?.enabled ?? true)
  if (stages.length > 0 && on.length === 0) return '至少留一个阶段'
  // 一个按项目跑的阶段开着、却一个项目都没选 ⇒ 它会得到零个 lane,跑起来什么都不做。
  if (pickedProjects.length === 0 && on.some((s) => stageFansOut(s, d))) return '按项目跑的阶段需要至少选一个项目'
  return null
}
