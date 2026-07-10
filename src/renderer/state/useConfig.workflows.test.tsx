import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useConfig } from './useConfig'

const wfA = { id: 'a', name: 'A', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] }
const wfB = { id: 'b', name: 'B', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }] }

beforeEach(() => {
  ;(window as any).forge = {
    listProjects: async () => [],
    listWorkflows: async () => [wfA],
    detectProviders: async () => [],
    getSettings: async () => ({ disabledProviders: [] }),
    onSettingsChanged: () => () => {},
    addProject: async () => [], deleteProject: async () => [],
    addWorkflow: vi.fn(async () => [wfA, wfB]),
    deleteWorkflow: vi.fn(async () => [])
  }
})

describe('useConfig workflows CRUD', () => {
  it('addWorkflow + deleteWorkflow update the workflows state', async () => {
    const { result } = renderHook(() => useConfig())
    await waitFor(() => expect(result.current.workflows).toHaveLength(1))
    await act(async () => { await result.current.addWorkflow('B', ['design']) })
    expect((window as any).forge.addWorkflow).toHaveBeenCalledWith({ name: 'B', stages: ['design'] })
    expect(result.current.workflows.map(w => w.id)).toEqual(['a', 'b'])
    await act(async () => { await result.current.deleteWorkflow('a') })
    expect(result.current.workflows).toHaveLength(0)
  })

  it('updateStagePrompts 调用 preload 并刷新 workflows', async () => {
    const updateStagePromptsMock = vi.fn().mockResolvedValue([{ id: 'standard', name: 'S', stages: [], plugins: [], stagePrompts: { design: 'x' } }])
    ;(window as any).forge = { ...(window as any).forge, updateStagePrompts: updateStagePromptsMock }
    const { result } = renderHook(() => useConfig())
    await waitFor(() => expect(result.current.workflows).toHaveLength(1))
    await act(async () => { await result.current.updateStagePrompts('standard', { design: 'x' }) })
    expect(updateStagePromptsMock).toHaveBeenCalledWith('standard', { design: 'x' })
    expect(result.current.workflows).toEqual([{ id: 'standard', name: 'S', stages: [], plugins: [], stagePrompts: { design: 'x' } }])
  })
})
