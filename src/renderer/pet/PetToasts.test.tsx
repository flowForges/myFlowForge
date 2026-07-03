import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { PetToasts } from './PetToasts'
import type { Toast } from './usePetToasts'

const toasts: Toast[] = [
  { id: 'p1', kind: 'confirm', wsName: 'ds', title: 'a' },
  { id: 'p2', kind: 'input', wsName: 'api', title: 'b' }
]

describe('PetToasts', () => {
  it('renders one .pet-toast per toast with the corner attribute', () => {
    const { container } = render(<PetToasts toasts={toasts} corner="left" onView={() => {}} onDismiss={() => {}} />)
    expect(container.querySelector('.pet-toasts')!.getAttribute('data-corner')).toBe('left')
    expect(container.querySelectorAll('.pet-toast')).toHaveLength(2)
  })

  it('wires per-toast callbacks', () => {
    const onDismiss = vi.fn()
    const { container } = render(<PetToasts toasts={toasts} corner="right" onView={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(container.querySelectorAll('.tx')[1])
    expect(onDismiss).toHaveBeenCalledWith('p2')
  })

  it('renders nothing inside when there are no toasts', () => {
    const { container } = render(<PetToasts toasts={[]} corner="right" onView={() => {}} onDismiss={() => {}} />)
    expect(container.querySelectorAll('.pet-toast')).toHaveLength(0)
  })
})
