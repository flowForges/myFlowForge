import type { StageInfo, WorkflowInfo } from './useWorkflow'

/**
 * 手机上「改这条工作流」的草稿。
 *
 * ★★和启动屏那份草稿(`stageChoices.ts`)是**两件事**,别混:
 *  · `stageChoices` 改的是**这一次运行** —— 跑完就没了,工作流本身一个字节不动;
 *  · 这一份改的是**工作流本身** —— 存回主机的 workspace.json,电脑端立刻看得见,以后每次都这么跑。
 *  两屏长得像,后果差一个数量级,所以文案上必须说清楚(编辑屏顶上那句话就是干这个的)。
 *
 * ★手机上看得见、也只改得动三样:**阶段顺序、每个阶段用哪个代理、要不要停下来确认**。
 *  提示词、CR 视角、权限档、hooks 一律不在这儿 —— 那是一屏塞不下、改错了每一轮都受影响的东西。
 *  主机端按「合并」处理正是为了这个:手机没发的字段一个都不许丢(见 main/workspace/editWorkflows.ts)。
 */
export type DraftStage = {
  key: string
  name: string
  desc: string
  provider: string
  model: string
  /** 天生按项目扇出(代码开发)。只用来在界面上标一句,手机上不给改。 */
  code: boolean
  producesDoc: boolean
  gate: boolean
  /** 新加的自定义阶段:引用全局阶段库的哪一条。存回去时由主机据此物化提示词和行为开关。 */
  libId?: string
}
export type FlowDraft = { id: string; name: string; stages: DraftStage[] }

/** 「加一个阶段」那张单子里的一项(主机 `workflow:stage-catalog` 给的)。 */
export type CatalogStage = {
  key: string
  name: string
  desc: string
  provider: string
  model: string
  code: boolean
  producesDoc: boolean
  gate: boolean
  libId?: string
}

/** 从启动屏已经拿到的那条工作流建草稿。传 null = 新建一条空的。 */
export function draftFromFlow(flow: WorkflowInfo | null): FlowDraft {
  if (!flow) return { id: '', name: '', stages: [] }
  return { id: flow.id, name: flow.name, stages: flow.stages.map(stageToDraft) }
}

const stageToDraft = (s: StageInfo): DraftStage => ({
  key: s.key,
  name: s.name,
  desc: s.desc ?? '',
  provider: s.provider,
  model: s.model,
  code: s.code,
  producesDoc: s.producesDoc ?? false,
  gate: s.gate,
})

export const setName = (d: FlowDraft, name: string): FlowDraft => ({ ...d, name })

/**
 * 上移 / 下移一个阶段。★越界原样返回 —— 第一条上移、最后一条下移是**正常操作**
 * (人就是会去点),不该崩,也不该悄悄把顺序搅乱。
 */
export function moveStage(d: FlowDraft, index: number, dir: -1 | 1): FlowDraft {
  const to = index + dir
  if (index < 0 || index >= d.stages.length || to < 0 || to >= d.stages.length) return d
  const stages = [...d.stages]
  const [s] = stages.splice(index, 1)
  stages.splice(to, 0, s)
  return { ...d, stages }
}

export const removeStage = (d: FlowDraft, key: string): FlowDraft =>
  ({ ...d, stages: d.stages.filter((s) => s.key !== key) })

/**
 * 加一个阶段。★同 key 的直接忽略:一条工作流里两个同 key 的阶段跑起来会撞 id,
 * 主机那边也会去重 —— 与其让人加完看见一条、存完变没了,不如这儿就不让加(单子上那项置灰)。
 */
export function addStage(d: FlowDraft, cat: CatalogStage): FlowDraft {
  if (d.stages.some((s) => s.key === cat.key)) return d
  return {
    ...d,
    stages: [...d.stages, {
      key: cat.key, name: cat.name, desc: cat.desc,
      provider: cat.provider, model: cat.model,
      code: cat.code, producesDoc: cat.producesDoc, gate: cat.gate,
      ...(cat.libId ? { libId: cat.libId } : {}),
    }],
  }
}

export const setStageAgent = (d: FlowDraft, key: string, a: { provider: string; model: string }): FlowDraft =>
  ({ ...d, stages: d.stages.map((s) => (s.key === key ? { ...s, ...a } : s)) })

export const toggleGate = (d: FlowDraft, key: string): FlowDraft =>
  ({ ...d, stages: d.stages.map((s) => (s.key === key ? { ...s, gate: !s.gate } : s)) })

/**
 * 能不能按「保存」。★每一条都是主机会拒的,提前在屏幕上说,而不是让人点下去吃一句报错
 * (启动屏就是这么设计的,两屏保持一致)。
 */
export function saveBlocker(d: FlowDraft, otherNames: string[]): string | null {
  const name = d.name.trim()
  if (!name) return '先给这条工作流起个名字'
  if (otherNames.some((n) => n.trim() === name)) return `已经有一条叫「${name}」的工作流了`
  if (d.stages.length === 0) return '至少留一个阶段'
  if (d.stages.some((s) => !s.provider)) return '有阶段还没选代理'
  return null
}

/** 发给主机的形状(`workspace:save-workflow`)。只发主机需要的那几个字段。 */
export function toWorkflowEdit(d: FlowDraft) {
  return {
    id: d.id,
    name: d.name.trim(),
    stages: d.stages.map((s) => ({
      key: s.key,
      provider: s.provider,
      model: s.model,
      gate: s.gate,
      ...(s.libId ? { libId: s.libId } : {}),
    })),
  }
}

/** 改过没有。没改就把保存键置灰 —— 比弹一个「要放弃修改吗」的框轻,而且一眼看得出状态。 */
export const isDirty = (a: FlowDraft, b: FlowDraft): boolean => JSON.stringify(a) !== JSON.stringify(b)
