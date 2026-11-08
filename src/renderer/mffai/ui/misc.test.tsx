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
