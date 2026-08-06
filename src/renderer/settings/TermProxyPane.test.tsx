import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { TermProxyPane } from './TermProxyPane'

describe('TermProxyPane', () => {
  it('does NOT prefill an unsaved default — an empty setting shows an empty box (no decoy)', () => {
    // Regression: prefilling http://127.0.0.1:7897 into an unsaved box read as "a proxy is configured"
    // when it wasn't, so the provider ran direct-connect and 403'd. Unset MUST look unset.
    const onChange = vi.fn()
    render(<TermProxyPane termProxy="" onChange={onChange} />)
    const input = screen.getByPlaceholderText('http://127.0.0.1:7897') as HTMLInputElement
    expect(input.value).toBe('')
    // And the current-state line must say 直连 so the user can't mistake it for "enabled".
    const { container } = render(<TermProxyPane termProxy="" onChange={vi.fn()} />)
    expect(container.querySelector('.proxy-current.off')?.textContent).toContain('直连')
  })

  it('picking a preset commits it immediately (no hidden "touched" trap)', () => {
    const onChange = vi.fn()
    render(<TermProxyPane termProxy="" onChange={onChange} />)
    fireEvent.click(screen.getByText('Clash Verge · 7897'))
    expect(onChange).toHaveBeenCalledWith('http://127.0.0.1:7897')
  })

  it('shows the active proxy in the current-state line when set', () => {
    render(<TermProxyPane termProxy="http://127.0.0.1:1080" onChange={vi.fn()} />)
    // 当前状态行显示「经代理」；出口 IP 检测按钮初始不显示结果，故只此一处。
    expect(screen.getByText(/当前：经代理/)).toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:1080')).toBeInTheDocument()
  })

  it('检测出口 IP button shows the result on success', async () => {
    ;(window as any).forge = { checkExitIp: vi.fn(async () => ({ ip: '1.2.3.4', region: 'US · California', via: 'proxy' as const })) }
    render(<TermProxyPane termProxy="http://127.0.0.1:1080" onChange={vi.fn()} />)
    fireEvent.click(screen.getByText('检测出口 IP'))
    expect(await screen.findByText('1.2.3.4')).toBeInTheDocument()
    expect(screen.getByText(/US · California/)).toBeInTheDocument()
    expect(screen.getByText('（经代理）')).toBeInTheDocument()
  })

  it('检测出口 IP button shows a failure message on error', async () => {
    ;(window as any).forge = { checkExitIp: vi.fn(async () => { throw new Error('boom') }) }
    render(<TermProxyPane termProxy="" onChange={vi.fn()} />)
    fireEvent.click(screen.getByText('检测出口 IP'))
    expect(await screen.findByText(/检测失败/)).toBeInTheDocument()
  })

  it('edits the proxy and reports changes; reset clears it', () => {
    const onChange = vi.fn()
    render(<TermProxyPane termProxy="http://127.0.0.1:7897" onChange={onChange} />)
    const input = screen.getByPlaceholderText('http://127.0.0.1:7897') as HTMLInputElement
    expect(input.value).toBe('http://127.0.0.1:7897')
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:1080' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('http://127.0.0.1:1080')
    fireEvent.click(screen.getByText('清空 · 直连'))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('flashes the saved class transiently after a save', () => {
    vi.useFakeTimers()
    try {
      const onChange = vi.fn()
      render(<TermProxyPane termProxy="http://127.0.0.1:7897" onChange={onChange} />)
      const input = screen.getByPlaceholderText('http://127.0.0.1:7897') as HTMLInputElement
      const status = document.querySelector('.proxy-status') as HTMLElement

      expect(status.classList.contains('saved')).toBe(false)

      fireEvent.change(input, { target: { value: 'http://127.0.0.1:1080' } })
      fireEvent.blur(input)
      expect(status.classList.contains('saved')).toBe(true)

      act(() => {
        vi.advanceTimersByTime(1400)
      })
      expect(status.classList.contains('saved')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // 用户反馈:手动填完代理地址后,没有任何东西告诉你"存上了没有" —— 习惯性去找保存按钮却找不到。
  // 而且原先那行「已保存」是**常驻**的:哪怕框是空的、从没存过,也一直写着已保存,属于假信息。
  describe('保存状态必须如实', () => {
    const setup = (termProxy: string) => {
      const onChange = vi.fn()
      render(<TermProxyPane termProxy={termProxy} onChange={onChange} />)
      return { onChange, input: screen.getByPlaceholderText('http://127.0.0.1:7897') as HTMLInputElement }
    }
    const statusText = () => (document.querySelector('.proxy-status') as HTMLElement).textContent ?? ''
    const saveBtn = () => document.querySelector('.proxy-save') as HTMLButtonElement

    it('未改动时:按钮是禁用的「已保存」,状态行不喊未保存', () => {
      setup('http://127.0.0.1:7897')
      expect(saveBtn().disabled).toBe(true)
      expect(saveBtn().textContent).toBe('已保存')
      expect(statusText()).not.toContain('未保存')
    })

    it('改动后:状态行明说未保存,按钮变成可点的「保存」', () => {
      const { input } = setup('http://127.0.0.1:7897')
      fireEvent.change(input, { target: { value: 'http://127.0.0.1:1080' } })
      expect(statusText()).toContain('未保存')
      expect(saveBtn().disabled).toBe(false)
      expect(saveBtn().textContent).toBe('保存')
      expect(document.querySelector('.proxy-status')!.className).toContain('dirty')
    })

    it('点保存按钮真的提交,并回到已保存', () => {
      const { input, onChange } = setup('http://127.0.0.1:7897')
      fireEvent.change(input, { target: { value: 'http://127.0.0.1:1080' } })
      fireEvent.click(saveBtn())
      expect(onChange).toHaveBeenCalledWith('http://127.0.0.1:1080')
    })

    it('回车提交(不必先失焦)', () => {
      const { input, onChange } = setup('http://127.0.0.1:7897')
      fireEvent.change(input, { target: { value: 'socks5://127.0.0.1:1080' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onChange).toHaveBeenCalledWith('socks5://127.0.0.1:1080')
    })

    it('前后空格不算改动(trim 后与已保存值相同)', () => {
      const { input } = setup('http://127.0.0.1:7897')
      fireEvent.change(input, { target: { value: '  http://127.0.0.1:7897  ' } })
      expect(saveBtn().disabled).toBe(true)
      expect(statusText()).not.toContain('未保存')
    })
  })
})
