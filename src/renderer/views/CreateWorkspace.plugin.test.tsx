import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CreateWorkspace } from './CreateWorkspace'
import type { Workspace } from '@shared/types'

const workflows = [{ id: 'standard', name: '标准工作流', stages: [
  { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
  { key: 'develop', defaultAgent: 'claude', defaultModel: 'sonnet-4.6' }
], plugins: [] }]
const providers = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }, { id: 'sonnet-4.6', label: 'sonnet-4.6' }] }]
const projects = [{ id: 'proj1', name: 'proj1', repoUrl: 'git@x:y/proj1.git', defaultBranch: 'main' }]

const defaultProps = {
  open: true as const,
  onCancel: () => {},
  onCreate: () => {},
  projects,
  workflows,
  providers,
  onOpenProjectSettings: () => {},
  onNewWorkflow: vi.fn(),
}

// Helper: the insert "+" now opens a picker (从库选择 / 新建). Click 新建 Hook to reach the blank
// editor, then fill its name field + click add/save.
function fillEditorAndSave(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /新建 Hook/ }))
  const nameInput = screen.getByPlaceholderText(/当前时间 \/ 读取我的记忆/) as HTMLInputElement
  fireEvent.change(nameInput, { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: /添加插件/ }))
}

describe('CreateWorkspace – two-scope plugin editing', () => {
  it('adds a wf-scope plugin between stages and a step-scope plugin at __proj, submits both', () => {
    const onCreate = vi.fn()
    render(<CreateWorkspace {...defaultProps} onCreate={onCreate} />)
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-p' } })

    // --- wf scope: insert after the design stage (data-ovscope="wf") ---
    const wfIns = document.querySelector('.cr-flow-preview .wf-flow [data-ovadd="design"][data-ovscope="wf"]') as HTMLElement
    expect(wfIns).toBeTruthy()
    fireEvent.click(wfIns)
    fillEditorAndSave('wf-plug')

    // --- step scope: insert at the __proj boundary (涉及项目 之后) ---
    const stepIns = document.querySelector('[data-ovadd="__proj"][data-ovscope="step"]') as HTMLElement
    expect(stepIns).toBeTruthy()
    fireEvent.click(stepIns)
    fillEditorAndSave('step-plug')

    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const opts = onCreate.mock.calls[0][0]

    expect(opts.plugins).toHaveLength(1)
    expect(opts.plugins[0]).toMatchObject({ name: 'wf-plug', after: 'design' })
    expect(opts.stepPlugins).toHaveLength(1)
    expect(opts.stepPlugins[0]).toMatchObject({ name: 'step-plug', after: '__proj' })
  })

  it('picks a hook from the library — inserts a snapshot copy at the slot with a fresh id', () => {
    const onCreate = vi.fn()
    const hookLibrary = [{ id: 'hk1', name: '库钩子', prompt: 'p', skills: [], tools: [] }]
    render(<CreateWorkspace {...defaultProps} hookLibrary={hookLibrary} onCreate={onCreate} />)
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-lib' } })

    // Insert at __proj → picker → click the library chip (no 新建 needed).
    fireEvent.click(document.querySelector('[data-ovadd="__proj"][data-ovscope="step"]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /库钩子/ }))

    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    const opts = onCreate.mock.calls[0][0]
    expect(opts.stepPlugins).toHaveLength(1)
    expect(opts.stepPlugins[0]).toMatchObject({ name: '库钩子', prompt: 'p', after: '__proj' })
    // Snapshot copy: a fresh workspace-plugin id, NOT the library id.
    expect(opts.stepPlugins[0].id).not.toBe('hk1')
  })

  it('new inline hook with 保存到 Hook 库 checked calls onSaveHookToLibrary (without an after)', () => {
    const onSaveHookToLibrary = vi.fn()
    render(<CreateWorkspace {...defaultProps} onSaveHookToLibrary={onSaveHookToLibrary} onCreate={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-save' } })

    fireEvent.click(document.querySelector('[data-ovadd="design"][data-ovscope="wf"]') as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: /新建 Hook/ }))
    fireEvent.change(screen.getByPlaceholderText(/当前时间 \/ 读取我的记忆/), { target: { value: '可复用钩子' } })
    fireEvent.click(screen.getByRole('checkbox'))   // 保存到 Hook 库
    fireEvent.click(screen.getByRole('button', { name: /添加插件/ }))

    expect(onSaveHookToLibrary).toHaveBeenCalledTimes(1)
    const saved = onSaveHookToLibrary.mock.calls[0][0]
    expect(saved).toMatchObject({ name: '可复用钩子' })
    expect(saved).not.toHaveProperty('after')
  })

  it('seeds wf-scope plugins from the selected workflow definition (Bug #1)', () => {
    const wfWithHook = [{ id: 'standard', name: '标准工作流', stages: [
      { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      { key: 'develop', defaultAgent: 'claude', defaultModel: 'sonnet-4.6' },
    ], plugins: [{ id: 'pl-wf', name: '流程钩子', prompt: 'x', after: 'design', skills: [], tools: [] }] }]
    const onCreate = vi.fn()
    render(<CreateWorkspace {...defaultProps} workflows={wfWithHook} onCreate={onCreate} />)
    // workflows[0] is selected by default → its plugin hook must be visible in the flow strip.
    expect(screen.getByText('流程钩子')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-h' } })
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    const opts = onCreate.mock.calls[0][0]
    expect(opts.plugins).toContainEqual(expect.objectContaining({ name: '流程钩子', after: 'design' }))
  })

  it('switching to a different workflow replaces seeded plugins; __custom clears them (Bug #1)', () => {
    const wfA = { id: 'a', name: 'A', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [{ id: 'pl-a', name: 'A钩子', prompt: 'x', after: 'design', skills: [], tools: [] }] }
    const wfB = { id: 'b', name: 'B', stages: [{ key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [{ id: 'pl-b', name: 'B钩子', prompt: 'y', after: 'design', skills: [], tools: [] }] }
    render(<CreateWorkspace {...defaultProps} workflows={[wfA, wfB]} onCreate={vi.fn()} />)
    expect(screen.getByText('A钩子')).toBeInTheDocument()
    // switch to workflow B
    fireEvent.click(document.querySelector('[data-crtpl="b"]') as HTMLElement)
    expect(screen.queryByText('A钩子')).not.toBeInTheDocument()
    expect(screen.getByText('B钩子')).toBeInTheDocument()
    // switch to 自定义 → hooks cleared
    fireEvent.click(document.querySelector('[data-crtpl="__custom"]') as HTMLElement)
    expect(screen.queryByText('B钩子')).not.toBeInTheDocument()
  })

  it('prefills plugins/stepPlugins from an editing workspace', () => {
    const editingWs: Workspace = {
      name: '设计迁移', path: '/abs/ws-a', workflowId: 'standard',
      stages: [
        { key: 'design', provider: 'claude', model: 'opus-4.8' },
        { key: 'develop', provider: 'claude', model: 'sonnet-4.6' },
      ],
      // Mirror readWorkspace()'s ensureWorkspaceWorkflows migration.
      workflows: [{
        id: 'standard', name: 'standard',
        stages: [
          { key: 'design', provider: 'claude', model: 'opus-4.8' },
          { key: 'develop', provider: 'claude', model: 'sonnet-4.6' },
        ],
      }],
      projects: [{ repoId: 'proj1', name: 'proj1', branch: 'feat/x', provider: 'claude', model: 'sonnet-4.6' }],
      status: 'ok',
      plugins: [{ id: 'pl-1', name: '我的wf插件', prompt: 'do', after: 'design', skills: [], tools: [] }],
      stepPlugins: [{ id: 'pl-2', name: '我的step插件', prompt: 'do', after: '__proj', skills: [], tools: [] }],
    }
    render(<CreateWorkspace {...defaultProps} editing={editingWs} />)
    expect(screen.getByText('我的wf插件')).toBeInTheDocument()
    expect(screen.getByText('我的step插件')).toBeInTheDocument()
  })
})
