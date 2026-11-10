import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Chip } from './Chip'
import { CodeChip } from './CodeChip'
import { Countdown } from './Countdown'
import { PathField } from './PathField'
import { installFakeForge } from '../test/fakeForge'

afterEach(() => vi.useRealTimers())

describe('Chip / CodeChip', () => {
  it('Chip carries its tone, CodeChip shows the code verbatim', () => {
    const { container } = render(<><Chip tone="bad" title="proxy">未隔离</Chip><CodeChip code="cwd_too_broad" /></>)
    expect(screen.getByText('未隔离').className).toContain('bad')
    expect(screen.getByText('未隔离').getAttribute('title')).toBe('proxy')
    const code = container.querySelector('code')!
    expect(code.textContent).toBe('cwd_too_broad')
  })

  it('dot and sq variants are classes on the same chip; text and tone stay', () => {
    render(<><Chip tone="run" dot>运行中</Chip><Chip tone="warn" sq>部分</Chip><Chip>无</Chip></>)
    const run = screen.getByText('运行中')
    expect(run.className.split(' ')).toEqual(expect.arrayContaining(['mffai-chip', 'run', 'dot']))
    expect(run.textContent).toBe('运行中')
    const sq = screen.getByText('部分')
    expect(sq.className.split(' ')).toEqual(expect.arrayContaining(['mffai-chip', 'warn', 'sq']))
    expect(sq.classList.contains('dot')).toBe(false)
    expect(screen.getByText('无').className.split(' ')).toEqual(expect.arrayContaining(['mffai-chip', 'muted']))
  })

  it('CodeChip tone adds the tone class, the code stays verbatim', () => {
    const { container } = render(<><CodeChip code="crash-loop" tone="bad" /><CodeChip code="test_failed" tone="warn" /><CodeChip code="exec" /></>)
    const codes = [...container.querySelectorAll('code.mffai-code')]
    expect(codes.map((c) => c.textContent)).toEqual(['crash-loop', 'test_failed', 'exec'])
    expect(codes.map((c) => c.className)).toEqual(['mffai-badge mffai-code bad', 'mffai-badge mffai-code warn', 'mffai-badge mffai-code'])
  })
})

describe('Countdown', () => {
  it('shows m:ss, ticks down and calls onDone once at zero', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const onDone = vi.fn()
    render(<Countdown until={1_000_000 + 65_000} onDone={onDone} />)
    expect(screen.getByText('1:05')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(6_000) })
    expect(screen.getByText('0:59')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(70_000) })
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('already past -> 0:00 and onDone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const onDone = vi.fn()
    render(<Countdown until={1_000} onDone={onDone} />)
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('with from: a ring whose stroke-dashoffset follows the remaining fraction, onDone once', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const onDone = vi.fn()
    const { container } = render(<Countdown from={1_000_000 - 20_000} until={1_000_000 + 80_000} onDone={onDone} />)
    const ring = container.querySelector('svg.mffai-ring')!
    expect(ring).not.toBeNull()
    expect(ring.getAttribute('width')).toBe('34')
    const arc = ring.querySelector('circle.mffai-ring-arc')!
    const c = parseFloat(arc.getAttribute('stroke-dasharray')!)
    const off = () => parseFloat(arc.getAttribute('stroke-dashoffset')!)
    // 剩 80/100
    expect(off()).toBeCloseTo(c * 0.2, 3)
    expect(screen.getByText('1:20')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(off()).toBeCloseTo(c * 0.5, 3)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(off()).toBeCloseTo(c, 3)
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('without from there is no ring', () => {
    const { container } = render(<Countdown until={Date.now() + 5_000} />)
    expect(container.querySelector('svg')).toBeNull()
  })
})

describe('PathField', () => {
  it('typing and picking a directory', async () => {
    const f = installFakeForge()
    f.forge.pickDirectory = vi.fn(async () => '/picked')
    const onChange = vi.fn()
    render(<PathField value="/a" kind="directory" onChange={onChange} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('/a')
    expect(input.getAttribute('placeholder')).toBeNull()
    fireEvent.change(input, { target: { value: '/b' } })
    expect(onChange).toHaveBeenLastCalledWith('/b')
    await act(async () => { fireEvent.click(screen.getByText('选择')) })
    expect(f.forge.pickDirectory).toHaveBeenCalled()
    expect(onChange).toHaveBeenLastCalledWith('/picked')
  })

  it('file kind uses pickFile; cancel keeps the value', async () => {
    const f = installFakeForge()
    f.forge.pickFile = vi.fn(async () => null)
    const onChange = vi.fn()
    render(<PathField value="" kind="file" onChange={onChange} />)
    await act(async () => { fireEvent.click(screen.getByText('选择')) })
    expect(f.forge.pickFile).toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})
