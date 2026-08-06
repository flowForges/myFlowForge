import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'
import { sysFile } from '../config/paths'
import { writeJsonAtomic } from '../util/atomicWrite'
import { parseSkillSource, defaultSkillName, safeSkillName, contentsApiUrl, type SkillSource } from './skillSource'

// 从 Git/URL 安装 skill 到各 CLI 自己的 skills 目录(用户选定的方案)。agent 自动发现,零注入。
//
// ★ 为什么要有台账:装到用户自己的 ~/.claude/skills 里意味着 Forge 装的东西和用户手放的东西混在一起。
// 卸载时若按名字直接 rm,就可能删掉用户自己写的同名 skill。所以每次安装都记一笔(装了什么、装到哪些
// 路径、来源是什么),**卸载只删台账里记着的路径**,台账外的一律不碰。

export type SkillFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

/** 可安装的目标 CLI —— 与 installedSkills.ts 的 SKILL_ROOTS 保持一致。 */
export const SKILL_TARGETS: { id: string; label: string; dir: string }[] = [
  { id: 'claude', label: 'Claude Code', dir: join('.claude', 'skills') },
  { id: 'codex', label: 'Codex', dir: join('.codex', 'skills') },
  { id: 'qoder', label: 'Qoder', dir: join('.qoder', 'skills') },
  { id: 'cursor', label: 'Cursor', dir: join('.cursor', 'skills') },
  { id: 'agents', label: 'Agents (通用)', dir: join('.agents', 'skills') },
]

export interface InstalledEntry {
  name: string
  source: string
  targets: { id: string; path: string }[]
  installedAt: number
  files: number
}
interface Ledger { skills: InstalledEntry[] }

export const ledgerFile = () => sysFile('installed-skills.json')

export function readLedger(file = ledgerFile()): Ledger {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Ledger
    return Array.isArray(j?.skills) ? j : { skills: [] }
  } catch { return { skills: [] } }
}
function writeLedger(l: Ledger, file = ledgerFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  writeJsonAtomic(file, l)
}

// 一次安装最多取这么多文件 / 单文件大小上限 —— 防止把一个大仓库整个拖下来。
const MAX_FILES = 40
const MAX_BYTES = 2 * 1024 * 1024

interface RepoFile { path: string; downloadUrl: string; size: number }

interface GhEntry { type?: string; name?: string; path?: string; size?: number; download_url?: string | null }

/**
 * 列出来源目录下要装的文件(递归一层子目录,足够覆盖 scripts/ references/ 这类常见布局)。
 * 必须含 SKILL.md,否则不是一个 skill。
 */
async function listGithubFiles(src: Extract<SkillSource, { kind: 'github' }>, fetchImpl: SkillFetch): Promise<RepoFile[] | { error: string }> {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'myFlowForge' }
  const walk = async (url: string, prefix: string, depth: number, out: RepoFile[]): Promise<string | null> => {
    if (depth > 2 || out.length >= MAX_FILES) return null
    const res = await fetchImpl(url, { headers })
    if (!res.ok) {
      if (res.status === 404) return '仓库/目录不存在,或分支名写错了'
      if (res.status === 403) return 'GitHub 接口限流了(未认证每小时 60 次),稍后再试'
      return `读取仓库失败(HTTP ${res.status})`
    }
    const body = await res.json()
    // 指向单个文件时 API 返回对象而非数组
    const entries: GhEntry[] = Array.isArray(body) ? body as GhEntry[] : [body as GhEntry]
    for (const e of entries) {
      if (out.length >= MAX_FILES) break
      if (e.type === 'dir' && e.path) {
        const sub = `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${e.path}${src.ref ? `?ref=${encodeURIComponent(src.ref)}` : ''}`
        const err = await walk(sub, `${prefix}${e.name}/`, depth + 1, out)
        if (err) return err
      } else if (e.type === 'file' && e.download_url && e.name) {
        out.push({ path: `${prefix}${e.name}`, downloadUrl: e.download_url, size: e.size ?? 0 })
      }
    }
    return null
  }
  const files: RepoFile[] = []
  const err = await walk(contentsApiUrl(src), '', 0, files)
  if (err) return { error: err }
  if (!files.some(f => /^SKILL\.md$/i.test(f.path))) {
    return { error: '这个地址下没有 SKILL.md —— 请指向包含 SKILL.md 的目录' }
  }
  return files
}

/**
 * 把一个相对路径安全地拼到根目录下。**安全关键**:文件名来自远端,必须挡住 `../` 与绝对路径,
 * 否则一个恶意仓库能把文件写到 skills 目录之外(乃至覆盖 ~/.zshrc)。
 */
export function safeJoin(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null
  const p = join(root, rel)
  const r = relative(root, p)
  if (!r || r.startsWith('..') || r.split(sep)[0] === '..') return null
  return p
}

export interface InstallArgs {
  url: string
  /** 目标 CLI id 列表(SKILL_TARGETS 里的 id)。 */
  targets: string[]
  /** 覆盖安装目录名;缺省从来源推导。 */
  name?: string
}
export type InstallResult =
  | { ok: true; name: string; targets: { id: string; path: string }[]; files: number }
  | { ok: false; error: string }

export async function installSkillFromUrl(
  args: InstallArgs,
  fetchImpl: SkillFetch,
  home = homedir(),
  ledger = ledgerFile(),
): Promise<InstallResult> {
  const src = parseSkillSource(args.url)
  if ('error' in src) return { ok: false, error: src.error }

  const wanted = SKILL_TARGETS.filter(t => args.targets.includes(t.id))
  if (!wanted.length) return { ok: false, error: '请至少选择一个要安装到的编码代理' }

  const name = safeSkillName(args.name?.trim() || defaultSkillName(src))

  // —— 取文件 ——
  let files: { path: string; content: string }[] = []
  if (src.kind === 'raw') {
    try {
      const res = await fetchImpl(src.url)
      if (!res.ok) return { ok: false, error: `下载 SKILL.md 失败(HTTP ${res.status})` }
      files = [{ path: 'SKILL.md', content: await res.text() }]
    } catch (e) { return { ok: false, error: `下载失败:${String((e as Error)?.message ?? e)}` } }
  } else {
    const listed = await listGithubFiles(src, fetchImpl).catch((e): { error: string } =>
      ({ error: `读取仓库失败:${String((e as Error)?.message ?? e)}` }))
    if ('error' in listed) return { ok: false, error: listed.error }
    const tooBig = listed.find(f => f.size > MAX_BYTES)
    if (tooBig) return { ok: false, error: `文件过大(${tooBig.path}),已跳过安装` }
    for (const f of listed) {
      try {
        const res = await fetchImpl(f.downloadUrl)
        if (!res.ok) return { ok: false, error: `下载 ${f.path} 失败(HTTP ${res.status})` }
        files.push({ path: f.path, content: await res.text() })
      } catch (e) { return { ok: false, error: `下载 ${f.path} 失败:${String((e as Error)?.message ?? e)}` } }
    }
  }
  if (!files.length) return { ok: false, error: '没有取到任何文件' }

  // —— 落盘 ——
  const written: { id: string; path: string }[] = []
  for (const t of wanted) {
    const root = join(home, t.dir, name)
    try {
      for (const f of files) {
        const abs = safeJoin(root, f.path)
        if (!abs) return { ok: false, error: `文件名不安全,已中止:${f.path}` }
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, f.content, 'utf8')
      }
      written.push({ id: t.id, path: root })
    } catch (e) {
      return { ok: false, error: `写入 ${t.label} 失败:${String((e as Error)?.message ?? e)}` }
    }
  }

  // —— 记台账(同名覆盖:合并目标路径,避免装两次留下孤儿记录)——
  const l = readLedger(ledger)
  const prior = l.skills.find(s => s.name === name)
  const merged = new Map<string, { id: string; path: string }>()
  for (const t of [...(prior?.targets ?? []), ...written]) merged.set(t.path, t)
  const entry: InstalledEntry = {
    name, source: args.url.trim(), targets: [...merged.values()],
    installedAt: Date.now(), files: files.length,
  }
  writeLedger({ skills: [...l.skills.filter(s => s.name !== name), entry] }, ledger)

  return { ok: true, name, targets: written, files: files.length }
}

/**
 * 卸载。**只删台账里记着的路径** —— 用户自己手放在 ~/.claude/skills 下的同名目录绝不会被碰到,
 * 这是「装进用户目录」这一选择必须配的安全垫。
 */
export function uninstallSkill(name: string, ledger = ledgerFile()): { ok: true; removed: number } | { ok: false; error: string } {
  const l = readLedger(ledger)
  const entry = l.skills.find(s => s.name === name)
  if (!entry) return { ok: false, error: '这个 skill 不是由 Forge 安装的,不能从这里卸载' }
  let removed = 0
  for (const t of entry.targets) {
    if (!existsSync(t.path)) continue
    try { rmSync(t.path, { recursive: true, force: true }); removed++ } catch { /* 尽力而为 */ }
  }
  writeLedger({ skills: l.skills.filter(s => s.name !== name) }, ledger)
  return { ok: true, removed }
}

/** Forge 装过的 skill 列表(给 UI 标出「可卸载」)。 */
export function listManagedSkills(ledger = ledgerFile()): InstalledEntry[] {
  return readLedger(ledger).skills.sort((a, b) => b.installedAt - a.installedAt)
}
