// 用量探针(spec §10):智谱 / Kimi / MiniMax。响应形状不稳定,一律防御性解析,认不出 → null
import type { Quota } from '../../lib/models/types'

export type ProbeKind = 'zhipu' | 'kimi' | 'minimax'
export interface ProbeResult {
  quota: Quota | null
  /** key 被拒(401/403,或 MiniMax 200 + base_resp 报错):调用方把账号标 error */
  authFailed?: boolean
}
export interface ProbeOpts {
  baseUrl: string
  apiKey: string
  fetch: typeof fetch
  timeoutMs?: number
}

type Window = { label: string; usedPercent: number; resetsAt?: number }
type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const clamp = (p: number) => Math.round(Math.min(100, Math.max(0, p)) * 10) / 10
/** 秒或毫秒时间戳 / ISO 字符串 → 毫秒 */
const time = (v: unknown): number | undefined => {
  const n = num(v)
  if (n !== undefined) return n > 0 ? (n < 1e12 ? n * 1000 : n) : undefined
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}
const win = (label: string, usedPercent: number | undefined, resetsAt: number | undefined): Window | undefined =>
  usedPercent === undefined ? undefined : { label, usedPercent: clamp(usedPercent), ...(resetsAt !== undefined && { resetsAt }) }
const ratio = (used: number | undefined, total: number | undefined) =>
  used !== undefined && total !== undefined && total > 0 ? (used / total) * 100 : undefined
const windows = (ws: (Window | undefined)[]): Quota | null => {
  const list = ws.filter((w): w is Window => !!w)
  return list.length ? { windows: list } : null
}

// 智谱:unit 3 = 小时,5 = 月,6 = 周(未知单位只用类型名)
const ZHIPU_UNIT: Record<number, string> = { 3: 'h', 5: 'mo', 6: 'w' }
function parseZhipu(j: Obj): Quota | null {
  const limits = (obj(j.data)?.limits ?? j.limits) as unknown
  if (!Array.isArray(limits)) return null
  return windows(
    limits.map(raw => {
      const l = obj(raw)
      if (!l) return undefined
      const unit = num(l.unit)
      const n = num(l.number)
      const label = unit !== undefined && n !== undefined && ZHIPU_UNIT[unit] ? `${n}${ZHIPU_UNIT[unit]}` : String(l.type ?? 'limit')
      return win(label, num(l.percentage) ?? ratio(num(l.currentValue), num(l.usage)), time(l.nextResetTime))
    }),
  )
}

const KIMI_UNIT: Record<string, number> = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440 }
function kimiLabel(w: Obj | undefined): string {
  const d = num(w?.duration)
  const m = d !== undefined ? d * (KIMI_UNIT[String(w?.timeUnit)] ?? NaN) : NaN
  if (!Number.isFinite(m) || m <= 0) return 'window'
  return m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`
}
function kimiDetail(label: string, d: Obj | undefined): Window | undefined {
  if (!d) return undefined
  const limit = num(d.limit)
  const used = num(d.used) ?? (limit !== undefined && num(d.remaining) !== undefined ? limit - num(d.remaining)! : undefined)
  return win(label, ratio(used, limit), time(d.resetTime ?? d.reset_at ?? d.resetAt))
}
function parseKimi(j: Obj): Quota | null {
  const limits = Array.isArray(j.limits) ? j.limits : []
  return windows([
    kimiDetail('total', obj(j.usage)),
    ...limits.map(raw => {
      const l = obj(raw)
      return kimiDetail(kimiLabel(obj(l?.window)), obj(l?.detail) ?? l)
    }),
  ])
}

function parseMinimax(j: Obj): Quota | null {
  const list = j.model_remains
  if (!Array.isArray(list)) return null
  return windows(
    list.map(raw => {
      const m = obj(raw)
      if (!m) return undefined
      const label = typeof m.model_name === 'string' && m.model_name ? m.model_name : 'requests'
      return win(label, ratio(num(m.current_interval_usage_count), num(m.current_interval_total_count)), time(m.end_time))
    }),
  )
}

function endpoint(kind: ProbeKind, baseUrl: string): string {
  if (kind === 'kimi') return `${baseUrl.replace(/\/+$/, '')}/usages`
  const origin = new URL(baseUrl).origin
  return kind === 'zhipu' ? `${origin}/api/monitor/usage/quota/limit` : `${origin}/v1/token_plan/remains`
}

export async function probeQuota(kind: ProbeKind, opts: ProbeOpts): Promise<ProbeResult> {
  try {
    const res = await opts.fetch(endpoint(kind, opts.baseUrl), {
      method: 'GET',
      // 智谱要裸 key,其余 Bearer
      headers: { authorization: kind === 'zhipu' ? opts.apiKey : `Bearer ${opts.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    })
    if (res.status === 401 || res.status === 403) return { quota: null, authFailed: true }
    if (!res.ok) return { quota: null }
    const j = obj(JSON.parse(await res.text()))
    if (!j) return { quota: null }
    if (kind === 'minimax') {
      const code = num(obj(j.base_resp)?.status_code)
      if (code !== undefined && code !== 0) return { quota: null, authFailed: true } // 被拒的 key 也是 200
      return { quota: parseMinimax(j) }
    }
    return { quota: kind === 'zhipu' ? parseZhipu(j) : parseKimi(j) }
  } catch {
    return { quota: null } // 网络 / 非 JSON / 坏地址
  }
}
