import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { linkRoots, type ExtProvider } from './types'

// 由 provider + 外部会话 id 找到外部记录文件(只读)。根目录不存在 / 找不到 → undefined,从不抛。
//   claude: <root>/<slug>/<id>.jsonl        (slug = cwd 里非字母数字换成 `-`)
//   codex:  <root>/**/rollout-…-<id>.jsonl
//   qoder:  <root>/<project>/<id>.jsonl     (格式同 Claude,未验证)

export interface LocateOpts { roots?: Record<ExtProvider, string>; cwd?: string }

export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

async function isFile(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile() } catch { return false }
}
async function dirs(root: string): Promise<string[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
}

async function inProjects(root: string, id: string, cwd?: string): Promise<string | undefined> {
  const name = `${id}.jsonl`
  const first = cwd ? claudeProjectSlug(cwd) : undefined
  if (first && await isFile(join(root, first, name))) return join(root, first, name)
  for (const d of await dirs(root)) {
    if (d === first) continue
    if (await isFile(join(root, d, name))) return join(root, d, name)
  }
  return undefined
}

/** 新的日期目录先找(sessions/YYYY/MM/DD),通常最近的会话在最新的目录里。 */
async function inRollouts(dir: string, id: string): Promise<string | undefined> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return undefined }
  const hit = entries.find(e => e.isFile() && (e.name.endsWith(`-${id}.jsonl`) || e.name === `${id}.jsonl`))
  if (hit) return join(dir, hit.name)
  for (const e of entries.filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const f = await inRollouts(join(dir, e.name), id)
    if (f) return f
  }
  return undefined
}

/** UUIDv7 的前 48 位是毫秒时间戳;codex 按本地日期建 sessions/YYYY/MM/DD。不是 v7 → undefined。 */
function uuidV7Ms(id: string): number | undefined {
  const hex = id.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return undefined
  const ms = parseInt(hex.slice(0, 12), 16)
  return Number.isFinite(ms) ? ms : undefined
}
const dayDir = (root: string, d: Date) =>
  join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))

async function inRolloutDay(dir: string, id: string): Promise<string | undefined> {
  let names: string[]
  try { names = await readdir(dir) } catch { return undefined }
  const hit = names.find(n => n.endsWith(`-${id}.jsonl`) || n === `${id}.jsonl`)
  return hit && await isFile(join(dir, hit)) ? join(dir, hit) : undefined
}

async function codexRollout(root: string, id: string): Promise<string | undefined> {
  const ms = uuidV7Ms(id)
  if (ms !== undefined) {
    // 当天优先,再前后各一天(本地时区 / 跨午夜)
    for (const delta of [0, -1, 1]) {
      const f = await inRolloutDay(dayDir(root, new Date(ms + delta * 86_400_000)), id)
      if (f) return f
    }
  }
  return inRollouts(root, id)
}

export async function locateExternal(provider: ExtProvider, externalId: string, opts: LocateOpts = {}): Promise<string | undefined> {
  if (!SAFE_ID.test(externalId)) return undefined
  const root = (opts.roots ?? linkRoots())[provider]
  if (!root) return undefined
  try {
    return provider === 'codex' ? await codexRollout(root, externalId) : await inProjects(root, externalId, opts.cwd)
  } catch { return undefined }
}
