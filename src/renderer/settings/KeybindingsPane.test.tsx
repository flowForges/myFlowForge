import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { KeybindingsPane } from './KeybindingsPane'
import type { Keybindings } from '@shared/types'

beforeEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
})

const renderPane = (kb: Keybindings, failed: string[] = []) => {
  const onChange = vi.fn()
  render(<KeybindingsPane keybindings={kb} onChange={onChange} globalFailed={failed} />)
  return onChange
}

// Find the row (set-row) containing a given action label.
const row = (label: string) => screen.getByText(label).closest('.set-row') as HTMLElement

describe('KeybindingsPane', () => {
  it('shows defaults formatted, records a new combo on keydown', () => {
    const onChange = renderPane({ overrides: {} })
    const r = within(row('新建工作区'))
    expect(r.getByText('Ctrl+N')).toBeTruthy()
    fireEvent.click(r.getByText('Ctrl+N'))
    expect(r.getByText('按下组合键…')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true, altKey: true })
    expect(onChange).toHaveBeenCalledWith({ overrides: { 'new-workspace': 'Control+Alt+W' } })
  })

  it('unbinds on Backspace while recording', () => {
    const onChange = renderPane({ overrides: {} })
    const r = within(row('新建会话'))
    fireEvent.click(r.getByText('Ctrl+T'))
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(onChange).toHaveBeenCalledWith({ overrides: { 'new-session': '' } })
  })

  it('cancels recording on Escape without changing anything', () => {
    const onChange = renderPane({ overrides: {} })
    const r = within(row('开关终端'))
    fireEvent.click(r.getByText('Ctrl+`'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(r.getByText('Ctrl+`')).toBeTruthy()
  })

  it('flags an in-app duplicate on both colliding rows', () => {
    // Bind new-session onto new-workspace's default → collision.
    renderPane({ overrides: { 'new-session': 'CommandOrControl+N' } })
    expect(within(row('新建工作区')).getByText(/与其他动作快捷键冲突/)).toBeTruthy()
    expect(within(row('新建会话')).getByText(/与其他动作快捷键冲突/)).toBeTruthy()
  })

  it('flags an OS-taken global shortcut', () => {
    renderPane({ overrides: {} }, ['toggle-pet'])
    expect(within(row('显示 / 隐藏宠物')).getByText(/已被系统或其他软件占用/)).toBeTruthy()
  })

  it('shows a reset button only for overridden actions and clears the override', () => {
    const onChange = renderPane({ overrides: { 'new-workspace': 'Control+Alt+W' } })
    const r = within(row('新建工作区'))
    fireEvent.click(r.getByText('重置'))
    expect(onChange).toHaveBeenCalledWith({ overrides: {} })
  })

  it('resets everything via 全部恢复默认', () => {
    const onChange = renderPane({ overrides: { 'new-workspace': 'Control+Alt+W' } })
    fireEvent.click(screen.getByText('全部恢复默认'))
    expect(onChange).toHaveBeenCalledWith({ overrides: {} })
  })
})
