import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
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
    { name: 'zgh', selected: true, provider: 'claude', model: 'claude-opus-4-8' },
  ],
  supplement: '',
}

// Improvement ⑦: the model chip's picker is fed by a `providers` prop (the SAME shape
// WorkspaceView/Composer pass down — real, locally-discovered providers/models), never a
// hardcoded catalog. These test doubles stand in for that discovered data.
// Projects now render as lane cards under EACH per-project stage (代码开发/写单测按项目/…). Scope to a
// specific stage's lane (default 代码开发/develop) so a project name that repeats across stages resolves
// to one card, then pick its provider/model chip.
function projectChip(projectName: string, chip: '.lg-model-chip' | '.lg-provider-chip', stage = 'develop'): HTMLElement {
  const lane = document.querySelector(`.lg-stg[data-stage="${stage}"] .lg-lane[data-proj="${projectName}"]`)
  return lane!.querySelector(chip) as HTMLElement
}
// Click a stage's enable checkbox (its numbered node) or a project lane's checkbox, scoped by data attrs.
function clickStageToggle(stageKey: string): void {
  fireEvent.click(document.querySelector(`.lg-stg[data-stage="${stageKey}"] .lg-stg-idx`)!)
}
function clickProjectCheckbox(projectName: string, stage = 'develop'): void {
  fireEvent.click(document.querySelector(`.lg-stg[data-stage="${stage}"] .lg-lane[data-proj="${projectName}"] .lg-lane-ck`)!)
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
    clickProjectCheckbox('go-blog')   // deselect go-blog (zgh stays selected, so confirm isn't blocked)
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

    const pop = document.querySelector('.wfo-mpop') as HTMLElement
    expect(pop).toBeTruthy()
    // The model chip now shows the bare model (opus-4.8 is go-blog's current model, also its chip label),
    // so scope the popup-content assertions to the popup itself.
    expect(within(pop).getByText('opus-4.8')).toBeInTheDocument()
    expect(within(pop).getByText('sonnet-4.6')).toBeInTheDocument()
    // Only claude's models show — codex's gpt-5-codex must not leak in (go-blog's provider is claude).
    expect(within(pop).queryByText('gpt-5-codex')).toBeNull()
  })

  it('选中弹层里的一项模型后确认，该项目的 model 更新为选中值', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)

    fireEvent.click(projectChip('go-blog', '.lg-model-chip'))
    fireEvent.click(screen.getByText('sonnet-4.6'))

    // Picking closes the popup and updates the chip's displayed label immediately (go-blog's card repeats
    // under every per-project stage, so its updated model label now shows in more than one lane).
    expect(document.querySelector('.wfo-mpop')).toBeNull()
    expect(screen.getAllByText(/sonnet-4\.6/).length).toBeGreaterThan(0)

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

  // #3: 一键把所有 provider 切成同一个 — 覆盖所有项目 + 所有阶段(含写码阶段,见 applyProviderToAll 注释)。
  it('「统一编码代理·全部设为」一键把所有项目与阶段切成同一个 provider', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByText('全部设为…'))
    const pop = document.querySelector('.wfo-mpop') as HTMLElement
    expect(pop).toBeTruthy()
    fireEvent.click(within(pop).getByText('Codex'))
    fireEvent.click(screen.getByText('确认'))
    const arg = onConfirm.mock.calls[0][0]
    // every project (selected or not) → codex + codex's default model, never ''
    for (const p of arg.projects) { expect(p.provider).toBe('codex'); expect(p.model).toBe('gpt-5-codex') }
    // 全部设为 switches EVERY stage to the bulk provider — including code stages (develop/test): a
    // per-project code stage's lanes resolve `p.provider || stage.provider`, and since all projects are
    // now codex too, setting the stage provider to codex as well is harmless + correct (see
    // applyProviderToAll's doc). So all four stages read codex.
    const byKey = Object.fromEntries(arg.stageChoices.map((s: { key: string; provider: string }) => [s.key, s.provider]))
    expect(byKey.requirement).toBe('codex')
    expect(byKey.review).toBe('codex')
    expect(byKey.develop).toBe('codex')
    expect(byKey.test).toBe('codex')
  })
})

describe('LaunchGateCard 阶段级 单代理⇄按项目 切换', () => {
  it('非写码非文档阶段(代码评审)可切「按项目」,确认回传 perProject:true;写码阶段不带该字段', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    const reviewRow = document.querySelector('.lg-stg[data-stage="review"]') as HTMLElement
    expect(reviewRow).toBeTruthy()
    // the row offers a 单代理 / 按项目 segmented toggle; click 按项目
    fireEvent.click(within(reviewRow).getByText('按项目'))
    fireEvent.click(screen.getByText('确认'))
    const arg = onConfirm.mock.calls[0][0]
    expect(arg.stageChoices.find((s: { key: string }) => s.key === 'review').perProject).toBe(true)
    // a code stage (develop) is not toggle-eligible → no perProject field is sent for it
    expect(arg.stageChoices.find((s: { key: string }) => s.key === 'develop').perProject).toBeUndefined()
  })

  it('代码CR(lensCount>0)的开关诚实标为「多镜头⇄按项目」,不是误导的「单代理」', () => {
    // review 默认多镜头(4视角),其 off 状态不是单代理 —— 门必须如实标注。
    const cfg: LaunchGateConfig = {
      ...base,
      workflows: base.workflows.map((w) => w.id === 'std'
        ? { ...w, stages: w.stages.map((s) => (s.key === 'review' ? { ...s, lensCount: 4 } : s)) }
        : w),
    }
    render(<LaunchGateCard config={cfg} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    const reviewRow = document.querySelector('.lg-stg[data-stage="review"]') as HTMLElement
    expect(within(reviewRow).getByText('多镜头')).toBeInTheDocument()   // the toggle's off-label
    // no 单代理 anywhere in the review row (toggle off-label + mode tag both read 多镜头)
    expect(within(reviewRow).queryByText('单代理')).toBeNull()
    // switching to 按项目 still works from the honest toggle
    fireEvent.click(within(reviewRow).getByText('按项目'))
    expect(within(reviewRow).getByText('按项目').className).toContain('on')
  })
})

// 用户诉求:claude 开发 + codex CR。CR 切「按项目」后,它那几行项目的编码代理必须归这个阶段自己管 ——
// 在这之前它们渲染的就是代码开发那份项目数据,改一边另一边跟着变(用户报的「provider 是同步的」)。
describe('LaunchGateCard 按项目阶段的阶段级项目代理', () => {
  const perProjectReview = () => {
    const row = document.querySelector('.lg-stg[data-stage="review"]') as HTMLElement
    fireEvent.click(within(row).getByText('按项目'))
  }
  const setProviderIn = (stage: string, project: string, label: string) => {
    fireEvent.click(projectChip(project, '.lg-provider-chip', stage))
    const pop = document.querySelector('.wfo-mpop') as HTMLElement
    fireEvent.click(within(pop).getByText(label))
  }

  it('改 CR 行某项目的编码代理,只落到该阶段的 projects,不动全局项目', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    perProjectReview()
    setProviderIn('review', 'go-blog', 'Codex')
    fireEvent.click(screen.getByText('确认'))
    const arg = onConfirm.mock.calls[0][0]
    expect(arg.stageChoices.find((s: { key: string }) => s.key === 'review').projects)
      .toEqual([{ name: 'go-blog', provider: 'codex', model: 'gpt-5-codex' }])
    // 全局项目(= 代码开发用的编码代理)纹丝不动
    expect(arg.projects.find((p: { name: string }) => p.name === 'go-blog').provider).toBe('claude')
  })

  it('代码开发那行照旧改的是项目本身(它就是项目的编码代理,唯一真源)', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    setProviderIn('develop', 'go-blog', 'Codex')
    fireEvent.click(screen.getByText('确认'))
    const arg = onConfirm.mock.calls[0][0]
    expect(arg.projects.find((p: { name: string }) => p.name === 'go-blog').provider).toBe('codex')
    expect(arg.stageChoices.find((s: { key: string }) => s.key === 'develop').projects).toBeUndefined()
  })

  it('没动过的阶段不带 projects 字段(老行为零变化)', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    perProjectReview()
    fireEvent.click(screen.getByText('确认'))
    const arg = onConfirm.mock.calls[0][0]
    expect(arg.stageChoices.find((s: { key: string }) => s.key === 'review').projects).toBeUndefined()
  })

  it('工作区里配好的 projectAgents 作为该阶段各项目行的初值显示', () => {
    const withPersisted = {
      ...base,
      workflows: base.workflows.map((w) => w.id !== 'std' ? w : {
        ...w,
        stages: w.stages.map((s) => s.key !== 'review' ? s : { ...s, projectAgents: [{ name: 'go-blog', provider: 'codex', model: 'gpt-5-codex' }] }),
      }),
    }
    render(<LaunchGateCard config={withPersisted} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    perProjectReview()
    expect(projectChip('go-blog', '.lg-provider-chip', 'review').textContent).toContain('Codex')
    // 同一个项目在代码开发那行仍显示它自己的编码代理
    expect(projectChip('go-blog', '.lg-provider-chip', 'develop').textContent).toContain('Claude Code')
  })
})

// 用户反馈(2026-08-12):什么也没聊、什么也没输入就点启动,agent 只拿到一串项目名,自己猜一个需求执行了
// 一堆东西。门里这道是给人看的提示;真正拦得住「⚡自动」的是主进程那道(launch.hasRequirement)。
describe('LaunchGateCard 没有需求就不许启动', () => {
  const blank = { ...base, seed: '' }
  it('需求和补充说明都空时,确认按钮禁用并说明原因', () => {
    render(<LaunchGateCard config={blank} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    const btn = screen.getByText('确认') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toContain('要做什么')
  })

  it('在需求框里打一句就能启动', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={blank} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.change(document.querySelector('.lg-seed-input')!, { target: { value: '把 token 迁到 OKLCH' } })
    const btn = screen.getByText('确认') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onConfirm).toHaveBeenCalled()
  })

  it('没聊过但只写了补充说明,也放行(这条路要留着)', () => {
    render(<LaunchGateCard config={blank} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('补充说明…（可选）'), { target: { value: '只改前端配色' } })
    expect((screen.getByText('确认') as HTMLButtonElement).disabled).toBe(false)
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
    // std 工作流的阶段节点都显示(按 data-stage 定位,阶段名在节点头与单代理子卡里各出现一次)
    expect(document.querySelector('.lg-stg[data-stage="requirement"]')).toBeTruthy()
    expect(document.querySelector('.lg-stg[data-stage="review"]')).toBeTruthy()
    // 切到 basic(只有 2 步),代码评审阶段不应再出现
    fireEvent.click(screen.getByText('基础流程'))
    expect(document.querySelector('.lg-stg[data-stage="review"]')).toBeNull()
    expect(document.querySelector('.lg-stg[data-stage="develop"]')).toBeTruthy()
  })
})

// #1+#3: stages are checkable (uncheck = drop from run plan) and root stages can switch provider/model.
describe('LaunchGateCard 阶段可选 + 阶段 provider', () => {
  it('取消勾选某阶段后确认，stageChoices 里该阶段 enabled=false', () => {
    const onConfirm = vi.fn()
    render(<LaunchGateCard config={base} providers={providers} onConfirm={onConfirm} onCancel={() => {}} />)
    clickStageToggle('requirement')   // click its numbered node to disable it
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      stageChoices: expect.arrayContaining([expect.objectContaining({ key: 'requirement', enabled: false })]),
    }))
  })

  it('全部阶段取消勾选时，确认按钮禁用', () => {
    render(<LaunchGateCard config={base} providers={providers} onConfirm={() => {}} onCancel={() => {}} />)
    for (const key of ['requirement', 'develop', 'test', 'review']) clickStageToggle(key)
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
    // Hooks now render inline on the pipeline (between the stages they weave after), each with an
    // 已启用/已停用 toggle — no longer a bottom list with a spelled-out 触发时机.
    expect(screen.getByText('跑测试')).toBeInTheDocument()
    expect(screen.getByText('收尾总结')).toBeInTheDocument()
    // toggle 跑测试 (h1) off via its inline switch
    const h1row = screen.getByText('跑测试').closest('.lg-hook') as HTMLElement
    fireEvent.click(within(h1row).getByText('已启用'))
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      hookChoices: expect.arrayContaining([
        expect.objectContaining({ id: 'h1', enabled: false }),
        expect.objectContaining({ id: 'h2', enabled: true }),
      ]),
    }))
  })

})

// Task 8:旧的 checkDirty(→ 弹「仍要启动」二次确认警告)被 baseInfo(→ 集中的「运行基准」区块)取代 ——
// 未提交改动不再是需要拦一下的例外,它现在是被完整带进临时分支快照的正常路径(见 tempBranch.ts 的
// createTempBranch)。运行基准区块只列「已选中」的项目,项目名要能和 baseInfo 返回的条目对上,所以这里
// 用 web/api(与 run2Handlers.test.ts 的 basline 项目命名一致)而不是复用 base 的 go-blog/zgh。
const baseInfoConfig: LaunchGateConfig = {
  ...base,
  projects: [
    { name: 'web', selected: true, provider: 'claude', model: 'claude-opus-4-8' },
    { name: 'api', selected: true, provider: 'claude', model: 'claude-opus-4-8' },
  ],
}
const baseProps = { config: baseInfoConfig, providers, onConfirm: vi.fn(), onCancel: () => {} }

describe('启动门基准分支', () => {
  it('每个项目显示实测基准分支与未提交改动数', async () => {
    const baseInfo = async () => [
      { name: 'web', branch: 'branch1', dirtyCount: 7 },
      { name: 'api', branch: 'main', dirtyCount: 0 },
    ]
    render(<LaunchGateCard {...baseProps} baseInfo={baseInfo} />)
    expect(await screen.findByText(/基准 branch1 · 含 7 项未提交改动/)).toBeTruthy()
    expect(await screen.findByText(/基准 main · 工作树干净/)).toBeTruthy()
  })

  it('detached HEAD → 红字提示且不可启动', async () => {
    const baseInfo = async () => [{ name: 'web', branch: '', dirtyCount: 3 }]
    render(<LaunchGateCard {...baseProps} baseInfo={baseInfo} />)
    expect(await screen.findByText(/未在任何分支上，无法启动/)).toBeTruthy()
    expect((screen.getByText('确认') as HTMLButtonElement).disabled).toBe(true)
  })

  it('文案不再承诺 git stash（已改为快照提交）', async () => {
    const baseInfo = async () => [{ name: 'web', branch: 'branch1', dirtyCount: 7 }]
    const { container } = render(<LaunchGateCard {...baseProps} baseInfo={baseInfo} />)
    await screen.findByText(/基准 branch1/)
    expect(container.textContent).not.toMatch(/stash/i)
  })
})
