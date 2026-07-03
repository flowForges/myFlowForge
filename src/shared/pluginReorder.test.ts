import { describe, it, expect } from 'vitest'
import { movePluginBefore } from './pluginReorder'
import type { Plugin } from './plugin'

describe('movePluginBefore', () => {
  const createPlugin = (id: string, name: string, after: string): Plugin => ({
    id,
    name,
    prompt: `Prompt for ${name}`,
    after,
    skills: [],
    tools: [],
  })

  it('reorder within same after: [A, B, C] drag B before A → [B, A, C]', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'root')
    const C = createPlugin('c', 'C', 'root')
    const plugins = [A, B, C]

    const result = movePluginBefore(plugins, 'b', 'a')

    expect(result).toEqual([B, A, C])
    expect(plugins).toEqual([A, B, C]) // Original unchanged
  })

  it('reorder forward: [A, B, C] drag A before C → [B, A, C]', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'root')
    const C = createPlugin('c', 'C', 'root')
    const plugins = [A, B, C]

    const result = movePluginBefore(plugins, 'a', 'c')

    expect(result).toEqual([B, A, C])
    expect(plugins).toEqual([A, B, C]) // Original unchanged
  })

  it('no-op across different after (drag.after !== target.after): returns same array ref', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'hook1')
    const C = createPlugin('c', 'C', 'root')
    const plugins = [A, B, C]

    const result = movePluginBefore(plugins, 'a', 'b')

    expect(result).toBe(plugins) // Same reference
  })

  it('no-op for unknown dragId: returns same array ref', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'root')
    const plugins = [A, B]

    const result = movePluginBefore(plugins, 'unknown', 'a')

    expect(result).toBe(plugins) // Same reference
  })

  it('no-op for unknown targetId: returns same array ref', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'root')
    const plugins = [A, B]

    const result = movePluginBefore(plugins, 'a', 'unknown')

    expect(result).toBe(plugins) // Same reference
  })

  it('no-op when dragId === targetId: returns same array ref', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'root')
    const plugins = [A, B]

    const result = movePluginBefore(plugins, 'a', 'a')

    expect(result).toBe(plugins) // Same reference
  })

  it('input not mutated: original array unchanged after call', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'root')
    const C = createPlugin('c', 'C', 'root')
    const plugins = [A, B, C]
    const originalOrder = plugins.map(p => p.id)

    movePluginBefore(plugins, 'b', 'a')

    expect(plugins.map(p => p.id)).toEqual(originalOrder)
  })

  it('drag backward: [A, B, C, D] drag C before A → [C, A, B, D]', () => {
    const A = createPlugin('a', 'A', 'root')
    const B = createPlugin('b', 'B', 'root')
    const C = createPlugin('c', 'C', 'root')
    const D = createPlugin('d', 'D', 'root')
    const plugins = [A, B, C, D]

    const result = movePluginBefore(plugins, 'c', 'a')

    expect(result).toEqual([C, A, B, D])
    expect(plugins).toEqual([A, B, C, D]) // Original unchanged
  })
})
