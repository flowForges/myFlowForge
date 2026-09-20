import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'
import type { Addon, AddonKind, AddonScan } from '../../shared/addons'

/**
 * 「加载项」:这台机器上,各个 CLI 全局装了哪些 **skill / rule / MCP**,以及能不能删。
 *
 * ★★2026-09-05 用户提的三条,决定了这个模块的形状:
 *  ①「加载项里好像有 skill,所以 skill 是不是多余?」—— 是。设置里那一页删了,这里是唯一入口。
 *  ②「能不能根据当前支持的 provider 扫描出来 …… 然后进行筛选」—— 每一条都带 provider,界面据此筛。
 *  ③「如果一个 skill 既在 claude 安装了,又在 codex 安装了,都应该展示出来」——
 *     **所以这里刻意不做跨 provider 去重**。老的 `readInstalledSkills` 按 `source+name` 去重,
 *     那正好把这个场景折叠掉了:界面上只剩一条,而用户想知道的恰恰是"两边都装了"。
 *     同一个 provider 内部仍然按路径去重(插件包会带同一个技能的好几个版本)。
 *
 * ★删除一律**先扫再删**:客户端只传一个 id,路径由这一侧的扫描结果给出。
 *  直接删客户端传来的路径 = 把 `rm -rf 任意路径` 开放给了任何一个连上来的客户端。
 */

/** 全局技能目录。★`provider` 是**真的 provider id**,不是显示名 —— 界面按它筛选。 */
export const SKILL_ROOTS: { provider: string; dir: string; plugins?: boolean }[] = [
  { provider: 'claude', dir: join('.claude', 'skills') },
  { provider: 'claude', dir: join('.claude', 'plugins'), plugins: true },
  { provider: 'codex', dir: join('.codex', 'skills') },
  { provider: 'qoder', dir: join('.qoder', 'skills') },
  { provider: 'cursor', dir: join('.cursor', 'skills') },
  { provider: 'codex', dir: join('.agents', 'skills') },
]

/**
 * 全局规则文档。
 * ★`readers` 是**都读它的那几个 CLI**,而 `provider` 是归属(界面上挂在谁名下)。
 *  `~/.codex/AGENTS.md` 一个文件被 codex/qwen/agents 三个读 —— 列三遍是噪音,列一遍 + 说清谁读它才对。
 */
export const GLOBAL_RULE_FILES: { provider: string; rel: string; readers: string[] }[] = [
  { provider: 'claude', rel: join('.claude', 'CLAUDE.md'), readers: ['claude'] },
  { provider: 'claude', rel: 'CLAUDE.md', readers: ['claude'] },
  { provider: 'codex', rel: join('.codex', 'AGENTS.md'), readers: ['codex', 'qwen', 'agents'] },
  { provider: 'gemini', rel: join('.gemini', 'GEMINI.md'), readers: ['gemini'] },
  { provider: 'qoder', rel: join('.qoder', 'QODER.md'), readers: ['qoder'] },
  { provider: 'cursor', rel: join('.cursor', 'rules'), readers: ['cursor'] },
]

/** MCP 配置文件(JSON:`mcpServers` 对象;codex 是 TOML 的 `[mcp_servers.x]`)。 */
const MCP_JSON: { provider: string; rel: string }[] = [
  { provider: 'claude', rel: '.claude.json' },
  { provider: 'cursor', rel: join('.cursor', 'mcp.json') },
  { provider: 'gemini', rel: join('.gemini', 'settings.json') },
]

const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])

function frontmatter(file: string): { name?: string; description?: string } {
  try {
    const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return {}
    const unquote = (s?: string) => s?.trim().replace(/^['"]|['"]$/g, '')
    return {
      name: unquote(m[1].match(/^name:\s*(.+)$/m)?.[1]),
      description: unquote(m[1].match(/^description:\s*(.+)$/m)?.[1]),
    }
  } catch { return {} }
}

function findSkillFiles(root: string, out: string[], depth = 0): void {
  // 深度 9 覆盖插件的层级(.claude/plugins/cache/<market>/<plugin>/<ver>/skills/<name>/SKILL.md)。
  if (depth > 9 || out.length >= 400) return
  let entries: Dirent[]
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = join(root, e.name)
    if (e.isDirectory()) findSkillFiles(p, out, depth + 1)
    else if (e.name === 'SKILL.md') out.push(p)
  }
}

function readJsonMcp(path: string): string[] {
  try {
    const servers = JSON.parse(readFileSync(path, 'utf8'))?.mcpServers
    return servers && typeof servers === 'object' ? Object.keys(servers) : []
  } catch { return [] }
}

function readTomlMcp(path: string): string[] {
  try {
    const names = new Set<string>()
    const re = /^\s*\[mcp_servers\.([^.\]\s]+)/gm
    let m: RegExpExecArray | null
    const text = readFileSync(path, 'utf8')
    while ((m = re.exec(text))) names.add(m[1])
    return [...names]
  } catch { return [] }
}

/**
 * 这个技能属于哪个包。
 * 布局是 `<root>/<包>/skills/<技能>` 或 `<root>/cache/<市场>/<插件>/<版本>/skills/<技能>`;
 * 直接放在 `<root>/<技能>` 下的就没有包。★取的是 `skills/` **前面**那一段里最有辨识度的一节:
 * 插件那条路上是插件名(版本号是噪音),普通包就是包名。
 */
function packOf(root: string, dir: string): string | undefined {
  const rel = dir.startsWith(root) ? dir.slice(root.length).replace(/^[/\\]/, '') : ''
  const parts = rel.split(/[/\\]/).filter(Boolean)
  const i = parts.lastIndexOf('skills')
  if (i <= 0) return undefined
  const before = parts.slice(0, i)
  // 版本号那一节跳过(6.3.0 / v1.2 这种)
  const last = before[before.length - 1]
  const pick = /^v?\d+(\.\d+)*$/.test(last ?? '') ? before[before.length - 2] : last
  return pick || undefined
}

/** 稳定 id:同一条加载项每次扫出来都是同一个 id(界面用它做 key,删除也按它找)。 */
export const addonId = (kind: AddonKind, provider: string, name: string, path: string) =>
  `${kind}:${provider}:${name}:${path}`

/**
 * 扫全局加载项。
 * @param installed 当前**探测到装了**的 provider id 集合。不在里面的照样扫、照样列,
 *   只是标成 `installed: false` —— 「我卸载了 qoder,它那些技能还在磁盘上占着」正是该看见的事。
 */
export function scanAddons(home = homedir(), installed: Set<string> = new Set()): AddonScan {
  const addons: Addon[] = []
  const add = (a: Omit<Addon, 'id' | 'installed'>) =>
    addons.push({ ...a, id: addonId(a.kind, a.provider, a.name, a.path), installed: installed.has(a.provider) })

  // —— skill ——
  for (const root of SKILL_ROOTS) {
    const files: string[] = []
    findSkillFiles(join(home, root.dir), files)
    const seen = new Set<string>()
    for (const file of files) {
      const dir = dirname(file)
      if (seen.has(dir)) continue
      seen.add(dir)
      const fm = frontmatter(file)
      add({
        kind: 'skill',
        provider: root.provider,
        pack: packOf(join(home, root.dir), dir),
        name: fm.name || basename(dir) || 'skill',
        description: fm.description || '',
        path: dir,
        // ★插件包里的技能不给单删:那是插件的一部分,删掉一个子目录等于把插件弄成半残,
        //  而且插件下次更新还会把它装回来。说清楚该去哪儿卸,比给一颗会闯祸的按钮好。
        removable: !root.plugins,
        removeVia: root.plugins ? null : 'trash',
        note: root.plugins ? '属于插件包,要删就在 CLI 那边卸载整个插件' : '',
      })
    }
  }

  // —— rule ——
  for (const r of GLOBAL_RULE_FILES) {
    const p = join(home, r.rel)
    if (!existsSync(p)) continue
    const many = r.readers.length > 1
    add({
      kind: 'rule',
      provider: r.provider,
      name: basename(r.rel),
      description: many ? `${r.readers.join(' / ')} 都读它` : '',
      path: p,
      removable: true,
      removeVia: 'trash',
      note: '',
    })
  }

  // —— mcp ——
  // ★这里读的是**配置文件**(快),不是 `mcp list`(要跑进程 + 健康检查)。
  //  「连上没有 / 授权没有」在 MCP 那一页答;这一页答的是「装了哪些、怎么删」。
  for (const m of MCP_JSON) {
    const p = join(home, m.rel)
    for (const name of readJsonMcp(p)) {
      add({ kind: 'mcp', provider: m.provider, name, description: '', path: p, removable: true, removeVia: 'cli', note: '' })
    }
  }
  const codexToml = join(home, '.codex', 'config.toml')
  for (const name of readTomlMcp(codexToml)) {
    add({ kind: 'mcp', provider: 'codex', name, description: '', path: codexToml, removable: true, removeVia: 'cli', note: '' })
  }

  addons.sort((a, b) => a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  return { addons, home }
}

/**
 * 删之前的安全闸门:这条路径必须是**刚扫出来的那一条**。
 *
 * ★★客户端只传 id;路径由这一侧给。不这么做的话,`addons:remove` 就是一个
 *  「删任意路径」的远程接口 —— 而这个 app 是**能被手机和另一台电脑连上的**。
 * ★再兜一层:只允许删 home 底下的东西。扫描器哪天写出个 `/` 开头的路径,这一层也拦得住。
 */
export function resolveRemovable(scan: AddonScan, id: string): Addon | null {
  const a = scan.addons.find(x => x.id === id)
  if (!a || !a.removable) return null
  const homeDir = scan.home.endsWith(sep) ? scan.home : scan.home + sep
  if (a.removeVia === 'trash') {
    if (!a.path.startsWith(homeDir)) return null
    if (!existsSync(a.path)) return null
    // 目录才递归删;文件就是文件。两者都在 home 里,已经过了上面那道闸门。
    try { statSync(a.path) } catch { return null }
  }
  return a
}
