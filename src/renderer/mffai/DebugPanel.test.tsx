import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DebugPanel } from './DebugPanel'

let mffai: any
let listeners: Set<(e: any) => void>
let seq = 0

const emit = (type: string, payload: any, sessionId = 's1') =>
  act(() => { const e = { seq: ++seq, ts: 1, type, sessionId, payload }; for (const cb of [...listeners]) cb(e) })

beforeEach(() => {
  seq = 0
  listeners = new Set()
  mffai = {
    tail: vi.fn(async () => ({ events: [] })),
    prompt: vi.fn(async () => ({ accepted: true, turnId: 't1' })),
    approvalRespond: vi.fn(async () => ({ ok: true })),
    rollback: vi.fn(async () => ({ ok: true, files: 2 })),
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
})
