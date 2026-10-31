import { describe, expect, it } from 'vitest'
import type { Tool } from '../../lib/tools/types'
import { family, toolDefs, TOOLSETS, toolsetFor } from './family'

describe('family', () => {
  it.each([
    ['chatgpt', 'anything', 'gpt'],
    [undefined, 'gpt-5', 'gpt'],
    [undefined, 'GPT-4.1', 'gpt'],
    [undefined, 'o3-mini', 'gpt'],
    [undefined, 'o4', 'gpt'],
    [undefined, 'codex-mini-latest', 'gpt'],
    [undefined, 'openai/gpt-5', 'gpt'],
    [undefined, 'claude-sonnet-4-5', 'claude'],
    [undefined, 'anthropic/claude-opus-4', 'claude'],
    ['anthropic', 'kimi-k2', 'generic'],
    [undefined, 'deepseek-chat', 'generic'],
    [undefined, 'ollama-gpt', 'generic'],
    [undefined, 'omni', 'generic'],
    [undefined, undefined, 'generic'],
  ] as const)('%s %s → %s', (protocol, modelId, want) => {
    expect(family(protocol, modelId)).toBe(want)
  })

  it('toolset: gpt → patch, others → edit, session override wins', () => {
    expect(toolsetFor('gpt')).toBe('patch')
    expect(toolsetFor('claude')).toBe('edit')
    expect(toolsetFor('generic')).toBe('edit')
    expect(toolsetFor('gpt', 'edit')).toBe('edit')
    expect(toolsetFor('claude', 'patch')).toBe('patch')
  })

  it('tool names per toolset follow spec §7', () => {
    expect(TOOLSETS.patch).toEqual(['read', 'list', 'glob', 'grep', 'apply_patch', 'shell'])
    expect(TOOLSETS.edit).toEqual(['read', 'list', 'glob', 'grep', 'write', 'edit', 'shell'])
  })

  it('toolDefs keeps the toolset order, skips missing tools, maps only name / description / parameters', () => {
    const t = (name: string): Tool => ({ name, description: `d-${name}`, parameters: { type: 'object' }, permission: () => [], run: async () => ({ content: '' }) })
    const all = ['shell', 'edit', 'apply_patch', 'read', 'extra'].map(t)
    expect(toolDefs(all, 'patch')).toEqual([
      { name: 'read', description: 'd-read', parameters: { type: 'object' } },
      { name: 'apply_patch', description: 'd-apply_patch', parameters: { type: 'object' } },
      { name: 'shell', description: 'd-shell', parameters: { type: 'object' } },
    ])
    expect(toolDefs(all, 'edit').map(d => d.name)).toEqual(['read', 'edit', 'shell'])
  })
})
