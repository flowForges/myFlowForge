import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [
    { id: 'opus-4.8', label: 'opus-4.8', description: '最强推理 · 编排首选' },
  ] }
]

beforeEach(() => {
  ;(window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() }
})

describe('Composer stop button', () => {
  it('running + empty input → stop button rendered, click calls onStop', () => {
    const onStop = vi.fn()
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} running onStop={onStop} onSend={onSend} />)
    const stopBtn = screen.getByTitle('停止 (Esc)')
    expect(stopBtn).toBeInTheDocument()
    expect(stopBtn.id).toBe('stopBtn')
    fireEvent.click(stopBtn)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('running + typed text → send button rendered, click calls onSend', () => {
    const onStop = vi.fn()
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} running onStop={onStop} onSend={onSend} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '队列消息' } })
    // send button should now be rendered (not stop button)
    const sendBtn = screen.getByTitle(/发送/)
    expect(sendBtn).toBeInTheDocument()
    expect(screen.queryByTitle('停止 (Esc)')).toBeNull()
    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('stopping BEFORE any output restores the sent message to the box', () => {
    const onSend = vi.fn()
    const { rerender } = render(<Composer providers={providers} disabled={false} onStop={vi.fn()} onSend={onSend} />)
    const ta = () => screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement
    fireEvent.change(ta(), { target: { value: '帮我读一下代码' } })
    fireEvent.keyDown(ta(), { key: 'Enter' })            // send → clears the box
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(ta().value).toBe('')
    // turn is now running with NO output yet → Esc restores the message for editing
    rerender(<Composer providers={providers} disabled={false} running turnHasOutput={false} onStop={vi.fn()} onSend={onSend} />)
    fireEvent.keyDown(ta(), { key: 'Escape' })
    expect(ta().value).toBe('帮我读一下代码')
  })

  it('stopping AFTER the AI has output does NOT restore', () => {
    const onSend = vi.fn()
    const { rerender } = render(<Composer providers={providers} disabled={false} onStop={vi.fn()} onSend={onSend} />)
    const ta = () => screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement
    fireEvent.change(ta(), { target: { value: '改个东西' } })
    fireEvent.keyDown(ta(), { key: 'Enter' })
    expect(ta().value).toBe('')
    rerender(<Composer providers={providers} disabled={false} running turnHasOutput onStop={vi.fn()} onSend={onSend} />)
    fireEvent.keyDown(ta(), { key: 'Escape' })
    expect(ta().value).toBe('')   // AI already produced output → not restored
  })

  it('focus textarea, press Escape while running → calls onStop', () => {
    const onStop = vi.fn()
    render(<Composer providers={providers} disabled={false} running onStop={onStop} onSend={vi.fn()} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.focus(ta)
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
