import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StageConfigEditor, builtinStageDefaults } from './StageConfigEditor'
import type { CfgStage } from '../state/useConfig'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [{ id: 'claude', displayName: 'Claude', models: [{ id: 'opus', label: 'Opus' }] } as unknown as ProviderInfo]
const reviewStage: CfgStage = { key: 'review', defaultAgent: 'claude', defaultModel: 'opus' }

function renderEditor(stage: CfgStage, onSave = vi.fn()) {
  render(<StageConfigEditor stage={stage} isBuiltin builtinName="代码 CR" providers={providers} onSave={onSave} onCancel={vi.fn()} />)
  return onSave
}

describe('②多镜头CR: StageConfigEditor lens picker', () => {
  it('builtinStageDefaults review = 并行多视角 with all four lenses', () => {
    expect(builtinStageDefaults('review').review).toEqual({ mode: 'parallel', reviewers: ['correctness', 'security', 'performance', 'style'] })
  })

  it('shows the four lens chips only when 并行多视角 is selected', () => {
    renderEditor(reviewStage)
    // review defaults to parallel → chips visible
    expect(screen.getByText('正确性')).toBeInTheDocument()
    expect(screen.getByText('安全')).toBeInTheDocument()
    expect(screen.getByText('性能')).toBeInTheDocument()
    expect(screen.getByText('规范')).toBeInTheDocument()
    // switch to 单代理 → chips gone
    fireEvent.click(screen.getByText('单代理'))
    expect(screen.queryByText('正确性')).toBeNull()
  })

  it('saves the checked lenses in canonical order; unchecking one drops it', () => {
    const onSave = renderEditor(reviewStage)
    fireEvent.click(screen.getByText('性能')) // uncheck performance (starts all-on)
    fireEvent.click(screen.getByText('保存阶段'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      review: { mode: 'parallel', reviewers: ['correctness', 'security', 'style'] },
    }))
  })

  it('unchecking ALL lenses falls back to all four on save (a parallel review needs ≥1 reviewer)', () => {
    const onSave = renderEditor(reviewStage)
    for (const l of ['正确性', '安全', '性能', '规范']) fireEvent.click(screen.getByText(l))
    fireEvent.click(screen.getByText('保存阶段'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      review: { mode: 'parallel', reviewers: ['correctness', 'security', 'performance', 'style'] },
    }))
  })

  it('单代理 saves mode single (no lenses)', () => {
    const onSave = renderEditor(reviewStage)
    fireEvent.click(screen.getByText('单代理'))
    fireEvent.click(screen.getByText('保存阶段'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ review: { mode: 'single' } }))
  })
})
