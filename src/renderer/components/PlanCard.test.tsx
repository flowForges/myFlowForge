import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlanCard, type PlanReq } from './PlanCard'

const base: PlanReq = {
  id: 'pl1',
  approach: '逐文件迁移 tokens.css,先抽变量再替换引用',
  task: '重构主题 tokens',
  stages: [
    { key: '规划', name: '规划', agents: 1, perProject: false, projects: [] },
    { key: '开发', name: '开发', agents: 3, perProject: false, projects: [] },
    { key: '审查', name: '审查', agents: 1, perProject: false, projects: [] },
  ],
  allProjects: [],
}

describe('PlanCard', () => {
  it('renders approach, task and an editable stage list', () => {
    const { container } = render(<PlanCard req={base} onResolve={() => {}} />)
    expect(container.querySelector('.msg-req.k-confirm')).toBeTruthy()
    expect(screen.getByText('方案待批准')).toBeInTheDocument()
    expect(screen.getByText('任务')).toBeInTheDocument()
    expect(screen.getByText('重构主题 tokens')).toBeInTheDocument()
    expect(container.querySelector('.req-title')?.textContent).toBe(base.approach)
    const rows = container.querySelectorAll('.plan-stage-list .plan-stage-row')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('规划')
    expect(rows[1].textContent).toContain('开发')
    // every stage starts ticked
    expect(container.querySelectorAll('.plan-stage-head input:checked')).toHaveLength(3)
  })

  it('fires allow (with the stage selection) on 批准并执行 and deny on 取消', () => {
    const onResolve = vi.fn()
    render(<PlanCard req={base} onResolve={onResolve} />)
    fireEvent.click(screen.getByText('批准并执行'))
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow' }))
    expect(onResolve.mock.calls[0][0].selection.stages).toEqual(['规划', '开发', '审查'])
    fireEvent.click(screen.getByText('取消'))
    expect(onResolve).toHaveBeenCalledWith({ decision: 'deny' })
  })

  it('unticking a stage drops it from the approved selection', () => {
    const onResolve = vi.fn()
    const { container } = render(<PlanCard req={base} onResolve={onResolve} />)
    const devCheckbox = container.querySelectorAll('.plan-stage-head input')[1] as HTMLInputElement
    fireEvent.click(devCheckbox) // untick 开发
    fireEvent.click(screen.getByText('批准并执行'))
    expect(onResolve.mock.calls[0][0].selection.stages).toEqual(['规划', '审查'])
  })

  it('修改方向… calls onSupplement instead of opening an inline textarea (Task 15: reflows into the main composer)', () => {
    const onResolve = vi.fn()
    const onSupplement = vi.fn()
    render(<PlanCard req={base} onResolve={onResolve} onSupplement={onSupplement} />)
    expect(screen.queryByPlaceholderText(/说明要改的方向/)).toBeNull()
    fireEvent.click(screen.getByText('修改方向…'))
    expect(onSupplement).toHaveBeenCalledTimes(1)
    // no inline textarea ever appears, and no decision was resolved directly by the card
    expect(screen.queryByPlaceholderText(/说明要改的方向/)).toBeNull()
    expect(onResolve).not.toHaveBeenCalled()
    // the three-button row stays put (card doesn't switch to any other view)
    expect(screen.getByText('批准并执行')).toBeInTheDocument()
    expect(screen.getByText('取消')).toBeInTheDocument()
  })

  it('修改方向… is a no-op when onSupplement is not wired (optional prop)', () => {
    const onResolve = vi.fn()
    render(<PlanCard req={base} onResolve={onResolve} />)
    expect(() => fireEvent.click(screen.getByText('修改方向…'))).not.toThrow()
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('escapes untrusted html in approach (no XSS) — renders as literal text', () => {
    const req: PlanReq = { ...base, approach: '<img src=x onerror=alert(1)>' }
    const { container } = render(<PlanCard req={req} onResolve={() => {}} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.req-title')?.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('renders the approach as Markdown (headings, not raw text)', () => {
    const req: PlanReq = { ...base, approach: '## 目标\n逐文件迁移' }
    const { container } = render(<PlanCard req={req} onResolve={() => {}} />)
    const heading = container.querySelector('.req-title h2')
    expect(heading).toBeTruthy()
    expect(heading?.textContent).toBe('目标')
  })

  it('shows the detected workflow name, falling back to 临时/自定义流程 when ad-hoc', () => {
    const { rerender } = render(<PlanCard req={base} onResolve={() => {}} />)
    expect(screen.getByText('本次识别为【临时/自定义流程】')).toBeInTheDocument()
    const named: PlanReq = { ...base, workflowId: 'full', workflowName: '完整流程' }
    rerender(<PlanCard req={named} onResolve={() => {}} />)
    expect(screen.getByText('本次识别为【完整流程】')).toBeInTheDocument()
  })

  it('switch dropdown lists workflowOptions + ad-hoc, and calls onSwitchWorkflow with the picked id (undefined for ad-hoc)', () => {
    const onSwitchWorkflow = vi.fn()
    const req: PlanReq = {
      ...base,
      workflowId: 'full',
      workflowName: '完整流程',
      workflowOptions: [{ id: 'quick', name: '快速修复' }, { id: 'full', name: '完整流程' }],
    }
    const { container } = render(<PlanCard req={req} onResolve={() => {}} onSwitchWorkflow={onSwitchWorkflow} />)
    const select = container.querySelector('.plan-workflow-switch') as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.value).toBe('full')
    const optionLabels = Array.from(select.options).map(o => o.textContent)
    expect(optionLabels).toEqual(['临时/自定义(ad-hoc)', '快速修复', '完整流程 (推荐)'])
    fireEvent.change(select, { target: { value: 'quick' } })
    expect(onSwitchWorkflow).toHaveBeenCalledWith('quick')
    fireEvent.change(select, { target: { value: '' } })
    expect(onSwitchWorkflow).toHaveBeenCalledWith(undefined)
  })

  it('renders hooks woven into the step list and drops an unticked hook from the approved selection', () => {
    const onResolve = vi.fn()
    const req: PlanReq = {
      ...base,
      stages: [{ key: 'develop', name: '开发', agents: 1, perProject: false, projects: [] }],
      hooks: [{ id: 'h1', name: '规范检查', after: 'develop' }, { id: 'w1', name: '收尾', after: '__wf' }],
    }
    const { container } = render(<PlanCard req={req} onResolve={onResolve} />)
    expect(container.querySelectorAll('.plan-hook-row')).toHaveLength(2)
    expect(screen.getByText('规范检查')).toBeInTheDocument()
    const h1Box = screen.getByText('规范检查').closest('label')!.querySelector('input[type=checkbox]') as HTMLInputElement
    fireEvent.click(h1Box)   // untick 规范检查
    fireEvent.click(screen.getByText('批准并执行'))
    expect(onResolve.mock.calls[0][0].selection.hooks).toEqual(['w1'])
  })

  it('marks the agent-detected workflow with (推荐) in the switch dropdown', () => {
    const req: PlanReq = { ...base, workflowId: 'full', workflowName: '完整流程', workflowOptions: [{ id: 'full', name: '完整流程' }, { id: 'quick', name: '快速' }] }
    const { container } = render(<PlanCard req={req} onResolve={() => {}} />)
    const labels = Array.from((container.querySelector('.plan-workflow-switch') as HTMLSelectElement).options).map(o => o.textContent)
    expect(labels).toContain('完整流程 (推荐)')
    expect(labels).toContain('快速')
  })
})
