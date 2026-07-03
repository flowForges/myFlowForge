import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorkflowStrip } from './WorkflowStrip'
import type { Plugin } from '@shared/plugin'

const plug = (over: Partial<Plugin>): Plugin =>
  ({ id: 'p1', name: 'plug', prompt: '', after: '__start', skills: [], tools: [], ...over })

describe('WorkflowStrip', () => {
  it('renders stage chips in order', () => {
    const { container } = render(
      <WorkflowStrip stages={[{ key: 'design', name: '技术方案设计' }, { key: 'develop', name: '代码开发' }]} plugins={[]} />,
    )
    const stages = [...container.querySelectorAll('.ic-stage')].map(n => n.textContent)
    expect(stages[0]).toContain('技术方案设计')
    expect(stages[1]).toContain('代码开发')
  })

  it('renders a plugin hook chip after its stage (so the user sees it took effect)', () => {
    render(
      <WorkflowStrip
        stages={[{ key: 'design', name: '技术方案设计' }]}
        plugins={[plug({ id: 'x', name: 'code-review', after: 'design', skills: ['code-review'] })]}
      />,
    )
    const chip = screen.getByText('code-review').closest('.ic-plug')
    expect(chip).toBeTruthy()
    // its position is described in the tooltip so the user knows where it runs
    expect(chip?.getAttribute('title')).toContain('技术方案设计 之后')
  })

  it('renders start-position and end-position plugin hooks', () => {
    render(
      <WorkflowStrip
        stages={[{ key: 'design', name: '技术方案设计' }]}
        plugins={[plug({ id: 's', name: 'startplug', after: '__start' }), plug({ id: 'w', name: 'wfplug', after: '__wf' })]}
      />,
    )
    expect(screen.getByText('startplug').closest('.ic-plug')?.getAttribute('title')).toContain('流程开始前')
    expect(screen.getByText('wfplug').closest('.ic-plug')?.getAttribute('title')).toContain('流程结束后')
  })

  it('renders no plugin chips when there are none', () => {
    const { container } = render(
      <WorkflowStrip stages={[{ key: 'design', name: '技术方案设计' }]} plugins={[]} />,
    )
    expect(container.querySelector('.ic-plug')).toBeNull()
  })
})
