// 规则表格(08 §11):效果/规则文本/match·noMatch 标签,上移/下移/删除,添加规则;invalid rules 的
// RuleError 按 index 标红对应行,显示 reason 和 case,别的行不受影响。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { RuleError, RuleSpec } from '@mffai/protocol'
import { RuleEditor } from './RuleEditor'

const rules = (): RuleSpec[] => [
  { effect: 'deny', rule: 'a', match: ['x'], noMatch: [] },
  { effect: 'ask', rule: 'b', match: [], noMatch: ['y'] },
]
const rows = () => [...document.querySelectorAll('[data-rule]')] as HTMLElement[]

describe('RuleEditor', () => {
  it('one row per rule: effect select, rule text, its match/noMatch tags', () => {
    render(<RuleEditor rules={rules()} errors={new Map()} onChange={() => {}} />)
    expect(rows()).toHaveLength(2)
    expect(within(rows()[0]).getByLabelText<HTMLSelectElement>('效果').value).toBe('deny')
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('a')
    expect(within(rows()[0]).getByText('x')).toBeInTheDocument()
    expect(within(rows()[1]).getByLabelText<HTMLSelectElement>('效果').value).toBe('ask')
    expect(within(rows()[1]).getByText('y')).toBeInTheDocument()
  })

  it('edits effect and rule text in place', () => {
    const onChange = vi.fn()
    render(<RuleEditor rules={rules()} errors={new Map()} onChange={onChange} />)
    fireEvent.change(within(rows()[0]).getByLabelText('效果'), { target: { value: 'allow' } })
    expect(onChange).toHaveBeenLastCalledWith([{ ...rules()[0], effect: 'allow' }, rules()[1]])
    fireEvent.change(within(rows()[1]).getByLabelText('规则'), { target: { value: 'bb' } })
    expect(onChange).toHaveBeenLastCalledWith([rules()[0], { ...rules()[1], rule: 'bb' }])
  })

  it('a tag added inside a row only changes that row', () => {
    const onChange = vi.fn()
    render(<RuleEditor rules={rules()} errors={new Map()} onChange={onChange} />)
    const input = within(rows()[0]).getByLabelText('应匹配')
    fireEvent.change(input, { target: { value: 'z' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith([{ ...rules()[0], match: ['x', 'z'] }, rules()[1]])
  })

  it('moves a row up/down; the top/bottom buttons are disabled', () => {
    const onChange = vi.fn()
    render(<RuleEditor rules={rules()} errors={new Map()} onChange={onChange} />)
    expect(within(rows()[0]).getByRole('button', { name: '上移' })).toBeDisabled()
    expect(within(rows()[1]).getByRole('button', { name: '下移' })).toBeDisabled()
    fireEvent.click(within(rows()[0]).getByRole('button', { name: '下移' }))
    expect(onChange).toHaveBeenCalledWith([rules()[1], rules()[0]])
  })

  it('deletes a row', () => {
    const onChange = vi.fn()
    render(<RuleEditor rules={rules()} errors={new Map()} onChange={onChange} />)
    fireEvent.click(within(rows()[0]).getByRole('button', { name: '删除' }))
    expect(onChange).toHaveBeenCalledWith([rules()[1]])
  })

  it('添加规则 appends a blank ask rule', () => {
    const onChange = vi.fn()
    render(<RuleEditor rules={rules()} errors={new Map()} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }))
    expect(onChange).toHaveBeenCalledWith([...rules(), { effect: 'ask', rule: '', match: [], noMatch: [] }])
  })

  it('a row error marks only that row by index; the other row keeps its text untouched', () => {
    const errors = new Map<number, RuleError>([[1, { index: 1, rule: 'b', reason: 'pattern', case: 'c1' }]])
    render(<RuleEditor rules={rules()} errors={errors} onChange={() => {}} />)
    expect(within(rows()[0]).queryByText('pattern')).toBeNull()
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('a')
    expect(within(rows()[1]).getByText('pattern')).toBeInTheDocument()
    expect(within(rows()[1]).getByText('c1')).toBeInTheDocument()
    expect(within(rows()[1]).getByLabelText<HTMLInputElement>('规则').value).toBe('b')
  })
})
