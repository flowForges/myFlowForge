import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addonId, resolveRemovable, scanAddons } from './addons'

/**
 * 拿**真目录**测:这个模块干的就是「磁盘上有什么」,用假 fs 测等于测了个假设。
 */
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'addons-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const skill = (rel: string, name: string, desc = '') => {
  const dir = join(home, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n正文`)
  return dir
}
const file = (rel: string, text = 'x') => {
  const p = join(home, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
  return p
}

describe('scanAddons · skill', () => {
  it('读 frontmatter 的 name/description', () => {
    skill('.claude/skills/code-review', 'code-review', '审查 diff')
    const [a] = scanAddons(home).addons
    expect(a).toMatchObject({ kind: 'skill', provider: 'claude', name: 'code-review', description: '审查 diff' })
  })

  it('★★同一个技能在 claude 和 codex 各装一份 —— 两条都要在(用户点名要的)', () => {
    skill('.claude/skills/writing-plans', 'writing-plans')
    skill('.codex/skills/writing-plans', 'writing-plans')
    const got = scanAddons(home).addons.filter(a => a.name === 'writing-plans')
    expect(got.map(a => a.provider).sort()).toEqual(['claude', 'codex'])
  })

  it('同一个 provider 里同名同路径只算一条(插件包会带好几个版本)', () => {
    const dir = skill('.claude/skills/dup', 'dup')
    writeFileSync(join(dir, 'other.md'), 'x')
    expect(scanAddons(home).addons.filter(a => a.name === 'dup').length).toBe(1)
  })

  it('★插件包里的技能不给单删,并说清该去哪儿卸', () => {
    skill('.claude/plugins/cache/market/superpowers/6.1.1/skills/brainstorming', 'brainstorming')
    const a = scanAddons(home).addons.find(x => x.name === 'brainstorming')!
    expect(a.removable).toBe(false)
    expect(a.removeVia).toBeNull()
    expect(a.note).toContain('插件包')
  })

  it('★标出技能来自哪个包 —— 这台机器实测 178 个技能,不标包名就是一屏认不出的陌生名字', () => {
    skill('.claude/skills/awesome-design-skills/skills/bento', 'bento')
    skill('.claude/skills/solo', 'solo')
    const out = scanAddons(home).addons
    expect(out.find(a => a.name === 'bento')!.pack).toBe('awesome-design-skills')
    expect(out.find(a => a.name === 'solo')!.pack).toBeUndefined()
  })

  it('★插件那条路上取插件名,不取版本号(6.3.0 是噪音)', () => {
    skill('.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/brainstorming', 'brainstorming')
    expect(scanAddons(home).addons.find(a => a.name === 'brainstorming')!.pack).toBe('superpowers')
  })

  it('嵌套的技能目录也扫得到', () => {
    skill('.codex/skills/group/nested-one', 'nested-one')
    expect(scanAddons(home).addons.some(a => a.name === 'nested-one')).toBe(true)
  })

  it('没有 frontmatter 就用目录名', () => {
    const dir = join(home, '.claude/skills/bare')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '没有 frontmatter')
    expect(scanAddons(home).addons[0].name).toBe('bare')
  })
})

describe('scanAddons · rule', () => {
  it('列出存在的全局规则文档;不存在的不列', () => {
    file('.claude/CLAUDE.md')
    const rules = scanAddons(home).addons.filter(a => a.kind === 'rule')
    expect(rules.map(r => r.name)).toEqual(['CLAUDE.md'])
  })
  it('★一个文件被三个 CLI 读 → 列一条 + 说清谁读它(列三遍是噪音)', () => {
    file('.codex/AGENTS.md')
    const r = scanAddons(home).addons.find(a => a.kind === 'rule')!
    expect(r.provider).toBe('codex')
    expect(r.description).toContain('qwen')
  })
})

describe('scanAddons · mcp', () => {
  it('claude 的 .claude.json', () => {
    file('.claude.json', JSON.stringify({ mcpServers: { sentry: { url: 'https://x' }, gdrive: {} } }))
    const names = scanAddons(home).addons.filter(a => a.kind === 'mcp').map(a => a.name).sort()
    expect(names).toEqual(['gdrive', 'sentry'])
  })
  it('codex 的 TOML,并且不把嵌套表当成新服务器', () => {
    file('.codex/config.toml', '[mcp_servers.omx_wiki]\ncommand = "node"\n[mcp_servers.omx_wiki.env]\nA = "1"\n')
    const mcps = scanAddons(home).addons.filter(a => a.kind === 'mcp')
    expect(mcps.map(m => m.name)).toEqual(['omx_wiki'])
    expect(mcps[0]).toMatchObject({ provider: 'codex', removeVia: 'cli' })
  })
  it('配置文件坏了不抛,当成没有', () => {
    file('.claude.json', '{ 这不是 json')
    expect(scanAddons(home).addons.filter(a => a.kind === 'mcp')).toEqual([])
  })
})

describe('installed 标记', () => {
  it('★卸载了的 CLI 留下的东西照样列出来,只是标成未安装 —— 那正是该看见的事', () => {
    skill('.qoder/skills/leftover', 'leftover')
    skill('.claude/skills/live', 'live')
    const out = scanAddons(home, new Set(['claude'])).addons
    expect(out.find(a => a.name === 'leftover')!.installed).toBe(false)
    expect(out.find(a => a.name === 'live')!.installed).toBe(true)
  })
})

describe('resolveRemovable(删之前的闸门)', () => {
  it('认得出刚扫到的那一条', () => {
    const dir = skill('.claude/skills/gone', 'gone')
    const scan = scanAddons(home)
    const a = resolveRemovable(scan, scan.addons[0].id)!
    expect(a.path).toBe(dir)
  })

  it('★★不在扫描结果里的 id 一律拒 —— 否则这就是个「删任意路径」的远程接口', () => {
    skill('.claude/skills/keep', 'keep')
    const scan = scanAddons(home)
    expect(resolveRemovable(scan, addonId('skill', 'claude', 'evil', '/etc/passwd'))).toBeNull()
    expect(resolveRemovable(scan, 'skill:claude:keep:/tmp/somewhere-else')).toBeNull()
  })

  it('★不能删的(插件包里的)也拒', () => {
    skill('.claude/plugins/cache/m/p/1.0/skills/x', 'x')
    const scan = scanAddons(home)
    expect(resolveRemovable(scan, scan.addons[0].id)).toBeNull()
  })

  it('★home 之外的路径拒 —— 扫描器哪天写出个 / 开头的,这一层也拦得住', () => {
    const scan = { home, addons: [{ id: 'x', kind: 'skill' as const, provider: 'claude', name: 'x', path: '/etc/hosts', installed: true, removable: true, removeVia: 'trash' as const }] }
    expect(resolveRemovable(scan, 'x')).toBeNull()
  })

  it('路径已经不在了(手动删过)也拒,而不是让下游去删一个不存在的东西', () => {
    const scan = { home, addons: [{ id: 'x', kind: 'skill' as const, provider: 'claude', name: 'x', path: join(home, '.claude/skills/vanished'), installed: true, removable: true, removeVia: 'trash' as const }] }
    expect(resolveRemovable(scan, 'x')).toBeNull()
  })

  it('mcp 走 CLI,不做路径检查(删的是配置里的一项,不是文件)', () => {
    file('.claude.json', JSON.stringify({ mcpServers: { s1: {} } }))
    const scan = scanAddons(home)
    const a = resolveRemovable(scan, scan.addons[0].id)!
    expect(a).toMatchObject({ kind: 'mcp', removeVia: 'cli', name: 's1' })
  })
})
