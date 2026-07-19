import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LaunchGateCard, type LaunchGateConfig } from './LaunchGateCard'
import type { ProviderInfo } from '@shared/types'

const base: LaunchGateConfig = {
  seed: '把 token 迁到 OKLCH',
  workflows: [{ id: 'std', name: '标准工作流', stageCount: 4 }, { id: 'basic', name: '基础流程', stageCount: 2 }],
  selectedWorkflowId: 'std',
  projects: [
    { name: 'go-blog', selected: true, provider: 'claude', model: 'claude-opus-4-8' },
    { name: 'zgh', selected: false, provider: 'claude', model: 'claude-opus-4-8' },
  ],
  supplement: '',
}

// Improvement ⑦: the model chip's picker is fed by a `providers` prop (the SAME shape
// WorkspaceView/Composer pass down — real, locally-discovered providers/models), never a
// hardcoded catalog. These test doubles stand in for that discovered data.
const providers: ProviderInfo[] = [
  {
    id: 'claude', displayName: 'Claude Code', installed: true,
    models: [
      { id: 'claude-opus-4-8', label: 'opus-4.8' },
      { id: 'claude-sonnet-4-6', label: 'sonnet-4.6' },
    ],
  },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-5-codex', label: 'gpt-5-codex' }] },
]

describe('LaunchGateCard 活态', () => {
  it('展示种子、工作流、项目；确认回传当前配置', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByText('把 token 迁到 OKLCH')).toBeTruthy()
    expect(screen.getByText('标准工作流')).toBeTruthy()
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ selectedWorkflowId: 'std' }))
  })

  it('取消触发 onCancel', () => {
    const onCancel = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalled()
  })

  it('frozen 态渲染静态记录、无确认按钮', () => {
    render(<LaunchGateCard config={base} frozen={{ workflowName: '标准工作流', projects: ['go-blog'], supplement: '', decidedAt: 1 }} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByText('确认')).toBeNull()
    expect(screen.getByText(/标准工作流/)).toBeTruthy()
  })

  it('切换工作流选中态后确认，回传新的 selectedWorkflowId', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByText('基础流程'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ selectedWorkflowId: 'basic' }))
  })

  it('取消勾选项目后确认，该项目 selected 变为 false', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByText('go-blog'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: expect.arrayContaining([expect.objectContaining({ name: 'go-blog', selected: false })]),
      })
    )
  })

  it('编辑补充说明后确认，回传新文本', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('补充说明…（可选）'), { target: { value: '记得加测试' } })
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ supplement: '记得加测试' }))
  })

  // P1-3 follow-up fix: run2.start rejecting must not freeze the card — it stays active with an inline
  // error so the user can retry (see WorkspaceView's confirmLaunchGate .catch branch).
  it('error 存在时活态展示内联错误，且仍是活态(有确认/取消按钮，不是 frozen 记录)', () => {
    render(<LaunchGateCard config={base} error="工作流不存在" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('工作流不存在')).toBeTruthy()
    expect(screen.getByText('确认')).toBeTruthy()
    expect(screen.getByText('取消')).toBeTruthy()
  })

  it('无 error 时不展示错误区块', () => {
    render(<LaunchGateCard config={base} onConfirm={() => {}} onCancel={() => {}} />)
    expect(document.querySelector('.lg-error')).toBeNull()
  })
})

// Improvement ⑦: replaces the old static-catalog cycle-on-click chip with a real popup listing the
// project's provider's actually-discovered models (via the `providers` prop) — no hardcoded list.
describe('LaunchGateCard 模型选择弹层(真实可用模型,非静态表)', () => {
  it('点击模型 chip 打开弹层，列出该项目 provider 的真实可用模型', () => {
    render(<LaunchGateCard config={base} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    expect(document.querySelector('.wfo-mpop')).toBeNull()

    fireEvent.click(document.querySelector('.wfo-model')!)

    const pop = document.querySelector('.wfo-mpop')!
    expect(pop).toBeTruthy()
    expect(screen.getByText('opus-4.8')).toBeInTheDocument()
    expect(screen.getByText('sonnet-4.6')).toBeInTheDocument()
    // Only claude's models show — codex's gpt-5-codex must not leak in (go-blog's provider is claude).
    expect(screen.queryByText('gpt-5-codex')).toBeNull()
  })

  it('选中弹层里的一项模型后确认，该项目的 model 更新为选中值', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)

    fireEvent.click(document.querySelector('.wfo-model')!)
    fireEvent.click(screen.getByText('sonnet-4.6'))

    // Picking closes the popup and updates the chip's displayed label immediately.
    expect(document.querySelector('.wfo-mpop')).toBeNull()
    expect(screen.getByText(/sonnet-4\.6/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: expect.arrayContaining([
          expect.objectContaining({ name: 'go-blog', provider: 'claude', model: 'claude-sonnet-4-6' }),
        ]),
      })
    )
  })

  it('provider 在真实可用模型里没有条目(未安装/未加载)时弹层降级为手动输入，不回退到硬编码表', () => {
    const cfg: LaunchGateConfig = {
      ...base,
      projects: [{ name: 'go-blog', selected: true, provider: 'unknown-cli', model: 'some-model' }],
    }
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={cfg} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)

    fireEvent.click(document.querySelector('.wfo-model')!)
    const input = screen.getByPlaceholderText('输入模型 id')
    expect(input).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'custom-model-x' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: expect.arrayContaining([expect.objectContaining({ name: 'go-blog', model: 'custom-model-x' })]),
      })
    )
  })

  it('不传 providers 时(旧调用点)仍能渲染当前值，不因缺 prop 崩溃', () => {
    render(<LaunchGateCard config={base} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByText(/claude-opus-4-8/)).toBeInTheDocument()
  })
})
