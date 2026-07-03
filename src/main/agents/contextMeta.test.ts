import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { discoverAgentContext, extractRuntimeContext, forgeMcpContext, mergeAgentContext, scanWorkspaceContext } from './contextMeta'

describe('discoverAgentContext', () => {
  it('finds rules and local skills visible to an agent cwd', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ctx-meta-'))
    const project = join(ws, 'packages', 'web')
    mkdirSync(join(project, '.claude', 'skills', 'reviewer'), { recursive: true })
    mkdirSync(join(project, '.codex', 'skills', 'planner'), { recursive: true })
    writeFileSync(join(ws, 'AGENTS.md'), '# root rules')
    writeFileSync(join(project, 'CLAUDE.md'), '# project rules')
    writeFileSync(join(project, '.claude', 'skills', 'reviewer', 'SKILL.md'), '# reviewer')
    writeFileSync(join(project, '.codex', 'skills', 'planner', 'SKILL.md'), '# planner')

    const meta = discoverAgentContext(project, ws)

    expect(meta.rules.map(r => r.name)).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(meta.skills.map(s => s.name)).toEqual(['planner', 'reviewer'])
  })
})

describe('scanWorkspaceContext rule coverage (multi-CLI)', () => {
  it('detects rules beyond Claude/AGENTS.md: Gemini, Windsurf, Cursor .mdc, Copilot', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ctx-rules-'))
    mkdirSync(join(ws, '.cursor', 'rules'), { recursive: true })
    mkdirSync(join(ws, '.github'), { recursive: true })
    writeFileSync(join(ws, 'CLAUDE.md'), '# claude')
    writeFileSync(join(ws, 'AGENTS.md'), '# agents')
    writeFileSync(join(ws, 'GEMINI.md'), '# gemini')
    writeFileSync(join(ws, '.windsurfrules'), '# windsurf')
    writeFileSync(join(ws, '.cursor', 'rules', 'style.mdc'), '# cursor mdc')
    writeFileSync(join(ws, '.cursor', 'rules', 'notes.txt'), 'ignored — not a rule')
    writeFileSync(join(ws, '.github', 'copilot-instructions.md'), '# copilot')

    const names = scanWorkspaceContext(ws, false).rules.map(r => r.name)
    expect(names).toContain('CLAUDE.md')
    expect(names).toContain('GEMINI.md')
    expect(names).toContain('.windsurfrules')
    expect(names).toContain('style.mdc')
    expect(names).toContain('copilot-instructions.md')
    expect(names).not.toContain('notes.txt')   // non-.md/.mdc files under .cursor/rules are skipped
  })

  it('tags each rule with its ecosystem reason', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ctx-rules-r-'))
    writeFileSync(join(ws, 'GEMINI.md'), '# gemini')
    const rule = scanWorkspaceContext(ws, false).rules.find(r => r.name === 'GEMINI.md')
    expect(rule?.reason).toBe('Gemini CLI 规则')
  })
})

describe('runtime agent context extraction', () => {
  it('extracts actual skill and rule paths from streamed thinking/tool text', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ctx-runtime-'))
    const text = [
      '调用 shell: /bin/zsh -lc "sed -n \'1,220p\' /Users/zghua/.codex/skills/using-superpowers/SKILL.md"',
      '已加载并接受该工作区的 AGENTS.md 指令',
    ].join('\n')

    const meta = extractRuntimeContext(text, ws)

    expect(meta.skills).toEqual([
      expect.objectContaining({ name: 'using-superpowers', path: '/Users/zghua/.codex/skills/using-superpowers/SKILL.md', state: 'ok' }),
    ])
    expect(meta.rules).toEqual([
      expect.objectContaining({ name: 'AGENTS.md', path: 'AGENTS.md', state: 'ok' }),
    ])
  })

  it('merges runtime context without duplicating existing refs', () => {
    const merged = mergeAgentContext(
      { skills: [{ name: 'forge-workflow', path: '.claude/skills/forge-workflow/SKILL.md' }], rules: [] },
      { skills: [{ name: 'forge-workflow', path: '.claude/skills/forge-workflow/SKILL.md', state: 'ok' }], rules: [{ name: 'AGENTS.md', path: 'AGENTS.md' }], mcps: [{ name: 'forge', path: 'mcp://forge' }] },
    )

    expect(merged.skills).toHaveLength(1)
    expect(merged.skills[0].state).toBe('ok')
    expect(merged.rules.map(r => r.name)).toEqual(['AGENTS.md'])
    expect(merged.mcps?.map(r => r.name)).toEqual(['forge'])
  })

  it('describes the forge MCP server from agent env', () => {
    const meta = forgeMcpContext({ FORGE_SOCKET: '/tmp/forge.sock', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/app/forgeMcp.js', FORGE_TOOLS: 'forge_read_context,forge_handoff' })

    expect(meta.mcps).toEqual([
      expect.objectContaining({ name: 'forge', path: 'mcp://forge', state: 'ok' }),
    ])
    expect(meta.mcps?.[0].reason).toContain('forge_read_context')
  })
})
