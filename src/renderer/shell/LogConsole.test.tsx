import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LogConsole } from './LogConsole'
import type { LogLine } from '../state/logReducer'

const mkLine = (overrides: Partial<LogLine> & Pick<LogLine, 'id' | 'level'>): LogLine => ({
  t: '10:00:00',
  src: 'agent',
  color: 'var(--accent)',
  text: 'test message',
  streaming: false,
  ...overrides,
})

const baseProps = {
  open: true,
  logs: [],
  busy: false,
  onClear: vi.fn(),
  onClose: vi.fn(),
}

describe('LogConsole', () => {
  it('renders empty state when no logs', () => {
    render(<LogConsole {...baseProps} />)
    expect(screen.getByText(/暂无日志/)).toBeInTheDocument()
  })

  it('does not render empty state when logs exist', () => {
    const logs = [mkLine({ id: '1', level: 'exec', text: 'some log' })]
    render(<LogConsole {...baseProps} logs={logs} />)
    expect(screen.queryByText(/暂无日志/)).not.toBeInTheDocument()
    expect(screen.getByText('some log')).toBeInTheDocument()
  })

  it('shows all logs when filter is "all"', () => {
    const logs = [
      mkLine({ id: '1', level: 'think', text: 'thinking' }),
      mkLine({ id: '2', level: 'exec', text: 'executing' }),
      mkLine({ id: '3', level: 'out', text: 'outputting' }),
    ]
    render(<LogConsole {...baseProps} logs={logs} />)
    expect(screen.getByText('thinking')).toBeInTheDocument()
    expect(screen.getByText('executing')).toBeInTheDocument()
    expect(screen.getByText('outputting')).toBeInTheDocument()
  })

  it('hides non-matching lines when filter is set', () => {
    const logs = [
      mkLine({ id: '1', level: 'think', text: 'thinking text' }),
      mkLine({ id: '2', level: 'exec', text: 'executing text' }),
      mkLine({ id: '3', level: 'out', text: 'output text' }),
    ]
    render(<LogConsole {...baseProps} logs={logs} />)

    // Click '执行' filter (use role+name to avoid ambiguity with lg-lvl label)
    fireEvent.click(screen.getByRole('button', { name: '执行' }))

    // exec line visible, think and out have .hide class
    const thinkLine = screen.getByText('thinking text').closest('.lg-line')
    const execLine = screen.getByText('executing text').closest('.lg-line')
    const outLine = screen.getByText('output text').closest('.lg-line')
    expect(thinkLine).toHaveClass('hide')
    expect(execLine).not.toHaveClass('hide')
    expect(outLine).toHaveClass('hide')
  })

  it('active filter button has "on" class', () => {
    render(<LogConsole {...baseProps} />)
    // Initially "全部" is active
    expect(screen.getByText('全部')).toHaveClass('on')
    expect(screen.getByText('思考')).not.toHaveClass('on')

    fireEvent.click(screen.getByText('思考'))
    expect(screen.getByText('思考')).toHaveClass('on')
    expect(screen.getByText('全部')).not.toHaveClass('on')
  })

  it('calls onClear when 清空 is clicked', () => {
    const onClear = vi.fn()
    render(<LogConsole {...baseProps} onClear={onClear} />)
    fireEvent.click(screen.getByTitle('清空日志'))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<LogConsole {...baseProps} onClose={onClose} />)
    fireEvent.click(screen.getByTitle('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has "open" class when open=true', () => {
    const { container } = render(<LogConsole {...baseProps} open={true} />)
    expect(container.querySelector('.logcon')).toHaveClass('open')
  })

  it('does not have "open" class when open=false', () => {
    const { container } = render(<LogConsole {...baseProps} open={false} />)
    expect(container.querySelector('.logcon')).not.toHaveClass('open')
  })

  it('shows streaming class on streaming lines', () => {
    const logs = [mkLine({ id: '1', level: 'out', text: 'streaming...', streaming: true })]
    render(<LogConsole {...baseProps} logs={logs} />)
    const line = screen.getByText('streaming...').closest('.lg-line')
    expect(line).toHaveClass('streaming')
  })

  it('shows busy dot with run class when busy=true', () => {
    const { container } = render(<LogConsole {...baseProps} busy={true} />)
    expect(container.querySelector('.logcon-head .tt .lg-dot')).toHaveClass('run')
  })

  it('does not show run class on dot when busy=false', () => {
    const { container } = render(<LogConsole {...baseProps} busy={false} />)
    expect(container.querySelector('.logcon-head .tt .lg-dot')).not.toHaveClass('run')
  })

  it('hides lines from other agents when an agentFilter is set (by agent id = line.src)', () => {
    const logs = [
      mkLine({ id: '1', level: 'out', src: 'a1', text: 'from-a1' }),
      mkLine({ id: '2', level: 'out', src: 'a2', text: 'from-a2' }),
    ]
    render(<LogConsole {...baseProps} logs={logs} agentFilter={{ id: 'a1', name: 'Explorer' }} />)
    expect(screen.getByText('from-a1').closest('.lg-line')).not.toHaveClass('hide')
    expect(screen.getByText('from-a2').closest('.lg-line')).toHaveClass('hide')
  })

  it('agentFilter combines with the level filter (both must match)', () => {
    const logs = [
      mkLine({ id: '1', level: 'out', src: 'a1', text: 'a1-out' }),
      mkLine({ id: '2', level: 'think', src: 'a1', text: 'a1-think' }),
    ]
    render(<LogConsole {...baseProps} logs={logs} agentFilter={{ id: 'a1', name: 'Explorer' }} />)
    fireEvent.click(screen.getByRole('button', { name: '输出' }))
    expect(screen.getByText('a1-out').closest('.lg-line')).not.toHaveClass('hide')
    expect(screen.getByText('a1-think').closest('.lg-line')).toHaveClass('hide')
  })

  it('shows a removable agent chip and clears the filter', () => {
    const onClearAgentFilter = vi.fn()
    render(<LogConsole {...baseProps} logs={[mkLine({ id: '1', level: 'out' })]} agentFilter={{ id: 'a1', name: 'Explorer' }} onClearAgentFilter={onClearAgentFilter} />)
    expect(screen.getByText(/Explorer/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('清除代理过滤'))
    expect(onClearAgentFilter).toHaveBeenCalledTimes(1)
  })

  it('shows no agent chip when agentFilter is absent', () => {
    render(<LogConsole {...baseProps} logs={[mkLine({ id: '1', level: 'out' })]} />)
    expect(screen.queryByLabelText('清除代理过滤')).not.toBeInTheDocument()
  })
})
