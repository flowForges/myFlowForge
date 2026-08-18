import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FinalizeFailureCard } from './FinalizeFailureCard'

const failures = [{
  project: 'web', target: 'branch1', tempBranch: 'forge/run-a1b2',
  conflictFiles: ['src/foo.ts', 'src/bar.ts'], detail: 'CONFLICT (content)',
}]

describe('FinalizeFailureCard', () => {
  it('第一句就说清没丢，并点名保留改动的分支', () => {
    render(<FinalizeFailureCard failures={failures} onHandoff={() => {}} />)
    expect(screen.getByText(/本次改动一个都没丢/)).toBeTruthy()
    expect(screen.getAllByText(/forge\/run-a1b2/).length).toBeGreaterThan(0)
  })

  it('列出冲突文件', () => {
    render(<FinalizeFailureCard failures={failures} onHandoff={() => {}} />)
    expect(screen.getByText('src/foo.ts')).toBeTruthy()
    expect(screen.getByText('src/bar.ts')).toBeTruthy()
  })

  it('给出可直接粘贴的手工合并命令（含真实分支名）', () => {
    render(<FinalizeFailureCard failures={failures} onHandoff={() => {}} />)
    expect(screen.getByText(/git merge --no-ff forge\/run-a1b2/)).toBeTruthy()
  })

  // #7 fix round 1 (F7): the test name promised BOTH words are never said — only 回滚 was actually
  // asserted. A test whose name overstates its coverage is worse than no test.
  it('绝不对用户说「回滚」或用「丢弃」描述工作流产出', () => {
    const { container } = render(<FinalizeFailureCard failures={failures} onHandoff={() => {}} />)
    expect(container.textContent).not.toMatch(/回滚/)
    expect(container.textContent).not.toMatch(/丢弃/)
  })

  it('「知道了，我自己处理」触发 onHandoff', () => {
    const onHandoff = vi.fn()
    render(<FinalizeFailureCard failures={failures} onHandoff={onHandoff} />)
    fireEvent.click(screen.getByText('知道了，我自己处理'))
    expect(onHandoff).toHaveBeenCalledOnce()
  })
})
