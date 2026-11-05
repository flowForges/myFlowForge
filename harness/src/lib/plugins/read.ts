// 把一个插件目录读成数据(09 spec §5、§6.3)。只用 lstat 和 O_NOFOLLOW 读文本与 JSON,
// 不跟符号链接,不执行、不加载根里的任何东西;hooks、脚本、可执行文件只列出来
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { scanInjection } from '../memory/scan'
import { cleanText } from '../tools/diagnostics'
import { sanitizeLine } from '../memory/wrap'
import { deriveId, parseClaudeManifest, unwrapServers } from './claudeFormat'
import { parseFrontmatter } from './frontmatter'
import { configKeysOf, parseNative, satisfiesKernel, type Manifest } from './manifest'
import { parseServer } from './mcpConfig'
import {
  COMMAND_MAX,
  KERNEL_VERSION,
  NAME_RE,
  SKILL_MAX,
  clip,
  isObject,
  type Claimed,
  type ConfigKey,
  type NotRun,
  type ParsedCommand,
  type ParsedPlugin,
  type ParsedServer,
  type ParsedSkill,
  type ReadError,
  type Warning,
} from './types'

const JSON_MAX = 1024 * 1024
const MAX_ENTRIES = 5000
const MAX_DEPTH = 32
const MAX_ITEMS = 500
const MAX_LIST = 200
const HOOK_MAX = 16384
const IGNORED_KEYS = ['allowed-tools', 'model', 'hooks', 'context', 'agent']
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

interface Inv {
  files: { rel: string; exec: boolean }[]
  truncated: boolean
}

/** 遍历一次:lstat,符号链接不算、不进;`.git` 和 node_modules 不进 */
function inventory(root: string): Inv {
  const files: Inv['files'] = []
  let seen = 0
  let truncated = false
  const walk = (rel: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(join(root, rel)).sort()
    } catch {
      return
    }
    for (const n of names) {
      if (++seen > MAX_ENTRIES) {
        truncated = true
        return
      }
      if (n === '.git') continue
      const r = rel === '' ? n : `${rel}/${n}`
      let st
      try {
        st = lstatSync(join(root, r))
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (n !== 'node_modules' && depth < MAX_DEPTH) walk(r, depth + 1)
        else if (depth >= MAX_DEPTH) truncated = true
      } else if (st.isFile()) files.push({ rel: r, exec: (st.mode & 0o111) !== 0 })
      if (truncated) return
    }
  }
  walk('', 0)
  return { files, truncated }
}

/** 相对路径:不是绝对、不含 `..` 和控制字符。`./` 前缀去掉。不合规是 null */
function safeRel(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 1024) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    out.push(seg)
  }
  return out.length === 0 ? '' : out.join('/')
}

/** 逐段 lstat,有符号链接就不读 */
function plainFile(root: string, rel: string): string | null {
  let cur = root
  const segs = rel.split('/')
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i])
    try {
      const st = lstatSync(cur)
      if (st.isSymbolicLink()) return null
      if (i === segs.length - 1 ? !st.isFile() : !st.isDirectory()) return null
    } catch {
      return null
    }
  }
  return cur
}

interface Read {
  text: string
  size: number
  hash: string
  over: boolean
}

/** 读到 cap 字节,整个文件的哈希分块算,所以超大文件也不进内存 */
function readCapped(root: string, rel: string, cap: number): Read | null {
  const abs = plainFile(root, rel)
  if (abs === null) return null
  let fd: number | undefined
  try {
    fd = openSync(abs, constants.O_RDONLY | O_NOFOLLOW)
    const size = fstatSync(fd).size
    const h = createHash('sha256')
    const keep: Buffer[] = []
    let kept = 0
    const buf = Buffer.allocUnsafe(65536)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const chunk = Buffer.from(buf.subarray(0, n))
      h.update(chunk)
      if (kept < cap) {
        keep.push(chunk.subarray(0, cap - kept))
        kept += Math.min(n, cap - kept)
      }
    }
    return { text: Buffer.concat(keep).toString('utf8'), size, hash: h.digest('hex'), over: size > cap }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readJson(root: string, rel: string): { state: 'missing' } | { state: 'bad' } | { state: 'ok'; value: unknown } {
  const abs = plainFile(root, rel)
  if (abs === null) {
    try {
      lstatSync(join(root, rel))
    } catch {
      return { state: 'missing' }
    }
    return { state: 'bad' }
  }
  const r = readCapped(root, rel, JSON_MAX)
  if (r === null || r.over) return { state: 'bad' }
  try {
    return { state: 'ok', value: JSON.parse(r.text.charCodeAt(0) === 0xfeff ? r.text.slice(1) : r.text) as unknown }
  } catch {
    return { state: 'bad' }
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const line = (s: string, max: number) => clip(sanitizeLine(s), max)

function boolField(v: string | string[] | undefined): boolean | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().toLowerCase()
  return t === 'true' ? true : t === 'false' ? false : undefined
}

function firstLine(body: string): string {
  for (const l of body.split('\n')) {
    const t = l.replace(/^[#>\s-]+/, '').trim()
    if (t !== '') return t
  }
  return ''
}

interface Meta {
  description: string
  argumentHint?: string
  argNames: string[]
  ignored: string[]
  flags: ParsedSkill['flags']
  hiddenChars: boolean
  modelInvocable: boolean
  userInvocable: boolean
  body: string
  fmName?: string
}

function metaOf(text: string, warn: Set<Warning>): Meta {
  const fm = parseFrontmatter(text)
  const f = fm.fields
  const asText = (k: string) => {
    const v = f.get(k)
    return Array.isArray(v) ? v.join(' ') : v
  }
  const body = fm.body
  const description = line(asText('description') || firstLine(body), 200)
  const hint = asText('argument-hint')
  const argsField = f.get('arguments')
  const argNames = (Array.isArray(argsField) ? argsField : typeof argsField === 'string' ? argsField.split(/[\s,]+/) : [])
    .filter(n => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(n))
    .slice(0, 20)
  const hiddenChars = cleanText(body.replace(/\r\n?/g, '\n')) !== body.replace(/\r\n?/g, '\n')
  if (hiddenChars) warn.add('hidden_chars')
  if (/!`[^`\n]+`|(?:^|\s)@[\w./~-]+/m.test(body)) warn.add('shell_in_text')
  const name = asText('name')
  return {
    description,
    argumentHint: hint ? line(hint, 200) : undefined,
    argNames,
    ignored: IGNORED_KEYS.filter(k => f.has(k)),
    flags: scanInjection(`${description}\n${body}`),
    hiddenChars,
    modelInvocable: boolField(f.get('disable-model-invocation')) !== true,
    userInvocable: boolField(f.get('user-invocable')) !== false,
    body,
    fmName: name ? name.trim() : undefined,
  }
}

const listOf = (names: Iterable<string>): string[] => [...new Set(names)].sort(cmp)
const cap = (list: string[], warn: Set<Warning>) => {
  if (list.length > MAX_LIST) warn.add('truncated')
  return list.slice(0, MAX_LIST)
}

function dedupeName(name: string, seen: Set<string>, warn: Set<Warning>): boolean {
  if (!NAME_RE.test(name) || seen.has(name)) {
    warn.add('name_dropped')
    return false
  }
  seen.add(name)
  return true
}

export function readPlugin(
  root: string,
  o: { nameHint: string; reservedIds: Set<string>; kernelVersion?: string; home?: string },
): { ok: true; plugin: ParsedPlugin } | { ok: false; error: ReadError } {
  try {
    return read(root, o)
  } catch {
    return { ok: false, error: 'bad_manifest' }
  }
}

function read(root: string, o: { nameHint: string; reservedIds: Set<string>; kernelVersion?: string; home?: string }) {
  const warn = new Set<Warning>()
  const inv = inventory(root)
  if (inv.truncated) warn.add('truncated')
  const has = (rel: string) => inv.files.some(f => f.rel === rel)
  const under = (dir: string) => inv.files.filter(f => f.rel.startsWith(dir + '/')).map(f => f.rel.slice(dir.length + 1))

  // 清单:原生 > Claude Code > 没有
  let format: 'native' | 'claude' = 'claude'
  let manifest: Manifest
  let id: string | null
  const native = readJson(root, 'mff-plugin.json')
  const claude = native.state === 'missing' ? readJson(root, '.claude-plugin/plugin.json') : ({ state: 'missing' } as const)
  if (native.state === 'bad' || claude.state === 'bad') return { ok: false, error: 'bad_manifest' } as const
  if (native.state === 'ok') {
    const r = parseNative(native.value)
    if (!r.ok) return { ok: false, error: 'bad_manifest' } as const
    format = 'native'
    manifest = r.manifest
    id = r.manifest.id
    if (r.manifest.kernel !== undefined && !satisfiesKernel(r.manifest.kernel, o.kernelVersion ?? KERNEL_VERSION)) return { ok: false, error: 'kernel_incompatible' } as const
  } else if (claude.state === 'ok') {
    const r = parseClaudeManifest(claude.value)
    if (!r.ok) return { ok: false, error: 'bad_manifest' } as const
    manifest = r.manifest
    id = deriveId(manifest.name ?? '') ?? deriveId(o.nameHint)
  } else {
    const components = ['skills', 'commands', 'agents', 'hooks', 'bin', 'monitors', 'workflows']
    const any = has('SKILL.md') || has('.mcp.json') || has('.lsp.json') || components.some(c => inv.files.some(f => f.rel.startsWith(c + '/')))
    if (!any) return { ok: false, error: 'not_a_plugin' } as const
    warn.add('no_manifest')
    manifest = { skills: [], mcp: [], userConfig: new Map(), hooks: [], other: new Map() }
    id = deriveId(o.nameHint)
  }
  if (id === null) return { ok: false, error: 'bad_manifest' } as const
  if (o.reservedIds.has(id) || id.startsWith('dev-')) return { ok: false, error: 'id_reserved' } as const

  const dropPath = (p: string): string | null => {
    const r = safeRel(p)
    if (r === null) warn.add('path_dropped')
    return r
  }

  // 技能:默认 skills/ 追加 manifest 的路径,没有 skills/ 时根上的 SKILL.md 算一个
  const skills: ParsedSkill[] = []
  const skillNames = new Set<string>()
  const addSkill = (dir: string, fallbackName: string) => {
    if (skills.length >= MAX_ITEMS) {
      warn.add('truncated')
      return
    }
    const file = dir === '' ? 'SKILL.md' : `${dir}/SKILL.md`
    const r = readCapped(root, file, SKILL_MAX)
    if (r === null) {
      warn.add('file_unreadable')
      return
    }
    const meta = metaOf(r.text, warn)
    const name = meta.fmName && NAME_RE.test(meta.fmName) ? meta.fmName : fallbackName
    if (!dedupeName(name, skillNames, warn)) return
    if (r.over) warn.add('truncated')
    skills.push({
      name,
      dir,
      file,
      description: meta.description,
      modelInvocable: meta.modelInvocable,
      userInvocable: meta.userInvocable,
      argumentHint: meta.argumentHint,
      files: dir === '' ? 1 : inv.files.filter(f => f.rel.startsWith(dir + '/')).length,
      flags: meta.flags,
      ignored: meta.ignored,
      hiddenChars: meta.hiddenChars,
      tooLarge: r.over,
      bodyHash: r.hash,
    })
  }
  const skillRoots = ['skills']
  for (const p of manifest.skills) {
    const r = dropPath(p)
    if (r !== null && r !== '') skillRoots.push(r)
  }
  for (const dir of skillRoots) {
    if (has(`${dir}/SKILL.md`)) addSkill(dir, dir.slice(dir.lastIndexOf('/') + 1))
    const names = new Set<string>()
    for (const rel of under(dir)) {
      const m = /^([^/]+)\/SKILL\.md$/.exec(rel)
      if (m) names.add(m[1])
    }
    for (const n of [...names].sort(cmp)) addSkill(`${dir}/${n}`, n)
  }
  if (!inv.files.some(f => f.rel.startsWith('skills/')) && has('SKILL.md')) addSkill('', id)

  // 命令:有 commands 键就替换默认目录
  const commands: ParsedCommand[] = []
  const commandNames = new Set<string>()
  const addCommand = (name: string, file: string | undefined, text: string, hash: string, over: boolean) => {
    if (commands.length >= MAX_ITEMS) {
      warn.add('truncated')
      return
    }
    if (!dedupeName(name, commandNames, warn)) return
    if (over) warn.add('truncated')
    const meta = metaOf(text, warn)
    commands.push({
      name,
      file,
      description: meta.description,
      argumentHint: meta.argumentHint,
      argNames: meta.argNames,
      flags: meta.flags,
      ignored: meta.ignored,
      hiddenChars: meta.hiddenChars,
      tooLarge: over,
      body: over ? '' : meta.body,
      bodyHash: hash,
    })
  }
  const addCommandFile = (rel: string, name: string) => {
    const r = readCapped(root, rel, COMMAND_MAX)
    if (r === null) warn.add('file_unreadable')
    else addCommand(name, rel, r.text, r.hash, r.over)
  }
  const isMd = (p: string) => /\.md$/i.test(p)
  const stem = (p: string) => p.replace(/\.md$/i, '')
  const cmdPaths = manifest.commands === undefined ? ['commands'] : manifest.commands.paths.map(dropPath).filter((p): p is string => p !== null && p !== '')
  for (const p of cmdPaths) {
    if (has(p) && isMd(p)) addCommandFile(p, stem(p.slice(p.lastIndexOf('/') + 1)))
    else for (const rel of under(p).filter(isMd)) addCommandFile(`${p}/${rel}`, stem(rel).split('/').join(':'))
  }
  for (const [name, e] of manifest.commands?.map ?? []) {
    if (e.content !== undefined) {
      const over = e.content.length > COMMAND_MAX
      addCommand(name, undefined, over ? '' : e.content, createHash('sha256').update(e.content).digest('hex'), over)
    } else if (e.source !== undefined) {
      const src = dropPath(e.source)
      if (src !== null && src !== '') addCommandFile(src, name)
    }
  }

  // 服务
  const rawServers = new Map<string, unknown>()
  const remote: NotRun['remoteMcp'] = []
  const addDecl = (servers: Map<string, unknown>) => {
    for (const [k, v] of servers) rawServers.set(k, v)
  }
  if (format === 'claude' && has('.mcp.json')) {
    const j = readJson(root, '.mcp.json')
    if (j.state === 'ok') addDecl(unwrapServers(j.value))
    else warn.add('file_unreadable')
  }
  for (const d of manifest.mcp) {
    if (d.kind === 'inline') addDecl(d.servers)
    else {
      const p = dropPath(d.path)
      if (p === null || p === '') continue
      if (/\.mcpb$/i.test(p)) remote.push({ name: clip(p, 200), type: 'mcpb', url: clip(p, 2000) })
      else {
        const j = readJson(root, p)
        if (j.state === 'ok') addDecl(unwrapServers(j.value))
        else warn.add('file_unreadable')
      }
    }
  }
  const config = new Map<string, ConfigKey>(configKeysOf(manifest.userConfig).map(k => [k.key, k]))
  const servers: ParsedServer[] = []
  for (const [name, raw] of [...rawServers].sort((a, b) => cmp(a[0], b[0])).slice(0, 100)) {
    const s = parseServer(name, raw, { format, config, home: o.home })
    if (s.remote) remote.push({ name: clip(name, 200), type: clip(s.remote.type, 40), url: s.remote.url })
    else servers.push(s)
  }
  for (const s of servers) {
    if (s.fetchesAtRuntime) warn.add('runtime_fetch')
    for (const k of s.configRefs)
      if (!config.has(k) && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
        config.set(k, { key: k, title: k, sensitive: true, required: true, type: 'string', from: 'mcp' })
  }

  // 不跑的东西:原样列出
  const hooks: NotRun['hooks'] = []
  const addHooks = (v: unknown) => {
    const top = isObject(v) && isObject(v.hooks) ? v.hooks : v
    if (!isObject(top)) return
    for (const [event, groups] of Object.entries(top)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        const list = isObject(g) && Array.isArray(g.hooks) ? g.hooks : [g]
        for (const h of list) {
          if (!isObject(h) || hooks.length >= MAX_LIST) continue
          const c = typeof h.command === 'string' ? h.command : typeof h.prompt === 'string' ? h.prompt : typeof h.url === 'string' ? h.url : null
          if (c === null) continue
          if (c.length > HOOK_MAX) warn.add('truncated')
          hooks.push({ event: clip(event, 100), command: clip(c, HOOK_MAX) })
        }
      }
    }
  }
  if (has('hooks/hooks.json')) {
    const j = readJson(root, 'hooks/hooks.json')
    if (j.state === 'ok') addHooks(j.value)
    else warn.add('file_unreadable')
  }
  for (const h of manifest.hooks) {
    if (typeof h === 'string') {
      const p = dropPath(h)
      const j = p ? readJson(root, p) : null
      if (j?.state === 'ok') addHooks(j.value)
      else if (p) warn.add('file_unreadable')
    } else if (Array.isArray(h)) h.forEach(x => (isObject(x) ? addHooks(x) : undefined))
    else addHooks(h)
  }
  if (hooks.length > 0) warn.add('hooks_not_run')

  const listing = (key: string, dirs: string[]): string[] => {
    const names = new Set<string>()
    const v = manifest.other.get(key)
    const paths = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    for (const d of dirs) paths.push(d)
    for (const p of paths) {
      const r = safeRel(p)
      if (r === null) {
        warn.add('path_dropped')
        continue
      }
      if (r === '') continue
      if (has(r)) names.add(r)
      for (const n of under(r)) names.add(`${r}/${n}`)
    }
    if (isObject(v)) for (const k of Object.keys(v)) names.add(k)
    return cap(listOf(names), warn)
  }
  const other: string[] = []
  for (const [key, dir] of [['outputStyles', 'output-styles'], ['themes', 'themes'], ['settings', 'settings.json'], ['dependencies', ''], ['channels', '']] as const)
    if (manifest.other.has(key) || (dir !== '' && (has(dir) || under(dir).length > 0))) other.push(key)

  const scripts: string[] = []
  for (const f of inv.files) if (f.exec && !f.rel.startsWith('bin/')) scripts.push(f.rel)
  const pkg = has('package.json') ? readJson(root, 'package.json') : null
  if (pkg?.state === 'ok' && isObject(pkg.value) && isObject(pkg.value.scripts))
    for (const k of Object.keys(pkg.value.scripts)) scripts.push(`package.json#scripts.${k}`)

  const notRun: NotRun = {
    hooks,
    agents: listing('agents', ['agents']),
    bin: listing('bin', ['bin']),
    monitors: listing('monitors', ['monitors']),
    workflows: listing('workflows', ['workflows']),
    lsp: listing('lspServers', has('.lsp.json') ? ['.lsp.json'] : []),
    other: listOf(other),
    remoteMcp: remote.sort((a, b) => cmp(a.name, b.name)).slice(0, MAX_LIST),
    scripts: cap(listOf(scripts), warn),
  }
  if (manifest.main !== undefined) notRun.main = clip(manifest.main, 1024)

  const claimed: Claimed = { name: line(manifest.name ?? id, 300), description: line(manifest.description ?? '', 300) }
  if (manifest.author) claimed.author = line(manifest.author, 300)
  if (manifest.homepage) claimed.homepage = line(manifest.homepage, 300)

  skills.sort((a, b) => cmp(a.name, b.name))
  commands.sort((a, b) => cmp(a.name, b.name))
  return {
    ok: true,
    plugin: {
      id,
      version: format === 'native' ? manifest.version! : line(manifest.version ?? '0.0.0', 64) || '0.0.0',
      format,
      claimed,
      skills,
      commands,
      servers,
      config: [...config.values()].sort((a, b) => cmp(a.key, b.key)),
      notRun,
      warnings: [...warn].sort(cmp),
    },
  } as const
}
