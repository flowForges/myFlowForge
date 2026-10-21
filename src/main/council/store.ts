import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CouncilConfig } from '@shared/council'
import type { PersistedCouncil } from './engine'
import { wsForgeDir } from '../config/paths'
import { writeJsonAtomic } from '../util/atomicWrite'

export type CouncilDefaults = Omit<CouncilConfig, 'topic' | 'attachments'>

// ★和 <id>.json 同目录;loadCouncils 按文件名跳过它(共商 id 是 UUID,不会撞名)
const LAST_CONFIG = 'last-config.json'

/** <ws>/.forge/council:状态文件 <id>.json、结果 Markdown、上次配置都在这里。 */
export function councilDir(ws: string): string {
  return join(wsForgeDir(ws), 'council')
}

/** 原子写 <id>.json:先写 .tmp 再 rename,崩溃在半路也不会留下半个文件。 */
export function saveCouncil(ws: string, p: PersistedCouncil): void {
  const dir = councilDir(ws)
  mkdirSync(dir, { recursive: true })
  writeJsonAtomic(join(dir, `${p.state.id}.json`), p)
}

/** 读出工作区里的全部共商(可按会话过滤),按开始时间排序;坏文件 / 别的 JSON 跳过,不抛。 */
export function loadCouncils(ws: string, sid?: string): PersistedCouncil[] {
  const dir = councilDir(ws)
  if (!existsSync(dir)) return []
  const out: PersistedCouncil[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === LAST_CONFIG) continue
    const p = readJson(join(dir, name))
    if (!isPersistedCouncil(p)) continue
    if (sid === undefined || p.state.sessionId === sid) out.push(p)
  }
  return out.sort((a, b) => a.state.startedAt - b.state.startedAt)
}

/** 记住上次的席位 / 领导者 / 模式 / 材料,下次打开设置面板时当默认值;议题和附件不留。 */
export function saveLastConfig(ws: string, cfg: CouncilDefaults): void {
  const dir = councilDir(ws)
  mkdirSync(dir, { recursive: true })
  // ★调用方可能直接传整份 CouncilConfig:逐个字段挑,不能把 topic / attachments 带进去
  const { seats, leader, mode, materials } = cfg
  writeJsonAtomic(join(dir, LAST_CONFIG), { seats, leader, mode, ...(materials ? { materials } : {}) })
}

export function loadLastConfig(ws: string): CouncilDefaults | null {
  const c = readJson(join(councilDir(ws), LAST_CONFIG)) as Partial<CouncilDefaults> | undefined
  if (!c || !Array.isArray(c.seats) || !c.leader || !c.mode) return null
  return c as CouncilDefaults
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function isPersistedCouncil(v: unknown): v is PersistedCouncil {
  const p = v as Partial<PersistedCouncil> | undefined
  return !!p && typeof p === 'object'
    && !!p.state && typeof p.state.id === 'string' && typeof p.state.sessionId === 'string' && !!p.state.config
    && !!p.transcript && Array.isArray(p.transcript.items)
}
