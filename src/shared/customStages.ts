import type { ReviewConfig } from './types'

// —— 自定义工作流阶段全局库 · resolver(纯 TS,main 与 renderer 都 import)——
// 模版的 stages 项若带 libId,即为对全局库(customStages.json)某条定义的引用。解析时用库定义提供
// name/agent/model/prompt/flags,模版只保留 key(维持顺序与身份)与 libId。库项被删(byId 找不到)时
// 原样返回引用(用其冗余缓存的 key/name),不抛错 —— 向后兼容内置 / 内嵌自定义阶段(无 libId)。
//
// 本文件不得 import 任何 main / renderer 专有模块(zod / electron / react),保持纯类型 + 纯函数。

// 一条阶段引用 / 定义的结构性最小面(CfgStage、StageConfig、CustomStage 均结构可赋值到它)。
export interface StageRef {
  key: string
  libId?: string
  name?: string
  defaultAgent?: string
  defaultModel?: string
  prompt?: string
  review?: ReviewConfig
  scope?: 'root' | 'per-project'
  gate?: boolean
  summary?: boolean
  projectAgent?: boolean
  producesDoc?: boolean
}

// 全局库里一条完整定义:必带 id + name,agent/model 恒有值。
export interface CustomStageDef extends StageRef {
  id: string
  name: string
  defaultAgent: string
  defaultModel: string
}

export type StageDefById = Record<string, CustomStageDef>

// 把库定义数组转成 byId 索引(便利函数)。
export function indexCustomStages(defs: CustomStageDef[]): StageDefById {
  const byId: StageDefById = {}
  for (const d of defs) byId[d.id] = d
  return byId
}

// 解析单个阶段:命中库 → { ...库定义(去 id), key: 模版 key, libId }; 否则(内置 / 内嵌自定义 /
// 库项已删)原样返回。返回类型与输入同型,便于就地替换。
export function resolveStageDef<S extends StageRef>(stage: S, byId: StageDefById): S {
  const lib = stage.libId ? byId[stage.libId] : undefined
  if (!lib) return stage
  const { id: _id, ...libFields } = lib
  return { ...libFields, key: stage.key, libId: stage.libId } as unknown as S
}

// 解析整列阶段(顺序不变)。
export function resolveStages<S extends StageRef>(stages: S[], byId: StageDefById): S[] {
  return stages.map(s => resolveStageDef(s, byId))
}
