// 同意页数据、升级差异、绑定"看到的内容"的哈希,以及只能收窄的授权(09 spec §7、§8.1)。纯函数
import { createHash } from 'node:crypto'
import type { Grants, PluginConsent, PluginDiff, PluginSource } from '../../protocol'
import { scrub } from '../memory/scrub'
import { checkHost, validateNetworkEntry } from '../sandbox/net/domains'
import { isInternalHost } from './hosts'
import { clip, PROTO_NAMES, type ParsedPlugin } from './types'

export type Declared = { network: string[]; cwd: 'none' | 'read' | 'write' }
export type Effective = Grants
export type GrantError = 'grants_exceed_declared' | 'bad_host'

type Warning = PluginConsent['warnings'][number]

// ---------- 显示字符串 ----------

/** 控制符、双向控制符、零宽、行/段分隔符、标签字符:同意页不能被 Unicode 骗 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu

/** 写成可见的 \uXXXX(基本平面之外 \u{XXXXX}) */
export function escapeDisplay(s: string): string {
  return s.replace(UNSAFE, ch => {
    const cp = ch.codePointAt(0)!
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  })
}

/** 自称的文字:控制符整个去掉,换行当空格 */
const stripUnsafe = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(UNSAFE, '')

const LIMIT = { str: 1024, arg: 1024, hook: 4096, desc: 200, ignored: 100, path: 1024 }

// ---------- 规范化 JSON 与哈希 ----------

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(x => canon(x === undefined ? null : x)).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter(k => o[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export const consentHash = (c: PluginConsent): string => createHash('sha256').update(canon(c)).digest('hex')

// ---------- 构造 ----------

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const by = <T,>(key: (x: T) => string) => (a: T, b: T) => cmp(key(a), key(b))
const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort(cmp)

/** 各部分的字节预算:总和加上差异不超过 1 MB(差异的名字表受同一批预算约束) */
const BUDGET = { mcp: 100_000, config: 10_000, hooks: 50_000, notRun: 30_000, skills: 150_000, commands: 60_000 }
const CAP = { skills: 500, commands: 500, mcp: 100, config: 100, env: 100, args: 100, hooks: 200, names: 500, flags: 16, ignored: 20, hosts: 64 }

export function buildConsent(
  p: ParsedPlugin,
  s: { source: PluginSource; integrity: string; files: number; bytes: number; commit?: string },
  previous?: { consent: PluginConsent; textHashes?: Map<string, string> },
): PluginConsent {
  const warnings = new Set<Warning>(p.warnings)
  let cut = false
  const str = (x: string, max: number = LIMIT.str) => {
    if (x.length > max) cut = true
    return escapeDisplay(clip(x, max))
  }
  /** 先按条数,再按字节预算收;砍掉了就记 truncated */
  const fit = <T,>(items: T[], cap: number, budget: number): T[] => {
    const out: T[] = []
    let used = 0
    for (const it of items) {
      used += JSON.stringify(it).length
      if (out.length >= cap || used > budget) {
        cut = true
        break
      }
      out.push(it)
    }
    return out
  }
  /** 映射之前就按条数截,超长输入不做多余的打码和转义 */
  const head = <T,>(items: T[], cap: number): T[] => {
    if (items.length > cap) cut = true
    return items.slice(0, cap)
  }
  const names = (xs: string[]) => fit(head(uniqueSorted(xs.map(x => str(x))), CAP.names), CAP.names, BUDGET.notRun / 8)
  const hook = (h: { event: string; command: string }) => ({ event: str(h.event), command: str(h.command, LIMIT.hook) })

  const source: PluginSource =
    s.source.kind === 'path'
      ? { kind: 'path', path: str(s.source.path, LIMIT.path) }
      : {
          kind: 'git',
          url: str(s.source.url, LIMIT.path),
          ...(s.source.ref !== undefined ? { ref: str(s.source.ref) } : {}),
          commit: str(s.commit ?? s.source.commit),
          ...(s.source.subpath !== undefined ? { subpath: str(s.source.subpath, LIMIT.path) } : {}),
        }

  const claimed: PluginConsent['claimed'] = {
    name: clip(stripUnsafe(p.claimed.name), 100),
    description: clip(stripUnsafe(p.claimed.description), 500),
    ...(p.claimed.author !== undefined ? { author: clip(stripUnsafe(p.claimed.author), 100) } : {}),
    ...(p.claimed.homepage !== undefined ? { homepage: clip(stripUnsafe(p.claimed.homepage), 300) } : {}),
  }

  const mcp = fit(
    head([...p.servers].sort(by(x => x.name)), CAP.mcp).map(sv => ({
      name: str(sv.name),
      command: str(sv.command),
      args: head(sv.args, CAP.args).map(a => str(a, LIMIT.arg)),
      fetchesAtRuntime: sv.fetchesAtRuntime,
      env: fit(
        head([...sv.env].sort(by(e => e.name)), CAP.env).map(e => ({
          name: str(e.name),
          source: e.source,
          required: e.required,
          ...(e.source === 'literal' && e.value !== undefined ? { value: escapeDisplay(scrub(clip(e.value, LIMIT.str)).text) } : {}),
        })),
        CAP.env,
        BUDGET.mcp / 4,
      ),
      declared: sv.declared ? { network: fit(head(sv.declared.network, CAP.hosts).map(h => str(h, 253)), CAP.hosts, BUDGET.mcp / 8), cwd: sv.declared.cwd } : null,
      suggestedHosts: fit(head(sv.suggestedHosts, CAP.hosts).map(h => str(h, 253)), CAP.hosts, BUDGET.mcp / 8),
      problems: [...sv.problems].sort(cmp),
    })),
    CAP.mcp,
    BUDGET.mcp,
  )

  const config = fit(
    head([...p.config].sort(by(c => c.key)), CAP.config).map(c => ({ key: str(c.key), title: str(c.title), sensitive: c.sensitive, required: c.required, type: str(c.type) })),
    CAP.config,
    BUDGET.config,
  )

  const hooks = fit(head([...p.notRun.hooks].sort((a, b) => cmp(a.event, b.event) || cmp(a.command, b.command)), CAP.hooks).map(hook), CAP.hooks, BUDGET.hooks)
  const notRun: PluginConsent['notRun'] = {
    hooks,
    agents: names(p.notRun.agents),
    bin: names(p.notRun.bin),
    monitors: names(p.notRun.monitors),
    workflows: names(p.notRun.workflows),
    lsp: names(p.notRun.lsp),
    other: names(p.notRun.other),
    remoteMcp: fit(
      head([...p.notRun.remoteMcp].sort(by(r => r.name)), CAP.names).map(r => ({ name: str(r.name), type: str(r.type), url: str(r.url, LIMIT.path) })),
      CAP.names,
      BUDGET.notRun,
    ),
    ...(p.notRun.main !== undefined ? { main: str(p.notRun.main, LIMIT.path) } : {}),
    scripts: names(p.notRun.scripts),
  }

  const skills = fit(
    head([...p.skills].sort(by(x => x.name)), CAP.skills).map(x => ({
      name: str(x.name),
      description: str(x.description, LIMIT.desc),
      modelInvocable: x.modelInvocable,
      userInvocable: x.userInvocable,
      files: x.files,
      flags: [...x.flags].sort(cmp).slice(0, CAP.flags),
      ignored: fit(head(x.ignored, CAP.ignored).map(i => str(i, LIMIT.ignored)), CAP.ignored, 4000),
    })),
    CAP.skills,
    BUDGET.skills,
  )
  const commands = fit(
    head([...p.commands].sort(by(x => x.name)), CAP.commands).map(x => ({
      name: str(x.name),
      description: str(x.description, LIMIT.desc),
      flags: [...x.flags].sort(cmp).slice(0, CAP.flags),
      ignored: fit(head(x.ignored, CAP.ignored).map(i => str(i, LIMIT.ignored)), CAP.ignored, 4000),
    })),
    CAP.commands,
    BUDGET.commands,
  )
  if (p.notRun.hooks.some(h => h.command.length > LIMIT.hook)) cut = true

  const consent: PluginConsent = {
    id: p.id,
    version: str(p.version),
    format: p.format,
    claimed,
    source,
    integrity: str(s.integrity),
    files: s.files,
    bytes: s.bytes,
    skills,
    commands,
    mcp,
    config,
    notRun,
    warnings: [],
  }

  if (previous) {
    const to = new Map<string, string>([...p.skills.map(x => [`skill:${x.name}`, x.bodyHash] as const), ...p.commands.map(x => [`command:${x.name}`, x.bodyHash] as const)])
    consent.diff = diffConsent(previous.consent, consent, { from: previous.textHashes ?? new Map(), to })
    if (consent.diff.sourceChanged) warnings.add('source_changed')
  }
  if (cut) warnings.add('truncated')
  consent.warnings = [...warnings].sort(cmp)
  return consent
}

// ---------- 差异 ----------

const sourceKey = (c: PluginConsent) => (c.source.kind === 'path' ? canon(['path', c.source.path]) : canon(['git', c.source.url, c.source.subpath ?? null]))
const setDiff = (from: string[], to: string[]) => {
  const f = new Set(from)
  const t = new Set(to)
  return { added: uniqueSorted(to.filter(x => !f.has(x))), removed: uniqueSorted(from.filter(x => !t.has(x))) }
}

export function diffConsent(from: PluginConsent, to: PluginConsent, textHashes: { from: Map<string, string>; to: Map<string, string> }): PluginDiff {
  const fm = new Map(from.mcp.map(m => [m.name, m]))
  const tm = new Map(to.mcp.map(m => [m.name, m]))
  const mcpNames = setDiff([...fm.keys()], [...tm.keys()])
  const changed: PluginDiff['mcp']['changed'] = []
  for (const name of [...tm.keys()].sort(cmp)) {
    const a = fm.get(name)
    const b = tm.get(name)!
    if (!a) continue
    const fields: ('command' | 'args' | 'env' | 'declared')[] = []
    if (a.command !== b.command) fields.push('command')
    if (canon(a.args) !== canon(b.args)) fields.push('args')
    if (canon(a.env) !== canon(b.env)) fields.push('env')
    if (canon(a.declared) !== canon(b.declared)) fields.push('declared')
    if (fields.length) changed.push({ name, fields })
  }

  /** 两边都有的名字里,正文哈希不同的;任何一边没有哈希就算变了,不算没变 */
  const textChanged = (kind: 'skill' | 'command', a: { name: string }[], b: { name: string }[]) => {
    const inFrom = new Set(a.map(x => x.name))
    return uniqueSorted(
      b.map(x => x.name).filter(n => {
        if (!inFrom.has(n)) return false
        const h0 = textHashes.from.get(`${kind}:${n}`)
        const h1 = textHashes.to.get(`${kind}:${n}`)
        return h0 === undefined || h1 === undefined || h0 !== h1
      }),
    )
  }
  const skills = { ...setDiff(from.skills.map(x => x.name), to.skills.map(x => x.name)), textChanged: textChanged('skill', from.skills, to.skills) }
  const commands = { ...setDiff(from.commands.map(x => x.name), to.commands.map(x => x.name)), textChanged: textChanged('command', from.commands, to.commands) }

  const hosts = (c: PluginConsent) => c.mcp.flatMap(m => m.declared?.network ?? [])
  const hk = (h: { event: string; command: string }) => canon([h.event, h.command])
  const fh = new Set(from.notRun.hooks.map(hk))
  const th = new Set(to.notRun.hooks.map(hk))

  return {
    fromVersion: from.version,
    toVersion: to.version,
    sourceChanged: sourceKey(from) !== sourceKey(to),
    mcp: { added: mcpNames.added, removed: mcpNames.removed, changed },
    skills,
    commands,
    network: setDiff(hosts(from), hosts(to)),
    notRun: { hooksAdded: to.notRun.hooks.filter(h => !fh.has(hk(h))), hooksRemoved: from.notRun.hooks.filter(h => !th.has(hk(h))) },
    files: { added: Math.max(0, to.files - from.files), removed: Math.max(0, from.files - to.files), changed: skills.textChanged.length + commands.textChanged.length },
  }
}

// ---------- 授权:只能收窄 ----------

const RANK = { none: 0, read: 1, write: 2 } as const
type Cwd = keyof typeof RANK
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const minCwd = (a: Cwd, b: Cwd): Cwd => (RANK[a] <= RANK[b] ? a : b)
const DEFAULT_CWD: Cwd = 'read'

interface Entry {
  host: string
  wild: boolean
  port: 'web' | 'any' | number
}

/** `[*.]主机[:端口|:*]`。形状不对、`*`、字面 IP、内网名都是 undefined */
function parseGrantHost(e: unknown): Entry | undefined {
  if (typeof e !== 'string' || e === '') return undefined
  const wild = e.startsWith('*.')
  let rest = wild ? e.slice(2) : e
  let port: Entry['port'] = 'web'
  const i = rest.lastIndexOf(':')
  if (i >= 0) {
    const pp = rest.slice(i + 1)
    rest = rest.slice(0, i)
    if (pp === '*') port = 'any'
    else if (/^[1-9][0-9]{0,4}$/.test(pp) && Number(pp) <= 65535) port = Number(pp)
    else return undefined
  }
  if (rest.includes(':') || isInternalHost(rest) || !validateNetworkEntry(e)) return undefined
  return { host: rest, wild, port }
}

/** 声明的条目覆盖这一条:用 05 的匹配,通配和端口用探针主机和端口逐个试 */
function covers(declared: string[], g: Entry): boolean {
  const host = g.wild ? `zz-probe.${g.host}` : g.host
  const ports = g.port === 'web' ? [80, 443] : g.port === 'any' ? [1, 22, 80, 443, 8080, 65535] : [g.port]
  return ports.every(port => checkHost(declared, host, port).allowed)
}

const safeNames = (o: object) => Object.keys(o).filter(k => !PROTO_NAMES.has(k))
const dedupe = (xs: string[]) => [...new Set(xs)]

export function effectiveGrants(
  declared: Record<string, Declared | null>,
  grants: Grants,
): { ok: true; grants: Effective } | { ok: false; error: GrantError } {
  const given: Record<string, Grants['servers'][string]> = grants.servers
  for (const name of Object.keys(given)) if (PROTO_NAMES.has(name) || !own(declared, name)) return { ok: false, error: 'grants_exceed_declared' }
  const servers: Effective['servers'] = {}
  for (const name of safeNames(declared)) {
    const d = declared[name] ?? null
    const g = own(given, name) ? given[name] : undefined
    const cap: Cwd = d ? minCwd(DEFAULT_CWD, d.cwd) : DEFAULT_CWD
    if (!g) {
      servers[name] = { network: [], cwd: cap }
      continue
    }
    const entries = g.network.map(h => [h, parseGrantHost(h)] as const)
    if (entries.some(([, e]) => !e)) return { ok: false, error: 'bad_host' }
    if (d && entries.some(([, e]) => !covers(d.network, e!))) return { ok: false, error: 'grants_exceed_declared' }
    if (!own(RANK, g.cwd) || (d && RANK[g.cwd] > RANK[d.cwd])) return { ok: false, error: 'grants_exceed_declared' }
    servers[name] = { network: dedupe(g.network), cwd: g.cwd }
  }
  return { ok: true, grants: { servers } }
}

/** 升级后的授权 = 旧授权 ∩ 新声明:声明里没了的域名去掉,cwd 不超过新声明;新服务从默认开始 */
export function intersectOnUpgrade(old: Effective, declared: Record<string, Declared | null>): Effective {
  const servers: Effective['servers'] = {}
  for (const name of safeNames(declared)) {
    const d = declared[name] ?? null
    const o = own(old.servers, name) ? old.servers[name] : undefined
    const cap: Cwd = d ? minCwd(DEFAULT_CWD, d.cwd) : DEFAULT_CWD
    if (!o) {
      servers[name] = { network: [], cwd: cap }
      continue
    }
    servers[name] = d
      ? { network: dedupe(o.network.filter(h => { const e = parseGrantHost(h); return !!e && covers(d.network, e) })), cwd: minCwd(o.cwd, d.cwd) }
      : { network: dedupe(o.network), cwd: o.cwd }
  }
  return { servers }
}
