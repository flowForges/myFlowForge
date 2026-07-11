import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlanCard, type PlanReq } from './PlanCard'

const base: PlanReq = {
  id: 'pl1',
  approach: '逐文件迁移 tokens.css,先抽变量再替换引用',
  task: '重构主题 tokens',
  stages: [
    { name: '规划', agents: 1 },
    { name: '开发', agents: 3 },
    { name: '审查', agents: 1 },
  ],
}

describe('PlanCard', () => {
  it('renders approach, task and stage chips (单代理 / 并行N代理)', () => {
    const { container } = render(<PlanCard req={base} onResolve={() => {}} />)
    expect(container.querySelector('.msg-req.k-confirm')).toBeTruthy()
    expect(screen.getByText('方案待批准')).toBeInTheDocument()
    expect(screen.getByText('任务')).toBeInTheDocument()
    expect(screen.getByText('重构主题 tokens')).toBeInTheDocument()
    expect(container.querySelector('.req-title')?.textContent).toBe(base.approach)
    const chips = container.querySelectorAll('.ic-stages .ic-stage')
    expect(chips).toHaveLength(3)
    expect(chips[0].textContent).toContain('规划')
    expect(chips[0].textContent).toContain('单代理')
    expect(chips[1].textContent).toContain('开发')
    expect(chips[1].textContent).toContain('并行3代理')
  })

  it('fires allow on 批准并执行 and deny on 取消', () => {
    const onResolve = vi.fn()
    render(<PlanCard req={base} onResolve={onResolve} />)
    fireEvent.click(screen.getByText('批准并执行'))
    expect(onResolve).toHaveBeenCalledWith({ decision: 'allow' })
    fireEvent.click(screen.getByText('取消'))
    expect(onResolve).toHaveBeenCalledWith({ decision: 'deny' })
  })

  it('修改方向… reveals an input and submits a modify decision with the typed value', () => {
    const onResolve = vi.fn()
    render(<PlanCard req={base} onResolve={onResolve} />)
    expect(screen.queryByPlaceholderText(/说明要改的方向/)).toBeNull()
    fireEvent.click(screen.getByText('修改方向…'))
    const input = screen.getByPlaceholderText(/说明要改的方向/) as HTMLInputElement
    fireEvent.change(input, { target: { value: '改成全量替换' } })
    fireEvent.click(screen.getByText('提交修改'))
    expect(onResolve).toHaveBeenCalledWith({ decision: 'modify', value: '改成全量替换' })
  })

  it('修改方向… can be cancelled via 返回 — restores the three primary buttons without resolving', () => {
    const onResolve = vi.fn()
    render(<PlanCard req={base} onResolve={onResolve} />)
    fireEvent.click(screen.getByText('修改方向…'))
    expect(screen.getByPlaceholderText(/说明要改的方向/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('返回'))
    // back to the three-button row
    expect(screen.queryByPlaceholderText(/说明要改的方向/)).toBeNull()
    expect(screen.getByText('批准并执行')).toBeInTheDocument()
    expect(screen.getByText('修改方向…')).toBeInTheDocument()
    expect(screen.getByText('取消')).toBeInTheDocument()
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
    expect(optionLabels).toEqual(['临时/自定义(ad-hoc)', '快速修复', '完整流程'])
    fireEvent.change(select, { target: { value: 'quick' } })
    expect(onSwitchWorkflow).toHaveBeenCalledWith('quick')
    fireEvent.change(select, { target: { value: '' } })
    expect(onSwitchWorkflow).toHaveBeenCalledWith(undefined)
  })
})
