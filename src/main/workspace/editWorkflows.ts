// 在手机上改这个工作区的工作流(2026-09-04)。
//
// 用户原话:「手机端支持新增就更好了,但是新增的需要同步到电脑端,否则电脑端没有配置信息,
// 不知道怎么执行呢」。所以改的是**工作区自己那份** `ws.workflows` —— 它就是启动屏列出来、
// 也是真跑起来用的那一份(`buildLaunchInfo` / `resolveStartPlan` 都读它),写完电脑端立刻看得见。
// 改全局模板(设置 → 工作流)不行:那份不会出现在一个已经建好的工作区的列表里。
//
// ★★这里的核心是**合并,不是覆盖**。手机上看得见的只有「阶段名 + 用哪个代理 + 要不要确认」,
//  而一条 WsStage 上还挂着提示词、CR 视角、逐项目代理、权限档。如果照手机发来的三个字段直接
//  写回去,用户在手机上挪一下顺序,就会把电脑端配了半天的提示词/CR 配置**静默清空** ——
//  屏幕上一切正常,下一次跑才炸。所以每个阶段都以「它现在解析出来的样子」为底,只覆盖手机改过的字段。
// ★另一半同样重要:`ws.workflows[].stages` 为空时含义是「回退全局模板」。所以合并的底不是
//  `wf.stages`,而是 `resolveWorkflowStages(...)` —— 手机上看到的是解析后的阶段,存回去的也必须是
//  同一份物化结果,否则「删掉两个阶段」存完会因为回退而原封不动地长回来。
import type { Workspace, WsWorkflow, WsStage, Workflow, CustomStage } from '../config/schema'
import { STAGE_KEYS, STAGE_DESC, DEFAULT_STAGE_PER_PROJECT_AGENT, DEFAULT_STAGE_PRODUCES_DOC, stageName } from '../config/schema'
import { deriveProjectId } from '../config/projectId'
import { indexCustomStages, type StageDefById } from '../../shared/customStages'
import { resolveWorkflowStages } from './resolveStages'

/** 手机端发来的一个阶段:只有它看得见的那几个字段。其余一律沿用现有定义(见文件顶注释)。 */
export interface StageEdit {
  key: string
  provider: string
  model: string
  /** 新加的自定义阶段:引用全局阶段库的哪一条(据此物化 name/prompt/行为开关)。 */
  libId?: string
  /** 这个阶段要不要停下来等人确认。不传 = 不动。 */
  gate?: boolean
}

/** 一条工作流的编辑意图。`id` 为空(或对不上)= 新建。 */
export interface WorkflowEdit {
  id: string
  name: string
  stages: StageEdit[]
}

/** 「加一个阶段」那张单子里的一项。 */
export interface CatalogStage {
  key: string
  name: string
  desc: string
  provider: string
  model: string
  code: boolean
  producesDoc: boolean
  gate: boolean
  /** 有值 = 来自全局自定义阶段库。 */
  libId?: string
}
export interface StageCatalog {
  builtin: CatalogStage[]
  custom: CatalogStage[]
}

/**
 * 手机上能往工作流里加哪些阶段。
 *
 * ★provider/model 一并给出默认值 —— 手机上加完一个阶段如果 provider 是空的,存下去就是一条
 *  跑不起来的阶段,而这在界面上只显示成一个没有副标题的行,看不出来。内置阶段的默认取自
 *  全局模板里第一条配了这个 key 的(用户在电脑端定的那份),取不到才落到 claude。
 */
export function buildStageCatalog(globals: Workflow[], custom: CustomStage[]): StageCatalog {
  const defaultFor = (key: string): { provider: string; model: string } => {
    for (const g of globals) {
      const s = g.stages.find((x) => x.key === key)
      if (s?.defaultAgent) return { provider: s.defaultAgent, model: s.defaultModel }
    }
    return { provider: 'claude', model: '' }
  }
  return {
    builtin: STAGE_KEYS.map((key) => ({
      key,
      name: stageName(key),
      desc: STAGE_DESC[key] ?? '',
      ...defaultFor(key),
      code: DEFAULT_STAGE_PER_PROJECT_AGENT[key] ?? false,
      producesDoc: DEFAULT_STAGE_PRODUCES_DOC[key] ?? false,
      gate: false,
    })),
    custom: custom.map((d) => ({
      libId: d.id,
      key: d.key,
      name: d.name,
      desc: '',
      provider: d.defaultAgent || 'claude',
      model: d.defaultModel || '',
      code: d.projectAgent ?? false,
      producesDoc: d.producesDoc ?? false,
      gate: d.gate ?? false,
    })),
  }
}

// 新阶段的底:引用了阶段库就把库定义物化下来(WsStage 没有 libId 字段,存的是快照 ——
// 和 materializeGlobalStages 走的是同一条路),否则就是一个内置 key 的裸阶段(name/prompt/
// 行为开关全部走内置默认表)。
function seedStage(e: StageEdit, byId: StageDefById): WsStage {
  const lib = e.libId ? byId[e.libId] : undefined
  if (!lib) return { key: e.key, provider: e.provider, model: e.model }
  return {
    key: e.key,
    provider: e.provider || lib.defaultAgent,
    model: e.model || lib.defaultModel,
    ...(lib.name ? { name: lib.name } : {}),
    ...(lib.prompt ? { prompt: lib.prompt } : {}),
    ...(lib.scope ? { scope: lib.scope } : {}),
    ...(lib.gate !== undefined ? { gate: lib.gate } : {}),
    ...(lib.review ? { review: lib.review } : {}),
    ...(lib.summary !== undefined ? { summary: lib.summary } : {}),
    ...(lib.projectAgent !== undefined ? { projectAgent: lib.projectAgent } : {}),
    ...(lib.producesDoc !== undefined ? { producesDoc: lib.producesDoc } : {}),
    ...(lib.permissionMode ? { permissionMode: lib.permissionMode } : {}),
  }
}

/**
 * 新增 / 改一条工作流,返回新的 `ws.workflows`(纯函数,不落盘)。
 *
 * ★**一次只动一条**,不是整份列表覆盖。手机上拿到的列表可能是几分钟前的,整份写回去就会把
 *  这期间电脑端新建的那条**悄悄删掉**。单条 upsert 没有这个风险。删除是另一条明确的路
 *  (`removeWorkflow`)。
 */
export function upsertWorkflow(
  ws: Workspace,
  edit: WorkflowEdit,
  globals: Workflow[],
  custom: CustomStage[],
): WsWorkflow[] {
  const name = edit.name.trim()
  if (!name) throw new Error('工作流得有个名字')
  const prev = edit.id ? ws.workflows.find((w) => w.id === edit.id) ?? null : null
  if (ws.workflows.some((w) => w.id !== prev?.id && w.name.trim() === name)) {
    throw new Error(`已经有一条叫「${name}」的工作流了`)
  }
  // 一条都没有 = 回退全局模板,于是「我明明删光了」下次启动又全长回来。宁可在这儿拒绝。
  if (edit.stages.length === 0) throw new Error('至少留一个阶段')

  const byId = indexCustomStages(custom)
  const base = prev ? resolveWorkflowStages(prev, globals, byId) : []
  const baseByKey = new Map(base.map((s) => [s.key, s]))

  // 同一条工作流里两个同 key 的阶段跑起来会撞 id;和 buildWorkflow 一样按「保留第一条」去重
  // (手机端那张单子已经把用过的 key 置灰了,这里是安全网)。
  const seen = new Set<string>()
  const stages: WsStage[] = []
  for (const e of edit.stages) {
    if (seen.has(e.key)) continue
    seen.add(e.key)
    const seed = baseByKey.get(e.key) ?? seedStage(e, byId)
    stages.push({
      ...seed,
      key: e.key,
      provider: e.provider || seed.provider,
      model: e.model || seed.model,
      ...(e.gate !== undefined ? { gate: e.gate } : {}),
    })
  }

  if (prev) return ws.workflows.map((w) => (w.id === prev.id ? { ...w, name, stages } : w))
  return [...ws.workflows, { id: freshId(name, ws.workflows.map((w) => w.id)), name, stages }]
}

// 和全局模板 buildWorkflow 同一套:名字转 slug,重名加序号。中文名转不出 slug → 'workflow'。
function freshId(name: string, taken: string[]): string {
  const base = deriveProjectId(name) || 'workflow'
  let id = base
  let n = 2
  while (taken.includes(id)) id = `${base}-${n++}`
  return id
}

/**
 * 删一条工作流。★最后一条不让删 —— `ws.workflows` 空了之后
 * `ensureWorkspaceWorkflows` 会拿 legacy 字段兜一条出来,用户看到的是「删了又冒出来一条陌生的」。
 */
export function removeWorkflow(ws: Workspace, workflowId: string): WsWorkflow[] {
  if (!ws.workflows.some((w) => w.id === workflowId)) throw new Error(`未知工作流: ${workflowId}`)
  if (ws.workflows.length <= 1) throw new Error('至少留一条工作流')
  return ws.workflows.filter((w) => w.id !== workflowId)
}
