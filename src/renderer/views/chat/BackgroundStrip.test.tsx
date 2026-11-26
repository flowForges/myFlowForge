import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { BackgroundStrip } from './BackgroundStrip'

describe('BackgroundStrip', () => {
  it('count=0 时不渲染任何东西', () => {
    const { container } = render(<BackgroundStrip count={0} onStop={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('count=2 时渲染「后台 2 个任务在运行」与「停止」，点击停止调用 onStop', () => {
    const onStop = vi.fn()
    const { container } = render(<BackgroundStrip count={2} onStop={onStop} />)
    expect(container.querySelector('.bg-strip')!.textContent).toContain('后台 2 个任务在运行')
    const btn = container.querySelector('.bg-strip-stop') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toBe('停止')
    btn.click()
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
