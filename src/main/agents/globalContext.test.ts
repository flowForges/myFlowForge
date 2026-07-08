import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanGlobalContext } from './globalContext'

let home: string
beforeEach(() => { home = join(tmpdir(), 'gctx-' + Math.random().toString(36).slice(2)); mkdirSync(home) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

function write(rel: string, body: string) {
  const p = join(home, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

describe('scanGlobalContext', () => {
  it('collects home-level skills across CLIs', () => {
    write('.claude/skills/code-review/SKILL.md', '---\nname: code-review\ndescription: d\n---')
    write('.codex/skills/sec/SKILL.md', '---\nname: sec\n---')
    const out = scanGlobalContext(home)
    expect(out.skills.map(s => s.name).sort()).toEqual(['code-review', 'sec'])
    expect(out.skills.every(s => s.state === 'ok')).toBe(true)
    expect(out.skills.find(s => s.name === 'code-review')?.reason).toBe('Claude')
  })

  it('detects home-level rule docs per CLI convention', () => {
    write('.codex/AGENTS.md', 'rules')
    write('.gemini/GEMINI.md', 'rules')
    write('.claude/CLAUDE.md', 'rules')
    const out = scanGlobalContext(home)
    const names = out.rules.map(r => r.name).sort()
    expect(names).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'])
    expect(out.rules.find(r => r.name === 'AGENTS.md')?.reason).toBe('Codex 全局规则')
  })

  it('parses MCP servers from JSON (claude/cursor/gemini) and codex TOML', () => {
    write('.claude.json', JSON.stringify({ mcpServers: { fs: {}, git: {} } }))
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { puppeteer: {} } }))
    write('.codex/config.toml', [
      '[mcp_servers.omx_state]',
      'command = "x"',
      '[mcp_servers.omx_state.env]', // nested — must NOT become its own server
      'A = "1"',
      '[mcp_servers.node_repl]',
      'command = "y"',
    ].join('\n'))
    const out = scanGlobalContext(home)
    const names = out.mcps!.map(m => m.name).sort()
    expect(names).toEqual(['fs', 'git', 'node_repl', 'omx_state', 'puppeteer'])
    expect(out.mcps!.find(m => m.name === 'omx_state')?.reason).toBe('Codex MCP')
  })

  it('fails open on missing/malformed configs', () => {
    write('.claude.json', '{ not json')
    const out = scanGlobalContext(home)
    expect(out).toEqual({ skills: [], rules: [], mcps: [] })
  })

  it('dedupes a repeated server within the same CLI but keeps same name across CLIs distinct', () => {
    write('.cursor/mcp.json', JSON.stringify({ mcpServers: { git: {} } }))
    write('.gemini/settings.json', JSON.stringify({ mcpServers: { git: {} } }))
    const out = scanGlobalContext(home)
    // same name "git" under two CLIs → two distinct entries (different reason)
    expect(out.mcps!.filter(m => m.name === 'git')).toHaveLength(2)
    expect(new Set(out.mcps!.map(m => m.reason))).toEqual(new Set(['Cursor MCP', 'Gemini MCP']))
  })
})
