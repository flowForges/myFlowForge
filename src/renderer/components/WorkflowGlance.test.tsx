import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkflowGlance, stageDisplayName } from './WorkflowGlance'
import type { WsWorkflow } from '@shared/types'

const wf = (over: Partial<WsWorkflow>): WsWorkflow =>
  ({ id: 'wf1', name: '默认流程', stages: [], ...over })

describe('stageDisplayName', () => {
  it('custom name wins over the built-in fallback', () => {
    expect(stageDisplayName('design', '自定义设计')).toBe('自定义设计')
  })
  it('falls back to the built-in Chinese label for a known key', () => {
    expect(stageDisplayName('design')).toBe('技术方案设计')
  })
  it('falls back to the raw key when unknown and unnamed', () => {
    expect(stageDisplayName('my-custom-stage')).toBe('my-custom-stage')
  })
})

describe('WorkflowGlance', () => {
  it('renders nothing for an empty workflow list', () => {
    const { container } = render(<WorkflowGlance workflows={[]} />)
    expect(container.querySelector('.wf-glance')).toBeNull()
  })

  it('auto-expands the first workflow and shows stage · provider · model', () => {
    render(
      <WorkflowGlance
        workflows={[
          wf({ id: 'a', name: '流程 A', stages: [{ key: 'design', provider: 'claude', model: 'opus' }] }),
        ]}
      />,
    )
    expect(screen.getByText('技术方案设计')).toBeInTheDocument()
    expect(screen.getByText('claude · opus')).toBeInTheDocument()
  })

  it('collapses other workflows until their header is clicked', () => {
    render(
      <WorkflowGlance
        workflows={[
          wf({ id: 'a', name: '流程 A', stages: [{ key: 'design', provider: 'claude', model: 'opus' }] }),
          wf({ id: 'b', name: '流程 B', stages: [{ key: 'develop', provider: 'codex', model: 'gpt-5' }] }),
        ]}
      />,
    )
    expect(screen.queryByText('codex · gpt-5')).toBeNull()
    fireEvent.click(screen.getByText('流程 B'))
    expect(screen.getByText('codex · gpt-5')).toBeInTheDocument()
    // clicking again collapses it back
    fireEvent.click(screen.getByText('流程 B'))
    expect(screen.queryByText('codex · gpt-5')).toBeNull()
  })

  it('shows a custom stage name and stage count', () => {
    render(
      <WorkflowGlance
        workflows={[
          wf({
            id: 'a',
            name: '流程 A',
            stages: [
              { key: 'design', provider: 'claude', model: 'opus' },
              { key: 'custom-1', name: '自定义阶段', provider: 'codex', model: 'gpt-5' },
            ],
          }),
        ]}
      />,
    )
    expect(screen.getByText('2 阶段')).toBeInTheDocument()
    expect(screen.getByText('自定义阶段')).toBeInTheDocument()
  })
})
