import { it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Message } from './Message'

it('a user turn made in the official app carries 在 <App> 中', () => {
  const { container } = render(<Message msg={{ id: 'e1', who: 'user', text: '问', ts: '', ext: { app: 'Claude', id: 'u' } }} streaming={false} />)
  expect(container.querySelector('.msg-ext')!.textContent).toBe('在 Claude 中')
})

it('an app reply carries the tag and folds its tool calls into one collapsed line', () => {
  const { container } = render(<Message msg={{ id: 'e2', who: 'ai', text: '答', ts: '', ext: { app: 'Codex', id: 'a' }, tools: [{ id: 't1', title: 'shell ls', status: 'ok' }, { id: 't2', title: 'shell pwd', status: 'ok' }] }} streaming={false} />)
  expect(container.querySelector('.msg-ext')!.textContent).toBe('在 Codex 中')
  const block = container.querySelector('details.tool-block') as HTMLDetailsElement
  expect(block.open).toBe(false)
  expect(block.querySelector('summary')!.textContent).toContain('2 步')
})

it('the backlog cap row reads 更早的 N 条 and nothing else', () => {
  const { container } = render(<Message msg={{ id: 'e3', who: 'ai', text: '', ts: '', ext: { app: 'Codex', id: '', earlier: 37 } }} streaming={false} />)
  expect(container.textContent).toBe('更早的 37 条')
})
