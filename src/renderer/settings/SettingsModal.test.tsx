import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'

describe('SettingsModal tab routing', () => {
  it('defaults to appearance and switches panes on nav click', () => {
    const renderPane = vi.fn((key: string) => <div data-testid="pane">{key}</div>)
    render(<SettingsModal open onClose={() => {}} renderPane={renderPane} />)
    expect(screen.getByTestId('pane').textContent).toBe('appearance')
    fireEvent.click(screen.getByText('终端代理'))
    expect(screen.getByTestId('pane').textContent).toBe('agents')
    fireEvent.click(screen.getByText('项目设置'))
    expect(screen.getByTestId('pane').textContent).toBe('project')
  })

  it('opens to the pane specified by initialPane', () => {
    const renderPane = vi.fn((key: string) => <div data-testid="pane">{key}</div>)
    render(<SettingsModal open onClose={() => {}} renderPane={renderPane} initialPane="workflow" />)
    expect(screen.getByTestId('pane').textContent).toBe('workflow')
    // the nav button for workflow should have class "on"
    const wfNav = document.querySelector('[data-set="workflow"]') as HTMLElement
    expect(wfNav?.className).toContain('on')
  })

  it('resets to the new initialPane when closed then reopened', () => {
    const renderPane = vi.fn((key: string) => <div data-testid="pane">{key}</div>)
    const { rerender } = render(<SettingsModal open onClose={() => {}} renderPane={renderPane} initialPane="workflow" />)
    expect(screen.getByTestId('pane').textContent).toBe('workflow')
    // close
    rerender(<SettingsModal open={false} onClose={() => {}} renderPane={renderPane} initialPane="project" />)
    // reopen with different initialPane
    rerender(<SettingsModal open onClose={() => {}} renderPane={renderPane} initialPane="project" />)
    expect(screen.getByTestId('pane').textContent).toBe('project')
  })
})
