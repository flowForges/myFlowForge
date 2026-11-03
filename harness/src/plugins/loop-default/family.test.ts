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
    [undefined, 'gpt5', 'gpt'],
    [undefined, 'chatgpt-4o-latest', 'gpt'],
    [undefined, 'o1-preview', 'gpt'],
    [undefined, 'codex', 'gpt'],
    [undefined, 'openrouter/openai/o3', 'gpt'],
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

  it('delegate tools follow the toolset in both toolsets, sorted by name; TOOLSETS stays as it was', () => {
    const t = (name: string, delegate?: boolean): Tool => ({ name, description: name, parameters: {}, ...(delegate && { delegate }), permission: () => [], run: async () => ({ content: '' }) })
    const before = structuredClone(TOOLSETS)
    const all = [t('delegate_qoder', true), t('shell'), t('delegate_codex', true), t('read'), t('extra')]
    expect(toolDefs(all, 'patch').map(d => d.name)).toEqual(['read', 'shell', 'delegate_codex', 'delegate_qoder'])
    expect(toolDefs(all, 'edit').map(d => d.name)).toEqual(['read', 'shell', 'delegate_codex', 'delegate_qoder'])
    expect(TOOLSETS).toEqual(before)
    expect(toolDefs([t('read')], 'edit').map(d => d.name)).toEqual(['read'])
  })

  it('order is toolset, then ambient by name, then delegate by name; TOOLSETS stays as it was', () => {
    const t = (name: string, o: Partial<Tool> = {}): Tool => ({ name, description: name, parameters: {}, ...o, permission: () => [], run: async () => ({ content: '' }) })
    const before = structuredClone(TOOLSETS)
    const all = [
      t('delegate_qoder', { delegate: true }), t('memory_write', { ambient: true }), t('shell'), t('delegate_codex', { delegate: true }),
      t('memory_get', { ambient: true }), t('read'), t('memory_search', { ambient: true }), t('extra'),
    ]
    const want = ['read', 'shell', 'memory_get', 'memory_search', 'memory_write', 'delegate_codex', 'delegate_qoder']
    expect(toolDefs(all, 'patch').map(d => d.name)).toEqual(want)
    expect(toolDefs(all, 'edit').map(d => d.name)).toEqual(want)
    expect(toolDefs([...all].reverse(), 'edit').map(d => d.name)).toEqual(want)
    expect(TOOLSETS).toEqual(before)
  })

  it('ambient does not leak into the definition sent to the model', () => {
    const tool: Tool = { name: 'memory_get', description: 'd', parameters: { type: 'object' }, ambient: true, permission: () => [], run: async () => ({ content: '' }) }
    expect(toolDefs([tool], 'edit')).toEqual([{ name: 'memory_get', description: 'd', parameters: { type: 'object' } }])
  })
})
