import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DebugPanel } from './DebugPanel'

let mffai: any
let listeners: Set<(e: any) => void>
let seq = 0

const emit = (type: string, payload: any, sessionId = 's1') =>
  act(() => { const e = { seq: ++seq, ts: 1, type, sessionId, payload }; for (const cb of [...listeners]) cb(e) })

beforeEach(() => {
  vi.restoreAllMocks()
  seq = 0
  listeners = new Set()
  mffai = {
    state: vi.fn(async () => ({ enabled: true, autostart: true, running: true })),
    tail: vi.fn(async () => ({ events: [] })),
    prompt: vi.fn(async () => ({ accepted: true, turnId: 't1' })),
    approvalRespond: vi.fn(async () => ({ ok: true })),
    rollback: vi.fn(async () => ({ ok: true, files: 2 })),
    cancel: vi.fn(async () => ({ ok: true })),
    onEvent: (cb: any) => { listeners.add(cb); return () => void listeners.delete(cb) },
    models: {
      catalog: vi.fn(async () => ({ presets: [], models: {} })),
      accounts: vi.fn(async () => ({ accounts: [], secretsBackend: 'keychain' })),
    },
  }
  ;(window as any).forge = { mffai }
})

describe('DebugPanel', () => {
  it('一轮两步:两步的文本都显示', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'go' })
    emit('message.assistant.delta', { turnId: 't1', step: 1, text: '先看' })
    emit('message.assistant.delta', { turnId: 't1', step: 1, text: '一下' })
    emit('message.assistant', { turnId: 't1', step: 1, text: '先看一下' })
    emit('message.assistant.delta', { turnId: 't1', step: 2, text: '改好' })
    expect(screen.getByText('先看一下')).toBeInTheDocument()
    expect(screen.getByText('改好')).toBeInTheDocument()
    emit('message.assistant.delta', { turnId: 't1', step: 2, text: '了' })
    expect(screen.getByText('改好了')).toBeInTheDocument()
  })

  it('loop-direct:没有 step 的 delta 拼成一行,终稿替换', async () => {
    render(<DebugPanel />)
    emit('message.assistant.delta', { turnId: 't1', text: 'he' })
    emit('message.assistant.delta', { turnId: 't1', text: 'llo' })
    expect(screen.getByText('hello')).toBeInTheDocument()
    emit('message.assistant', { turnId: 't1', text: 'hello!' })
    expect(screen.getByText('hello!')).toBeInTheDocument()
    expect(screen.queryByText('hello')).toBeNull()
  })

  it('工具行:名字 + 参数摘要,结束后 ✓ / ✗', async () => {
    render(<DebugPanel />)
    const long = `{"path":"${'x'.repeat(100)}"}`
    emit('tool.started', { turnId: 't1', callId: 'c1', name: 'read', argsPreview: '{"path":"a.txt"}' })
    emit('tool.started', { turnId: 't1', callId: 'c2', name: 'shell', argsPreview: long })
    const one = screen.getByText('read {"path":"a.txt"}').closest('.mffai-tool')!
    expect(one.textContent).not.toMatch(/[✓✗]/)
    emit('tool.ended', { turnId: 't1', callId: 'c1', name: 'read', ok: true })
    emit('tool.ended', { turnId: 't1', callId: 'c2', name: 'shell', ok: false, isError: true })
    expect(one.textContent).toContain('✓')
    const two = screen.getByText(`shell ${long.slice(0, 60)}`).closest('.mffai-tool')!
    expect(two.textContent).toContain('✗')
  })

  it('审批卡:本会话允许 → approvalRespond(id, allow_session);approval.resolved 后消失', async () => {
    render(<DebugPanel />)
    emit('approval.requested', { approvalId: 'ap1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'npm test' })
    expect(screen.getByText('npm test')).toBeInTheDocument()
    expect(screen.getByText('允许')).toBeInTheDocument()
    expect(screen.getByText('拒绝')).toBeInTheDocument()
    fireEvent.click(screen.getByText('本会话允许'))
    expect(mffai.approvalRespond).toHaveBeenCalledWith('ap1', 'allow_session')
    emit('approval.resolved', { approvalId: 'ap1', turnId: 't1', callId: 'c1', decision: 'allow', by: 'user' })
    expect(screen.queryByText('本会话允许')).toBeNull()
    expect(screen.queryByText('npm test')).toBeNull()
  })

  it('别处结束的审批(超时 / 取消)也不再显示按钮', async () => {
    render(<DebugPanel />)
    emit('approval.requested', { approvalId: 'ap2', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'make' })
    emit('approval.resolved', { approvalId: 'ap2', turnId: 't1', callId: 'c1', decision: 'deny', by: 'timeout' })
    expect(screen.queryByText('允许')).toBeNull()
  })

  it('结束快照:改动文件数 + 回滚本轮 → rollback(sid, turnId) → 已回滚', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'edit' })
    emit('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'refs/mffai/snapshots/s1/t1-start' })
    emit('message.assistant', { turnId: 't1', step: 1, text: 'done' })
    emit('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'refs/mffai/snapshots/s1/t1-end', changed: 3 })
    emit('turn.ended', { turnId: 't1' })
    expect(screen.getByText('3 个文件')).toBeInTheDocument()
    fireEvent.click(screen.getByText('回滚本轮'))
    expect(mffai.rollback).toHaveBeenCalledWith('s1', 't1')
    expect(await screen.findByText('已回滚')).toBeInTheDocument()
    expect(screen.queryByText('回滚本轮')).toBeNull()
  })

  it('回滚结果带 skipped:列出这些路径', async () => {
    mffai.rollback = vi.fn(async () => ({ ok: true, files: 1, skipped: ['vendor/lib'] }))
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'edit' })
    emit('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'r0' })
    emit('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'r', changed: 2 })
    emit('turn.ended', { turnId: 't1' })
    fireEvent.click(screen.getByText('回滚本轮'))
    expect(await screen.findByText('vendor/lib')).toBeInTheDocument()
  })

  it('已有 turn.rolledBack:显示已回滚,不给按钮;更早的轮变成可回滚', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'a' })
    emit('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'r1s' })
    emit('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'r1', changed: 1 })
    emit('turn.ended', { turnId: 't1' })
    emit('message.user', { turnId: 't2', text: 'b' })
    emit('turn.snapshot', { turnId: 't2', phase: 'start', ref: 'r2s' })
    emit('turn.snapshot', { turnId: 't2', phase: 'end', ref: 'r2', changed: 2 })
    emit('turn.ended', { turnId: 't2' })
    expect(screen.getAllByText('回滚本轮')).toHaveLength(1)
    emit('turn.rolledBack', { turnId: 't2', files: 2, skipped: ['sub'] })
    expect(screen.getByText('已回滚')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    fireEvent.click(screen.getByText('回滚本轮'))
    expect(mffai.rollback).toHaveBeenCalledWith('s1', 't1')
  })

  it('进行中的轮不给回滚按钮', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'a' })
    emit('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'r1', changed: 1 })
    expect(screen.getByText('1 个文件')).toBeInTheDocument()
    expect(screen.queryByText('回滚本轮')).toBeNull()
  })

  it('同一 callId 在两轮重复:各占一行,状态互不影响', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'a' })
    emit('tool.started', { turnId: 't1', callId: 'call_1_0', name: 'read', argsPreview: 'one' })
    emit('tool.ended', { turnId: 't1', callId: 'call_1_0', name: 'read', ok: true })
    emit('turn.ended', { turnId: 't1' })
    emit('message.user', { turnId: 't2', text: 'b' })
    emit('tool.started', { turnId: 't2', callId: 'call_1_0', name: 'read', argsPreview: 'two' })
    emit('tool.ended', { turnId: 't2', callId: 'call_1_0', name: 'read', ok: false })
    emit('turn.failed', { turnId: 't2', reason: 'error' })
    const one = screen.getByText('read one').closest('.mffai-line')!
    const two = screen.getByText('read two').closest('.mffai-line')!
    expect(one.textContent).toContain('✓')
    expect(one.textContent).not.toContain('失败')
    expect(two.textContent).toContain('✗')
    expect(two.textContent).toContain('失败')
  })

  it('只有结束快照(开始快照没拍到)不给回滚按钮', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'a' })
    emit('turn.snapshot', { turnId: 't1', phase: 'start', reason: 'too_large' })
    emit('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'r1' })
    emit('turn.ended', { turnId: 't1' })
    expect(screen.queryByText('回滚本轮')).toBeNull()
  })

  it('会话里有进行中的轮(没拍快照)时不给回滚按钮,结束后再给', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'a' })
    emit('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'r1s' })
    emit('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'r1', changed: 1 })
    emit('turn.ended', { turnId: 't1' })
    expect(screen.getByText('回滚本轮')).toBeInTheDocument()
    emit('message.user', { turnId: 't2', text: 'b' })
    expect(screen.queryByText('回滚本轮')).toBeNull()
    emit('turn.ended', { turnId: 't2' })
    expect(screen.getByText('回滚本轮')).toBeInTheDocument()
  })

  it('两个会话各自有可回滚的轮', async () => {
    render(<DebugPanel />)
    for (const [sid, tid] of [['s1', 'a1'], ['s2', 'b1']]) {
      emit('message.user', { turnId: tid, text: tid }, sid)
      emit('turn.snapshot', { turnId: tid, phase: 'start', ref: `${tid}s` }, sid)
      emit('turn.snapshot', { turnId: tid, phase: 'end', ref: `${tid}e`, changed: 1 }, sid)
      emit('turn.ended', { turnId: tid }, sid)
    }
    const buttons = screen.getAllByText('回滚本轮')
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(mffai.rollback).toHaveBeenCalledWith('s2', 'b1')
  })

  it('应答回 ok:false:当作已结束,卡片消失', async () => {
    mffai.approvalRespond = vi.fn(async () => ({ ok: false }))
    render(<DebugPanel />)
    emit('approval.requested', { approvalId: 'ap9', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'rm x' })
    fireEvent.click(screen.getByText('允许'))
    await waitFor(() => expect(screen.queryByText('rm x')).toBeNull())
    expect(mffai.approvalRespond).toHaveBeenCalledWith('ap9', 'allow')
  })

  it('日志重置后 seq 重复:新的用户消息照样显示', async () => {
    render(<DebugPanel />)
    seq = 0
    emit('message.user', { turnId: 't1', text: 'old' })
    seq = 0
    emit('message.user', { turnId: 't2', text: 'new' })
    expect(screen.getByText('old')).toBeInTheDocument()
    expect(screen.getByText('new')).toBeInTheDocument()
  })

  it('挂载时 tail 回放(审批 / 工具 / 快照)与之后的实时事件合并', async () => {
    const ev = (s: number, type: string, payload: any) => ({ seq: s, ts: 1, type, sessionId: 's1', payload })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    mffai.tail = vi.fn(async () => {
      await gate
      return {
        events: [
          ev(1, 'message.user', { turnId: 't1', text: 'go' }),
          ev(2, 'turn.snapshot', { turnId: 't1', phase: 'start', ref: 'rs' }),
          ev(3, 'tool.started', { turnId: 't1', callId: 'c1', name: 'shell', argsPreview: 'make' }),
          ev(4, 'approval.requested', { approvalId: 'ap1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'make all' }),
        ],
      }
    })
    render(<DebugPanel />)
    expect(mffai.tail).toHaveBeenCalledWith(500)
    // 订阅先到的实时事件(与回放有重叠)
    seq = 3
    emit('approval.requested', { approvalId: 'ap1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'make all' })
    await act(async () => { release(); await gate })
    await screen.findByText('make all')
    expect(screen.getAllByText('make all')).toHaveLength(1)
    expect(screen.getByText('go')).toBeInTheDocument()
    emit('approval.resolved', { approvalId: 'ap1', turnId: 't1', callId: 'c1', decision: 'allow', by: 'user' })
    emit('tool.ended', { turnId: 't1', callId: 'c1', name: 'shell', ok: true })
    emit('turn.snapshot', { turnId: 't1', phase: 'end', ref: 're', changed: 4 })
    emit('turn.ended', { turnId: 't1' })
    expect(screen.queryByText('make all')).toBeNull()
    expect(screen.getByText('shell make').closest('.mffai-line')!.textContent).toContain('✓')
    expect(screen.getByText('4 个文件')).toBeInTheDocument()
    expect(screen.getByText('回滚本轮')).toBeInTheDocument()
  })

  it('turn.failed 的轮标失败', async () => {
    render(<DebugPanel />)
    emit('message.user', { turnId: 't1', text: 'go' })
    emit('message.assistant.delta', { turnId: 't1', step: 1, text: '半截' })
    expect(screen.queryByText('失败')).toBeNull()
    emit('turn.failed', { turnId: 't1', reason: 'cancelled' })
    const line = screen.getByText('半截').closest('.mffai-line')!
    expect(line.textContent).toContain('失败')
  })

  it('工作目录与命令自动放行传给 prompt', async () => {
    const { container } = render(<DebugPanel />)
    const msg = container.querySelector('.mffai-send input')!
    fireEvent.change(msg, { target: { value: 'hi' } })
    fireEvent.click(screen.getByText('发送'))
    expect(mffai.prompt).toHaveBeenLastCalledWith('hi')
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: ' /repo ' } })
    expect(screen.getByPlaceholderText('工作目录')).toBeInTheDocument()
    fireEvent.change(msg, { target: { value: 'edit' } })
    fireEvent.click(screen.getByText('发送'))
    expect(mffai.prompt).toHaveBeenLastCalledWith('edit', undefined, { cwd: '/repo', approvalMode: 'ask' })
    fireEvent.click(screen.getByLabelText('命令自动放行'))
    fireEvent.change(msg, { target: { value: 'more' } })
    fireEvent.click(screen.getByText('发送'))
    expect(mffai.prompt).toHaveBeenLastCalledWith('more', undefined, { cwd: '/repo', approvalMode: 'auto' })
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '  ' } })
    fireEvent.change(msg, { target: { value: 'chat' } })
    fireEvent.click(screen.getByText('发送'))
    expect(mffai.prompt).toHaveBeenLastCalledWith('chat', undefined, { approvalMode: 'auto' })
    await waitFor(() => expect(mffai.prompt).toHaveBeenCalledTimes(4))
  })

  describe('委派运行', () => {
    const queued = { runId: 'run_1', turnId: 't1', callId: 'c1', executor: 'codex', summary: 'x', readOnly: false, isolation: 'own', position: 1 }
    const started = { runId: 'run_1', turnId: 't1', executor: 'codex', cwd: '/r', isolation: 'own' }
    const ended = (status: string, extra: object = {}) => ({ runId: 'run_1', turnId: 't1', executor: 'codex', status, ms: 5, ...extra })
    const stop = () => screen.queryByRole('button', { name: '停止' })
    const parkedChip = (c: HTMLElement) => c.querySelector('.mffai-send .mffai-parked')
    const burst = (n: number, make: (i: number) => [string, any]) => act(() => {
      for (let i = 0; i < n; i++) {
        const [type, payload] = make(i)
        const e = { seq: ++seq, ts: 1, type, sessionId: 's1', payload }
        for (const cb of [...listeners]) cb(e)
      }
    })

    it('排队 → 运行中 → 进度 → 结束:状态行跟着变,结束行在最后', () => {
      const { container } = render(<DebugPanel />)
      emit('executor.run.queued', queued)
      expect(screen.getByText('codex 排队中')).toBeInTheDocument()
      emit('executor.run.started', started)
      expect(screen.queryByText('codex 排队中')).toBeNull()
      expect(screen.getByText('codex 运行中')).toBeInTheDocument()
      emit('executor.run.progress', { runId: 'run_1', turnId: 't1', kind: 'tool', text: 'ls -la' })
      expect(screen.getByText('ls -la')).toBeInTheDocument()
      emit('executor.run.ended', ended('ok', { changed: { files: ['a', 'b', 'c'], source: 'git' } }))
      expect(screen.queryByText('codex 运行中')).toBeNull()
      const lines = [...container.querySelectorAll('.mffai-log .mffai-line')].map(l => l.textContent)
      expect(lines).toEqual(['ls -la', 'codex 完成 3 个文件'])
    })

    it.each([
      ['ok', '完成'], ['failed', '失败'], ['cancelled', '已取消'],
      ['timeout', '超时'], ['stalled', '卡住'], ['interrupted', '中断'],
    ])('结束状态 %s → %s', (status, label) => {
      render(<DebugPanel />)
      emit('executor.run.ended', ended(status))
      expect(screen.getByText(`codex ${label}`)).toBeInTheDocument()
    })

    it('文件数:线上截断的也算进去;空列表不显示', () => {
      render(<DebugPanel />)
      emit('executor.run.ended', ended('ok', { changed: { files: ['a', 'b'], filesTruncated: 998, source: 'git' } }))
      expect(screen.getByText('codex 完成 1000 个文件')).toBeInTheDocument()
      emit('executor.run.ended', { ...ended('interrupted', { changed: { files: [], source: 'none' } }), runId: 'run_2' })
      expect(screen.getByText('codex 中断')).toBeInTheDocument()
    })

    it('executor.notice、turn.parked、turn.resumed 不成行', () => {
      const { container } = render(<DebugPanel />)
      emit('executor.notice', { turnId: 't1', runId: 'run_1', text: '给模型的通知' })
      emit('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 })
      emit('turn.resumed', { turnId: 't1', step: 1, cause: 'notice' })
      expect(container.querySelectorAll('.mffai-log .mffai-line')).toHaveLength(0)
    })

    it('不认识的字段与残缺载荷都不影响面板', () => {
      const { container } = render(<DebugPanel />)
      emit('executor.run.started', { ...started, extra: { deep: 1 } })
      expect(screen.getByText('codex 运行中')).toBeInTheDocument()
      emit('executor.run.progress', { runId: 'run_1', turnId: 't1', kind: 'new_kind', text: 'p1', more: true })
      expect(screen.getByText('p1')).toBeInTheDocument()
      emit('executor.run.ended', { ...ended('brand_new'), runId: 'run_3', changed: 7 })
      expect(screen.getByText('codex brand_new')).toBeInTheDocument()
      emit('executor.run.ended', { ...ended('constructor'), runId: 'run_4', changed: null })
      expect(screen.getByText('codex constructor')).toBeInTheDocument()
      const before = container.querySelectorAll('.mffai-log .mffai-line').length
      emit('executor.run.started', {})
      emit('executor.run.queued', null)
      emit('executor.run.ended', { status: 'ok' })
      emit('executor.run.progress', { runId: 'run_1' })
      emit('some.future.event', { turnId: 't1' })
      expect(container.querySelectorAll('.mffai-log .mffai-line')).toHaveLength(before)
    })

    it('旧后台没有这些事件:面板照常,轮结束后没有停止', () => {
      const { container } = render(<DebugPanel />)
      emit('message.user', { turnId: 't1', text: 'go' })
      expect(stop()).not.toBeNull()
      expect(parkedChip(container)).toBeNull()
      emit('message.assistant', { turnId: 't1', text: 'ok' })
      emit('turn.ended', { turnId: 't1' })
      const lines = [...container.querySelectorAll('.mffai-log .mffai-line')].map(l => l.textContent)
      expect(lines).toEqual(['go', 'ok'])
      expect(stop()).toBeNull()
    })

    it('取消的轮:最后一行是运行结束行时也标失败', () => {
      render(<DebugPanel />)
      emit('message.user', { turnId: 't1', text: 'go' })
      emit('executor.run.started', started)
      emit('turn.failed', { turnId: 't1', reason: 'cancelled' })
      expect(screen.getByText('codex 运行中')).toBeInTheDocument()
      emit('executor.run.ended', ended('cancelled'))
      expect(screen.getByText('codex 已取消').closest('.mffai-line')!.textContent).toContain('失败')
    })

    it('后续消息:同一轮第二条用户行,顺序不乱;相同文字也各占一行', () => {
      const { container } = render(<DebugPanel />)
      emit('message.user', { turnId: 't1', text: 'first' })
      emit('message.assistant', { turnId: 't1', step: 1, text: 'on it' })
      emit('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 })
      emit('message.user', { turnId: 't1', text: 'second', followUp: true })
      emit('turn.resumed', { turnId: 't1', step: 1, cause: 'message' })
      emit('message.assistant', { turnId: 't1', step: 2, text: 'noted' })
      emit('message.user', { turnId: 't1', text: 'second', followUp: true })
      const lines = [...container.querySelectorAll('.mffai-log .mffai-line')].map(l => l.textContent)
      expect(lines).toEqual(['first', 'on it', 'second', 'noted', 'second'])
      expect(container.querySelectorAll('.mffai-line.user')).toHaveLength(3)
    })

    it('tail 回放与实时事件重叠:后续消息不重复', async () => {
      const ev = (s: number, type: string, payload: any) => ({ seq: s, ts: 1, type, sessionId: 's1', payload })
      mffai.tail = vi.fn(async () => ({
        events: [ev(1, 'message.user', { turnId: 't1', text: 'first' }), ev(2, 'message.user', { turnId: 't1', text: 'again', followUp: true })],
      }))
      const { container } = render(<DebugPanel />)
      seq = 1
      emit('message.user', { turnId: 't1', text: 'again', followUp: true })
      await screen.findByText('first')
      expect(container.querySelectorAll('.mffai-line.user')).toHaveLength(2)
    })

    it('挂起状态块:turn.parked 显示,被叫醒 / 后续消息 / 终态后消失', () => {
      const { container } = render(<DebugPanel />)
      emit('message.user', { turnId: 't1', text: 'go' })
      expect(parkedChip(container)).toBeNull()
      emit('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 })
      expect(parkedChip(container)?.textContent).toBe('挂起')
      emit('turn.resumed', { turnId: 't1', step: 1, cause: 'notice' })
      expect(parkedChip(container)).toBeNull()
      emit('turn.parked', { turnId: 't1', step: 2, active: 1, pending: 0 })
      emit('message.user', { turnId: 't1', text: 'more', followUp: true })
      expect(parkedChip(container)).toBeNull()
      emit('turn.parked', { turnId: 't1', step: 3, active: 1, pending: 0 })
      expect(parkedChip(container)).not.toBeNull()
      emit('turn.failed', { turnId: 't1', reason: 'cancelled' })
      expect(parkedChip(container)).toBeNull()
    })

    it('停止:只在进行中的轮(含挂起)显示,点了 cancel(sessionId)', async () => {
      render(<DebugPanel />)
      expect(stop()).toBeNull()
      emit('message.user', { turnId: 't1', text: 'go' })
      expect(stop()).not.toBeNull()
      emit('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 })
      expect(stop()).not.toBeNull()
      fireEvent.click(stop()!)
      expect(mffai.cancel).toHaveBeenCalledWith('s1')
      await waitFor(() => expect((stop() as HTMLButtonElement).disabled).toBe(false))
      emit('turn.failed', { turnId: 't1', reason: 'cancelled' })
      expect(stop()).toBeNull()
    })

    it('停止:请求进行中按钮不可点,失败显示失败', async () => {
      let reject!: (e: Error) => void
      mffai.cancel = vi.fn(() => new Promise((_, r) => { reject = r }))
      render(<DebugPanel />)
      emit('message.user', { turnId: 't1', text: 'go' })
      fireEvent.click(stop()!)
      expect((stop() as HTMLButtonElement).disabled).toBe(true)
      await act(async () => { reject(new Error('mff-ai not running')) })
      expect((stop() as HTMLButtonElement).disabled).toBe(false)
      expect(screen.getByText('失败')).toBeInTheDocument()
    })

    it('多个会话:优先本面板发的那一轮;没发过时取最新的轮', async () => {
      const { container } = render(<DebugPanel />)
      emit('message.user', { turnId: 'a', text: 'a' }, 's1')
      emit('message.user', { turnId: 'b', text: 'b' }, 's2')
      fireEvent.click(stop()!)
      expect(mffai.cancel).toHaveBeenLastCalledWith('s2')
      await waitFor(() => expect((stop() as HTMLButtonElement).disabled).toBe(false))
      mffai.prompt = vi.fn(async () => ({ accepted: true, turnId: 'a', followUp: true }))
      fireEvent.change(container.querySelector('.mffai-send input')!, { target: { value: 'hi' } })
      fireEvent.click(screen.getByText('发送'))
      await act(async () => {})
      fireEvent.click(stop()!)
      expect(mffai.cancel).toHaveBeenLastCalledWith('s1')
      await waitFor(() => expect((stop() as HTMLButtonElement).disabled).toBe(false))
      emit('turn.ended', { turnId: 'a' }, 's1')
      expect(stop()).toBeNull()
    })

    it('大量进度挤满窗口:用户行、挂起、运行中、停止都还在', () => {
      const { container } = render(<DebugPanel />)
      emit('message.user', { turnId: 't1', text: 'go' })
      emit('executor.run.started', started)
      emit('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 })
      burst(600, i => ['executor.run.progress', { runId: 'run_1', turnId: 't1', kind: 'text', text: `p${i}` }])
      expect(screen.getByText('go')).toBeInTheDocument()
      expect(screen.getByText('codex 运行中')).toBeInTheDocument()
      expect(parkedChip(container)).not.toBeNull()
      expect(stop()).not.toBeNull()
      expect(screen.queryByText('p0')).toBeNull()
      expect(screen.getByText('p599')).toBeInTheDocument()
      expect(container.querySelectorAll('.mffai-log .mffai-line').length).toBeLessThanOrEqual(500)
    })

    it('重开面板时 tail 里只剩进度:停止仍在;结束的运行之后的尾巴不算进行中', async () => {
      const ev = (s: number, type: string, payload: any) => ({ seq: s, ts: 1, type, sessionId: 's1', payload })
      mffai.tail = vi.fn(async () => ({ events: [ev(900, 'executor.run.progress', { runId: 'run_1', turnId: 't1', kind: 'text', text: 'tail' })] }))
      const { unmount } = render(<DebugPanel />)
      await screen.findByText('tail')
      expect(stop()).not.toBeNull()
      unmount()
      mffai.tail = vi.fn(async () => ({ events: [ev(901, 'executor.run.ended', ended('cancelled'))] }))
      render(<DebugPanel />)
      await screen.findByText('codex 已取消')
      expect(stop()).toBeNull()
    })

    it('发送失败(ERR_BUSY 等):文字回到输入框,显示失败', async () => {
      mffai.prompt = vi.fn(async () => { throw new Error('ERR_BUSY') })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { container } = render(<DebugPanel />)
      const input = container.querySelector('.mffai-send input') as HTMLInputElement
      fireEvent.change(input, { target: { value: ' keep me ' } })
      fireEvent.click(screen.getByText('发送'))
      expect(input.value).toBe('')
      await waitFor(() => expect(input.value).toBe(' keep me '))
      expect(screen.getByText('失败')).toBeInTheDocument()
    })

    it('发送失败时已经又打了字:两段都留下', async () => {
      let reject!: (e: Error) => void
      mffai.prompt = vi.fn(() => new Promise((_, r) => { reject = r }))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { container } = render(<DebugPanel />)
      const input = container.querySelector('.mffai-send input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'one' } })
      fireEvent.click(screen.getByText('发送'))
      fireEvent.change(input, { target: { value: 'two' } })
      await act(async () => { reject(new Error('ERR_BUSY')) })
      expect(input.value).toBe('one two')
    })

    it('回执 accepted:false 也算没发出去', async () => {
      mffai.prompt = vi.fn(async () => ({ accepted: false, turnId: 't9' }))
      const { container } = render(<DebugPanel />)
      const input = container.querySelector('.mffai-send input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'nope' } })
      fireEvent.click(screen.getByText('发送'))
      await waitFor(() => expect(input.value).toBe('nope'))
      expect(screen.getByText('失败')).toBeInTheDocument()
    })

    it('发送成功:输入框保持清空', async () => {
      const { container } = render(<DebugPanel />)
      const input = container.querySelector('.mffai-send input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'fine' } })
      fireEvent.click(screen.getByText('发送'))
      await act(async () => {})
      expect(input.value).toBe('')
      expect(screen.queryByText('失败')).toBeNull()
    })
  })

  describe('沙箱', () => {
    const withSandbox = (sandbox: any) => {
      mffai.state = vi.fn(async () => ({ enabled: true, autostart: true, running: true, ...(sandbox && { sandbox }) }))
    }
    const chip = (container: HTMLElement) => container.querySelector('.mffai-opts .mffai-sandbox')

    it.each([
      ['full', [], '完整', null],
      ['partial', ['netns', 'proxy'], '部分', 'netns proxy'],
      ['none', ['sandbox-exec'], '未隔离', 'sandbox-exec'],
    ])('级别 %s → 选项行里的状态块', async (level, missing, label, title) => {
      withSandbox({ level, missing, autoDegraded: false })
      const { container } = render(<DebugPanel />)
      await waitFor(() => expect(chip(container)).not.toBeNull())
      expect(chip(container)!.textContent).toBe(label)
      expect(chip(container)!.getAttribute('title')).toBe(title)
    })

    it('旧后台的状态没有 sandbox:不显示状态块,面板照常', async () => {
      withSandbox(undefined)
      const { container } = render(<DebugPanel />)
      await waitFor(() => expect(mffai.state).toHaveBeenCalled())
      await act(async () => {})
      expect(chip(container)).toBeNull()
      emit('message.user', { turnId: 't1', text: 'go' })
      expect(screen.getByText('go')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('命令自动放行'))
      expect(screen.queryByText('需审批')).toBeNull()
    })

    it('state 失败:不显示状态块', async () => {
      mffai.state = vi.fn(async () => { throw new Error('x') })
      const { container } = render(<DebugPanel />)
      await waitFor(() => expect(mffai.state).toHaveBeenCalled())
      await act(async () => {})
      expect(chip(container)).toBeNull()
    })

    it('kernel.started 后重新取状态', async () => {
      let sandbox = { level: 'full', missing: [] as string[], autoDegraded: false }
      mffai.state = vi.fn(async () => ({ enabled: true, autostart: true, running: true, sandbox }))
      const { container } = render(<DebugPanel />)
      await waitFor(() => expect(chip(container)?.textContent).toBe('完整'))
      sandbox = { level: 'none', missing: ['disabled'], autoDegraded: true }
      emit('message.user', { turnId: 't1', text: 'x' })
      expect(mffai.state).toHaveBeenCalledTimes(1)
      emit('kernel.started', {}, undefined as never)
      await waitFor(() => expect(chip(container)?.textContent).toBe('未隔离'))
      expect(mffai.state).toHaveBeenCalledTimes(2)
    })

    it('permissions.updated 后重新取状态', async () => {
      let sandbox = { level: 'full', missing: [] as string[], autoDegraded: false }
      mffai.state = vi.fn(async () => ({ enabled: true, autostart: true, running: true, sandbox }))
      const { container } = render(<DebugPanel />)
      await waitFor(() => expect(chip(container)?.textContent).toBe('完整'))
      sandbox = { level: 'partial', missing: ['loopback'], autoDegraded: false }
      emit('permissions.updated', { rules: 0, network: 1 }, undefined as never)
      await waitFor(() => expect(chip(container)?.textContent).toBe('部分'))
      expect(mffai.state).toHaveBeenCalledTimes(2)
    })

    it('需审批:只在勾了命令自动放行且 autoDegraded 时出现', async () => {
      withSandbox({ level: 'none', missing: ['platform'], autoDegraded: true })
      const { container } = render(<DebugPanel />)
      await waitFor(() => expect(chip(container)).not.toBeNull())
      expect(screen.queryByText('需审批')).toBeNull()
      fireEvent.click(screen.getByLabelText('命令自动放行'))
      expect(screen.getByText('需审批')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('命令自动放行'))
      expect(screen.queryByText('需审批')).toBeNull()
    })

    it('没降级(allowUnsandboxedAuto / 有沙箱):勾了也没有需审批', async () => {
      withSandbox({ level: 'none', missing: ['platform'], autoDegraded: false })
      const { container } = render(<DebugPanel />)
      await waitFor(() => expect(chip(container)).not.toBeNull())
      fireEvent.click(screen.getByLabelText('命令自动放行'))
      expect(screen.queryByText('需审批')).toBeNull()
    })

    it('审批卡:unsandboxed → 未隔离;没有该标记的卡不显示', async () => {
      const { container } = render(<DebugPanel />)
      emit('approval.requested', { approvalId: 'ap1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'npm test', unsandboxed: true })
      emit('approval.requested', { approvalId: 'ap2', turnId: 't1', callId: 'c2', tool: 'shell', summary: 'make' })
      const flagged = screen.getByText('npm test').closest('.mffai-approval')!
      const plain = screen.getByText('make').closest('.mffai-approval')!
      expect(flagged.querySelector('.mffai-unsandboxed')?.textContent).toBe('未隔离')
      expect(plain.querySelector('.mffai-unsandboxed')).toBeNull()
      expect(plain.textContent).not.toContain('未隔离')
      expect(container.querySelectorAll('.mffai-unsandboxed')).toHaveLength(1)
    })

    it('sandbox.netDenied → 已拦截 host:port 一行', async () => {
      render(<DebugPanel />)
      emit('sandbox.netDenied', { host: 'evil.example', port: 443, reason: 'not_allowed' })
      emit('sandbox.netDenied', { host: 'other.test', port: 80, reason: 'private' })
      expect(screen.getByText('已拦截 evil.example:443')).toBeInTheDocument()
      expect(screen.getByText('已拦截 other.test:80')).toBeInTheDocument()
    })
  })
})
