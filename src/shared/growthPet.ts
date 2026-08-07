// 成长宠物包契约（见 docs/superpowers/specs/2026-08-07-growth-pet-design.md）。
// 纯:无 DOM、无 IO —— main 与 renderer 共用,单测直接跑。
//
// 一个包 = 一个文件夹:pet.json + 每阶段一张 sprite atlas(行=动作,列=帧)。
// 不含任何可执行代码 —— 安装一个包不会让任何第三方代码在本机跑起来。

export const GROWTH_ACTIONS = ['idle', 'working', 'alert'] as const
export type GrowthAction = typeof GROWTH_ACTIONS[number]

/** 一个动作占 atlas 的哪一行,以及该行逐帧的显示时长(ms)。数组长度 = 该行帧数。 */
export interface GrowthActionCfg { row: number; durations: number[] }

/** 一个成长阶段。`at` 是 0~1 的归一化进度门槛,`sheet` 是该阶段的 atlas 文件。 */
export interface GrowthStage { at: number; name?: string; sheet: string }

export interface GrowthPack {
  atlas: { cols: number; cellW: number; cellH: number }
  // 部分:作者只画 idle 一行也合法,缺的动作由 resolveGrowthAction 回落到 idle。
  actions: Partial<Record<GrowthAction, GrowthActionCfg>>
  stages: GrowthStage[]
}

export interface GrowthManifest extends GrowthPack { id: string; name: string }

// 作者省略整块 actions 时用这套 —— 直接沿用 codex v2 的手调时长(见 petAtlas.ts FRAME_DURATIONS),
// 那套节奏是实测顺眼的,拿来当默认比让作者从零猜更靠谱。
export const DEFAULT_GROWTH_ACTIONS: Record<GrowthAction, GrowthActionCfg> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  working: { row: 1, durations: [120, 120, 120, 120, 120, 220] },
  alert: { row: 2, durations: [150, 150, 150, 150, 150, 280] },
}

/** 便宜的分派判断:没有 kind:"growth" 的包走原来的普通宠物路径,老包完全不受影响。 */
export function isGrowthManifestRaw(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'growth'
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

// 字符串级越界防护。main 侧装包时还会再用 path.relative 复查一次(纵深防御,与 pluginManifest.ts 同款),
// 但这里先挡掉,好让校验能在纯环境里单测。
function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.length) return false
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false
  return !p.split(/[\\/]/).includes('..')
}

function parseActions(
  raw: unknown,
  cols: number,
): { ok: true; actions: Partial<Record<GrowthAction, GrowthActionCfg>> } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, actions: { ...DEFAULT_GROWTH_ACTIONS } }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'actions 不是对象' }
  const src = raw as Record<string, unknown>
  const out: Partial<Record<GrowthAction, GrowthActionCfg>> = {}
  const rows = new Set<number>()
  for (const action of GROWTH_ACTIONS) {
    const cfg = src[action]
    if (cfg === undefined) continue
    if (typeof cfg !== 'object' || cfg === null) return { ok: false, error: `actions.${action} 不是对象` }
    const { row, durations } = cfg as { row?: unknown; durations?: unknown }
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 0) return { ok: false, error: `actions.${action}.row 必须是非负整数` }
    if (rows.has(row)) return { ok: false, error: `actions.${action}.row 与其它动作重复` }
    rows.add(row)
    if (!Array.isArray(durations) || !durations.length) return { ok: false, error: `actions.${action}.durations 不能为空` }
    if (durations.length > cols) return { ok: false, error: `actions.${action}.durations 帧数(${durations.length})超过 atlas.cols(${cols})` }
    if (!durations.every((d) => typeof d === 'number' && d > 0)) return { ok: false, error: `actions.${action}.durations 必须都是正数` }
    out[action] = { row, durations: [...durations] }
  }
  // idle 是所有回落的终点,缺了就没有任何画面可退。
  if (!out.idle) return { ok: false, error: 'actions 至少要有 idle' }
  return { ok: true, actions: out }
}

function parseStages(raw: unknown): { ok: true; stages: GrowthStage[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'stages 不能为空' }
  const out: GrowthStage[] = []
  let prev = -1
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as { at?: unknown; name?: unknown; sheet?: unknown }
    if (typeof s !== 'object' || s === null) return { ok: false, error: `stages[${i}] 不是对象` }
    if (typeof s.at !== 'number' || !(s.at >= 0 && s.at <= 1)) return { ok: false, error: `stages[${i}].at 必须在 0~1 之间` }
    // 首条必须是 0:否则进度低于首档时无图可用。
    if (i === 0 && s.at !== 0) return { ok: false, error: 'stages[0].at 必须是 0' }
    if (s.at <= prev) return { ok: false, error: `stages[${i}].at 必须严格大于前一条` }
    prev = s.at
    if (!isSafeRelPath(s.sheet)) return { ok: false, error: `stages[${i}].sheet 非法或越出包目录` }
    out.push(typeof s.name === 'string' && s.name
      ? { at: s.at, name: s.name, sheet: s.sheet }
      : { at: s.at, sheet: s.sheet })
  }
  return { ok: true, stages: out }
}

/** 校验一份解析好的 pet.json。调用方负责读文件。 */
export function parseGrowthManifest(
  raw: unknown,
): { ok: true; manifest: GrowthManifest } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'pet.json 不是对象' }
  const o = raw as Record<string, unknown>
  if (o.kind !== 'growth') return { ok: false, error: 'pet.json 不是成长宠物包(缺少 kind: "growth")' }
  // v1 只有 token 这一个变量。字段现在就留出来,以后接天气等信号零迁移。
  if (o.signal !== 'dailyTokens') return { ok: false, error: `暂不支持的 signal: ${String(o.signal)}(当前只支持 "dailyTokens")` }
  const id = typeof o.id === 'string' ? o.id : ''
  const name = typeof o.name === 'string' ? o.name : ''
  if (!id) return { ok: false, error: 'pet.json 缺少 id' }
  if (!name) return { ok: false, error: 'pet.json 缺少 name' }

  const atlas = o.atlas as { cols?: unknown; cellW?: unknown; cellH?: unknown } | undefined
  if (typeof atlas !== 'object' || atlas === null) return { ok: false, error: 'pet.json 缺少 atlas' }
  if (!isPosInt(atlas.cols) || !isPosInt(atlas.cellW) || !isPosInt(atlas.cellH)) {
    return { ok: false, error: 'atlas 的 cols/cellW/cellH 必须是正整数' }
  }

  const actions = parseActions(o.actions, atlas.cols)
  if (!actions.ok) return actions
  const stages = parseStages(o.stages)
  if (!stages.ok) return stages

  return {
    ok: true,
    manifest: {
      id, name,
      atlas: { cols: atlas.cols, cellW: atlas.cellW, cellH: atlas.cellH },
      actions: actions.actions,
      stages: stages.stages,
    },
  }
}
