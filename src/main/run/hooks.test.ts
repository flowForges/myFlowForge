import { describe, it, expect } from 'vitest'
import { collectRunHooks, hooksAfter, hookLaneId, buildHookPrompt } from './hooks'
import type { Plugin } from '../../shared/plugin'

const hook = (id: string, after: string, over: Partial<Plugin> = {}): Plugin => ({
  id, name: `H-${id}`, prompt: `do ${id}`, after, skills: [], tools: [], ...over,
})

describe('collectRunHooks', () => {
  it('takes all workflow plugins + only the __wf step plugins (drops __basic/__proj)', () => {
    const plugins = [hook('a', '__start'), hook('b', 'design')]
    const step = [hook('c', '__basic'), hook('d', '__proj'), hook('e', '__wf')]
    expect(collectRunHooks(plugins, step).map(h => h.id)).toEqual(['a', 'b', 'e'])
  })
  it('defaults empty', () => {
    expect(collectRunHooks()).toEqual([])
  })
})

describe('hooksAfter', () => {
  const hooks = [hook('a', '__start'), hook('b', 'design'), hook('c', 'design'), hook('d', '__wf')]
  it('filters by weave point in order', () => {
    expect(hooksAfter(hooks, '__start').map(h => h.id)).toEqual(['a'])
    expect(hooksAfter(hooks, 'design').map(h => h.id)).toEqual(['b', 'c'])
    expect(hooksAfter(hooks, '__wf').map(h => h.id)).toEqual(['d'])
    expect(hooksAfter(hooks, 'develop')).toEqual([])
    expect(hooksAfter(undefined, 'design')).toEqual([])
  })
})

describe('hookLaneId', () => {
  it('namespaces so it never collides with a real stage key', () => {
    expect(hookLaneId('x')).toBe('hook:x')
  })
})

describe('buildHookPrompt', () => {
  it('includes skill directive, task, upstream artifacts, and the hook prompt', () => {
    const p = buildHookPrompt(hook('a', 'design', { skills: ['code-review'], prompt: '扫一遍安全' }),
      [{ path: '/ws/design.md', kind: 'design' }] as any, '实现登录')
    expect(p).toContain('code-review')
    expect(p).toContain('实现登录')
    expect(p).toContain('/ws/design.md')
    expect(p).toContain('扫一遍安全')
    expect(p).toContain('forge_ask')
  })
  it('falls back to a placeholder line when the hook has no prompt', () => {
    const p = buildHookPrompt(hook('a', 'design', { prompt: '' }), [])
    expect(p).toContain('占位步骤')
  })
})
