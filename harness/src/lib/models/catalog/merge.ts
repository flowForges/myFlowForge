// 目录合并:预设内置清单 > 运行时缓存 > 入库快照 > 保守默认值(spec §7.3)
import type { CatalogView, ModelEntry } from '../../../protocol/models'
import { toPresetView, type Preset, type PresetModel } from './presets'

export type SnapshotModel = {
  id: string
  name: string
  context?: number
  output?: number
  reasoning: boolean
  toolCall: boolean
  image: boolean
  cost?: { input: number; output: number }
  status?: string
}
export type Snapshot = { generatedAt: string; models: Record<string, SnapshotModel> }

const DEFAULTS = { context: 128000, output: 8000, image: false, reasoning: 'none', toolCall: true } as const

type Lookup = (provider: string | undefined, id: string) => SnapshotModel | undefined

/** 先按 provider/modelId 精确查,缺失才退回任意 provider 的同 id 条目(先出现者优先)。 */
function lookup(s: Snapshot | undefined): Lookup {
  const byId = new Map<string, SnapshotModel>()
  for (const v of Object.values(s?.models ?? {})) if (!byId.has(v.id)) byId.set(v.id, v)
  return (provider, id) => (provider ? s?.models[`${provider}/${id}`] : undefined) ?? byId.get(id)
}

function fromSnapshot(s: SnapshotModel): Partial<ModelEntry> {
  const e: Partial<ModelEntry> = { name: s.name, image: s.image, toolCall: s.toolCall, reasoning: s.reasoning ? 'toggle' : 'none' }
  if (s.context) e.context = s.context
  if (s.output) e.output = s.output
  if (s.cost) e.cost = s.cost
  if (s.status === 'deprecated') e.deprecated = true
  return e
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

function resolveModel(pm: PresetModel, provider: string | undefined, cache: Lookup, snap: Lookup): ModelEntry {
  const meta = cache(provider, pm.id) ?? snap(provider, pm.id)
  return { ...DEFAULTS, ...(meta ? fromSnapshot(meta) : {}), name: pm.id, ...(meta ? { name: meta.name } : {}), ...defined(pm), id: pm.id } as ModelEntry
}

export function mergeCatalog(presets: Preset[], snapshot: Snapshot, cache?: Snapshot): CatalogView {
  const c = lookup(cache)
  const s = lookup(snapshot)
  const models: Record<string, ModelEntry[]> = {}
  for (const p of presets) {
    const entries = p.models === 'list' ? [] : p.models.map((pm) => resolveModel(pm, p.snapshotProvider, c, s))
    models[p.id] = [...entries.filter((e) => !e.deprecated), ...entries.filter((e) => e.deprecated)] // deprecated 排后
  }
  return { presets: presets.map(toPresetView), models }
}

/** 适配器列出的模型(只有 id / 名称):按快照 / 缓存补元数据,缺失走保守默认 */
export function resolveListed(list: { id: string; name?: string }[], provider: string | undefined, snapshot: Snapshot, cache?: Snapshot): ModelEntry[] {
  const c = lookup(cache)
  const s = lookup(snapshot)
  return list.map((m) => resolveModel({ id: m.id, ...(m.name !== undefined && { name: m.name }) }, provider, c, s))
}
