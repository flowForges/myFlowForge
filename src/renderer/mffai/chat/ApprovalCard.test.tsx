import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  it('a resolved approval renders its summary line through the same escapes, title attribute included', () => {
    installFakeForge()
    const summary = 'echo safe\u202E;txt.exe\u202C a\u200Bb'
    const { container } = render(<ApprovalCard sessionId="s1" approval={item({ summary, resolved: { decision: 'allow', by: 'user' } })} />)
    const line = container.querySelector('code.mffai-summary-line')!
    expect(line.textContent).toBe('echo safe\\u{202E};txt.exe\\u{202C} a\\u{200B}b')
    expect(line.getAttribute('title')).toBe('echo safe\\u{202E};txt.exe\\u{202C} a\\u{200B}b')
    expect(container.innerHTML).not.toMatch(/[\u202E\u202C\u200B]/)
  })

  it('bidi, format and zero-width characters show as visible escapes, so the text reads in the order it runs', () => {
    installFakeForge()
    const summary = 'echo safe‮;txt.exe‬ ⁦x⁩ a​b﻿­'
    const { container } = render(<ApprovalCard sessionId="s1" approval={item({ summary })} />)
    const pre = container.querySelector('pre.mffai-summary')!
    expect(pre.textContent).toBe('echo safe\\u{202E};txt.exe\\u{202C} \\u{2066}x\\u{2069} a\\u{200B}b\\u{FEFF}\\u{AD}')
    expect(/[\p{Cf}]/u.test(pre.textContent!)).toBe(false)
    expect(pre.querySelectorAll('.mffai-esc')).toHaveLength(7)
  })

  it('a run of blank lines collapses to ⋯ N 空行, so the tail after it is in view; no max-height on a pending summary', () => {
    installFakeForge()
    const summary = `echo ok${'\n'.repeat(40)};rm -rf ~`
    const { container } = render(<ApprovalCard sessionId="s1" approval={item({ summary })} />)
    const pre = container.querySelector('pre.mffai-summary')!
    expect(pre.textContent).toBe('echo ok\n⋯ 39 空行\n;rm -rf ~')
    expect(pre.querySelector('.mffai-blank')!.textContent).toBe('⋯ 39 空行')
    // 两行以内的空行原样
    const { container: c2 } = render(<ApprovalCard sessionId="s1" approval={item({ summary: 'a\n\n\nb' })} />)
    expect(c2.querySelector('pre.mffai-summary')!.textContent).toBe('a\n\n\nb')
    // 开头的空行一样收起:命令不会被推到下面
    const { container: c3 } = render(<ApprovalCard sessionId="s1" approval={item({ summary: `${'\n'.repeat(30)}rm -rf ~` })} />)
    expect(c3.querySelector('pre.mffai-summary')!.textContent).toBe('⋯ 30 空行\nrm -rf ~')
    const css = readFileSync(resolve(__dirname, '../mffai.css'), 'utf8')
    const rule = /\.mffai-summary\s*\{([^}]*)\}/.exec(css)![1]
    expect(rule).not.toMatch(/max-height|overflow/)
  })
})
