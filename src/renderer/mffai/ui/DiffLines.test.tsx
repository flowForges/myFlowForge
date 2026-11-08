import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffLines } from './DiffLines'

describe('DiffLines', () => {
  it('uses the inspector .code-line classes', () => {
    const { container } = render(<DiffLines diff={{ path: 'a.ts', status: 'M', binary: false, truncated: false, lines: [
      { kind: 'ctx', ln: 1, text: 'a' }, { kind: 'del', ln: 2, text: 'b' }, { kind: 'add', ln: 2, text: '<img src=x onerror=alert(1)>' },
    ] }} />)
    const lines = [...container.querySelectorAll('.code-line')]
    expect(lines.map((l) => l.className)).toEqual(['code-line', 'code-line del', 'code-line add'])
    expect(lines.map((l) => [l.querySelector('.ln')!.textContent, l.querySelector('.ct')!.textContent])).toEqual([['1', 'a'], ['2', 'b'], ['2', '<img src=x onerror=alert(1)>']])
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByText('二进制')).toBeNull()
    expect(screen.queryByText('已截断')).toBeNull()
  })

  it('binary and truncated chips', () => {
    render(<DiffLines diff={{ path: 'a.png', status: 'A', binary: true, truncated: true, lines: [] }} />)
    expect(screen.getByText('二进制')).toBeInTheDocument()
    expect(screen.getByText('已截断')).toBeInTheDocument()
  })
})
