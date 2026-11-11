import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ExecutorRunEndedPayload } from '@mffai/protocol'
import { RunCard } from './RunCard'
import type { RunItem } from './reduce'
import { fail, installFakeForge } from '../test/fakeForge'
import { runRow } from '../test/sessions'

const S = 's1'
const ended = (patch: Partial<ExecutorRunEndedPayload> = {}): ExecutorRunEndedPayload => ({
  runId: 'r1', turnId: 't1', executor: 'codex', status: 'ok', ms: 1500, changed: { files: ['a.ts', 'b.ts', 'c.ts'], source: 'git' }, worktree: '/wt/r1', ...patch,
})
const run = (patch: Partial<RunItem> = {}): RunItem => ({
  runId: 'r1', turnId: 't1', seq: 1, phase: 'running', executor: 'codex', isolation: 'wrapped', readOnly: false, cwd: '/repo', progress: [], ...patch,
})
const done = (patch: Partial<RunItem> = {}, end: Partial<ExecutorRunEndedPayload> = {}) => run({ phase: 'ended', worktree: '/wt/r1', ended: ended(end), ...patch })
/** executor.runs 里这次运行的行:worktree 还在 */
const kept = runRow('r1', S, { worktree: { path: '/wt/r1', present: true }, changed: 3 })
const btn = (name: string) => screen.queryByRole('button', { name }) as HTMLButtonElement | null
const dialog = () => screen.getByRole('dialog')
const rows = () => [...dialog().querySelectorAll('.mffai-confirm-row')].map((r) => [...r.querySelectorAll('span')].map((c) => c.textContent))

describe('RunCard head at the 368px panel width', () => {
  const rule = (sel: string) => {
    const css = readFileSync(resolve(__dirname, '../styles/chat.css'), 'utf8')
    return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim() === sel)).map((m) => m[2]).join(';')
  }
  it('the head does not wrap; the chips shrink and ellipsize; 停止 keeps its width on one line', () => {
    expect(rule('.mffai-act .mffai-rcard-h')).toMatch(/flex-wrap:\s*nowrap/)
    expect(rule('.mffai-chat-body .mffai-rcard-h')).toMatch(/flex-wrap:\s*nowrap/)
    expect(rule('.mffai-rcard-h .mffai-chip')).toMatch(/min-width:\s*0/)
    expect(rule('.mffai-rcard-h .mffai-chip')).toMatch(/text-overflow:\s*ellipsis/)
    const stop = rule('.mffai-rcard-h > .set-btn')
    expect(stop).toMatch(/flex:\s*0 0 auto/)
    expect(stop).toMatch(/white-space:\s*nowrap/)
  })
})

describe('RunCard', () => {
  it('head: executor, 排队 #N, 只读, isolation, 规则未翻译 N', () => {
    installFakeForge()
    render(<RunCard sessionId={S} turnOpen run={run({ phase: 'queued', position: 2, readOnly: true, isolation: 'own', untranslatedRules: 3 })} />)
    for (const t of ['codex', '排队 #2', '只读', '自带隔离', '规则未翻译 3']) expect(screen.getByText(t)).toBeInTheDocument()
  })

  it('running: 运行中 and the per-run 停止 sends executor.cancel for that run only; not offered once the turn is closed', async () => {
    const f = installFakeForge({ calls: { 'executor.cancel': { ok: true } } })
    const { rerender } = render(<RunCard sessionId={S} turnOpen run={run({ isolation: 'none' })} />)
    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(screen.getByText('未隔离')).toBeInTheDocument()
    await act(async () => { fireEvent.click(btn('停止')!) })
    expect(f.callsOf('executor.cancel')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
    expect(f.callsOf('session.cancel')).toEqual([])
    rerender(<RunCard sessionId={S} turnOpen={false} run={run()} />)
    expect(btn('停止')).toBeNull()
  })

  it('progress: the last 5, all on 全部; 省略 N 条 from droppedProgress', () => {
    installFakeForge()
    const progress = Array.from({ length: 7 }, (_, i) => ({ seq: i, kind: 'tool' as const, text: `p${i}` }))
    const { container } = render(<RunCard sessionId={S} turnOpen run={done({ progress }, { droppedProgress: 40 })} />)
    expect([...container.querySelectorAll('.mffai-progress-text')].map((x) => x.textContent)).toEqual(['p2', 'p3', 'p4', 'p5', 'p6'])
    fireEvent.click(btn('全部 7')!)
    expect(container.querySelectorAll('.mffai-progress-text')).toHaveLength(7)
    expect(screen.getByText('省略 40 条')).toBeInTheDocument()
  })

  it('ended: status, reason, time, exit, CLI usage, violations with 还有 N 条, raw log with a copy button, N 个文件', () => {
    installFakeForge()
    render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done({}, {
      status: 'failed', reason: 'exit_nonzero', exit: 1, usage: { input: 10, output: 20 }, violations: ['net:evil:443'], violationsTruncated: 2,
      rawLog: '/raw/r1.log', changed: { files: ['a', 'b', 'c'], source: 'git', filesTruncated: 4 },
    })} />)
    for (const t of ['失败', 'exit_nonzero', '1.5 s', 'exit 1', 'CLI 输入 10 · 输出 20', 'net:evil:443', '还有 2 条', '/raw/r1.log', '7 个文件']) {
      expect(screen.getByText(t)).toBeInTheDocument()
    }
    expect(btn('复制')).not.toBeNull()
  })

  it('a signal shows as a code', () => {
    installFakeForge()
    render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done({}, { status: 'cancelled', signal: 'SIGTERM' })} />)
    expect(screen.getByText('SIGTERM')).toBeInTheDocument()
  })

  it('合并: the confirm names the session checkout as the target and the worktree as the source; then executor.worktree.merge; merged hides 合并', async () => {
    const f = installFakeForge({ calls: { 'executor.worktree.merge': { ok: true, files: 3 } } })
    // 运行的 cwd 是 worktree(来源),合并写进的是会话的检出
    render(<RunCard sessionId={S} checkout="/repo" turnOpen={false} row={kept} run={done({ cwd: '/wt/r1', worktree: '/wt/r1' })} />)
    fireEvent.click(btn('合并')!)
    expect(dialog()).toHaveAccessibleName('合并到 /repo')
    expect(rows()).toEqual([['worktree', '/wt/r1'], ['文件', '3']])
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    expect(f.callsOf('executor.worktree.merge')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
    expect(btn('合并')).toBeNull()
    expect(screen.getByText('已合并 3 个文件')).toBeInTheDocument()
  })

  it('a run merged per its event shows no 合并', () => {
    installFakeForge()
    render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done({ merged: { files: 2 } })} />)
    expect(btn('合并')).toBeNull()
    expect(btn('丢弃')).not.toBeNull()
  })

  it('no 合并 without changes, without a worktree, or when the run list says the worktree is gone', () => {
    installFakeForge()
    const { rerender } = render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done({}, { changed: { files: [], source: 'git' } })} />)
    expect(btn('合并')).toBeNull()
    rerender(<RunCard sessionId={S} turnOpen={false} row={runRow('r1', S)} run={done({ worktree: undefined }, { worktree: undefined })} />)
    expect(btn('合并')).toBeNull()
    expect(btn('丢弃')).toBeNull()
    rerender(<RunCard sessionId={S} turnOpen={false} run={done()} row={runRow('r1', S, { worktree: { path: '/wt/r1', present: false } })} />)
    expect(btn('合并')).toBeNull()
    expect(btn('丢弃')).toBeNull()
  })

  it('no row for the run in executor.runs: worktree state unknown, so no 合并 and no 丢弃', () => {
    installFakeForge()
    render(<RunCard sessionId={S} turnOpen={false} run={done()} />)
    expect(btn('合并')).toBeNull()
    expect(btn('丢弃')).toBeNull()
  })

  const refuse = async (data: object) => {
    installFakeForge({ calls: { 'executor.worktree.merge': () => fail(-32602, 'refused', data) } })
    const r = render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done()} />)
    fireEvent.click(btn('合并')!)
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    return r
  }

  it('merge refused dirty lists the paths', async () => {
    await refuse({ reason: 'dirty', paths: ['src/a.ts', 'src/b.ts'] })
    for (const t of ['dirty', 'src/a.ts', 'src/b.ts']) expect(screen.getByText(t)).toBeInTheDocument()
    expect(btn('合并')).not.toBeNull()
  })

  it('merge refused unsafe_path lists the paths', async () => {
    await refuse({ reason: 'unsafe_path', paths: ['.gitattributes'] })
    expect(screen.getByText('unsafe_path')).toBeInTheDocument()
    expect(screen.getByText('.gitattributes')).toBeInTheDocument()
  })

  it('conflict with restored:false shows 未还原 with the paths; restored:true does not', async () => {
    const { unmount } = await refuse({ reason: 'conflict', restored: false, paths: ['x.ts'] })
    expect(screen.getByText('未还原')).toBeInTheDocument()
    expect(screen.getByText('x.ts')).toBeInTheDocument()
    unmount()
    await refuse({ reason: 'conflict', restored: true })
    expect(screen.getByText('conflict')).toBeInTheDocument()
    expect(screen.queryByText('未还原')).toBeNull()
  })

  it('a merge of a run still going (-32003) shows 忙', async () => {
    installFakeForge({ calls: { 'executor.worktree.merge': () => fail(-32003, 'busy') } })
    render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done()} />)
    fireEvent.click(btn('合并')!)
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '合并' })) })
    expect(screen.getByText('忙')).toBeInTheDocument()
  })

  it('丢弃: confirm 丢弃 worktree / 路径, then executor.worktree.discard; afterwards no buttons', async () => {
    const f = installFakeForge({ calls: { 'executor.worktree.discard': { ok: true } } })
    render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done()} />)
    fireEvent.click(btn('丢弃')!)
    expect(dialog()).toHaveAccessibleName('丢弃 worktree')
    expect(rows()).toEqual([['路径', '/wt/r1']])
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '丢弃' })) })
    expect(f.callsOf('executor.worktree.discard')).toEqual([{ commandId: expect.any(String), sessionId: S, runId: 'r1' }])
    expect(btn('合并')).toBeNull()
    expect(btn('丢弃')).toBeNull()
    expect(screen.getByText('已丢弃')).toBeInTheDocument()
  })

  it('a discard answering ok:false shows 失败 and keeps the buttons', async () => {
    installFakeForge({ calls: { 'executor.worktree.discard': { ok: false } } })
    render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done()} />)
    fireEvent.click(btn('丢弃')!)
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: '丢弃' })) })
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(btn('丢弃')).not.toBeNull()
  })

  it('N 个文件 opens executor.changes; a file click asks executor.diff with that path', async () => {
    const f = installFakeForge({ calls: {
      'executor.changes': { files: [{ path: 'a.ts', status: 'M' }], source: 'git' },
      'executor.diff': { path: 'a.ts', status: 'M', binary: false, truncated: false, lines: [{ kind: 'add', ln: 1, text: 'NEW' }] },
    } })
    render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done({}, { changed: { files: ['a.ts'], source: 'git' } })} />)
    await act(async () => { fireEvent.click(btn('1 个文件')!) })
    expect(f.callsOf('executor.changes')).toEqual([{ sessionId: S, runId: 'r1' }])
    await act(async () => { fireEvent.click(screen.getByText('a.ts')) })
    expect(f.callsOf('executor.diff')).toEqual([{ sessionId: S, runId: 'r1', path: 'a.ts' }])
    expect(screen.getByText('NEW')).toBeInTheDocument()
  })
  describe('08b layout', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('live (queued or running) is .mffai-rcard.live; ended is not; id and data-run stay', () => {
      installFakeForge()
      const { container, rerender } = render(<RunCard sessionId={S} turnOpen run={run({ summary: '补齐单测' })} />)
      const card = () => container.querySelector('[data-run="r1"]')!
      expect(card().id).toBe('mffai-run-r1')
      expect(card().classList.contains('mffai-rcard')).toBe(true)
      expect(card().classList.contains('live')).toBe(true)
      expect(screen.getByText('补齐单测')).toBeInTheDocument()
      rerender(<RunCard sessionId={S} turnOpen run={run({ phase: 'queued', position: 1 })} />)
      expect(card().classList.contains('live')).toBe(true)
      rerender(<RunCard sessionId={S} turnOpen={false} row={kept} run={done()} />)
      expect(card().classList.contains('mffai-rcard')).toBe(true)
      expect(card().classList.contains('live')).toBe(false)
      expect(card().id).toBe('mffai-run-r1')
    })

    it('progress rows carry a per-kind icon; the newest row is marked last', () => {
      installFakeForge()
      const progress = (['file', 'tool', 'text', 'think'] as const).map((kind, i) => ({ seq: i, kind, text: `p${i}` }))
      const { container } = render(<RunCard sessionId={S} turnOpen run={run({ progress })} />)
      const rows = [...container.querySelectorAll('.mffai-progress-row')]
      expect(rows.map((r) => r.querySelector('.mffai-progress-icon svg'))).not.toContain(null)
      expect(rows.map((r) => r.classList.contains('last'))).toEqual([false, false, false, true])
    })

    it('ended: violations count chip, 改动 label beside N 个文件, the merge target path in the footer', () => {
      installFakeForge()
      const { container } = render(<RunCard sessionId={S} checkout="/repo" turnOpen={false} row={kept} run={done({}, { violations: ['~/.npmrc'], violationsTruncated: 1 })} />)
      expect(screen.getByText('违规 2')).toBeInTheDocument()
      expect(container.querySelector('.mffai-rcard-chg')!.textContent).toContain('改动')
      expect(btn('3 个文件')).not.toBeNull()
      const foot = container.querySelector('.mffai-rcard-f')!
      expect(foot.querySelector('.mffai-rcard-to')!.textContent).toBe('/repo')
      const order = [...foot.querySelectorAll('button')].map((b) => b.textContent)
      expect(order.slice(0, 2)).toEqual(['合并', '丢弃'])
      expect(btn('丢弃')!.classList.contains('mffai-danger')).toBe(true)
    })

    const rect = { x: 600, y: 500, left: 600, top: 500, width: 80, height: 28, right: 680, bottom: 528, toJSON: () => ({}) } as DOMRect

    it('the merge confirm is anchored to the clicked 合并 button (R13)', () => {
      installFakeForge()
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
      render(<RunCard sessionId={S} checkout="/repo" turnOpen={false} row={kept} run={done()} />)
      const b = btn('合并')!
      fireEvent.click(b)
      expect(document.querySelector('.confirm-overlay.mffai-anchored')).not.toBeNull()
      expect(spy.mock.contexts).toContain(b)
    })

    it('the discard confirm is anchored to the clicked 丢弃 button', () => {
      installFakeForge()
      const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect)
      render(<RunCard sessionId={S} turnOpen={false} row={kept} run={done()} />)
      const b = btn('丢弃')!
      fireEvent.click(b)
      expect(document.querySelector('.confirm-overlay.mffai-anchored')).not.toBeNull()
      expect(spy.mock.contexts).toContain(b)
    })
      it('fix: the run summary goes through the visible escapes', () => {
      installFakeForge()
      const { container } = render(<RunCard sessionId={S} turnOpen run={run({ summary: 'fix\u202Eexe.txt a\u200Bb' })} />)
      const t = container.querySelector('.mffai-rcard-title')!
      expect(t.textContent).toBe('fix\\u{202E}exe.txt a\\u{200B}b')
      expect(t.querySelectorAll('.mffai-esc')).toHaveLength(2)
      expect(container.innerHTML).not.toMatch(/[\u202E\u200B]/)
    })

    it('fix: the merge target truncates in the middle: the last segment never shrinks, the full path in title', () => {
      installFakeForge()
      const checkout = '/Users/someone/work/very/long/path/to/the/checkout/forge-api'
      const { container } = render(<RunCard sessionId={S} checkout={checkout} turnOpen={false} row={kept} run={done()} />)
      const to = container.querySelector('.mffai-rcard-to')!
      expect(to.getAttribute('title')).toBe(checkout)
      expect(to.textContent).toBe(checkout)
      expect(to.querySelector('.mffai-rcard-to-head')!.textContent).toBe('/Users/someone/work/very/long/path/to/the/checkout/')
      expect(to.querySelector('.mffai-rcard-to-tail')!.textContent).toBe('forge-api')
    })
})
})
