import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [
    { id: 'opus-4.8', label: 'opus-4.8', description: '最强推理 · 编排首选' },
    { id: 'sonnet-4.6', label: 'sonnet-4.6', description: '均衡 · 高速执行' }
  ] }
]
beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() } })

describe('Composer', () => {
  it('sends the typed text with selected agent + model on ⌘↩', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '迁移颜色 token' } })
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
    const arg = onSend.mock.calls[0][0]
    expect(arg.text).toBe('迁移颜色 token')
    expect(arg.agent).toBe('claude')
    expect(arg.agentLabel).toBe('Claude Code')
    expect(arg.model).toBe('opus-4.8')
  })
  it('sends on plain Enter', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '你好' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].text).toBe('你好')
  })
  it('Shift+Enter inserts a newline instead of sending', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '第一行' } })
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })
  it('does not send while an IME composition is active (Enter commits the candidate)', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: 'nihao' } })
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })
  it('renders model subtitle in .sub span', () => {
    render(<Composer providers={providers} disabled={false} onSend={vi.fn()} />)
    const sub = screen.getByText('最强推理 · 编排首选')
    expect(sub.tagName.toLowerCase()).toBe('span')
    expect(sub.className).toBe('sub')
  })
  it('busy=true gives the send button the queueing class + busy title', () => {
    const { container } = render(<Composer providers={providers} disabled={false} busy onSend={vi.fn()} />)
    const btn = container.querySelector('.send') as HTMLButtonElement
    expect(btn.classList.contains('queueing')).toBe(true)
    expect(btn.title).toBe('执行中 · 发送将进入队列')
    expect(btn.disabled).toBe(false)
    expect(screen.getByPlaceholderText(/继续输入将排队/)).toBeInTheDocument()
  })
  it('busy=false keeps the normal send button (no queueing class)', () => {
    const { container } = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} />)
    const btn = container.querySelector('.send') as HTMLButtonElement
    expect(btn.classList.contains('queueing')).toBe(false)
    expect(btn.title).toBe('发送 (回车)')
  })
  it('does not send empty text, and clears after send', () => {
    const onSend = vi.fn()
    render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    const ta = screen.getByPlaceholderText(/给主代理下达任务/) as HTMLTextAreaElement
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.change(ta, { target: { value: 'x' } })
    fireEvent.click(screen.getByTitle(/发送/))
    expect(onSend).toHaveBeenCalled()
    expect(ta.value).toBe('')
  })

  it('model menu has 「自定义模型…」entry', () => {
    const { container } = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} />)
    // open the version menu via the verMenu button
    fireEvent.click(container.querySelector('[data-menu="verMenu"]') as HTMLElement)
    expect(screen.getByText('自定义模型…')).toBeInTheDocument()
  })

  it('clicking 「自定义模型…」reveals a text input for model id', () => {
    const { container } = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} />)
    fireEvent.click(container.querySelector('[data-menu="verMenu"]') as HTMLElement)
    fireEvent.click(screen.getByText('自定义模型…'))
    expect(screen.getByPlaceholderText(/模型 id/i)).toBeInTheDocument()
  })

  it('typing a custom model id and pressing Enter sets that model and calls onSend with it', () => {
    const onSend = vi.fn()
    const { container } = render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    // open version menu and choose custom
    fireEvent.click(container.querySelector('[data-menu="verMenu"]') as HTMLElement)
    fireEvent.click(screen.getByText('自定义模型…'))
    const input = screen.getByPlaceholderText(/模型 id/i)
    fireEvent.change(input, { target: { value: 'my-new-model' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // now send a message
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '测试' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].model).toBe('my-new-model')
  })

  it('ignores empty custom model input (does not clear the existing model)', () => {
    const onSend = vi.fn()
    const { container } = render(<Composer providers={providers} disabled={false} onSend={onSend} />)
    fireEvent.click(container.querySelector('[data-menu="verMenu"]') as HTMLElement)
    fireEvent.click(screen.getByText('自定义模型…'))
    const input = screen.getByPlaceholderText(/模型 id/i)
    fireEvent.keyDown(input, { key: 'Enter' }) // empty → ignore
    // send message: model should still be the original opus-4.8
    const ta = screen.getByPlaceholderText(/给主代理下达任务/)
    fireEvent.change(ta, { target: { value: '测试' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].model).toBe('opus-4.8')
  })

  it('claude agent logo bg/color/glyph come from catalog (◇)', () => {
    const { container } = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} />)
    // The selected agent logo — .mc-logo-sm in .cb-btn (composer bar button)
    const logos = container.querySelectorAll('.mc-logo-sm')
    // First logo is the currently-selected agent in the composer bar
    const firstLogo = logos[0] as HTMLElement
    expect(firstLogo.textContent).toBe('◇')
    // bg should use catalog brandBg for claude (oklch(60% .14 35 / .18))
    expect(firstLogo.style.background).toContain('oklch')
  })
})
