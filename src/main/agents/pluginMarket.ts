import type { CliPlugin, PluginCaps } from '../../shared/cliPlugins'
import { NO_PLUGIN_CAPS } from '../../shared/cliPlugins'

/**
 * 技能 / 插件市场 —— 调各个 CLI 自己的 `plugin` 子命令。
 *
 * ★用户原话:「我们能不能接入技能市场?codex 的 app 里,有技能和插件,它的这些我们能不能支持点击安装?
 *  还有 claude 等,这个我不清楚,你可以探究探究」。探究结果(2026-09-05 在这台机器上实测):
 *    claude plugin  install|i · uninstall|remove · list [--available --json] · marketplace add/list/remove · update
 *    codex  plugin  add       · remove           · list [--available --json] · marketplace
 *  两边形状几乎一样,连 `--json` 回的都是 `{ installed: [...], available: [...] }`。
 *  实测条数:claude 298 个可装、codex 65 个。
 *
 * ★★**动词不一样**:装是 claude `install` / codex `add`,卸是 `uninstall` / `remove`。
 *  所以动词也得**探**出来,不能写死 —— 写死的那一天,另一个 CLI 上点安装就是一句 "unknown command"。
 * ★★`--json` 只写在 `plugin list --help` 里,顶层 `plugin --help` 看不到。
 *  这条坑今天已经在 MCP 那边栽过一次(codex 的列表整个变空),这里从一开始就两处都探。
 */

/** 从 `<bin> plugin --help` 里认子命令。只认行首缩进后的第一个词(理由同 mcpCli.parseMcpHelp)。 */
export function parsePluginHelp(help: string, listHelp = ''): PluginCaps {
  if (!help.trim()) return NO_PLUGIN_CAPS
  const subs = new Set<string>()
  for (const line of help.split('\n')) {
    const m = /^\s{2,}([a-z][a-z-]*)\b/.exec(line)
    if (m) subs.add(m[1])
  }
  const list = subs.has('list')
  // ★动词按**这两个 CLI 实际用的**顺序找,找不到就是 null(界面据此不摆按钮)。
  const installVerb = subs.has('install') ? 'install' : subs.has('add') ? 'add' : null
  const removeVerb = subs.has('uninstall') ? 'uninstall' : subs.has('remove') ? 'remove' : null
  return {
    plugin: list || !!installVerb || subs.has('marketplace'),
    list,
    installVerb,
    removeVerb,
    marketplace: subs.has('marketplace'),
    json: /--json\b/.test(listHelp) || /--json\b/.test(help),
    available: /--available\b/.test(listHelp) || /--available\b/.test(help),
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function toPlugin(o: Record<string, unknown>, installed: boolean): CliPlugin | null {
  const id = str(o.pluginId) || str(o.id)
  const name = str(o.name) || id.split('@')[0]
  if (!id && !name) return null
  return {
    id: id || name,
    name,
    // codex 的 available 里**没有 description** —— 缺就是空串,界面自己少画一行,别编。
    description: str(o.description),
    marketplace: str(o.marketplaceName),
    version: str(o.version),
    installed: typeof o.installed === 'boolean' ? o.installed : installed,
    installs: num(o.installCount),
    enabled: typeof o.enabled === 'boolean' ? o.enabled : undefined,
  }
}

/**
 * 解析 `plugin list --available --json`。
 * 回的是 `{ installed: [...], available: [...] }`,合成一张表 —— 界面要的是「一条条目,装没装」,
 * 而不是两个各自为政的列表(同一个插件会在两边各出现一次)。
 */
export function parsePluginList(json: string): CliPlugin[] {
  let d: unknown
  try { d = JSON.parse(json) } catch { return [] }
  if (!d || typeof d !== 'object') return []
  const o = d as Record<string, unknown>
  const out = new Map<string, CliPlugin>()
  const take = (arr: unknown, installed: boolean) => {
    if (!Array.isArray(arr)) return
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue
      const p = toPlugin(it as Record<string, unknown>, installed)
      if (!p) continue
      const prev = out.get(p.id)
      if (!prev) { out.set(p.id, p); continue }
      // ★★同一个 id 两边都有:**两条都要用上**。claude 的 `installed` 那条只有 id 和版本,
      //  说明和安装量在 `available` 那条里;而 `available` 那条**不带 installed 字段**。
      //  直接后盖前 → 装过的显示成没装;直接跳过后一条 → 没有说明、没有安装量(排序也跟着乱)。
      out.set(p.id, {
        ...prev, ...p,
        description: p.description || prev.description,
        version: p.version || prev.version,
        installs: p.installs ?? prev.installs,
        installed: prev.installed || p.installed,
      })
    }
  }
  take(o.installed, true)
  take(o.available, false)
  return [...out.values()].sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0) || a.name.localeCompare(b.name))
}

export interface PluginDeps {
  binFor: (providerId: string) => Promise<string | null>
  envFor: (providerId: string) => NodeJS.ProcessEnv
  run: (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ stdout: string; code: number }>
}

export class PluginMarket {
  private caps = new Map<string, PluginCaps>()
  constructor(private deps: PluginDeps) {}

  async capsFor(providerId: string): Promise<PluginCaps> {
    const bin = await this.deps.binFor(providerId)
    if (!bin) return NO_PLUGIN_CAPS
    const key = `${providerId} ${bin}`
    const hit = this.caps.get(key)
    if (hit) return hit
    const env = this.deps.envFor(providerId)
    const help = await this.deps.run(bin, ['plugin', '--help'], process.cwd(), env).catch(() => ({ stdout: '', code: 1 }))
    // ★两处都探:`--json` / `--available` 写在子命令自己的 help 里(见文件顶上那段)。
    const listHelp = /^\s{2,}list\b/m.test(help.stdout)
      ? (await this.deps.run(bin, ['plugin', 'list', '--help'], process.cwd(), env).catch(() => ({ stdout: '', code: 1 }))).stdout
      : ''
    const caps = parsePluginHelp(help.stdout, listHelp)
    this.caps.set(key, caps)
    return caps
  }

  /** 这个 CLI 能装的 + 已经装了的。拿不到就是空表(不抛:一个 CLI 出问题不该把整个市场打空)。 */
  async list(providerId: string): Promise<CliPlugin[]> {
    const bin = await this.deps.binFor(providerId)
    if (!bin) return []
    const caps = await this.capsFor(providerId)
    if (!caps.list || !caps.json) return []
    const args = ['plugin', 'list', ...(caps.available ? ['--available'] : []), '--json']
    const r = await this.deps.run(bin, args, process.cwd(), this.deps.envFor(providerId))
    return parsePluginList(cutToJson(r.stdout))
  }

  async install(providerId: string, id: string): Promise<string> {
    return this.act(providerId, 'install', id)
  }

  async uninstall(providerId: string, id: string): Promise<string> {
    return this.act(providerId, 'uninstall', id)
  }

  private async act(providerId: string, what: 'install' | 'uninstall', id: string): Promise<string> {
    const bin = await this.deps.binFor(providerId)
    if (!bin) throw new Error(`没找到 ${providerId} 的可执行文件`)
    const caps = await this.capsFor(providerId)
    const verb = what === 'install' ? caps.installVerb : caps.removeVerb
    if (!verb) throw new Error(`${providerId} 这个版本不支持${what === 'install' ? '安装' : '卸载'}插件`)
    const r = await this.deps.run(bin, ['plugin', verb, id], process.cwd(), this.deps.envFor(providerId))
    if (r.code !== 0) throw new Error(r.stdout.trim() || `${providerId} plugin ${verb} 失败`)
    return r.stdout
  }
}

/**
 * 从输出里截出 JSON 那一段。
 * ★真机上必须有这一步:用户的 shell 给 claude/codex 套了个函数,每次先打几行「🚀 启动…」,
 *  而 `JSON.parse` 见到第一个字符不是 `{` 就直接抛 —— 表现是市场永远空着。
 */
export function cutToJson(s: string): string {
  const i = s.indexOf('{')
  const j = s.indexOf('[')
  const start = i < 0 ? j : j < 0 ? i : Math.min(i, j)
  return start < 0 ? '' : s.slice(start)
}
