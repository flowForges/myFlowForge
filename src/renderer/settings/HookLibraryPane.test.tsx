import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HookLibraryPane } from './HookLibraryPane'
import type { LibraryHook } from '@shared/plugin'

const hooks: LibraryHook[] = [
  { id: 'hk1', name: '拉取最新主干', prompt: 'git fetch', skills: [], tools: [] },
]

function props(over: Partial<React.ComponentProps<typeof HookLibraryPane>> = {}) {
  return { hooks, onSave: vi.fn(), onDelete: vi.fn(), onSetAll: vi.fn(), ...over }
}

describe('HookLibraryPane', () => {
  it('lists existing hooks with a count', () => {
    render(<HookLibraryPane {...props()} />)
    expect(screen.getByText('拉取最新主干')).toBeInTheDocument()
    expect(screen.getByText('1 条')).toBeInTheDocument()
  })

  it('adds a new hook via the editor (fresh hk- id, no after)', () => {
    const onSave = vi.fn()
    render(<HookLibraryPane {...props({ hooks: [], onSave })} />)
    // Open the blank editor (the "+" insert button), fill name, save.
    fireEvent.click(screen.getByRole('button', { name: /新增 Hook/ }))
    fireEvent.change(screen.getByPlaceholderText(/当前时间 \/ 读取我的记忆/), { target: { value: '新钩子' } })
    fireEvent.click(screen.getByRole('button', { name: /添加插件/ }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0][0]
    expect(saved).toMatchObject({ name: '新钩子' })
    expect(saved.id).toMatch(/^hk-/)
    expect(saved).not.toHaveProperty('after')
  })

  it('deletes a hook', () => {
    const onDelete = vi.fn()
    render(<HookLibraryPane {...props({ onDelete })} />)
    fireEvent.click(screen.getByRole('button', { name: /删除/ }))
    expect(onDelete).toHaveBeenCalledWith('hk1')
  })
})
