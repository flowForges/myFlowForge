import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
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

describe('CreateWorkspace', () => {
  it('builds opts from path + project selection and calls onCreate', () => {
    const onCreate = vi.fn(); const onCancel = vi.fn()
    render(<CreateWorkspace open onCancel={onCancel} onCreate={onCreate} projects={projects} workflows={workflows} providers={providers} onOpenProjectSettings={() => {}} onNewWorkflow={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-a' } })
    // select the project
    fireEvent.click(screen.getByText('proj1'))
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const opts = onCreate.mock.calls[0][0]
    expect(opts.name).toBe('ws-a')
    expect(opts.projects.map((p: any) => p.repoId)).toContain('proj1')
  })

  it('picks a directory via onPickPath and fills the path input', async () => {
    const onPickPath = vi.fn(async () => '/Users/me/code/picked')
    render(<CreateWorkspace open onCancel={() => {}} onCreate={() => {}} projects={projects} workflows={workflows} providers={providers} onOpenProjectSettings={() => {}} onNewWorkflow={() => {}} onPickPath={onPickPath} />)
    fireEvent.click(screen.getByText('选择…'))
    expect(onPickPath).toHaveBeenCalled()
    await waitFor(() => expect((screen.getByPlaceholderText('~/code/') as HTMLInputElement).value).toBe('/Users/me/code/picked'))
  })

  it('shows an error banner when the error prop is set', () => {
    render(<CreateWorkspace open onCancel={() => {}} onCreate={() => {}} projects={projects} workflows={workflows} providers={providers} onOpenProjectSettings={() => {}} onNewWorkflow={() => {}} error="git clone 失败" />)
    expect(screen.getByText(/创建失败：git clone 失败/)).toBeInTheDocument()
  })

  it('calls onNewWorkflow when the [data-crnewwf] add button is clicked', () => {
    const onNewWorkflow = vi.fn()
    render(<CreateWorkspace {...defaultProps} onNewWorkflow={onNewWorkflow} />)
    const addBtn = document.querySelector('[data-crnewwf]') as HTMLElement
    expect(addBtn).toBeTruthy()
    fireEvent.click(addBtn)
    expect(onNewWorkflow).toHaveBeenCalledTimes(1)
  })

  it('disables the create button and shows a pending label while creating', () => {
    const onCreate = vi.fn()
    render(<CreateWorkspace {...defaultProps} onCreate={onCreate} creating />)
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-x' } })
    const createBtn = screen.getByRole('button', { name: /创建中/ })
    expect(createBtn).toBeDisabled()
    fireEvent.click(createBtn)
    expect(onCreate).not.toHaveBeenCalled()   // in-flight: no double-submit
  })

  it('includes per-project provider in the create payload when a project is selected', () => {
    // providers has claude + a second "codex" provider so the project model picker has both options
    const providersWithCodex = [
      ...providers,
      { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }] }
    ]
    const onCreate = vi.fn()
    render(
      <CreateWorkspace
        open
        onCancel={() => {}}
        onCreate={onCreate}
        projects={projects}
        workflows={workflows}
        providers={providersWithCodex}
        onOpenProjectSettings={() => {}}
        onNewWorkflow={() => {}}
      />
    )
    // set path so workspace name resolves
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/ws-c' } })
    // select the project
    fireEvent.click(screen.getByText('proj1'))
    // change the per-project model to the codex option using the data-stpm selector
    const projModelSel = document.querySelector('[data-stpm="proj1"]') as HTMLSelectElement
    if (projModelSel) fireEvent.change(projModelSel, { target: { value: 'codex::gpt-5-codex' } })
    // create
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const opts = onCreate.mock.calls[0][0]
    const proj = opts.projects.find((p: any) => p.repoId === 'proj1')
    expect(proj).toBeDefined()
    // The provider field must be carried through (was previously stripped in doCreate)
    expect(proj.provider).toBe('codex')
    expect(proj.model).toBe('gpt-5-codex')
  })
})

describe('CreateWorkspace – custom model', () => {
  it('stage model select has a 「自定义…」option', () => {
    render(<CreateWorkspace {...defaultProps} />)
    // design stage is enabled in the standard workflow
    const sel = document.querySelector('[data-stmodel="design"]') as HTMLSelectElement
    expect(sel).toBeTruthy()
    expect(Array.from(sel.options).map(o => o.value)).toContain('__custom__')
  })

  it('selecting 自定义 in a stage model select reveals a text input', () => {
    render(<CreateWorkspace {...defaultProps} />)
    const sel = document.querySelector('[data-stmodel="design"]') as HTMLSelectElement
    fireEvent.change(sel, { target: { value: '__custom__' } })
    const input = document.querySelector('[data-stmodel-custom="design"]') as HTMLInputElement
    expect(input).toBeTruthy()
  })

  it('entering a custom model id stores it as provider::id in stage model', () => {
    const onCreate = vi.fn()
    render(<CreateWorkspace {...defaultProps} onCreate={onCreate} />)
    fireEvent.change(screen.getByPlaceholderText(/~\/code|路径/i), { target: { value: '~/code/cust' } })
    // design stage is enabled in the standard workflow
    const sel = document.querySelector('[data-stmodel="design"]') as HTMLSelectElement
    fireEvent.change(sel, { target: { value: '__custom__' } })
    const input = document.querySelector('[data-stmodel-custom="design"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'my-custom-123' } })
    // blur to confirm (as the form uses onBlur)
    fireEvent.blur(input)
    // submit
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const opts = onCreate.mock.calls[0][0]
    const stage = opts.stages.find((s: any) => s.key === 'design')
    expect(stage).toBeDefined()
    expect(stage.model).toBe('my-custom-123')
    expect(stage.provider).toBe('claude')
  })
})

const editingWs: Workspace = {
  name: '设计迁移', path: '/abs/ws-a', workflowId: 'standard',
  stages: [
    { key: 'design', provider: 'claude', model: 'opus-4.8' },
    { key: 'develop', provider: 'claude', model: 'sonnet-4.6' },
  ],
  projects: [{ repoId: 'proj1', name: 'proj1', branch: 'feat/x', provider: 'claude', model: 'sonnet-4.6' }],
  status: 'ok',
  plugins: [],
  stepPlugins: [],
}

describe('CreateWorkspace – edit mode', () => {
  it('renders edit title, save label, read-only path, prefilled name', () => {
    render(<CreateWorkspace {...defaultProps} editing={editingWs} />)
    expect(screen.getByText('编辑工作区')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /保存修改/ })).toBeInTheDocument()
    const path = screen.getByPlaceholderText('~/code/') as HTMLInputElement
    expect(path.value).toBe('/abs/ws-a')
    expect(path.readOnly).toBe(true)
    expect(screen.queryByText('选择…')).toBeNull()
    expect(screen.getByDisplayValue('设计迁移')).toBeInTheDocument()
  })

  it('locks already-included projects (cannot be deselected) and submits them', () => {
    const onCreate = vi.fn()
    render(<CreateWorkspace {...defaultProps} editing={editingWs} onCreate={onCreate} />)
    fireEvent.click(within(document.querySelector('#crProjs') as HTMLElement).getByText('proj1'))   // included → click must NOT remove it
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const opts = onCreate.mock.calls[0][0]
    expect(opts.projects.map((p: any) => p.repoId)).toContain('proj1')
    expect(opts.name).toBe('设计迁移')
  })

  it('shows a save-failed banner (not create-failed) in edit mode', () => {
    render(<CreateWorkspace {...defaultProps} editing={editingWs} error="worktree 失败" />)
    expect(screen.getByText(/保存失败：worktree 失败/)).toBeInTheDocument()
  })

  it('can add a new (non-locked) known project in edit mode', () => {
    const onCreate = vi.fn()
    const projectsPlus = [
      ...projects,
      { id: 'proj2', name: 'proj2', repoUrl: 'git@x:y/proj2.git', defaultBranch: 'main' },
    ]
    render(<CreateWorkspace {...defaultProps} projects={projectsPlus} editing={editingWs} onCreate={onCreate} />)
    // proj2 is NOT in editingWs → unlocked → selectable
    fireEvent.click(within(document.querySelector('#crProjs') as HTMLElement).getByText('proj2'))
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const opts = onCreate.mock.calls[0][0]
    const ids = opts.projects.map((p: any) => p.repoId)
    expect(ids).toContain('proj1')   // existing locked project still included
    expect(ids).toContain('proj2')   // newly added project included
  })
})
