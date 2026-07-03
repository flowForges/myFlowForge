import { describe, it, expect } from 'vitest'
import { weavePlugins } from './pluginWeave'
import type { Plugin } from '../../shared/plugin'

const mk = (id: string, after: string): Plugin => ({ id, name: id, prompt: 'x', after, skills: [], tools: [] })
const stages = [{ key: 'requirement' }, { key: 'design' }, { key: 'develop' }]

describe('weavePlugins', () => {
  it('places __start hooks before all stages', () => {
    const w = weavePlugins(stages, [mk('a', '__start')])
    expect(w[0]).toEqual({ kind: 'hook', plugin: mk('a', '__start') })
    expect(w[1]).toEqual({ kind: 'stage', stage: { key: 'requirement' } })
  })
  it('places a hook right after its after-stage', () => {
    const w = weavePlugins(stages, [mk('a', 'requirement')])
    expect(w.map(s => s.kind === 'hook' ? 'h:' + s.plugin.id : s.stage.key))
      .toEqual(['requirement', 'h:a', 'design', 'develop'])
  })
  it('preserves order of multiple hooks at the same boundary', () => {
    const w = weavePlugins(stages, [mk('a', 'design'), mk('b', 'design')])
    expect(w.filter(s => s.kind === 'hook').map(s => (s as any).plugin.id)).toEqual(['a', 'b'])
  })
  it('drops hooks whose after is not an enabled stage', () => {
    const w = weavePlugins(stages, [mk('z', 'test')])
    expect(w.some(s => s.kind === 'hook')).toBe(false)
  })
})
