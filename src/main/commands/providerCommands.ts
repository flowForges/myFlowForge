import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { readInstalledSkills } from '../skills/installedSkills'

// A command surfaced in the chat "/" menu, sourced from the user's real on-disk files (custom
// commands/prompts) or installed skills — NOT the CLI's built-in interactive commands (/help,
// /clear…), which don't work in our non-interactive exec/-p mode.
export interface ProviderCommand {
  cmd: string        // '/analyst'
  title: string      // 'analyst'
  desc: string       // frontmatter description (may be '')
  template: string   // what to drop into the composer when picked
  kind: 'command' | 'skill'
}

// Where each provider keeps its custom commands/prompts (relative to home or the workspace root).
// claude 'print' mode expands /command; codex exec may expand its prompts — we surface what exists.
const COMMAND_DIRS: Record<string, { base: 'home' | 'ws'; dir: string }[]> = {
  claude: [{ base: 'home', dir: '.claude/commands' }, { base: 'ws', dir: '.claude/commands' }],
  codex: [{ base: 'home', dir: '.codex/prompts' }],
  cursor: [{ base: 'home', dir: '.cursor/commands' }, { base: 'ws', dir: '.cursor/commands' }],
  qoder: [{ base: 'home', dir: '.qoder/commands' }, { base: 'ws', dir: '.qoder/commands' }],
}
// installedSkills' `source` label per provider id (skills are auto-triggered, listed for explicit use).
const SKILL_SOURCE: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', qoder: 'Qoder' }

function frontmatterDescription(file: string): string {
  try {
    const text = readFileSync(file, 'utf8')
    const body = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
    return (body.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '')
  } catch { return '' }
}

function scanCommandDir(dir: string): ProviderCommand[] {
  let files: string[]
  try { files = readdirSync(dir).filter(f => f.endsWith('.md')) } catch { return [] }
  return files.map(f => {
    const name = basename(f, '.md')
    return { cmd: '/' + name, title: name, desc: frontmatterDescription(join(dir, f)), template: '/' + name + ' ', kind: 'command' as const }
  })
}

// The user's real, usable commands for a provider: custom command/prompt files (home + workspace)
// followed by that provider's installed skills. Deduped by cmd. `home` injectable for tests.
export function providerCommands(providerId: string, wsPath: string | undefined, home = homedir()): ProviderCommand[] {
  const out: ProviderCommand[] = []
  const seen = new Set<string>()
  const add = (c: ProviderCommand) => { if (!seen.has(c.cmd)) { seen.add(c.cmd); out.push(c) } }

  for (const { base, dir } of COMMAND_DIRS[providerId] ?? []) {
    const root = base === 'home' ? join(home, dir) : (wsPath ? join(wsPath, dir) : null)
    if (root) scanCommandDir(root).forEach(add)
  }
  const src = SKILL_SOURCE[providerId]
  if (src) {
    for (const s of readInstalledSkills(home, true).filter(s => s.source === src)) {
      add({ cmd: '/' + s.name, title: s.name, desc: s.description, template: `请使用「${s.name}」技能来完成:\n`, kind: 'skill' })
    }
  }
  return out
}
