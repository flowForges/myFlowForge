import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThinkBlock } from './ThinkBlock'

const think = { label: '已思考', elapsed: 3, steps: ['扫描代码库', '定位 47 处引用'] }

describe('ThinkBlock', () => {
  it('while streaming: live + open (body visible), shows steps', () => {
    const { container } = render(<ThinkBlock think={{ label: '主代理思考中…', steps: ['读取入口文件'] }} streaming />)
    const el = container.querySelector('.think')!
    expect(el.className).toContain('live')
    expect(el.className).toContain('open')
    expect(screen.getByText('读取入口文件')).toBeInTheDocument()
  })
  it('when done: not live, collapsed by default, renders steps in the timeline', () => {
    const { container } = render(<ThinkBlock think={think} streaming={false} />)
    const el = container.querySelector('.think')!
    expect(el.className).not.toContain('live')
    expect(el.className).not.toContain('open')
    expect(container.querySelector('.think-steps')).toBeTruthy()
    expect(container.querySelectorAll('.think-step').length).toBe(2)
  })
  it('clicking the header toggles open', () => {
    const { container } = render(<ThinkBlock think={think} streaming={false} />)
    const el = container.querySelector('.think')!
    fireEvent.click(container.querySelector('.think-h')!)
    expect(el.className).toContain('open')
    fireEvent.click(container.querySelector('.think-h')!)
    expect(el.className).not.toContain('open')
  })
})
