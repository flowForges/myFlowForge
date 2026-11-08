import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Confirm } from './Confirm'

describe('Confirm', () => {
  it('renders item: value rows and keep rows, confirm and cancel', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn()
    const { container } = render(
      <Confirm title="删除会话" rows={[['会话', '修 bug'], ['运行', '2']]} keep={['仓库里的 worktree 登记']}
        confirmLabel="删除" danger onCancel={onCancel} onConfirm={onConfirm} />,
    )
    expect(container.querySelector('.confirm-overlay')).not.toBeNull()
    expect(container.querySelector('.confirm-card')).not.toBeNull()
    expect(screen.getByRole('dialog')).toHaveTextContent('删除会话')
    const rows = [...container.querySelectorAll('.mffai-confirm-row')].map((r) => [...r.children].map((c) => c.textContent))
    expect(rows).toEqual([['会话', '修 bug'], ['运行', '2'], ['保留', '仓库里的 worktree 登记']])
    expect(screen.getByText('删除').className).toBe('confirm-danger')
    fireEvent.click(screen.getByText('删除'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('not danger -> neutral button', () => {
    render(<Confirm title="t" rows={[]} confirmLabel="好" onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText('好').className).toBe('confirm-ok')
  })

  it('requireTyped: disabled until the exact text, a near miss stays disabled', () => {
    const onConfirm = vi.fn()
    render(<Confirm title="信任" rows={[]} confirmLabel="信任" requireTyped="plugin.json" onCancel={() => {}} onConfirm={onConfirm} />)
    const btn = screen.getByRole('button', { name: '信任' }) as HTMLButtonElement
    const input = screen.getByRole('textbox')
    expect(input.getAttribute('placeholder')).toBeNull()
    expect(input.getAttribute('aria-label')).not.toContain('plugin.json')
    expect(btn.disabled).toBe(true)
    for (const near of ['plugin.jso', 'plugin.json ', ' plugin.json', 'Plugin.json', 'plugin.jsonx']) {
      fireEvent.change(input, { target: { value: near } })
      expect(btn.disabled, near).toBe(true)
      fireEvent.click(btn)
    }
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'plugin.json' } })
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('busy disables confirm', () => {
    render(<Confirm title="t" rows={[]} confirmLabel="好" busy onCancel={() => {}} onConfirm={() => {}} />)
    expect((screen.getByText('好') as HTMLButtonElement).disabled).toBe(true)
  })
})
