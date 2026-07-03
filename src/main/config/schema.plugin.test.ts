import { describe, it, expect } from 'vitest'
import { PluginSchema, WorkflowSchema, WorkspaceSchema } from './schema'

describe('PluginSchema', () => {
  it('parses a full plugin and defaults skills/tools to []', () => {
    const p = PluginSchema.parse({ id: 'p1', name: '当前时间', prompt: '输出时间', after: 'requirement' })
    expect(p).toEqual({ id: 'p1', name: '当前时间', prompt: '输出时间', after: 'requirement', skills: [], tools: [] })
  })
  it('keeps provided skills/tools', () => {
    const p = PluginSchema.parse({ id: 'p2', name: 'x', prompt: 'y', after: '__proj', skills: ['code-review'], tools: ['read', 'bash'] })
    expect(p.skills).toEqual(['code-review']); expect(p.tools).toEqual(['read', 'bash'])
  })
})

describe('Workflow/Workspace plugin fields default to []', () => {
  it('workflow without plugins parses to []', () => {
    const w = WorkflowSchema.parse({ id: 'wf', name: '标准', stages: [{ key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] })
    expect(w.plugins).toEqual([])
  })
  it('workspace without plugins/stepPlugins parses to []', () => {
    const ws = WorkspaceSchema.parse({ name: 'w', path: '/tmp/w', workflowId: 'wf', projects: [] })
    expect(ws.plugins).toEqual([]); expect(ws.stepPlugins).toEqual([])
  })
})
