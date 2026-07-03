import { it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WsMenu } from './WsMenu'

const items = (onA: () => void, onB: () => void) => [
  { key: 'a', label: '操作甲', icon: <i />, onClick: onA },
  { key: 'b', label: '删除乙', icon: <i />, danger: true, onClick: onB },
]

it('is closed by default and opens on click, revealing icon+text items', () => {
  render(<WsMenu items={items(() => {}, () => {})} />)
  expect(screen.queryByText('操作甲')).toBeNull()
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(screen.getByText('操作甲')).toBeInTheDocument()
  expect(screen.getByText('删除乙')).toBeInTheDocument()
})

it('runs the item handler and closes the menu', () => {
  const onA = vi.fn()
  render(<WsMenu items={items(onA, () => {})} />)
  fireEvent.click(screen.getByTitle('更多操作'))
  fireEvent.click(screen.getByText('操作甲'))
  expect(onA).toHaveBeenCalledOnce()
  // menu closes after choosing an item
  expect(screen.queryByText('操作甲')).toBeNull()
})

it('closes on outside click without firing any handler', () => {
  const onA = vi.fn()
  render(<div><WsMenu items={items(onA, () => {})} /><button>外部</button></div>)
  fireEvent.click(screen.getByTitle('更多操作'))
  expect(screen.getByText('操作甲')).toBeInTheDocument()
  fireEvent.click(screen.getByText('外部'))
  expect(screen.queryByText('操作甲')).toBeNull()
  expect(onA).not.toHaveBeenCalled()
})
