import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentContextMeta, AgentContextRef } from '@shared/types'
import { readInstalledSkills } from '../skills/installedSkills'

// System/global (user-scoped) add-ons — the CLI-level skills/rules/MCP that apply across ALL
// workspaces, as opposed to the per-project ones scanned by scanWorkspaceContext. Covers every
// coding CLI this app supports (Claude / Codex / Gemini / Cursor / Qoder). Everything here is
// read-only and fail-open: a missing or malformed config simply contributes nothing.

// Home-level rule docs — the global equivalents of a project's CLAUDE.md / AGENTS.md.
const GLOBAL_RULES: { rel: string; reason: string }[] = [
  { rel: join('.claude', 'CLAUDE.md'), reason: 'Claude Code 全局规则' },
  { rel: 'CLAUDE.md', reason: 'Claude Code 全局规则' }, // ~/CLAUDE.md (older layout)
  { rel: join('.codex', 'AGENTS.md'), reason: 'Codex 全局规则' },
  { rel: join('.gemini', 'GEMINI.md'), reason: 'Gemini 全局规则' },
  { rel: join('.qoder', 'QODER.md'), reason: 'Qoder 全局规则' },
]

// JSON configs that expose MCP servers under an `mcpServers` object (keys = server names).
const MCP_JSON_SOURCES: { rel: string; reason: string }[] = [
  { rel: '.claude.json', reason: 'Claude Code MCP' },
  { rel: join('.cursor', 'mcp.json'), reason: 'Cursor MCP' },
  { rel: join('.gemini', 'settings.json'), reason: 'Gemini MCP' },
]

function readJsonMcp(path: string): string[] {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    const servers = j?.mcpServers
    return servers && typeof servers === 'object' ? Object.keys(servers) : []
  } catch { return [] }
}

// Codex stores MCP in TOML as top-level `[mcp_servers.<name>]` tables. Capture only the first
// segment after `mcp_servers.` so nested tables (`[mcp_servers.x.env]`, `[mcp_servers.x.tools.y]`)
// don't leak in as phantom servers.
function readCodexTomlMcp(path: string): string[] {
  try {
    const text = readFileSync(path, 'utf8')
    const names = new Set<string>()
    const re = /^\s*\[mcp_servers\.([^.\]\s]+)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) names.add(m[1])
    return [...names]
  } catch { return [] }
}

export function scanGlobalContext(home = homedir()): AgentContextMeta {
  // Skills — reuse the home-scoped skill scanner (includes plugin packs like superpowers).
  const skills: AgentContextRef[] = readInstalledSkills(home, true).map(s => ({
    name: s.name, path: s.path, reason: s.source, state: 'ok',
  }))

  // Rules — existing home-level rule docs, one per CLI convention.
  const rules: AgentContextRef[] = []
  for (const { rel, reason } of GLOBAL_RULES) {
    const p = join(home, rel)
    if (existsSync(p)) rules.push({ name: basename(rel), path: p, reason, state: 'ok' })
  }

  // MCP — union of every CLI's global MCP config. Dedupe by reason+name so the same server name
  // under two different CLIs stays distinct while an exact repeat collapses.
  const mcps: AgentContextRef[] = []
  const seen = new Set<string>()
  const push = (name: string, path: string, reason: string) => {
    const key = reason + ':' + name
    if (seen.has(key)) return
    seen.add(key)
    mcps.push({ name, path, reason, state: 'ok' })
  }
  for (const { rel, reason } of MCP_JSON_SOURCES) {
    const p = join(home, rel)
    for (const name of readJsonMcp(p)) push(name, p, reason)
  }
  const codexToml = join(home, '.codex', 'config.toml')
  for (const name of readCodexTomlMcp(codexToml)) push(name, codexToml, 'Codex MCP')

  return { skills, rules, mcps }
}
