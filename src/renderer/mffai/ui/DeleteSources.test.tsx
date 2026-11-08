import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DeleteSources } from './DeleteSources'
import { fail, installFakeForge } from '../test/fakeForge'

const item = (id: string, text: string) => ({ id, layer: 'memory' as const, text })
const rowOf = (id: string) => [...document.querySelectorAll('.mffai-confirm-row')].find((r) => r.querySelector('code')?.textContent === id) as HTMLElement | undefined

describe('DeleteSources', () => {
  it('lists each id with its text and deletes them one by one; -32010 retries with the same commandId; not found counts as deleted', async () => {
    let n = 0
    const f = installFakeForge({ calls: {
      'memory.get': ({ id }) => (id === 'n_a' ? item('n_a', '用户喜欢短回答') : id === 'n_b' ? item('n_b', 'bbb') : fail(-32602, 'not found')),
      'memory.delete': ({ id }) => {
        if (id === 'n_a') return { ok: true, redacted: 1, sources: [] }
        return ++n === 1 ? fail(-32010, 'timeout') : fail(-32602, 'not found')
      },
    } })
    const onClose = vi.fn()
    render(<DeleteSources title={(k) => `仍引用它的记忆 ${k} 条`} ids={['n_a', 'n_b', 'n_c']} onClose={onClose} />)
    expect(screen.getByRole('dialog')).toHaveAccessibleName('仍引用它的记忆 3 条')
    await waitFor(() => expect(within(rowOf('n_a')!).getByText('用户喜欢短回答')).toBeInTheDocument())
    expect(rowOf('n_c')).toBeDefined()

    await act(async () => { fireEvent.click(within(rowOf('n_a')!).getByRole('button', { name: '删除' })) })
    await waitFor(() => expect(rowOf('n_a')).toBeUndefined())
    expect(screen.getByText('仍引用它的记忆 2 条')).toBeInTheDocument()
    expect(f.callsOf('memory.delete')).toHaveLength(1)

    await act(async () => { fireEvent.click(within(rowOf('n_b')!).getByRole('button', { name: '删除' })) })
    expect(await within(rowOf('n_b')!).findByText('失败')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(rowOf('n_b')!).getByRole('button', { name: '删除' })) })
    await waitFor(() => expect(rowOf('n_b')).toBeUndefined())
    const [, b1, b2] = f.callsOf('memory.delete') as any[]
    expect(b1.id).toBe('n_b')
    expect(b2.commandId).toBe(b1.commandId)
    expect(screen.getByText('仍引用它的记忆 1 条')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalled()
  })
})
