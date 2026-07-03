import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Dirent } from 'node:fs'

export interface InstalledSkill { name: string; description: string; source: string; path: string }

// Home-level skill roots per agent. Skills can be nested (e.g. <pack>/skills/<name>/SKILL.md), so we
// walk recursively for SKILL.md rather than assuming a single level.
const SKILL_ROOTS: { source: string; dir: string }[] = [
  { source: 'Claude', dir: join('.claude', 'skills') },
  { source: 'Codex', dir: join('.codex', 'skills') },
  { source: 'Qoder', dir: join('.qoder', 'skills') },
  { source: 'Cursor', dir: join('.cursor', 'skills') },
  { source: 'Agents', dir: join('.agents', 'skills') },
]
const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])

function parseFrontmatter(file: string): { name?: string; description?: string } {
  try {
    const text = readFileSync(file, 'utf8')
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return {}
    const body = m[1]
    const unquote = (s?: string) => s?.trim().replace(/^['"]|['"]$/g, '')
    return {
      name: unquote(body.match(/^name:\s*(.+)$/m)?.[1]),
      description: unquote(body.match(/^description:\s*(.+)$/m)?.[1]),
    }
  } catch { return {} }
}

function findSkillFiles(root: string, out: string[], depth = 0): void {
  if (depth > 5 || out.length >= 300) return
  let entries: Dirent[]
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = join(root, e.name)
    if (e.isDirectory()) findSkillFiles(p, out, depth + 1)
    else if (e.name === 'SKILL.md') out.push(p)
  }
}

// List the real skills installed under the user's home agent dirs (read-only — Forge doesn't
// enable/disable skills; agents auto-discover them). Frontmatter `name`/`description` when present,
// else the skill's directory name.
export function readInstalledSkills(home = homedir()): InstalledSkill[] {
  const seen = new Set<string>()
  const out: InstalledSkill[] = []
  for (const { source, dir } of SKILL_ROOTS) {
    const files: string[] = []
    findSkillFiles(join(home, dir), files)
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      const fm = parseFrontmatter(file)
      const name = fm.name || file.split(/[/\\]/).slice(-2)[0] || 'skill'
      out.push({ name, description: fm.description || '', source, path: file })
    }
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
}
