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

export async function locateExternal(provider: ExtProvider, externalId: string, opts: LocateOpts = {}): Promise<string | undefined> {
  if (!SAFE_ID.test(externalId)) return undefined
  const root = (opts.roots ?? linkRoots())[provider]
  if (!root) return undefined
  try {
    return provider === 'codex' ? await inRollouts(root, externalId) : await inProjects(root, externalId, opts.cwd)
  } catch { return undefined }
}
