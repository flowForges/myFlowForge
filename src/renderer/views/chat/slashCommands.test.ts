import { describe, it, expect } from 'vitest'
import { commandsForProvider, isSlashQuery, mergeCommands, SLASH_COMMANDS, type MenuCommand } from './slashCommands'

describe('commandsForProvider', () => {
  it('always includes the universal 工作流 command for any provider', () => {
    for (const p of ['claude', 'codex', 'cursor', 'whatever']) {
      expect(commandsForProvider(p, '/').some(c => c.cmd === '/工作流')).toBe(true)
    }
  })

  it('claude sees claude-only commands but not codex-only', () => {
    const cmds = commandsForProvider('claude', '/').map(c => c.cmd)
    expect(cmds).toContain('/深思')
    expect(cmds).not.toContain('/计划')
  })

  it('codex sees codex-only commands but not claude-only', () => {
    const cmds = commandsForProvider('codex', '/').map(c => c.cmd)
    expect(cmds).toContain('/计划')
    expect(cmds).not.toContain('/深思')
  })

  it('filters by the typed query (token or title)', () => {
    expect(commandsForProvider('claude', '/架').map(c => c.cmd)).toEqual(['/架构'])
    // title match: '工作流' title 发起工作流
    expect(commandsForProvider('claude', '/工作').some(c => c.cmd === '/工作流')).toBe(true)
    expect(commandsForProvider('claude', '/zzz')).toEqual([])
  })

  it('every command carries a non-empty template', () => {
    for (const c of SLASH_COMMANDS) expect(c.template.length).toBeGreaterThan(0)
  })
})

describe('mergeCommands', () => {
  const dyn: MenuCommand[] = [
    { cmd: '/analyst', title: 'analyst', desc: '需求分析', template: '/analyst ', kind: 'command' },
    { cmd: '/awesome', title: 'awesome', desc: 'skill', template: '用 awesome:', kind: 'skill' },
  ]
  it('Forge commands first, then dynamic on-disk commands', () => {
    const merged = mergeCommands('codex', '/', dyn)
    expect(merged[0].kind).toBe('forge')
    expect(merged.some(c => c.cmd === '/analyst' && c.kind === 'command')).toBe(true)
    expect(merged.some(c => c.cmd === '/awesome' && c.kind === 'skill')).toBe(true)
  })
  it('filters dynamic by query too', () => {
    const merged = mergeCommands('codex', '/analy', dyn)
    expect(merged.map(c => c.cmd)).toContain('/analyst')
    expect(merged.map(c => c.cmd)).not.toContain('/awesome')
  })
  it('Forge command wins on a name clash (deduped)', () => {
    const clash: MenuCommand[] = [{ cmd: '/工作流', title: 'x', desc: '', template: '/工作流 ', kind: 'command' }]
    const merged = mergeCommands('claude', '/工作流', clash)
    expect(merged.filter(c => c.cmd === '/工作流')).toHaveLength(1)
    expect(merged.find(c => c.cmd === '/工作流')?.kind).toBe('forge')
  })
})

describe('isSlashQuery', () => {
  it('true while typing a slash token, false once a space or non-slash appears', () => {
    expect(isSlashQuery('/工作')).toBe(true)
    expect(isSlashQuery('/')).toBe(true)
    expect(isSlashQuery('/工作流 做个功能')).toBe(false)  // space → writing the argument
    expect(isSlashQuery('hello')).toBe(false)
    expect(isSlashQuery('')).toBe(false)
  })
})
