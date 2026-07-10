import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { WorkflowPane } from './WorkflowPane'
import type { CfgWorkflow, CfgCustomStage } from '../state/useConfig'

// A workflow whose 2nd stage is a REFERENCE (libId) into the global custom-stage library. Its cached
// name is intentionally stale ('旧缓存名') to prove display resolves against the live library.
const workflows: CfgWorkflow[] = [{
  id: 'w1', name: 'WF', plugins: [], stagePrompts: {},
  stages: [
    { key: 'develop', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
    { key: 'custom-1', libId: 'lib-1', name: '旧缓存名', defaultAgent: 'claude', defaultModel: '' },
  ],
}]
const customStages: CfgCustomStage[] = [
  { id: 'lib-1', key: 'lib-1', name: '安全审计', defaultAgent: 'claude', defaultModel: '' },
]

function renderPane(over: Partial<Parameters<typeof WorkflowPane>[0]> = {}) {
  const onUpsertCustomStage = vi.fn(async (_id: string, _patch: Partial<CfgCustomStage>) => customStages[0])
  const onUpdateStages = vi.fn()
  render(
    <WorkflowPane
      workflows={workflows}
      providers={[]}
      customStages={customStages}
      onCreate={() => {}}
      onDelete={() => {}}
      onUpdateWorkflow={() => {}}
      onUpdateStagePrompts={() => {}}
      onUpdateStages={onUpdateStages}
      onUpsertCustomStage={onUpsertCustomStage}
      {...over}
    />,
  )
  return { onUpsertCustomStage, onUpdateStages }
}

describe('WorkflowPane · custom-stage library references', () => {
  // The '安全审计' name and library buttons now also appear in the 新建流程 draft picker, so these
  // assertions scope to the saved workflow's stage chip / add-picker to stay unambiguous.
  it('renders a reference stage with the LIVE library name + a 共享 marker (not the stale cache)', () => {
    renderPane()
    const chip = screen.getByText('共享').closest('.wf-stage-chip') as HTMLElement   // 共享 only on the saved chip
    expect(chip).toBeTruthy()
    expect(chip.textContent).toContain('安全审计')     // live library name
    expect(chip.textContent).not.toContain('旧缓存名')  // not the stale cache
  })

  it('editing a reference stage saves to the shared LIBRARY, not the template stages', () => {
    const { onUpsertCustomStage, onUpdateStages } = renderPane()
    fireEvent.click(screen.getByText('共享').closest('.wf-stage-chip') as HTMLElement)   // open the stage editor
    fireEvent.click(screen.getByText('保存阶段'))    // save
    expect(onUpsertCustomStage).toHaveBeenCalledTimes(1)
    expect(onUpsertCustomStage.mock.calls[0][0]).toBe('lib-1')   // edits target the library def
    expect(onUpdateStages).not.toHaveBeenCalled()               // template stages untouched
  })

  it('offers 新建(共享) + existing library defs when adding a stage', () => {
    // The referenced lib-1 is filtered out of the picker (already used); add a second unused def.
    const cs = [...customStages, { id: 'lib-2', key: 'lib-2', name: '性能压测', defaultAgent: 'claude', defaultModel: '' }]
    renderPane({ customStages: cs })
    fireEvent.click(screen.getByText('阶段'))   // open the saved workflow's add-stage picker
    const picker = document.querySelector('.wf-add-picker') as HTMLElement
    expect(picker).toBeTruthy()
    expect(within(picker).getByText('+ 新建(共享)')).toBeTruthy()
    expect(within(picker).getByText('性能压测')).toBeTruthy()   // unused lib def is offered
  })
})
