import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ApprovalCard } from './ApprovalCard'
import type { ApprovalItem } from './reduce'
import { fail, installFakeForge } from '../test/fakeForge'

const item = (patch: Partial<ApprovalItem> = {}): ApprovalItem => ({ approvalId: 'p1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'ls', seq: 1, ...patch })
const btn = (name: string) => screen.queryByRole('button', { name }) as HTMLButtonElement | null

describe('ApprovalCard', () => {
  it('the summary is shown exactly as sent, as text, in full', () => {
    installFakeForge()
    const summary = `echo "<img src=x onerror=alert(1)>"\n${'x'.repeat(3000)}\n  && rm -rf ./build`
    const { container } = render(<ApprovalCard sessionId="s1" approval={item({ summary })} />)
    const pre = container.querySelector('pre.mffai-summary')!
    expect(pre.textContent).toBe(summary)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('shell')).toBeInTheDocument()
  })

  it('本会话允许 only with a key; 未隔离 with unsandboxed', () => {
    installFakeForge()
    const { rerender } = render(<ApprovalCard sessionId="s1" approval={item()} />)
    expect(btn('允许')).not.toBeNull()
    expect(btn('拒绝')).not.toBeNull()
    expect(btn('本会话允许')).toBeNull()
    expect(screen.queryByText('未隔离')).toBeNull()
    rerender(<ApprovalCard sessionId="s1" approval={item({ key: 'shell:ls', unsandboxed: true })} />)
    expect(btn('本会话允许')).not.toBeNull()
    expect(screen.getByText('未隔离')).toBeInTheDocument()
  })

  it('a click sends approval.respond and greys every button until approval.resolved', async () => {
    const f = installFakeForge({ calls: { 'approval.respond': { ok: true } } })
    const { rerender } = render(<ApprovalCard sessionId="s1" approval={item({ key: 'k' })} />)
    await act(async () => { fireEvent.click(btn('本会话允许')!) })
    expect(f.callsOf('approval.respond')).toEqual([{ approvalId: 'p1', decision: 'allow_session' }])
    for (const n of ['允许', '本会话允许', '拒绝']) expect(btn(n)!.disabled).toBe(true)
    rerender(<ApprovalCard sessionId="s1" approval={item({ key: 'k', resolved: { decision: 'allow', by: 'session' } })} />)
    expect(btn('允许')).toBeNull()
    expect(screen.getByText('已允许')).toBeInTheDocument()
  })

  it('two clicks in one frame send once', () => {
    const f = installFakeForge({ calls: { 'approval.respond': () => new Promise(() => {}) as never } })
    render(<ApprovalCard sessionId="s1" approval={item()} />)
    act(() => { btn('允许')!.click(); btn('拒绝')!.click() })
    expect(f.callsOf('approval.respond')).toHaveLength(1)
  })

  it('a failed respond re-enables the buttons with 失败; ok:false collapses to 已取消', async () => {
    const f = installFakeForge({ calls: { 'approval.respond': () => fail(-32603, 'x') } })
    render(<ApprovalCard sessionId="s1" approval={item()} />)
    await act(async () => { fireEvent.click(btn('拒绝')!) })
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(btn('拒绝')!.disabled).toBe(false)
    f.script({ 'approval.respond': { ok: false } })
    await act(async () => { fireEvent.click(btn('拒绝')!) })
    expect(btn('拒绝')).toBeNull()
    expect(screen.getByText('已取消')).toBeInTheDocument()
  })

  it('resolved lines, with · Telegram when via is set; a stale one is 已取消', () => {
    installFakeForge()
    const cases: [ApprovalItem['resolved'], string][] = [
      [{ decision: 'allow', by: 'user' }, '已允许'],
      [{ decision: 'deny', by: 'user' }, '已拒绝'],
      [{ decision: 'deny', by: 'timeout' }, '超时拒绝'],
      [{ decision: 'deny', by: 'cancel' }, '已取消'],
      [{ decision: 'allow', by: 'user', via: 'telegram:7' }, '已允许 · Telegram'],
      [{ decision: 'deny', by: 'user', via: 'acp' }, '已拒绝 · acp'],
    ]
    for (const [resolved, label] of cases) {
      const { unmount } = render(<ApprovalCard sessionId="s1" approval={item({ resolved })} />)
      expect(screen.getByText(label)).toBeInTheDocument()
      expect(screen.queryAllByRole('button')).toHaveLength(0)
      unmount()
    }
    render(<ApprovalCard sessionId="s1" approval={item({ stale: true })} />)
    expect(screen.getByText('已取消')).toBeInTheDocument()
  })
})
