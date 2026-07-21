import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { LaunchGateCard, type LaunchGateConfig } from './LaunchGateCard'
import type { ProviderInfo } from '@shared/types'

const base: LaunchGateConfig = {
  seed: '把 token 迁到 OKLCH',
  workflows: [
    { id: 'std', name: '标准工作流', stageCount: 4, stages: [
      { key: 'requirement', name: '需求梳理', gate: false, code: false, provider: 'claude', model: 'claude-opus-4-8' },
      { key: 'develop', name: '代码开发', gate: false, code: true, provider: 'claude', model: 'claude-opus-4-8' },
      { key: 'test', name: '测试', gate: false, code: true, provider: 'claude', model: 'claude-opus-4-8' },
      { key: 'review', name: '代码评审', gate: true, code: false, provider: 'claude', model: 'claude-opus-4-8' },
    ] },
    { id: 'basic', name: '基础流程', stageCount: 2, stages: [
      { key: 'requirement', name: '需求梳理', gate: false, code: false, provider: 'claude', model: 'claude-opus-4-8' },
      { key: 'develop', name: '代码开发', gate: false, code: true, provider: 'claude', model: 'claude-opus-4-8' },
    ] },
  ],
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
// The launch gate now renders provider/model chips on BOTH stage rows and project rows, so a bare
// document.querySelector('.lg-model-chip') would hit the first stage's chip. Scope to a project row.
function projectChip(projectName: string, chip: '.lg-model-chip' | '.lg-provider-chip'): HTMLElement {
  const row = Array.from(document.querySelectorAll('.wfo-proj')).find((el) => el.querySelector('.pn b')?.textContent === projectName)
  return row!.querySelector(chip) as HTMLElement
}

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

    fireEvent.click(projectChip('go-blog', '.lg-model-chip'))

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

    fireEvent.click(projectChip('go-blog', '.lg-model-chip'))
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

    fireEvent.click(projectChip('go-blog', '.lg-model-chip'))
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
    // model id shows on the project chip AND the root-stage chips — just assert it renders somewhere.
    expect(screen.getAllByText(/claude-opus-4-8/).length).toBeGreaterThan(0)
  })
})

// Q2: each selected project can switch its 编码代理(provider), not just its model — the picker lists
// installed providers, and choosing one resets the model (belongs to the old provider).
describe('LaunchGateCard 编码代理(provider)选择', () => {
  it('点击 provider chip 打开弹层，列出已安装的编码代理', () => {
    render(<LaunchGateCard config={base} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    fireEvent.click(projectChip('go-blog', '.lg-provider-chip'))
    const pop = document.querySelector('.wfo-mpop') as HTMLElement
    expect(pop).toBeTruthy()
    // Both installed providers are offered inside the popup (Claude Code also appears as the chip label
    // outside it, so scope the query to the popup).
    expect(within(pop).getByText('Codex')).toBeInTheDocument()
    expect(within(pop).getByText('Claude Code')).toBeInTheDocument()
  })

  it('切换 provider 后确认，回传新 provider 且 model 切到新 provider 的默认模型(非空,避免回退到 stage 的 claude 模型)', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(projectChip('go-blog', '.lg-provider-chip'))
    fireEvent.click(screen.getByText('Codex'))
    // popup closed, provider chip now shows Codex
    expect(document.querySelector('.wfo-mpop')).toBeNull()
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: expect.arrayContaining([
          // codex's first discovered model, NOT '' (empty would fall back to the stage's claude model)
          expect.objectContaining({ name: 'go-blog', provider: 'codex', model: 'gpt-5-codex' }),
        ]),
      })
    )
  })
})

describe('LaunchGateCard 需求(AI 总结 + 可编辑)', () => {
  it('seedLoading 时展示「正在总结」占位，不渲染需求输入框', () => {
    render(<LaunchGateCard config={{ ...base, seed: '' }} seedLoading onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByText(/正在根据对话总结需求/)).toBeInTheDocument()
    expect(document.querySelector('.lg-seed-input')).toBeNull()
  })

  it('总结完成后需求进入可编辑输入框；编辑后确认回传编辑值', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} onConfirm={onConfirm} onCancel={() => {}} />)
    const input = document.querySelector('.lg-seed-input') as HTMLTextAreaElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('把 token 迁到 OKLCH')
    fireEvent.change(input, { target: { value: '把设计 token 全量迁到 OKLCH 并更新暗色' } })
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ seed: '把设计 token 全量迁到 OKLCH 并更新暗色' }))
  })

  it('异步总结落地(config.seed 变化)后同步进输入框', () => {
    const { rerender } = render(<LaunchGateCard config={{ ...base, seed: '' }} onConfirm={() => {}} onCancel={() => {}} />)
    expect((document.querySelector('.lg-seed-input') as HTMLTextAreaElement).value).toBe('')
    rerender(<LaunchGateCard config={{ ...base, seed: 'AI 总结出来的需求' }} onConfirm={() => {}} onCancel={() => {}} />)
    expect((document.querySelector('.lg-seed-input') as HTMLTextAreaElement).value).toBe('AI 总结出来的需求')
  })
})

describe('LaunchGateCard 工作流阶段流程预览', () => {
  it('展示所选工作流的阶段流程；切换工作流后流程随之变化', () => {
    render(<LaunchGateCard config={base} onConfirm={() => {}} onCancel={() => {}} />)
    // std 工作流的阶段都显示
    expect(screen.getByText('需求梳理')).toBeInTheDocument()
    expect(screen.getByText('代码评审')).toBeInTheDocument()
    // 切到 basic(只有 2 步),代码评审不应再出现
    fireEvent.click(screen.getByText('基础流程'))
    expect(screen.queryByText('代码评审')).toBeNull()
    expect(screen.getByText('代码开发')).toBeInTheDocument()
  })
})

// #1+#3: stages are checkable (uncheck = drop from run plan) and root stages can switch provider/model.
describe('LaunchGateCard 阶段可选 + 阶段 provider', () => {
  it('取消勾选某阶段后确认，stageChoices 里该阶段 enabled=false', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByText('需求梳理'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      stageChoices: expect.arrayContaining([expect.objectContaining({ key: 'requirement', enabled: false })]),
    }))
  })

  it('全部阶段取消勾选时，确认按钮禁用', () => {
    render(<LaunchGateCard config={base} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    for (const name of ['需求梳理', '代码开发', '测试', '代码评审']) fireEvent.click(screen.getByText(name))
    expect((screen.getByText('确认') as HTMLButtonElement).disabled).toBe(true)
  })

  it('改根阶段 provider 后确认，stageChoices 反映新 provider + 默认模型', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    // requirement 是 root stage(code:false),渲染 provider chip;它排在项目行之前,是第一个 .lg-provider-chip
    fireEvent.click(document.querySelector('.lg-provider-chip')!)
    fireEvent.click(screen.getByText('Codex'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      stageChoices: expect.arrayContaining([expect.objectContaining({ key: 'requirement', provider: 'codex', model: 'gpt-5-codex' })]),
    }))
  })
})

describe('LaunchGateCard hook 可选', () => {
  const withHooks: LaunchGateConfig = {
    ...base,
    hooks: [
      { id: 'h1', name: '跑测试', after: 'develop' },
      { id: 'h2', name: '收尾总结', after: '__wf' },
    ],
  }
  it('展示 hook 列表 + 触发时机；取消勾选后确认 hookChoices 反映', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={withHooks} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByText('跑测试')).toBeInTheDocument()
    expect(screen.getByText('全部结束后')).toBeInTheDocument()
    fireEvent.click(screen.getByText('跑测试'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      hookChoices: expect.arrayContaining([
        expect.objectContaining({ id: 'h1', enabled: false }),
        expect.objectContaining({ id: 'h2', enabled: true }),
      ]),
    }))
  })
})
