// 规则表格(08 §11、评审修订 2):按稳定的行 id 操作和标错,不是下标——move/delete 之后错误还跟着它的规则,
// 删掉的规则连错误一起消失。纯展示组件:不发请求,草稿和保存都在页面层。disabled 时所有控件不可操作。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { RuleError } from '@mffai/protocol'
import { RuleEditor, type RuleRow } from './RuleEditor'

const rows = (): RuleRow[] => [
  { id: 'r1', r: { effect: 'deny', rule: 'read(a)', match: ['x'], noMatch: [] } },
  { id: 'r2', r: { effect: 'ask', rule: 'shell(b)', match: [], noMatch: ['y'] } },
]
const domRows = () => [...document.querySelectorAll('[data-rule]')] as HTMLElement[]

const noop = { onEdit: () => {}, onMove: () => {}, onRemove: () => {}, onAdd: () => {} }

describe('RuleEditor', () => {
  it('one row per rule: effect seg, rule text, its match/noMatch tags', () => {
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} />)
    expect(domRows()).toHaveLength(2)
    expect(within(domRows()[0]).getByRole('button', { name: '拒绝', pressed: true })).toBeInTheDocument()
    expect(within(domRows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('read(a)')
    expect(within(domRows()[0]).getByText('x')).toBeInTheDocument()
    expect(within(domRows()[1]).getByRole('button', { name: '询问', pressed: true })).toBeInTheDocument()
    expect(within(domRows()[1]).getByText('y')).toBeInTheDocument()
  })

  it('edits effect and rule text, identified by id', () => {
    const onEdit = vi.fn()
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} onEdit={onEdit} />)
    fireEvent.click(within(domRows()[0]).getByRole('button', { name: '允许' }))
    expect(onEdit).toHaveBeenCalledWith('r1', { effect: 'allow' })
    fireEvent.change(within(domRows()[1]).getByLabelText('规则'), { target: { value: 'shell(c)' } })
    expect(onEdit).toHaveBeenCalledWith('r2', { rule: 'shell(c)' })
  })

  it('a tag added inside a row calls onEdit for that row only', () => {
    const onEdit = vi.fn()
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} onEdit={onEdit} />)
    const input = within(domRows()[0]).getByLabelText('应匹配')
    fireEvent.change(input, { target: { value: 'z' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onEdit).toHaveBeenCalledWith('r1', { match: ['x', 'z'] })
  })

  it('moves a row by id; edge buttons are disabled', () => {
    const onMove = vi.fn()
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} onMove={onMove} />)
    expect(within(domRows()[0]).getByRole('button', { name: '上移' })).toBeDisabled()
    expect(within(domRows()[1]).getByRole('button', { name: '下移' })).toBeDisabled()
    fireEvent.click(within(domRows()[0]).getByRole('button', { name: '下移' }))
    expect(onMove).toHaveBeenCalledWith('r1', 1)
  })

  it('the effect seg shows exactly the current effect as pressed, one tone class per effect', () => {
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} />)
    const seg = within(domRows()[0]).getByRole('group', { name: '效果' })
    expect(within(seg).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['拒绝', 'true'], ['询问', 'false'], ['允许', 'false']])
    expect(within(seg).getByRole('button', { name: '拒绝' })).toHaveClass('deny')
    expect(within(seg).getByRole('button', { name: '允许' })).toHaveClass('allow')
  })

  it('match tags are green (ok), noMatch tags red (bad)', () => {
    render(<RuleEditor rows={[{ id: 'r1', r: { effect: 'ask', rule: 'a', match: ['m'], noMatch: ['n'] } }]} errors={new Map()} {...noop} />)
    expect(screen.getByText('m').closest('.mffai-chip')).toHaveClass('ok')
    expect(screen.getByText('n').closest('.mffai-chip')).toHaveClass('bad')
  })

  it('deletes a row by id', () => {
    const onRemove = vi.fn()
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} onRemove={onRemove} />)
    fireEvent.click(within(domRows()[1]).getByRole('button', { name: '删除' }))
    expect(onRemove).toHaveBeenCalledWith('r2')
  })

  it('添加规则 calls onAdd', () => {
    const onAdd = vi.fn()
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('a row error keyed by id marks only that row; the other row keeps its text untouched', () => {
    const errors = new Map<string, RuleError>([['r2', { index: 1, rule: 'shell(b)', reason: 'pattern', case: 'c1' }]])
    render(<RuleEditor rows={rows()} errors={errors} {...noop} />)
    expect(within(domRows()[0]).queryByText('pattern')).toBeNull()
    expect(within(domRows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('read(a)')
    expect(within(domRows()[1]).getByText('pattern')).toBeInTheDocument()
    expect(within(domRows()[1]).getByText('c1')).toBeInTheDocument()
    expect(within(domRows()[1]).getByLabelText<HTMLInputElement>('规则').value).toBe('shell(b)')
  })

  it('an error keeps marking its rule after the rows reorder (keyed by id, not position)', () => {
    const errors = new Map<string, RuleError>([['r2', { index: 1, rule: 'shell(b)', reason: 'pattern' }]])
    // r2 现在在第 0 位(模拟上移之后),错误还跟着 id r2
    const reordered: RuleRow[] = [rows()[1], rows()[0]]
    render(<RuleEditor rows={reordered} errors={errors} {...noop} />)
    expect(within(domRows()[0]).getByText('pattern')).toBeInTheDocument()
    expect(within(domRows()[1]).queryByText('pattern')).toBeNull()
  })

  it('disabled: every control in every row and the add button are disabled', () => {
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} disabled />)
    expect(within(domRows()[0]).getByRole('button', { name: '允许' })).toBeDisabled()
    expect(within(domRows()[0]).getByLabelText('规则')).toBeDisabled()
    expect(within(domRows()[0]).getByLabelText('应匹配')).toBeDisabled()
    expect(within(domRows()[0]).getByRole('button', { name: '删除' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加规则' })).toBeDisabled()
  })

  it('registerFlush is forwarded to every match/noMatch TagInput', () => {
    const seen: (() => void)[] = []
    const registerFlush = (fn: () => void) => { seen.push(fn); return () => {} }
    render(<RuleEditor rows={rows()} errors={new Map()} {...noop} registerFlush={registerFlush} />)
    // 两行,每行 match + noMatch 两个 TagInput
    expect(seen).toHaveLength(4)
  })
})
