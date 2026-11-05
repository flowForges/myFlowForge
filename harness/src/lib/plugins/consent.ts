// 同意页数据、升级差异、绑定"看到的内容"的哈希,以及只能收窄的授权(09 spec §7、§8.1)。纯函数
//
// 原则:有执行效果的内容(服务的命令、参数、环境变量、声明的域名、hook、不跑的可执行项)一个字也不剪、不丢;
// 放不下就整个拒绝(consent_too_large)。只有描述性文字(技能和命令列表、自称、配置标题)可以截,截了写进 truncatedSections,
// 那个列表在哈希里。显示用的字符串先转义再打码:显示的和运行的可能不同,args 和 hook 被打码时留标记
import { createHash } from 'node:crypto'
import type { Grants, PluginConsent, PluginConsentError, PluginDiff, PluginSource } from '../../protocol'
import { scrub } from '../memory/scrub'
import { normalizeHost, validateNetworkEntry } from '../sandbox/net/domains'
import { isInternalHost } from './hosts'
import { clip, PROTO_NAMES, type ParsedPlugin } from './types'

export type Declared = { network: string[]; cwd: 'none' | 'read' | 'write' }
export type Effective = Grants
export type GrantError = 'grants_exceed_declared' | 'bad_host'
export type BuildResult = { ok: true; consent: PluginConsent } | { ok: false; error: PluginConsentError }

type Warning = PluginConsent['warnings'][number]
type Hook = PluginConsent['notRun']['hooks'][number]

// ---------- 显示字符串 ----------

/** 控制符、格式符、孤立代理、私用区、默认忽略的码点(填充字符都在里面)、行/段分隔符、非 ASCII 空格、盲文空白 */
const UNSAFE_SRC = String.raw`\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u2800\u3164\u115f\u1160\uffa0\u{1bca0}-\u{1bca3}\u{e0000}-\u{e0fff}`
const ESCAPE_RE = new RegExp(String.raw`[\\${UNSAFE_SRC}]`, 'gu')
const STRIP_RE = new RegExp(`[${UNSAFE_SRC}]`, 'gu')

/** 写成可见的 \uXXXX(基本平面之外 \u{XXXXX});反斜杠自己翻倍,真字符和字面的 `‮` 不会显示成一样 */
export function escapeDisplay(s: string): string {
  return s.replace(ESCAPE_RE, ch => {
    if (ch === '\\') return '\\\\'
    const cp = ch.codePointAt(0)!
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  })
}

/** 自称的文字:不可见字符整个去掉,换行当空格 */
const stripUnsafe = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(STRIP_RE, '')

const utf8 = (x: unknown) => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x))

/** 转义,再打码。打码在转义之后:scrub 自带的清理会把双向控制符删掉,删之前它们必须已经可见 */
function shown(raw: string): { text: string; masked: boolean } {
  const r = scrub(escapeDisplay(raw))
  return { text: r.text, masked: r.masked > 0 }
}

/** 环境变量的值:连名字一起打码(`MY_PASSWORD=x`),再单独打一遍 */
function shownEnvValue(name: string, raw: string): string {
  const n = escapeDisplay(name)
  const joined = scrub(`${n}=${escapeDisplay(raw)}`).text
  const v = joined.startsWith(`${n}=`) ? joined.slice(n.length + 1) : escapeDisplay(raw)
  return scrub(v).text
}

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

/** 有执行效果的部分的上限(UTF-8 字节),超了整个拒绝 */
const EFFECT_BUDGET = 512 * 1024
/** 同意页加差异的总上限(字节) */
const TOTAL_LIMIT = 1_000_000
/** 描述性部分的预算(字节),放不下总上限时按比例缩 */
const DESC = { skills: 150_000, commands: 60_000, config: 10_000, lists: 30_000 }
const SCALES = [1, 0.5, 0.25, 0.1, 0]
const CAP = { skills: 500, commands: 500, config: 100, names: 500, flags: 16, ignored: 20 }
const LIMIT = { desc: 200, ignored: 100, source: 1024 }

export function buildConsent(
  p: ParsedPlugin,
  s: { source: PluginSource; integrity: string; files: number; bytes: number; commit?: string },
  previous?: { consent: PluginConsent; textHashes?: Map<string, string> },
): BuildResult {
  const tooLarge = { ok: false, error: 'consent_too_large' } as const

  // 有执行效果的输入先量一遍原始大小:超了就不做打码这类线性但不小的活
  const rawEffect =
    p.servers.reduce((n, sv) => n + utf8(sv.name) + utf8(sv.command) + sv.args.reduce((m, a) => m + utf8(a), 0) + sv.env.reduce((m, e) => m + utf8(e.name) + utf8(e.value ?? ''), 0) + sv.declared?.network.reduce((m, h) => m + utf8(h), 0)!, 0) +
    p.notRun.hooks.reduce((n, h) => n + utf8(h.event) + utf8(h.command), 0) +
    [p.notRun.bin, p.notRun.scripts, p.notRun.monitors, p.notRun.workflows, p.notRun.other].reduce((n, l) => n + l.reduce((m, x) => m + utf8(x), 0), 0) +
    p.notRun.remoteMcp.reduce((n, r) => n + utf8(r.name) + utf8(r.url), 0) +
    utf8(p.notRun.main ?? '')
  if (rawEffect > EFFECT_BUDGET) return tooLarge

  const esc = escapeDisplay
  const names = (xs: string[]) => uniqueSorted(xs.map(esc))

  // ----- 有执行效果的部分:不剪、不丢 -----
  const mcp: PluginConsent['mcp'] = [...p.servers].sort(by(x => x.name)).map(sv => {
    const args = sv.args.map(a => shown(a))
    return {
      name: esc(sv.name),
      command: shown(sv.command).text,
      args: args.map(a => a.text),
      argsMasked: args.flatMap((a, i) => (a.masked ? [i] : [])),
      fetchesAtRuntime: sv.fetchesAtRuntime,
      env: [...sv.env].sort(by(e => e.name)).map(e => ({
        name: esc(e.name),
        source: e.source,
        required: e.required,
        ...(e.source === 'literal' && e.value !== undefined ? { value: shownEnvValue(e.name, e.value) } : {}),
      })),
      declared: sv.declared ? { network: sv.declared.network.map(esc), cwd: sv.declared.cwd } : null,
      suggestedHosts: sv.suggestedHosts.map(esc),
      problems: [...sv.problems].sort(cmp),
    }
  })
  const hooks: Hook[] = [...p.notRun.hooks].sort((a, b) => cmp(a.event, b.event) || cmp(a.command, b.command)).map(h => {
    const c = shown(h.command)
    return { event: esc(h.event), command: c.text, ...(c.masked ? { masked: true } : {}) }
  })
  const source: PluginSource =
    s.source.kind === 'path'
      ? { kind: 'path', path: shown(clip(s.source.path, LIMIT.source)).text }
      : {
          kind: 'git',
          url: shown(clip(s.source.url, LIMIT.source)).text,
          ...(s.source.ref !== undefined ? { ref: esc(clip(s.source.ref, 256)) } : {}),
          commit: esc(clip(s.commit ?? s.source.commit, 128)),
          ...(s.source.subpath !== undefined ? { subpath: esc(clip(s.source.subpath, LIMIT.source)) } : {}),
        }
  const exec = {
    hooks,
    bin: names(p.notRun.bin),
    monitors: names(p.notRun.monitors),
    workflows: names(p.notRun.workflows),
    other: names(p.notRun.other),
    scripts: names(p.notRun.scripts),
    remoteMcp: [...p.notRun.remoteMcp].sort(by(r => r.name)).map(r => ({ name: esc(r.name), type: esc(r.type), url: shown(r.url).text })),
    ...(p.notRun.main !== undefined ? { main: esc(p.notRun.main) } : {}),
  }
  if (utf8({ mcp, source, exec }) > EFFECT_BUDGET) return tooLarge

  // ----- 描述性部分:可以截,截了要记下来 -----
  const warnings = new Set<Warning>(p.warnings)
  const to = new Map<string, string>([...p.skills.map(x => [`skill:${x.name}`, x.bodyHash] as const), ...p.commands.map(x => [`command:${x.name}`, x.bodyHash] as const)])

  for (const scale of SCALES) {
    const cut = new Map<string, number>()
    const note = (section: string, n: number) => {
      if (n > 0) cut.set(section, (cut.get(section) ?? 0) + n)
    }
    /** 描述文字:剪、转义、打码 */
    const text = (raw: string, max: number, section: string) => {
      note(section, Math.max(0, raw.length - max))
      return shown(clip(raw, max)).text
    }
    /** 先按条数,再按字节预算收;没收进来的计数 */
    const fit = <T,>(items: T[], cap: number, budget: number, section: string): T[] => {
      const out: T[] = []
      let used = 0
      for (const it of items) {
        used += utf8(it)
        if (out.length >= cap || used > budget) break
        out.push(it)
      }
      note(section, items.length - out.length)
      return out
    }
    const claimed: PluginConsent['claimed'] = {
      name: text(stripUnsafe(p.claimed.name), 100, 'claimed'),
      description: text(stripUnsafe(p.claimed.description), 500, 'claimed'),
      ...(p.claimed.author !== undefined ? { author: text(stripUnsafe(p.claimed.author), 100, 'claimed') } : {}),
      ...(p.claimed.homepage !== undefined ? { homepage: text(stripUnsafe(p.claimed.homepage), 300, 'claimed') } : {}),
    }
    const skills = fit(
      [...p.skills].sort(by(x => x.name)).slice(0, CAP.skills + 1).map(x => ({
        name: esc(x.name),
        description: text(x.description, LIMIT.desc, 'descriptions'),
        modelInvocable: x.modelInvocable,
        userInvocable: x.userInvocable,
        files: x.files,
        flags: [...x.flags].sort(cmp).slice(0, CAP.flags),
        ignored: x.ignored.slice(0, CAP.ignored).map(i => text(i, LIMIT.ignored, 'ignored')),
      })),
      CAP.skills,
      DESC.skills * scale,
      'skills',
    )
    note('skills', Math.max(0, p.skills.length - CAP.skills - 1))
    const commands = fit(
      [...p.commands].sort(by(x => x.name)).slice(0, CAP.commands + 1).map(x => ({
        name: esc(x.name),
        description: text(x.description, LIMIT.desc, 'descriptions'),
        flags: [...x.flags].sort(cmp).slice(0, CAP.flags),
        ignored: x.ignored.slice(0, CAP.ignored).map(i => text(i, LIMIT.ignored, 'ignored')),
      })),
      CAP.commands,
      DESC.commands * scale,
      'commands',
    )
    note('commands', Math.max(0, p.commands.length - CAP.commands - 1))
    const config = fit(
      [...p.config].sort(by(c => c.key)).slice(0, CAP.config + 1).map(c => ({ key: esc(c.key), title: text(c.title, 100, 'descriptions'), sensitive: c.sensitive, required: c.required, type: esc(clip(c.type, 40)) })),
      CAP.config,
      DESC.config * scale,
      'config',
    )
    note('config', Math.max(0, p.config.length - CAP.config - 1))
    const list = (xs: string[], section: string) => fit(names(xs.slice(0, CAP.names + 1)), CAP.names, DESC.lists * scale, section)
    const agents = list(p.notRun.agents, 'agents')
    const lsp = list(p.notRun.lsp, 'lsp')
    note('agents', Math.max(0, p.notRun.agents.length - CAP.names - 1))
    note('lsp', Math.max(0, p.notRun.lsp.length - CAP.names - 1))

    const consent: PluginConsent = {
      id: p.id,
      version: esc(clip(p.version, 128)),
      format: p.format,
      claimed,
      source,
      integrity: esc(clip(s.integrity, 256)),
      files: s.files,
      bytes: s.bytes,
      skills,
      commands,
      mcp,
      config,
      notRun: { ...exec, agents, lsp },
      warnings: [],
      truncatedSections: [],
    }
    if (previous) {
      consent.diff = diffConsent(previous.consent, consent, { from: previous.textHashes ?? new Map(), to })
      if (consent.diff.sourceChanged) warnings.add('source_changed')
    }
    consent.warnings = [...warnings].sort(cmp)
    consent.truncatedSections = [...cut].sort((a, b) => cmp(a[0], b[0])).map(([section, omitted]) => ({ section, omitted }))
    if (utf8(consent) < TOTAL_LIMIT) return { ok: true, consent }
  }
  return tooLarge
}

// ---------- 差异 ----------

const sourceKey = (c: PluginConsent) => (c.source.kind === 'path' ? canon(['path', c.source.path]) : canon(['git', c.source.url, c.source.subpath ?? null]))
const setDiff = (from: string[], to: string[]) => {
  const f = new Set(from)
  const t = new Set(to)
  return { added: uniqueSorted(to.filter(x => !f.has(x))), removed: uniqueSorted(from.filter(x => !t.has(x))) }
}

/** 不跑的项,`<类别>:<名字>`:新出现的要在升级时看见 */
function notRunKeys(c: PluginConsent): string[] {
  const n = c.notRun
  const out: string[] = []
  for (const k of ['agents', 'bin', 'lsp', 'monitors', 'other', 'scripts', 'workflows'] as const) for (const x of n[k]) out.push(`${k}:${x}`)
  for (const r of n.remoteMcp) out.push(`remoteMcp:${r.name}`)
  if (n.main !== undefined) out.push(`main:${n.main}`)
  return out
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
  const hk = (h: Hook) => canon([h.event, h.command])
  const fh = new Set(from.notRun.hooks.map(hk))
  const th = new Set(to.notRun.hooks.map(hk))
  const fromKeys = new Set(from.config.map(c => c.key))
  const newConfig = to.config.filter(c => !fromKeys.has(c.key))
  const had = new Set(notRunKeys(from))

  return {
    fromVersion: from.version,
    toVersion: to.version,
    sourceChanged: sourceKey(from) !== sourceKey(to),
    mcp: { added: mcpNames.added, removed: mcpNames.removed, changed },
    skills,
    commands,
    network: setDiff(hosts(from), hosts(to)),
    config: { added: uniqueSorted(newConfig.map(c => c.key)), requiredSensitive: uniqueSorted(newConfig.filter(c => c.sensitive && c.required).map(c => c.key)) },
    notRun: {
      hooksAdded: to.notRun.hooks.filter(h => !fh.has(hk(h))),
      hooksRemoved: from.notRun.hooks.filter(h => !th.has(hk(h))),
      added: uniqueSorted(notRunKeys(to).filter(k => !had.has(k))),
    },
    files: { from: from.files, to: to.files },
    integrity: from.integrity === to.integrity ? null : { from: from.integrity, to: to.integrity },
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

/** `[*.]主机[:端口|:*]`。形状不对、`*`、字面 IP、内网名都是 undefined;主机名规范化成小写 */
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
  const host = normalizeHost(rest)
  return host === undefined ? undefined : { host, wild, port }
}

/** 声明的一条覆盖授权的一条:结构比较,不探测。通配只被通配覆盖;端口 `*` 只被 `*` 覆盖;默认端口(80、443)覆盖这两个 */
function covers(declared: string[], g: Entry): boolean {
  return declared.some(raw => {
    const d = parseGrantHost(raw)
    if (!d) return false
    const portOk = d.port === 'any' || (d.port === 'web' ? g.port === 'web' || g.port === 80 || g.port === 443 : g.port === d.port)
    const hostOk = g.wild ? d.wild && (g.host === d.host || g.host.endsWith(`.${d.host}`)) : d.wild ? g.host.endsWith(`.${d.host}`) : g.host === d.host
    return portOk && hostOk
  })
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
      : { network: dedupe(o.network.filter(h => parseGrantHost(h) !== undefined)), cwd: o.cwd }
  }
  return { servers }
}
