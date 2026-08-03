import { describe, it, expect } from 'vitest'
import { collectRunHooks, hooksAfter, hookLaneId, buildHookPrompt, startHookKeys } from './hooks'
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

describe('startHookKeys', () => {
  it('is just __start with no lead stages (a normal full run)', () => {
    expect(startHookKeys()).toEqual(['__start'])
    expect(startHookKeys([])).toEqual(['__start'])
  })
  it('appends each lead-stage key so an after-<leadStage> hook fires at run start', () => {
    // Conversational tail run: design ran in chat (now a leadStage), the tail plan is [develop,test,review].
    // A hook `after: 'design'` must fire at the tail start — startHookKeys folds design's key in so
    // runHooksAfter / the adapter pick it up (regression: it was silently dropped before).
    expect(startHookKeys([{ key: 'requirement' }, { key: 'design' }])).toEqual(['__start', 'requirement', 'design'])
    const hooks = [hook('a', '__start'), hook('b', 'design'), hook('c', 'develop')]
    const startFired = startHookKeys([{ key: 'design' }]).flatMap((k) => hooksAfter(hooks, k)).map((h) => h.id)
    expect(startFired).toEqual(['a', 'b']) // after-design (b) joins __start (a); after-develop (c) stays for the develop stage
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
