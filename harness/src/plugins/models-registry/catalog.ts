// 运行时目录保鲜(spec §7.3):每 24 小时拉 models.dev api.json(ETag),缓存到 cache/models.json;失败沿用快照
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '../../kernel/log'
import type { Snapshot, SnapshotModel } from '../../lib/models/catalog/merge'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const REFRESH_MS = 24 * 3600_000
const FIRST_DELAY_MS = 10_000 // 启动后稍等再拉,不抢启动

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}
type CacheFile = { etag?: string; fetchedAt: number; snapshot: Snapshot }

type Obj = Record<string, any>

/** api.json → 精简快照(与 scripts/gen-model-snapshot.mjs 同规则),只保留给定 provider */
export function toSnapshot(api: unknown, providers: Set<string>, generatedAt: string): Snapshot {
  const models: Record<string, SnapshotModel> = {}
  if (!api || typeof api !== 'object') return { generatedAt, models }
  for (const provider of Object.values(api as Obj)) {
    if (!provider || typeof provider !== 'object' || !providers.has(provider.id)) continue
    for (const m of Object.values((provider.models ?? {}) as Obj)) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.modalities?.output?.includes?.('text')) continue
      const e: SnapshotModel = {
        id: m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
        reasoning: !!m.reasoning,
        toolCall: !!m.tool_call,
        image: !!m.modalities?.input?.includes?.('image'),
      }
      if (typeof m.limit?.context === 'number' && m.limit.context > 0) e.context = m.limit.context
      if (typeof m.limit?.output === 'number' && m.limit.output > 0) e.output = m.limit.output
      if (typeof m.cost?.input === 'number' && typeof m.cost?.output === 'number') e.cost = { input: m.cost.input, output: m.cost.output }
      if (typeof m.status === 'string') e.status = m.status
      models[`${provider.id}/${m.id}`] = e
    }
  }
  return { generatedAt, models }
}

export interface RefresherOpts {
  file: string
  providers: Set<string>
  fetch: typeof fetch
  timers: Timers
  now: () => number
  log: Logger
  onUpdate: (s: Snapshot) => void
}

export function startCatalogRefresh(o: RefresherOpts): { cache: Snapshot | undefined; stop(): void } {
  let cache = readCache(o.file)
  let timer: unknown
  let stopped = false

  const schedule = (ms: number) => {
    if (stopped) return
    timer = o.timers.setTimeout(() => void refresh(), ms)
    ;(timer as { unref?: () => void } | undefined)?.unref?.()
  }

  async function refresh(): Promise<void> {
    try {
      const res = await o.fetch(MODELS_DEV_URL, {
        headers: cache?.etag ? { 'if-none-match': cache.etag } : {},
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 304 && cache) {
        cache = { ...cache, fetchedAt: o.now() }
        writeCache(o.file, cache)
      } else if (res.ok) {
        const snapshot = toSnapshot(JSON.parse(await res.text()), o.providers, new Date(o.now()).toISOString())
        cache = { ...(res.headers.get('etag') ? { etag: res.headers.get('etag')! } : {}), fetchedAt: o.now(), snapshot }
        writeCache(o.file, cache)
        o.onUpdate(snapshot)
      } else {
        o.log.warn('catalog refresh failed', { failure: `http ${res.status}` })
      }
    } catch (err) {
      // 只记类别,不记响应内容
      o.log.warn('catalog refresh failed', { failure: err instanceof Error ? err.name : 'error' })
    } finally {
      schedule(REFRESH_MS)
    }
  }

  const age = cache ? o.now() - cache.fetchedAt : Infinity
  schedule(Math.max(FIRST_DELAY_MS, REFRESH_MS - age))
  return {
    cache: cache?.snapshot,
    stop() {
      stopped = true
      if (timer !== undefined) o.timers.clearTimeout(timer)
    },
  }
}

function readCache(file: string): CacheFile | undefined {
  if (!existsSync(file)) return undefined
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as CacheFile
    return typeof j?.fetchedAt === 'number' && j.snapshot && typeof j.snapshot.models === 'object' ? j : undefined
  } catch {
    return undefined
  }
}

function writeCache(file: string, c: CacheFile): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(c))
  renameSync(tmp, file)
}
