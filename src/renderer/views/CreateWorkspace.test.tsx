import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { CreateWorkspace } from './CreateWorkspace'
import type { Workspace } from '@shared/types'

const workflows = [{ id: 'standard', name: '标准工作流', stages: [
  { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
  { key: 'develop', defaultAgent: 'claude', defaultModel: 'sonnet-4.6' }
], plugins: [] }]
const providers = [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }, { id: 'sonnet-4.6', label: 'sonnet-4.6' }] }]
const projects = [{ id: 'proj1', name: 'proj1', repoUrl: 'git@x:y/proj1.git', defaultBranch: 'main' }]

// A detected in-place row's .pj-name div holds both the name text AND a nested 就地·不克隆 tag <span>,
// so its combined textContent no longer equals the bare name — screen.getByText(name) can't find it.
// Locate the row by its .pj-name prefix instead.
const projRowByName = (name: string): HTMLElement =>
  Array.from(document.querySelectorAll('.cr-proj')).find(r => r.querySelector('.pj-name')?.textContent?.startsWith(name)) as HTMLElement

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

  it('detects an unfinished creation on the picked folder: restores config, shows the banner, and 清除重来 discards + resets', async () => {
    const partialWs: Workspace = {
      name: 'ws-p', path: '/abs/ws-p', workflowId: 'standard',
      stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }],
      // As on disk, readWorkspace() migrates legacy workflowId+stages into `workflows` (ensureWorkspaceWorkflows)
      // before the renderer ever sees it — mirror that here so buildEditState gets a real workflow tab.
      workflows: [{ id: 'standard', name: 'standard', stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }] }],
      projects: [{ repoId: 'proj1', name: 'proj1', branch: 'feat/x', provider: 'claude', model: 'opus-4.8' }],
      status: 'idle', plugins: [], stepPlugins: [],
    }
    const onProbeWorkspace = vi.fn(async () => partialWs)
    const onDiscardPartial = vi.fn(async () => {})
    render(<CreateWorkspace {...defaultProps}
      onPickPath={async () => '/abs/ws-p'}
      onProbeWorkspace={onProbeWorkspace}
      onDiscardPartial={onDiscardPartial} />)
    fireEvent.click(screen.getByText('选择…'))
    // banner appears once the async probe resolves, and the path is restored
    expect(await screen.findByText('检测到未完成的创建')).toBeInTheDocument()
    expect(onProbeWorkspace).toHaveBeenCalledWith('/abs/ws-p')
    expect((screen.getByPlaceholderText('~/code/') as HTMLInputElement).value).toBe('/abs/ws-p')
    // 清除重来 → discards the partial and resets the wizard (banner gone, path cleared)
    fireEvent.click(screen.getByRole('button', { name: /清除重来/ }))
    await waitFor(() => expect(onDiscardPartial).toHaveBeenCalledWith('/abs/ws-p'))
    await waitFor(() => expect(screen.queryByText('检测到未完成的创建')).toBeNull())
    expect((screen.getByPlaceholderText('~/code/') as HTMLInputElement).value).toBe('')
  })

  it('auto-scans the picked folder and prepopulates 涉及项目 with detected repos, pre-checked in-place (Task 5)', async () => {
    const onPickPath = vi.fn(async () => '/Users/me/code/ws-scan')
    const scanRepos = vi.fn(async () => [
      { name: 'api', relPath: 'api', absPath: '/Users/me/code/ws-scan/api', branch: 'main' },
      { name: 'lib', relPath: 'packages/lib', absPath: '/Users/me/code/ws-scan/packages/lib', branch: 'dev' },
    ])
    ;(globalThis as any).window.forge = { scanRepos }
    const onCreate = vi.fn()
    render(<CreateWorkspace {...defaultProps} onCreate={onCreate} onPickPath={onPickPath} />)
    fireEvent.click(screen.getByText('选择…'))
    expect(onPickPath).toHaveBeenCalled()
    await waitFor(() => expect(scanRepos).toHaveBeenCalledWith('/Users/me/code/ws-scan'))
    // both detected repos show up as pre-checked rows, tagged 就地·不克隆, showing their current branch
    await waitFor(() => expect(projRowByName('api')).toBeTruthy())
    expect(projRowByName('packages/lib')).toBeTruthy()
    expect(screen.getAllByText('就地·不克隆')).toHaveLength(2)
    const apiRow = projRowByName('api')
    expect(apiRow.className).toContain(' on')   // pre-checked
    expect((within(apiRow).getByDisplayValue('main'))).toBeInTheDocument()
    const libRow = projRowByName('packages/lib')
    expect((within(libRow).getByDisplayValue('dev'))).toBeInTheDocument()
    // the registered project (proj1) is untouched, still present alongside the in-place rows
    expect(screen.getByText('proj1')).toBeInTheDocument()
    // create → both in-place repos carry inPlace:true + repoId = relPath (so <wsPath>/<repoId> resolves)
    fireEvent.click(screen.getByRole('button', { name: /创建/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    const opts = onCreate.mock.calls[0][0]
    const api = opts.projects.find((p: any) => p.repoId === 'api')
    const lib = opts.projects.find((p: any) => p.repoId === 'packages/lib')
    expect(api).toMatchObject({ repoId: 'api', branch: 'main', inPlace: true })
    expect(lib).toMatchObject({ repoId: 'packages/lib', branch: 'dev', inPlace: true })
    delete (globalThis as any).window.forge
  })

  it('re-picking a DIFFERENT folder replaces the previously-detected in-place rows, no leak (Task 5)', async () => {
    const scanRepos = vi.fn()
      .mockResolvedValueOnce([{ name: 'api', relPath: 'api', absPath: '/a/api', branch: 'main' }])
      .mockResolvedValueOnce([{ name: 'svc', relPath: 'svc', absPath: '/b/svc', branch: 'trunk' }])
    ;(globalThis as any).window.forge = { scanRepos }
    let call = 0
    const onPickPath = vi.fn(async () => (++call === 1 ? '/a' : '/b'))
    render(<CreateWorkspace {...defaultProps} onPickPath={onPickPath} />)
    fireEvent.click(screen.getByText('选择…'))
    await waitFor(() => expect(projRowByName('api')).toBeTruthy())
    fireEvent.click(screen.getByText('选择…'))
    await waitFor(() => expect(projRowByName('svc')).toBeTruthy())
    expect(projRowByName('api')).toBeFalsy()   // the first folder's detected row is gone, not leaked
    delete (globalThis as any).window.forge
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

  it('renders only the enabled stages and can add a disabled one', () => {
    // standard workflow enables design+develop → exactly 2 stage rows, not all 5 greyed
    render(<CreateWorkspace {...defaultProps} />)
    expect(document.querySelectorAll('[data-stage]').length).toBe(2)
    // the other stages are offered via an add-stage control
    const addReq = document.querySelector('[data-addstage="requirement"]') as HTMLElement
    expect(addReq).toBeTruthy()
    fireEvent.click(addReq)
    expect(document.querySelectorAll('[data-stage]').length).toBe(3)
    // adding a stage no longer offers it in the add control
    expect(document.querySelector('[data-addstage="requirement"]')).toBeNull()
  })

  it('adds a project inline and auto-selects it (P1)', async () => {
    function Harness() {
      const [projs, setProjs] = useState(projects)
      return <CreateWorkspace {...defaultProps} projects={projs}
        onAddProject={async (repoUrl, branch) => {
          const list = [...projs, { id: 'proj2', name: 'proj2', repoUrl, defaultBranch: branch }]
          setProjs(list); return list
        }} />
    }
    render(<Harness />)
    fireEvent.change(document.querySelector('[data-crnewproj-repo]') as HTMLElement, { target: { value: 'git@x:y/proj2.git' } })
    fireEvent.click(document.querySelector('[data-crnewproj-add]') as HTMLElement)
    // the new project appears as a second project row...
    await waitFor(() => expect(document.querySelector('[data-pi="1"]')).toBeTruthy())
    const row = document.querySelector('[data-pi="1"]') as HTMLElement
    expect(row.querySelector('.pj-name')?.textContent).toBe('proj2')
    expect(row.className).toContain('on')   // ...and is auto-selected
  })

  it('creates a workflow inline and selects it (P2b)', async () => {
    function Harness() {
      const [wfs, setWfs] = useState(workflows)
      return <CreateWorkspace {...defaultProps} workflows={wfs}
        onAddWorkflow={async (name, keys) => {
          const nw = { id: 'wf-new', name, stages: keys.map(k => ({ key: k, defaultAgent: 'claude', defaultModel: 'opus-4.8' })), plugins: [] }
          const list = [...wfs, nw]; setWfs(list); return list
        }} />
    }
    render(<Harness />)
    fireEvent.click(document.querySelector('[data-crnewwf]') as HTMLElement)   // open the inline designer
    fireEvent.click(document.querySelector('[data-crwf-stage="requirement"]') as HTMLElement)
    fireEvent.click(document.querySelector('[data-crwf-stage="review"]') as HTMLElement)
    fireEvent.change(document.querySelector('[data-crwf-name]') as HTMLElement, { target: { value: '快速修复' } })
    fireEvent.click(document.querySelector('[data-crwf-create]') as HTMLElement)
    // the new workflow is selected → stage rows now reflect ITS stages (requirement + review), not the default
    await waitFor(() => expect(document.querySelectorAll('[data-stage]').length).toBe(2))
    expect(document.querySelector('[data-stage="requirement"]')).toBeTruthy()
    expect(document.querySelector('[data-stage="review"]')).toBeTruthy()
    expect(document.querySelector('[data-stage="develop"]')).toBeNull()
  })

  it('switching to a different-staged workflow changes the rendered stage rows', () => {
    const twoWorkflows = [
      { id: 'standard', name: '标准工作流', stages: [
        { key: 'design', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
        { key: 'develop', defaultAgent: 'claude', defaultModel: 'sonnet-4.6' }], plugins: [] },
      { id: 'marketing', name: '商家营销开发工作流', stages: [
        { key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
        { key: 'develop', defaultAgent: 'claude', defaultModel: 'sonnet-4.6' },
        { key: 'test', defaultAgent: 'claude', defaultModel: 'sonnet-4.6' }], plugins: [] },
    ]
    render(<CreateWorkspace {...defaultProps} workflows={twoWorkflows} />)
    // default = standard → design + develop
    expect(document.querySelectorAll('[data-stage]').length).toBe(2)
    expect(document.querySelector('[data-stage="requirement"]')).toBeNull()
    // switch to marketing → requirement + develop + test
    fireEvent.click(document.querySelector('[data-crtpl="marketing"]') as HTMLElement)
    expect(document.querySelectorAll('[data-stage]').length).toBe(3)
    expect(document.querySelector('[data-stage="requirement"]')).toBeTruthy()
    expect(document.querySelector('[data-stage="test"]')).toBeTruthy()
    expect(document.querySelector('[data-stage="design"]')).toBeNull()
  })

  it('closes the inline workflow designer when a workflow card is clicked (issue 3)', () => {
    render(<CreateWorkspace {...defaultProps} onAddWorkflow={vi.fn(async () => workflows)} />)
    fireEvent.click(document.querySelector('[data-crnewwf]') as HTMLElement)     // open designer
    expect(document.querySelector('[data-crwf-name]')).toBeTruthy()
    fireEvent.click(document.querySelector('[data-crtpl="standard"]') as HTMLElement)  // pick a workflow
    expect(document.querySelector('[data-crwf-name]')).toBeNull()                // designer dismissed
  })

  it('switching workflows updates the per-stage model (same stages, different models)', () => {
    const twoWf = [
      { id: 'standard', name: '标准', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [] },
      { id: 'marketing', name: '商家营销', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'sonnet-4.6' }], plugins: [] },
    ]
    render(<CreateWorkspace {...defaultProps} workflows={twoWf} />)
    const sel = () => (document.querySelector('[data-stmodel="develop"]') as HTMLSelectElement).value
    expect(sel()).toBe('claude::opus-4.8')                                  // standard's model
    fireEvent.click(document.querySelector('[data-crtpl="marketing"]') as HTMLElement)
    expect(sel()).toBe('claude::sonnet-4.6')                                // marketing's model
  })

  it('switching to a workflow whose stage uses a different provider reflects that provider+model', () => {
    const providersWithCodex = [
      ...providers,
      { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }] },
    ]
    const twoWf = [
      { id: 'standard', name: '标准', stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }], plugins: [] },
      { id: 'marketing', name: '商家营销', stages: [{ key: 'develop', defaultAgent: 'codex', defaultModel: 'gpt-5-codex' }], plugins: [] },
    ]
    render(<CreateWorkspace {...defaultProps} providers={providersWithCodex} workflows={twoWf} />)
    const sel = () => (document.querySelector('[data-stmodel="develop"]') as HTMLSelectElement).value
    expect(sel()).toBe('claude::opus-4.8')
    fireEvent.click(document.querySelector('[data-crtpl="marketing"]') as HTMLElement)
    expect(sel()).toBe('codex::gpt-5-codex')   // respects the stage's own provider, not just provider[0]
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
    const stage = opts.workflows[0].stages.find((s: any) => s.key === 'design')
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
  // Mirror readWorkspace()'s ensureWorkspaceWorkflows migration (see partialWs above).
  workflows: [{
    id: 'standard', name: 'standard',
    stages: [
      { key: 'design', provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', provider: 'claude', model: 'sonnet-4.6' },
    ],
  }],
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

  it('unchecking an included project requires a removal confirmation, then drops it', () => {
    const onCreate = vi.fn()
    render(<CreateWorkspace {...defaultProps} editing={editingWs} onCreate={onCreate} />)
    // uncheck the included proj1 → it's marked for removal
    fireEvent.click(within(document.querySelector('#crProjs') as HTMLElement).getByText('proj1'))
    expect(screen.getByText('将移除')).toBeInTheDocument()
    // first save shows the confirmation, does NOT submit yet
    fireEvent.click(screen.getByRole('button', { name: /保存修改/ }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByText(/将移除并删除本地代码/)).toBeInTheDocument()
    // second save (now labelled 删除并保存) submits without proj1
    fireEvent.click(screen.getByRole('button', { name: /删除并保存/ }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0].projects.map((p: any) => p.repoId)).not.toContain('proj1')
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
