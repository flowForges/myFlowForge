// Review Focus 12 的面板行:删掉的文字不留在调试面板的缓存里
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { DebugPanel } from './DebugPanel'
import { installFakeForge, type FakeForge } from './test/fakeForge'
import { ev, redacted, userMsg } from './test/events'

let f: FakeForge
beforeEach(() => { f = installFakeForge() })

describe('DebugPanel redaction', () => {
  it('events.redacted with a seq replaces that cached text with [已删除]', async () => {
    render(<DebugPanel />)
    const marker = 'MARKER-7f3a'
    const e = userMsg('s1', 't1', marker)
    act(() => f.emit(e))
    act(() => f.emit(ev('message.assistant', { turnId: 't1', text: 'kept reply' }, { sessionId: 's1' })))
    expect(screen.getByText(marker)).toBeInTheDocument()
    act(() => f.emit(redacted({ seqs: [e.seq] })))
    expect(screen.queryByText(marker)).toBeNull()
    expect(document.body.innerHTML).not.toContain(marker)
    expect(screen.getByText('[已删除]')).toBeInTheDocument()
    expect(screen.getByText('kept reply')).toBeInTheDocument()
  })

  it('events.redacted with session drops every cached event of that session', async () => {
    render(<DebugPanel />)
    act(() => f.emit(userMsg('gone', 't1', 'GONE-1')))
    act(() => f.emit(ev('tool.started', { turnId: 't1', callId: 'c', name: 'shell', argsPreview: 'echo GONE-2' }, { sessionId: 'gone' })))
    act(() => f.emit(userMsg('stay', 't2', 'STAY-1')))
    act(() => f.emit(redacted({ session: 'gone' })))
    expect(document.body.innerHTML).not.toContain('GONE-')
    expect(screen.getByText('STAY-1')).toBeInTheDocument()
  })
})
