import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type { AgentContextMeta, AgentContextRef } from '@shared/types'

// Rule-file conventions across the coding CLIs this app supports — not just Claude/AGENTS.md.
// Each carries a `reason` so the UI can show which ecosystem a detected rule belongs to, and the
// `providers` that ACTUALLY read it: the chat context is filtered to the running provider so a Codex
// session no longer lists CLAUDE.md / .claude/skills it never loads (the "已加载" card was previously a
// provider-agnostic folder scan, hence inaccurate). Undefined provider = show all (scanWorkspaceContext).
const RULE_SPECS: { file: string; reason: string; providers: string[] }[] = [
  { file: 'CLAUDE.md', reason: 'Claude Code 规则', providers: ['claude'] },
  { file: 'AGENTS.md', reason: 'Codex / Agents 规则', providers: ['codex', 'qwen', 'agents'] },
  { file: 'GEMINI.md', reason: 'Gemini CLI 规则', providers: ['gemini'] },
  { file: 'QODER.md', reason: 'Qoder 规则', providers: ['qoder'] },
  { file: '.cursorrules', reason: 'Cursor 规则（legacy）', providers: ['cursor'] },
  { file: '.windsurfrules', reason: 'Windsurf 规则', providers: ['windsurf'] },
  { file: 'copilot-instructions.md', reason: 'GitHub Copilot 指令', providers: ['copilot'] },
]
const RULE_FILES = RULE_SPECS.map(s => s.file)
const RULE_REASON = new Map(RULE_SPECS.map(s => [s.file, s.reason]))
const SKILL_DIRS: { dir: string; providers: string[] }[] = [
  { dir: join('.claude', 'skills'), providers: ['claude'] },
  { dir: join('.codex', 'skills'), providers: ['codex'] },
  { dir: join('.qoder', 'skills'), providers: ['qoder'] },
  { dir: join('.cursor', 'skills'), providers: ['cursor'] },
  { dir: join('.agents', 'skills'), providers: ['codex', 'qwen', 'agents'] },
]
// True when `provider` is unset (show everything — the generic workspace scan) or the source belongs to
// that provider's ecosystem.
const providerReads = (providers: string[], provider?: string) => !provider || providers.includes(provider)
const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.forge', '.vite', 'coverage'])

function rel(root: string, path: string): string {
  const r = relative(root, path)
  return r && !r.startsWith('..') ? r : path
}

function pathChain(cwd: string, root: string): string[] {
  const out: string[] = []
  let cur = resolve(cwd)
  const stop = resolve(root)
  while (cur.startsWith(stop)) {
    out.push(cur)
    if (cur === stop) break
    const next = resolve(cur, '..')
    if (next === cur) break
    cur = next
  }
  return out.reverse()
}

function uniqueByPath(items: AgentContextRef[]): AgentContextRef[] {
  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.path)) return false
    seen.add(item.path)
    return true
  })
}

function withLoadedState(item: AgentContextRef): AgentContextRef {
  return { ...item, state: item.state ?? 'ok' }
}

function normPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function skillNameFromPath(path: string): string | null {
  const p = normPath(path)
  const m = p.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md\b/)
  return m?.[1] ?? null
}

function cleanPath(raw: string): string {
  return raw.replace(/^['"`]+|['"`,.;:)]+$/g, '')
}

function extractSkillPaths(text: string): AgentContextRef[] {
  const items: AgentContextRef[] = []
  const re = /(?:^|[\s"'`])((?:~|\/|[A-Za-z]:\/)[^\s"'`]*\/skills\/[^/\s"'`]+\/SKILL\.md)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const path = cleanPath(m[1])
    const name = skillNameFromPath(path)
    if (name) items.push({ name, path, state: 'ok' })
  }
  return uniqueByPath(items)
}

// Skills the agent EXPLICITLY referenced by NAME (next to 技能/skill, or quoted) that are actually
// installed. Catches home/plugin skills (e.g. superpowers/brainstorming) that the workspace scan +
// path-regex miss — the CLI loads them at runtime and usually names them without printing a path.
// Requiring the 技能/skill keyword or quotes keeps common words from false-matching.
export function mentionedSkills(text: string, installed: { name: string; path: string }[]): AgentContextRef[] {
  const items: AgentContextRef[] = []
  for (const s of installed) {
    const n = s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`[「『"'\`]${n}[」』"'\`]|\\b${n}\\b\\s*(?:技能|skill)|(?:技能|skill)\\s*[:：]?\\s*\\b${n}\\b`, 'i')
    if (re.test(text)) items.push({ name: s.name, path: s.path, state: 'ok' })
  }
  return uniqueByPath(items)
}

function extractRuleRefs(text: string, root: string): AgentContextRef[] {
  const items: AgentContextRef[] = []
  const ruleRe = /(?:^|[\s"'`])((?:~|\/|[A-Za-z]:\/)?[^\s"'`]*)?(AGENTS\.md|CLAUDE\.md|GEMINI\.md|QODER\.md|copilot-instructions\.md|\.cursorrules|\.windsurfrules)\b/g
  let m: RegExpExecArray | null
  while ((m = ruleRe.exec(text))) {
    const raw = cleanPath(`${m[1] ?? ''}${m[2]}`)
    const path = raw.includes('/') ? rel(root, raw) : raw
    items.push({ name: basename(raw), path, state: 'ok' })
  }
  return uniqueByPath(items)
}

export function mergeAgentContext(base: AgentContextMeta, next: AgentContextMeta): AgentContextMeta {
  const merge = (a: AgentContextRef[], b: AgentContextRef[]) => {
    const map = new Map<string, AgentContextRef>()
    for (const item of a) map.set(item.path, item)
    for (const item of b) map.set(item.path, { ...(map.get(item.path) ?? {}), ...withLoadedState(item) })
    return Array.from(map.values())
  }
  return { skills: merge(base.skills, next.skills), rules: merge(base.rules, next.rules), mcps: merge(base.mcps ?? [], next.mcps ?? []) }
}

export function extractRuntimeContext(text: string, workspaceRoot: string): AgentContextMeta {
  return {
    skills: extractSkillPaths(text),
    rules: extractRuleRefs(text, workspaceRoot),
  }
}

export function forgeMcpContext(env: NodeJS.ProcessEnv): AgentContextMeta {
  if (!env.FORGE_SOCKET || !env.FORGE_AGENT_ID || !env.FORGE_MCP_ENTRY) return { skills: [], rules: [], mcps: [] }
  const tools = env.FORGE_TOOLS ? `工具: ${env.FORGE_TOOLS}` : '工具: 全部 Forge MCP'
  return {
    skills: [],
    rules: [],
    mcps: [{
      name: 'forge',
      path: 'mcp://forge',
      reason: tools,
      state: 'ok',
    }],
  }
}

function safeReadDir(path: string): string[] {
  try { return readdirSync(path).sort() } catch { return [] }
}

function safeStat(path: string) {
  try { return statSync(path) } catch { return null }
}

function pushWorkspaceRefs(dir: string, root: string, out: AgentContextMeta) {
  for (const file of RULE_FILES) {
    const path = join(dir, file)
    const st = safeStat(path)
    if (st?.isFile()) out.rules.push({ name: basename(path), path: rel(root, path), reason: RULE_REASON.get(file), state: 'ok' })
  }
  // Cursor's modern rules live as .cursor/rules/*.mdc (or *.md) files.
  const cursorRules = join(dir, '.cursor', 'rules')
  const cursorSt = safeStat(cursorRules)
  if (cursorSt?.isDirectory()) {
    for (const entry of safeReadDir(cursorRules)) {
      if (!(entry.endsWith('.mdc') || entry.endsWith('.md'))) continue
      const path = join(cursorRules, entry)
      const st = safeStat(path)
      if (st?.isFile()) out.rules.push({ name: entry, path: rel(root, path), reason: 'Cursor 规则', state: 'ok' })
    }
  }
  for (const { dir: skillDir } of SKILL_DIRS) {
    const full = join(dir, skillDir)
    const st = safeStat(full)
    if (!st?.isDirectory()) continue
    for (const entry of safeReadDir(full)) {
      const skillFile = join(full, entry, 'SKILL.md')
      const skillSt = safeStat(skillFile)
      if (skillSt?.isFile()) out.skills.push({ name: entry, path: rel(root, skillFile), state: 'ok' })
    }
  }
}

export function scanWorkspaceContext(workspaceRoot: string, includeForgeMcp = true): AgentContextMeta {
  const root = resolve(workspaceRoot)
  const rootStat = safeStat(root)
  const out: AgentContextMeta = { skills: [], rules: [], mcps: [] }
  if (!rootStat?.isDirectory()) return includeForgeMcp ? mergeAgentContext(out, { skills: [], rules: [], mcps: [{ name: 'forge', path: 'mcp://forge', reason: 'Forge workflow tools', state: 'ok' }] }) : out

  const walk = (dir: string, depth: number) => {
    pushWorkspaceRefs(dir, root, out)
    if (depth >= 4) return
    for (const entry of safeReadDir(dir)) {
      if (WALK_SKIP.has(entry)) continue
      const path = join(dir, entry)
      const st = safeStat(path)
      if (st?.isDirectory()) walk(path, depth + 1)
    }
  }
  walk(root, 0)

  const scanned = {
    skills: uniqueByPath(out.skills).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 80),
    rules: uniqueByPath(out.rules).sort((a, b) => a.path.localeCompare(b.path)).slice(0, 80),
    mcps: includeForgeMcp ? [{ name: 'forge', path: 'mcp://forge', reason: 'Forge workflow tools', state: 'ok' as const }] : [],
  }
  return scanned
}

function findRules(cwd: string, root: string, provider?: string): AgentContextRef[] {
  const items: AgentContextRef[] = []
  for (const dir of pathChain(cwd, root)) {
    for (const spec of RULE_SPECS) {
      if (!providerReads(spec.providers, provider)) continue
      const path = join(dir, spec.file)
      if (existsSync(path)) items.push({ name: basename(path), path: rel(root, path), reason: spec.reason })
    }
    // Cursor's modern rules dir — only Cursor reads it.
    if (!providerReads(['cursor'], provider)) continue
    const cursorRules = join(dir, '.cursor', 'rules')
    if (existsSync(cursorRules)) {
      for (const entry of readdirSync(cursorRules).sort()) {
        if (!(entry.endsWith('.mdc') || entry.endsWith('.md'))) continue
        const path = join(cursorRules, entry)
        if (statSync(path).isFile()) items.push({ name: entry, path: rel(root, path), reason: 'Cursor 规则' })
      }
    }
  }
  return uniqueByPath(items).slice(0, 12)
}

function findSkills(cwd: string, root: string, provider?: string): AgentContextRef[] {
  const items: AgentContextRef[] = []
  for (const dir of pathChain(cwd, root)) {
    for (const { dir: skillDir, providers } of SKILL_DIRS) {
      if (!providerReads(providers, provider)) continue
      const full = join(dir, skillDir)
      if (!existsSync(full)) continue
      for (const entry of readdirSync(full).sort()) {
        const skillRoot = join(full, entry)
        const skillFile = join(skillRoot, 'SKILL.md')
        if (existsSync(skillFile) && statSync(skillFile).isFile()) {
          items.push({ name: entry, path: rel(root, skillFile) })
        }
      }
    }
  }
  return uniqueByPath(items).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12)
}

// `provider` (the running CLI id, e.g. 'claude'/'codex'/'cursor') filters the scan to the rule files &
// skill dirs that provider actually reads — so the "已加载" card reflects the current agent, not a union
// of every CLI's conventions. Omit it (scanWorkspaceContext's use) to scan all.
export function discoverAgentContext(cwd: string, workspaceRoot = cwd, provider?: string): AgentContextMeta {
  return {
    skills: findSkills(cwd, workspaceRoot, provider),
    rules: findRules(cwd, workspaceRoot, provider),
    mcps: [],
  }
}
