import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { AutoSwitch, AUTO_LABEL, UNSANDBOXED_AUTO_LABEL } from './AutoSwitch'

describe('AutoSwitch', () => {
  it('the labels are the spec §16 strings verbatim', () => {
    expect(AUTO_LABEL).toBe('自动放行 · 命令不经你看 · 能读凭据清单以外的文件')
    expect(UNSANDBOXED_AUTO_LABEL).toBe('无沙箱时自动放行 · 命令不隔离 · 能读写凭据清单以外的文件')
  })

  it('renders AUTO_LABEL as its <label> text and toggles', () => {
    const onChange = vi.fn()
    const { container } = render(<AutoSwitch checked={false} onChange={onChange} />)
    const labels = container.querySelectorAll('label')
    expect(labels).toHaveLength(1)
    expect(labels[0].textContent).toBe(AUTO_LABEL)
    const box = container.querySelector('input[type=checkbox]') as HTMLInputElement
    expect(labels[0].contains(box)).toBe(true)
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('disabled and the unsandboxed variant', () => {
    const { container } = render(<AutoSwitch checked disabled label={UNSANDBOXED_AUTO_LABEL} onChange={() => {}} />)
    expect(container.querySelector('label')!.textContent).toBe(UNSANDBOXED_AUTO_LABEL)
    const box = container.querySelector('input') as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(box.checked).toBe(true)
  })

  it('warn-row styling keeps the label text verbatim and the checkbox inside label.mffai-switch', () => {
    const { container } = render(<AutoSwitch checked onChange={() => {}} />)
    const label = container.querySelector('label.mffai-switch')!
    expect(label).not.toBeNull()
    expect(label.classList.contains('mffai-warnrow')).toBe(true)
    expect(label.textContent).toBe(AUTO_LABEL)
    expect(label.querySelector('input[type=checkbox]')).not.toBeNull()
    expect(label.querySelectorAll('input')).toHaveLength(1)
  })
})
