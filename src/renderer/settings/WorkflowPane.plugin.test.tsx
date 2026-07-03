import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowPane } from './WorkflowPane'

const workflows = [
  {
    id: 'wf1',
    name: '标准工作流',
    stages: [
      { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      { key: 'test', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    ],
    plugins: [],
  },
]

const workflowsWithPlugins = [
  {
    id: 'wf1',
    name: '标准工作流',
    stages: [
      { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      { key: 'test', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    ],
    plugins: [
      { id: 'pl1', name: '当前时间', prompt: '输出当前时间', after: 'develop', skills: [], tools: ['bash'] },
    ],
  },
]

const workflowsTwoPlugins = [
  {
    id: 'wf1',
    name: '标准工作流',
    stages: [
      { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    ],
    plugins: [
      { id: 'pl1', name: '插件A', prompt: 'A', after: 'develop', skills: [], tools: [] },
      { id: 'pl2', name: '插件B', prompt: 'B', after: 'develop', skills: [], tools: [] },
    ],
  },
]

describe('WorkflowPane plugin editing', () => {
  it('renders insert (+) buttons around stages in the flow strip', () => {
    const onUpdate = vi.fn()
    render(
      <WorkflowPane
        workflows={workflows}
        onCreate={() => {}}
        onDelete={() => {}}
        onUpdateWorkflow={onUpdate}
        onUpdateStagePrompts={() => {}}
      />
    )
    // Each stage has an insert button after it; plus one before the first stage (__start)
    const insBtns = document.querySelectorAll('.wf-ins')
    // 2 stages → 3 insert points (__start, after develop, after test)
    expect(insBtns.length).toBe(3)
  })

  it('clicking + after a stage opens PluginEditor, saving calls onUpdateWorkflow with new plugin', () => {
    const onUpdate = vi.fn()
    render(
      <WorkflowPane
        workflows={workflows}
        onCreate={() => {}}
        onDelete={() => {}}
        onUpdateWorkflow={onUpdate}
        onUpdateStagePrompts={() => {}}
      />
    )

    // Click the insert button after "develop" stage (data-after="develop")
    const insBtn = document.querySelector('.wf-ins[data-after="develop"]') as HTMLElement
    expect(insBtn).not.toBeNull()
    fireEvent.click(insBtn)

    // PluginEditor should appear
    expect(screen.getByText('新增插件')).toBeInTheDocument()

    // Fill in the plugin name
    const nameInput = screen.getByPlaceholderText(/当前时间/)
    fireEvent.change(nameInput, { target: { value: '测试插件' } })

    // Click "添加插件"
    fireEvent.click(screen.getByText('添加插件'))

    // onUpdateWorkflow should be called with wf1 id and plugins array containing the new plugin
    expect(onUpdate).toHaveBeenCalledTimes(1)
    const [calledId, calledPlugins] = onUpdate.mock.calls[0] as [string, { name: string; after: string }[]]
    expect(calledId).toBe('wf1')
    expect(calledPlugins).toHaveLength(1)
    expect(calledPlugins[0].name).toBe('测试插件')
    expect(calledPlugins[0].after).toBe('develop')
  })

  it('clicking cancel closes the editor without calling onUpdateWorkflow', () => {
    const onUpdate = vi.fn()
    render(
      <WorkflowPane
        workflows={workflows}
        onCreate={() => {}}
        onDelete={() => {}}
        onUpdateWorkflow={onUpdate}
        onUpdateStagePrompts={() => {}}
      />
    )

    const insBtn = document.querySelector('.wf-ins[data-after="develop"]') as HTMLElement
    fireEvent.click(insBtn)
    expect(screen.getByText('新增插件')).toBeInTheDocument()
    fireEvent.click(screen.getByText('取消'))
    expect(screen.queryByText('新增插件')).not.toBeInTheDocument()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('renders existing plugin chips and clicking x on a chip calls onUpdateWorkflow without it', () => {
    const onUpdate = vi.fn()
    render(
      <WorkflowPane
        workflows={workflowsWithPlugins}
        onCreate={() => {}}
        onDelete={() => {}}
        onUpdateWorkflow={onUpdate}
        onUpdateStagePrompts={() => {}}
      />
    )

    // Plugin chip should be visible
    expect(screen.getByText('当前时间')).toBeInTheDocument()

    // Click the x button on the plugin chip
    const xBtn = document.querySelector('.wf-plug-chip .x') as HTMLElement
    expect(xBtn).not.toBeNull()
    fireEvent.click(xBtn)

    expect(onUpdate).toHaveBeenCalledTimes(1)
    const [calledId, calledPlugins] = onUpdate.mock.calls[0] as [string, { id: string }[]]
    expect(calledId).toBe('wf1')
    // Plugin should be removed
    expect(calledPlugins.find(p => p.id === 'pl1')).toBeUndefined()
    expect(calledPlugins).toHaveLength(0)
  })

  it('dropping a chip onto itself does NOT call onUpdateWorkflow (self-drop no-op)', () => {
    const onUpdate = vi.fn()
    render(
      <WorkflowPane
        workflows={workflowsTwoPlugins}
        onCreate={() => {}}
        onDelete={() => {}}
        onUpdateWorkflow={onUpdate}
        onUpdateStagePrompts={() => {}}
      />
    )

    const chips = document.querySelectorAll('.wf-plug-chip')
    expect(chips.length).toBe(2)
    // dragStart sets draggedId = pl1; drop onto the same chip (draggedId === p.id) → no-op guard
    fireEvent.dragStart(chips[0])
    fireEvent.drop(chips[0])
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('cross-workflow drop (draggedId not in target workflow) does NOT call onUpdateWorkflow', () => {
    // Two separate workflows, each with one plugin. Drag plugin from wf2 over wf1's chip.
    // movePluginBefore on wf1's plugins won't find the foreign draggedId → returns same ref → no-op.
    const crossWfWorkflows = [
      {
        id: 'wf1',
        name: '工作流1',
        stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }],
        plugins: [{ id: 'pl-wf1', name: '插件WF1', prompt: '', after: 'develop', skills: [], tools: [] }],
      },
      {
        id: 'wf2',
        name: '工作流2',
        stages: [{ key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' }],
        plugins: [{ id: 'pl-wf2', name: '插件WF2', prompt: '', after: 'develop', skills: [], tools: [] }],
      },
    ]
    const onUpdate = vi.fn()
    render(
      <WorkflowPane
        workflows={crossWfWorkflows}
        onCreate={() => {}}
        onDelete={() => {}}
        onUpdateWorkflow={onUpdate}
        onUpdateStagePrompts={() => {}}
      />
    )

    const chips = document.querySelectorAll('.wf-plug-chip')
    expect(chips.length).toBe(2)
    // Drag wf2's chip (chips[1] = pl-wf2), then drop onto wf1's chip (chips[0] = pl-wf1).
    // draggedId='pl-wf2', but wf1 only has 'pl-wf1' → movePluginBefore returns same ref → no-op guard.
    fireEvent.dragStart(chips[1])
    fireEvent.drop(chips[0])
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('clicking a plugin chip opens editor in edit mode with existing data', () => {
    const onUpdate = vi.fn()
    render(
      <WorkflowPane
        workflows={workflowsWithPlugins}
        onCreate={() => {}}
        onDelete={() => {}}
        onUpdateWorkflow={onUpdate}
        onUpdateStagePrompts={() => {}}
      />
    )

    // Click the chip itself (not the x button) to edit
    const chip = document.querySelector('.wf-plug-chip') as HTMLElement
    fireEvent.click(chip)

    // Should open in edit mode showing "编辑插件"
    expect(screen.getByText('编辑插件')).toBeInTheDocument()

    // Input should be pre-filled with plugin name
    const nameInput = screen.getByDisplayValue('当前时间')
    expect(nameInput).toBeInTheDocument()

    // Change name and save
    fireEvent.change(nameInput, { target: { value: '修改后名称' } })
    fireEvent.click(screen.getByText('保存'))

    expect(onUpdate).toHaveBeenCalledTimes(1)
    const [calledId, calledPlugins] = onUpdate.mock.calls[0] as [string, { id: string; name: string }[]]
    expect(calledId).toBe('wf1')
    expect(calledPlugins[0].name).toBe('修改后名称')
  })
})
