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

  // I2(2026-08-17 全分支终审):收尾门有三个出口(合并/先不合并/彻底丢弃),三种失败走的是同一条记录
  // 路径,可这张卡此前把合并那套叙事写死了 —— 一个点了「先不合并」的用户,保留失败之后会被这张卡劝去
  // `git merge --no-ff` 合并他刚刚拒绝的东西。标题和命令块现在按 decision 分岔。
  describe('I2:按用户真正选的那个动作说话', () => {
    const withDecision = (decision: 'merge' | 'discard' | 'park') =>
      [{ ...failures[0], decision }]

    it('保留分支失败:不说"无法自动合并",也不给出合并命令', () => {
      const { container } = render(<FinalizeFailureCard failures={withDecision('park')} />)
      expect(container.textContent).not.toMatch(/无法自动合并/)
      expect(container.textContent).not.toMatch(/git merge/)
      expect(container.textContent).toMatch(/无法保留分支/)
      expect(container.textContent).toMatch(/git switch branch1/)
    })

    // Task 8 residual fix (R2): the card used to hand out an unconditional `git branch -D` here, which
    // directly contradicted the 原因 line's own recovery instructions whenever the failure was the
    // snapshot restore conflicting (that reason text says the branch was KEPT and gives its own
    // cherry-pick command — see tempBranch.ts's discardTempBranch). The card can't tell from `f.detail`
    // alone whether deleting is safe, so it no longer asserts it either way — it points back at 原因.
    it('丢弃失败:标题说丢弃,命令只给回到自己分支这一步,删不删分支交给上面「原因」说明', () => {
      const { container } = render(<FinalizeFailureCard failures={withDecision('discard')} />)
      expect(container.textContent).not.toMatch(/无法自动合并/)
      expect(container.textContent).not.toMatch(/git merge/)
      expect(container.textContent).toMatch(/无法丢弃/)
      expect(container.textContent).toMatch(/git switch branch1/)
      expect(container.textContent).not.toMatch(/git branch -D/)
      expect(container.textContent).toMatch(/按上面「原因」的说明来/)
    })

    it('合并失败:与改动前一字不差', () => {
      const { container } = render(<FinalizeFailureCard failures={withDecision('merge')} />)
      expect(container.textContent).toMatch(/无法自动合并/)
      expect(container.textContent).toMatch(/git merge --no-ff forge\/run-a1b2/)
    })

    it('老的落盘状态没有 decision 字段 → 按合并兜底(那是它们当时唯一能显示的文案)', () => {
      const { container } = render(<FinalizeFailureCard failures={failures} />)
      expect(container.textContent).toMatch(/无法自动合并/)
      expect(container.textContent).toMatch(/git merge --no-ff/)
    })

    it('非合并失败时不再宣称目标分支"已恢复到合并前的干净状态"(压根没尝试过合并)', () => {
      const { container } = render(<FinalizeFailureCard failures={withDecision('park')} />)
      expect(container.textContent).not.toMatch(/已恢复到合并前的干净状态/)
    })
  })

  it('「知道了，我自己处理」触发 onHandoff', () => {
    const onHandoff = vi.fn()
    render(<FinalizeFailureCard failures={failures} onHandoff={onHandoff} />)
    fireEvent.click(screen.getByText('知道了，我自己处理'))
    expect(onHandoff).toHaveBeenCalledOnce()
  })
})
