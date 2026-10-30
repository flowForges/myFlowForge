// 目录合并:预设内置清单 > 运行时缓存 > 入库快照 > 保守默认值(spec §7.3)
import type { CatalogView, ModelEntry } from '../../../protocol/models'
import { toPresetView, type Preset, type PresetModel } from './presets'

export type SnapshotModel = {
  id: string
  name: string
  context: number
  output: number
  reasoning: boolean
  toolCall: boolean
  image: boolean
  cost?: { input: number; output: number }
  status?: string
}
export type Snapshot = { generatedAt: string; models: Record<string, SnapshotModel> }

const DEFAULTS = { context: 128000, output: 8000, image: false, reasoning: 'none', toolCall: true } as const

/** 按模型 id(不含 provider 前缀)建索引,同 id 先出现者优先。 */
function indexById(s: Snapshot | undefined): Map<string, SnapshotModel> {
  const m = new Map<string, SnapshotModel>()
  for (const v of Object.values(s?.models ?? {})) if (!m.has(v.id)) m.set(v.id, v)
  return m
}

function fromSnapshot(s: SnapshotModel): Partial<ModelEntry> {
  const e: Partial<ModelEntry> = {
    name: s.name, context: s.context, output: s.output, image: s.image, toolCall: s.toolCall,
    reasoning: s.reasoning ? 'toggle' : 'none',
  }
  if (s.cost) e.cost = s.cost
  if (s.status === 'deprecated') e.deprecated = true
  return e
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

function resolveModel(pm: PresetModel, cache: Map<string, SnapshotModel>, snap: Map<string, SnapshotModel>): ModelEntry {
  const meta = cache.get(pm.id) ?? snap.get(pm.id)
  return { ...DEFAULTS, ...(meta ? fromSnapshot(meta) : {}), name: pm.id, ...(meta ? { name: meta.name } : {}), ...defined(pm), id: pm.id } as ModelEntry
}

export function mergeCatalog(presets: Preset[], snapshot: Snapshot, cache?: Snapshot): CatalogView {
  const c = indexById(cache)
  const s = indexById(snapshot)
  const models: Record<string, ModelEntry[]> = {}
  for (const p of presets) {
    const entries = p.models === 'list' ? [] : p.models.map((pm) => resolveModel(pm, c, s))
    models[p.id] = [...entries.filter((e) => !e.deprecated), ...entries.filter((e) => e.deprecated)] // deprecated 排后
  }
  return { presets: presets.map(toPresetView), models }
}
