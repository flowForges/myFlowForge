import { describe, it, expect } from 'vitest'
import { WorkspaceRegistrySchema } from './schema'

describe('WorkspaceRegistrySchema back-compat', () => {
  it('parses legacy {name,path} with lifecycle defaults', () => {
    const r = WorkspaceRegistrySchema.parse({ workspaces: [{ name: 'a', path: '/a' }] })
    expect(r.workspaces[0]).toMatchObject({ name: 'a', path: '/a', createdAt: 0, archived: false, archivedAt: null, description: '' })
  })
  it('keeps lifecycle fields when present', () => {
    const r = WorkspaceRegistrySchema.parse({ workspaces: [{ name: 'a', path: '/a', createdAt: 5, archived: true, archivedAt: 9, description: 'hi' }] })
    expect(r.workspaces[0]).toMatchObject({ createdAt: 5, archived: true, archivedAt: 9, description: 'hi' })
  })
})
