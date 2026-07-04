import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { providerCommands } from './providerCommands'

let home: string
let ws: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-cmd-home-'))
  ws = mkdtempSync(join(tmpdir(), 'forge-cmd-ws-'))
  // codex prompt with frontmatter description
  mkdirSync(join(home, '.codex/prompts'), { recursive: true })
  writeFileSync(join(home, '.codex/prompts', 'analyst.md'), '---\ndescription: "需求分析"\n---\nbody')
  writeFileSync(join(home, '.codex/prompts', 'debugger.md'), 'no frontmatter here')
  // claude home command + workspace command
  mkdirSync(join(home, '.claude/commands'), { recursive: true })
  writeFileSync(join(home, '.claude/commands', 'ship.md'), '---\ndescription: "release"\n---\n')
  mkdirSync(join(ws, '.claude/commands'), { recursive: true })
  writeFileSync(join(ws, '.claude/commands', 'wsonly.md'), 'local')
  // a claude skill
  mkdirSync(join(home, '.claude/skills/awesome'), { recursive: true })
  writeFileSync(join(home, '.claude/skills/awesome', 'SKILL.md'), '---\nname: awesome\ndescription: cool skill\n---\n')
  // a PLUGIN skill in two versions (superpowers-style) — must be found + deduped to one
  for (const v of ['6.0.0', '6.1.0']) {
    const d = join(home, '.claude/plugins/cache/mp/superpowers', v, 'skills/brainstorming')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), `---\nname: brainstorming\ndescription: v-${v}\n---\n`)
  }
})
afterAll(() => { rmSync(home, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }) })

describe('providerCommands', () => {
  it('codex: lists ~/.codex/prompts as commands, description from frontmatter (empty when none)', () => {
    const cmds = providerCommands('codex', undefined, home)
    const analyst = cmds.find(c => c.cmd === '/analyst')
    expect(analyst).toMatchObject({ title: 'analyst', desc: '需求分析', template: '/analyst ', kind: 'command' })
    expect(cmds.find(c => c.cmd === '/debugger')?.desc).toBe('')
  })

  it('claude: merges home commands + workspace commands + claude skills', () => {
    const cmds = providerCommands('claude', ws, home)
    const byCmd = cmds.map(c => c.cmd)
    expect(byCmd).toContain('/ship')      // home command
    expect(byCmd).toContain('/wsonly')    // workspace command
    const skill = cmds.find(c => c.cmd === '/awesome')
    expect(skill).toMatchObject({ kind: 'skill', desc: 'cool skill' })
  })

  it('finds plugin skills (superpowers-style) and dedupes multiple versions to one', () => {
    const cmds = providerCommands('claude', ws, home)
    expect(cmds.filter(c => c.cmd === '/brainstorming')).toHaveLength(1)
    expect(cmds.find(c => c.cmd === '/brainstorming')?.kind).toBe('skill')
  })

  it('unknown provider with no dirs → empty', () => {
    expect(providerCommands('nope', ws, home)).toEqual([])
  })
})
