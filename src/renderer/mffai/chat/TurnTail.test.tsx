import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { TurnTail } from './TurnTail'
import type { TurnView } from './reduce'
import { route } from '../route'
import { fail, installFakeForge } from '../test/fakeForge'

const S = 's1'
const t = (patch: Partial<TurnView> = {}): TurnView => ({ turnId: 't1', seq: 1, users: [], steps: [], approvals: [], runs: new Map(), netDenied: [], terminal: { type: 'turn.ended' }, ...patch })
const btn = (name: string) => screen.queryByRole('button', { name }) as HTMLButtonElement | null

beforeEach(() => route.set({ page: 'chat', sessionId: S }))

describe('TurnTail', () => {
  it('usage, 插件索引, 已拦截, the rebuilt and narrowed dividers', () => {
    installFakeForge()
    const { container } = render(<TurnTail sessionId={S} canRollback={false} turn={t({
      usage: { turnId: 't1', input: 11, output: 3, cacheRead: 5 }, plugins: true, netDenied: ['evil.example:443'], narrowed: true,
      rebuilt: [{ turnId: 't1', step: 2, checkpointSeq: 1, throughSeq: 1, before: 9000, after: 3000 }],
    })} />)
    for (const x of ['输入 11 · 输出 3 · 缓存 5', '插件索引', '已拦截 evil.example:443']) expect(screen.getByText(x)).toBeInTheDocument()
    expect([...container.querySelectorAll('.mffai-divider')].map((d) => d.textContent)).toEqual(['上下文已压缩 9000 → 3000', '自动放行已收回'])
  })

  it('no usage: no usage chip; cache 0 when absent', () => {
    installFakeForge()
    const { rerender } = render(<TurnTail sessionId={S} canRollback={false} turn={t()} />)
    expect(screen.queryByText(/^输入/)).toBeNull()
    rerender(<TurnTail sessionId={S} canRollback={false} turn={t({ usage: { turnId: 't1', input: 1, output: 2 } })} />)
    expect(screen.getByText('输入 1 · 输出 2 · 缓存 0')).toBeInTheDocument()
  })

  it('记忆 N lists the items through memory.get; a click goes to the memory page', async () => {
    const f = installFakeForge({ calls: { 'memory.get': ({ id }) => ({ id, layer: 'memory', text: `text of ${id}` }) as never } })
    render(<TurnTail sessionId={S} canRollback={false} turn={t({ injected: { items: ['n_a', 'n_b'], truncated: false } })} />)
    await act(async () => { fireEvent.click(btn('记忆 2')!) })
    expect(f.callsOf('memory.get')).toEqual([{ id: 'n_a' }, { id: 'n_b' }])
    fireEvent.click(screen.getByText('text of n_b'))
    expect(route.get().page).toBe('memory')
  })

  it('failure: the reason as a code; cancelled is 已停止', () => {
    installFakeForge()
    const { rerender } = render(<TurnTail sessionId={S} canRollback={false} turn={t({ terminal: { type: 'turn.failed', reason: 'max_steps' } })} />)
    expect(screen.getByText('max_steps').tagName).toBe('CODE')
    rerender(<TurnTail sessionId={S} canRollback={false} turn={t({ terminal: { type: 'turn.failed', reason: 'cancelled' } })} />)
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(screen.queryByText('cancelled')).toBeNull()
  })

  it('改动 N opens turn.changes and turn.diff', async () => {
    const f = installFakeForge({ calls: {
      'turn.changes': { files: [{ path: 'a.ts', status: 'A' }] },
      'turn.diff': { path: 'a.ts', status: 'A', binary: false, truncated: false, lines: [{ kind: 'add', ln: 1, text: 'NEWLINE' }] },
    } })
    render(<TurnTail sessionId={S} canRollback={false} turn={t({ snapshot: { start: 'a', end: 'b', changed: 4 } })} />)
    await act(async () => { fireEvent.click(btn('改动 4')!) })
    expect(f.callsOf('turn.changes')).toEqual([{ sessionId: S, turnId: 't1' }])
    await act(async () => { fireEvent.click(screen.getByText('a.ts')) })
    expect(f.callsOf('turn.diff')).toEqual([{ sessionId: S, turnId: 't1', path: 'a.ts' }])
    expect(screen.getByText('NEWLINE')).toBeInTheDocument()
  })

  it('a snapshot that was not taken: 不可回滚 with the code', () => {
    installFakeForge()
    render(<TurnTail sessionId={S} canRollback={false} turn={t({ snapshot: { reason: 'unsafe_filter' } })} />)
    expect(screen.getByText('不可回滚')).toBeInTheDocument()
    expect(screen.getByText('unsafe_filter').tagName).toBe('CODE')
  })

  it('回滚本轮 only when allowed; confirm 回滚本轮 / 文件 N; the result with skipped chips', async () => {
    const f = installFakeForge({ calls: { 'turn.rollback': { ok: true, files: 3, skipped: ['vendor/sub'] } } })
    const turn = t({ snapshot: { start: 'a', end: 'b', changed: 4 } })
    const { rerender } = render(<TurnTail sessionId={S} canRollback={false} turn={turn} />)
    expect(btn('回滚本轮')).toBeNull()
    rerender(<TurnTail sessionId={S} canRollback turn={turn} />)
    fireEvent.click(btn('回滚本轮')!)
    const d = screen.getByRole('dialog')
    expect(d).toHaveAccessibleName('回滚本轮')
    expect([...d.querySelectorAll('.mffai-confirm-row span')].map((s) => s.textContent)).toEqual(['文件', '4'])
    await act(async () => { fireEvent.click(within(d).getByRole('button', { name: '回滚本轮' })) })
    expect(f.callsOf('turn.rollback')).toEqual([{ commandId: expect.any(String), sessionId: S, turnId: 't1' }])
    expect(screen.getByText('已回滚 3 个文件')).toBeInTheDocument()
    expect(screen.getByText('vendor/sub').tagName).toBe('CODE')
    expect(btn('回滚本轮')).toBeNull()
  })

  it('a rolled-back turn from the event shows its result; a failed rollback 失败, retried with the same commandId', async () => {
    const f = installFakeForge({ calls: { 'turn.rollback': () => fail(-32010, 'timeout') } })
    const { rerender } = render(<TurnTail sessionId={S} canRollback turn={t({ snapshot: { start: 'a', end: 'b', changed: 1 } })} />)
    for (let i = 0; i < 2; i++) {
      fireEvent.click(btn('回滚本轮')!)
      await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '回滚本轮' })) })
    }
    expect(screen.getByText('失败')).toBeInTheDocument()
    const [a, b] = f.callsOf('turn.rollback') as { commandId: string }[]
    expect(b.commandId).toBe(a.commandId)
    rerender(<TurnTail sessionId={S} canRollback={false} turn={t({ rolledBack: { files: 2, skipped: [] } })} />)
    expect(screen.getByText('已回滚 2 个文件')).toBeInTheDocument()
  })
})
