import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentContextMeta, AgentContextRef } from '@shared/types'
import { readInstalledSkills } from '../skills/installedSkills'

// System/global (user-scoped) add-ons — the CLI-level skills/rules/MCP that apply across ALL
// workspaces, as opposed to the per-project ones scanned by scanWorkspaceContext. Covers every
// coding CLI this app supports (Claude / Codex / Gemini / Cursor / Qoder). Everything here is
// read-only and fail-open: a missing or malformed config simply contributes nothing.

// Home-level rule docs — the global equivalents of a project's CLAUDE.md / AGENTS.md. `providers` = the
// CLIs that actually read each, so scanGlobalContext can filter to the running provider (see its doc).
const GLOBAL_RULES: { rel: string; reason: string; providers: string[] }[] = [
  { rel: join('.claude', 'CLAUDE.md'), reason: 'Claude Code 全局规则', providers: ['claude'] },
  { rel: 'CLAUDE.md', reason: 'Claude Code 全局规则', providers: ['claude'] }, // ~/CLAUDE.md (older layout)
  { rel: join('.codex', 'AGENTS.md'), reason: 'Codex 全局规则', providers: ['codex', 'qwen', 'agents'] },
  { rel: join('.gemini', 'GEMINI.md'), reason: 'Gemini 全局规则', providers: ['gemini'] },
  { rel: join('.qoder', 'QODER.md'), reason: 'Qoder 全局规则', providers: ['qoder'] },
]

// JSON configs that expose MCP servers under an `mcpServers` object (keys = server names).
const MCP_JSON_SOURCES: { rel: string; reason: string; providers: string[] }[] = [
  { rel: '.claude.json', reason: 'Claude Code MCP', providers: ['claude'] },
  { rel: join('.cursor', 'mcp.json'), reason: 'Cursor MCP', providers: ['cursor'] },
  { rel: join('.gemini', 'settings.json'), reason: 'Gemini MCP', providers: ['gemini'] },
]

const providerReads = (providers: string[], provider?: string) => !provider || providers.includes(provider)

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

// `provider` (running CLI id) filters the result to what THAT CLI actually loads globally: its own
// home rule doc + its own MCP config. Home skills (superpowers etc.) are Claude-ecosystem, so they're
// included only for claude (or when provider is unset — the standalone IPC scan). Omit `provider` to get
// the full cross-CLI union (the CH.contextScanGlobal handler's use).
// `includeSkills=false` (the chat context's use) skips the broad home-skills scan — for chat, skills come
// from the provider-filtered project scan + runtime `mentionedSkills` (what the agent actually names),
// which is more accurate than listing every home/plugin skill dir on disk. The standalone IPC scan keeps
// skills (default true).
export function scanGlobalContext(home = homedir(), provider?: string, includeSkills = true): AgentContextMeta {
  // Skills — reuse the home-scoped skill scanner (includes plugin packs like superpowers). These load
  // under Claude, so don't attribute them to a non-claude session.
  const skills: AgentContextRef[] = includeSkills && providerReads(['claude'], provider)
    ? readInstalledSkills(home, true).map(s => ({ name: s.name, path: s.path, reason: s.source, state: 'ok' as const }))
    : []

  // Rules — home-level rule docs the running CLI reads.
  const rules: AgentContextRef[] = []
  for (const { rel, reason, providers } of GLOBAL_RULES) {
    if (!providerReads(providers, provider)) continue
    const p = join(home, rel)
    if (existsSync(p)) rules.push({ name: basename(rel), path: p, reason, state: 'ok' })
  }

  // MCP — the running CLI's global MCP config (or every CLI's, unfiltered). Dedupe by reason+name so the
  // same server name under two different CLIs stays distinct while an exact repeat collapses.
  const mcps: AgentContextRef[] = []
  const seen = new Set<string>()
  const push = (name: string, path: string, reason: string) => {
    const key = reason + ':' + name
    if (seen.has(key)) return
    seen.add(key)
    mcps.push({ name, path, reason, state: 'ok' })
  }
  for (const { rel, reason, providers } of MCP_JSON_SOURCES) {
    if (!providerReads(providers, provider)) continue
    const p = join(home, rel)
    for (const name of readJsonMcp(p)) push(name, p, reason)
  }
  if (providerReads(['codex', 'qwen', 'agents'], provider)) {
    const codexToml = join(home, '.codex', 'config.toml')
    for (const name of readCodexTomlMcp(codexToml)) push(name, codexToml, 'Codex MCP')
  }

  return { skills, rules, mcps }
}
