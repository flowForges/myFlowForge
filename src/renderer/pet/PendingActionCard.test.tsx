import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PendingActionCard } from './PendingActionCard'
import type { PendingAction } from '@shared/types'

const confirm: PendingAction = { id: 'p1', kind: 'confirm', agentId: 'a', agentName: 'Refactor 代理', wsName: 'design-system-v3', title: '覆盖 theme.ts', where: 'src/styles/theme.ts' }
const input: PendingAction = { id: 'p2', kind: 'input', agentId: 'a', agentName: '部署代理', wsName: 'api-gateway', title: '需要目标分支', placeholder: 'release/v2.4' }

describe('PendingActionCard', () => {
  it('renders a confirm card and resolves allow/deny', () => {
    const onResolve = vi.fn()
    const { container } = render(<PendingActionCard action={confirm} onResolve={onResolve} />)
    expect(container.querySelector('.pp-act')!.getAttribute('data-act')).toBe('p1')
    expect(screen.getByText('需确认')).toBeInTheDocument()
    expect(container.querySelector('.am')!.textContent).toBe('覆盖 theme.ts')
    expect(container.querySelector('.aw')!.textContent).toContain('src/styles/theme.ts')
    fireEvent.click(screen.getByText('允许'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'p1', decision: 'allow' })
    fireEvent.click(screen.getByText('拒绝'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'p1', decision: 'deny' })
  })

  it('renders an input card and resolves with the typed value', () => {
    const onResolve = vi.fn()
    const { container } = render(<PendingActionCard action={input} onResolve={onResolve} />)
    expect(screen.getByText('需输入')).toBeInTheDocument()
    const field = container.querySelector('.ain input') as HTMLInputElement
    expect(field.placeholder).toBe('release/v2.4')
    fireEvent.change(field, { target: { value: 'release/v2.5' } })
    fireEvent.click(screen.getByText('提交'))
    expect(onResolve).toHaveBeenCalledWith({ id: 'p2', decision: 'allow', value: 'release/v2.5' })
  })
})
