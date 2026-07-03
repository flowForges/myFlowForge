import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useConfig } from './useConfig'

beforeEach(() => {
  ;(window as any).forge = {
    listProjects: async () => [{ id: 'p1', name: 'P1', repoUrl: 'u', defaultBranch: 'main' }],
    listWorkflows: async () => [{ id: 'standard', name: '标准工作流', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] }],
    detectProviders: async () => [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] }],
    addProject: async () => [], deleteProject: async () => []
  }
})

describe('useConfig', () => {
  it('loads projects, workflows, providers on mount', async () => {
    const { result } = renderHook(() => useConfig())
    await waitFor(() => expect(result.current.projects).toHaveLength(1))
    expect(result.current.workflows[0].id).toBe('standard')
    expect(result.current.providers[0].installed).toBe(true)
  })
})
