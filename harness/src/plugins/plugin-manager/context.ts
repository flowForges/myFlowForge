// 第一轮钉视图(09 spec §9.3、M8、M22)。之后每轮循环只读事件,这里再也不会被问到。
// 索引只进事件:历史从事件重建,所以启用、禁用、升级、卸载都动不了已发的字节
import type { Logger } from '../../kernel/log'
import { HARNESS_VERSION } from '../../kernel/version'
import { readPlugin } from '../../lib/plugins/read'
import { walkTree } from '../../lib/plugins/tree'
import { pluginViewOf, type PluginView } from '../../lib/plugins/view'
import type { IndexItem, IndexServer } from '../../lib/plugins/wrap'
import { pluginIndex } from '../../lib/plugins/wrap'
import type { ParsedPlugin } from '../../lib/plugins/types'
import type { PluginsService, SandboxService } from '../../lib/tools/types'
import type { KernelEvent, SessionOrigin } from '../../protocol/index'
import type { InstalledRecord, PluginStore } from './store'

export const INDEX_MAX = 6000

const NONE: PluginView = { skill: false, mcp: false }
const CACHE_MAX = 64

/** files:完整性走过的那份清单。skill read 的 file 必须逐字是其中一个,大小写和 Unicode 折叠的变体、后来放进来的都不算 */
type Parsed = Pick<ParsedPlugin, 'skills' | 'servers' | 'commands'> & { files: ReadonlySet<string> }

/** 记录的代码读成技能和服务。版本目录按内容取名,所以按完整性缓存;读不了就是没有,只记日志 */
export class SkillCatalog {
  private readonly cache = new Map<string, Parsed>()

  constructor(
    private readonly store: Pick<PluginStore, 'list' | 'plainVersionDir'>,
    private readonly opts: { home: string },
    private readonly log: Pick<Logger, 'warn'>,
  ) {}

  of(rec: InstalledRecord): Parsed | undefined {
    const hit = this.cache.get(rec.integrity)
    if (hit) return hit
    const dir = this.store.plainVersionDir(rec)
    const read = dir ? readPlugin(dir, { nameHint: rec.id, reservedIds: new Set(), kernelVersion: HARNESS_VERSION, home: this.opts.home }) : undefined
    const walked = dir && read?.ok ? walkTree(dir) : undefined
    if (!read?.ok || !walked?.ok) {
      this.log.warn('plugin not readable', { id: rec.id })
      return undefined
    }
    const parsed: Parsed = { skills: read.plugin.skills, commands: read.plugin.commands, servers: read.plugin.servers, files: new Set(walked.files.map(f => f.path)) }
    if (this.cache.size >= CACHE_MAX) this.cache.clear()
    this.cache.set(rec.integrity, parsed)
    return parsed
  }

  /** 现在启用的、模型能用的技能 */
  invocable(): IndexItem[] {
    return this.store.list().filter(usable).flatMap(rec =>
      (this.of(rec)?.skills ?? []).filter(s => s.modelInvocable).map(s => ({ plugin: rec.id, skill: s.name, description: s.description })),
    )
  }

  /** 现在启用的、没有 problems 的服务;needs_config 算,配好了就能起 */
  runnable(): IndexServer[] {
    return this.store.list().filter(usable).flatMap(rec =>
      (this.of(rec)?.servers ?? []).filter(s => s.problems.length === 0).map(s => ({ plugin: rec.id, server: s.name })),
    )
  }
}

export const usable = (rec: InstalledRecord) => rec.enabled && rec.state === 'ok'

const MCP_ORIGINS: ReadonlySet<SessionOrigin> = new Set(['app', 'acp'])

export interface ContextDeps {
  store: Pick<PluginStore, 'list'>
  catalog: Pick<SkillCatalog, 'invocable' | 'runnable'>
  sessions: { get(id: string): { origin: SessionOrigin } | undefined }
  sandbox: Pick<SandboxService, 'status'>
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  log: Pick<Logger, 'warn'>
}

const isLaterTurn = (events: KernelEvent[], turnId: string) =>
  events.some(e => e.type === 'turn.started' && (e.payload as { turnId?: unknown } | null)?.turnId !== turnId)

export function createPluginsService(d: ContextDeps): PluginsService {
  return {
    injectFirst({ sessionId, turnId, events }) {
      try {
        const pinned = pluginViewOf(events)
        if (pinned) return pinned
        if (isLaterTurn(events, turnId)) return NONE
        const session = d.sessions.get(sessionId)
        if (!session) return NONE
        const items = d.catalog.invocable()
        const canRunServers = MCP_ORIGINS.has(session.origin) && d.sandbox.status(sessionId).level !== 'none'
        const servers = canRunServers ? d.catalog.runnable() : []
        const skill = items.length > 0
        const mcp = servers.length > 0
        if (!skill && !mcp) return NONE
        const text = pluginIndex(items, INDEX_MAX, session.origin === 'im', servers)
        if (text === '') return NONE
        d.append({ type: 'plugins.injected', sessionId, payload: { turnId, text, skill, mcp } })
        return { skill, mcp }
      } catch (err) {
        d.log.warn('plugin index not injected', { turnId, error: err instanceof Error ? err.name : 'unknown' })
        return NONE
      }
    },
  }
}
