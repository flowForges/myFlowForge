import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetToast } from './PetToast'
import type { Toast } from './usePetToasts'

const confirm: Toast = { id: 'p1', kind: 'confirm', wsName: 'ds', title: '覆盖 theme.ts' }
const input: Toast = { id: 'p2', kind: 'input', wsName: 'api', title: '需要分支' }
const done: Toast = { id: 'done-r1', kind: 'done', wsName: 'ds', title: '任务完成' }

describe('PetToast', () => {
  it('renders a confirm toast with 查看并处理 + close, firing callbacks', () => {
    const onView = vi.fn(); const onDismiss = vi.fn()
    const { container } = render(<PetToast toast={confirm} onView={onView} onDismiss={onDismiss} />)
    expect(container.querySelector('.tk')!.textContent).toBe('需要确认 · ds')
    expect(container.querySelector('.tm')!.textContent).toBe('覆盖 theme.ts')
    fireEvent.click(screen.getByText('查看并处理'))
    expect(onView).toHaveBeenCalledWith('p1')
    fireEvent.click(container.querySelector('.tx')!)
    expect(onDismiss).toHaveBeenCalledWith('p1')
  })

  it('labels an input toast', () => {
    const { container } = render(<PetToast toast={input} onView={() => {}} onDismiss={() => {}} />)
    expect(container.querySelector('.tk')!.textContent).toBe('需要输入 · api')
  })

  it('renders a done toast (ok variant, no 查看并处理)', () => {
    const { container } = render(<PetToast toast={done} onView={() => {}} onDismiss={() => {}} />)
    expect(container.querySelector('.pet-toast.done')).not.toBeNull()
    expect(container.querySelector('.tk')!.textContent).toBe('任务完成 · ds')
    expect(screen.queryByText('查看并处理')).toBeNull()
  })

  it('adds the leave class when leaving', () => {
    const { container } = render(<PetToast toast={{ ...confirm, leaving: true }} onView={() => {}} onDismiss={() => {}} />)
    expect(container.querySelector('.pet-toast.leave')).not.toBeNull()
  })
})
