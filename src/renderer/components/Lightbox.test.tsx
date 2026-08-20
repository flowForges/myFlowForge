import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Lightbox } from './Lightbox'
import { Markdown } from '../views/chat/markdown'

describe('Lightbox', () => {
  it('挂到 body 上(不被气泡/预览的 overflow 裁掉)', () => {
    const { container } = render(<Lightbox src="https://x/a.png" alt="图" onClose={() => {}} />)
    expect(container.querySelector('.lightbox')).toBeNull()
    expect(document.body.querySelector('.lightbox-img')?.getAttribute('src')).toBe('https://x/a.png')
  })
  it('Esc 关闭', () => {
    const onClose = vi.fn()
    render(<Lightbox src="https://x/a.png" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
  it('点遮罩关闭,点图片本身不关', () => {
    const onClose = vi.fn()
    render(<Lightbox src="https://x/a.png" onClose={onClose} />)
    fireEvent.click(document.body.querySelector('.lightbox-img')!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(document.body.querySelector('.lightbox')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('关闭按钮', () => {
    const onClose = vi.fn()
    render(<Lightbox src="https://x/a.png" onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('正文里的图片可点开大图', () => {
  it('点 markdown 图片 → 出灯箱,Esc 收回', () => {
    const { container } = render(<Markdown text={'见图 ![流程图](https://x/d.png)'} />)
    const img = container.querySelector('img.md-img')!
    expect(document.body.querySelector('.lightbox')).toBeNull()
    fireEvent.click(img)
    expect(document.body.querySelector('.lightbox-img')?.getAttribute('src')).toBe('https://x/d.png')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.body.querySelector('.lightbox')).toBeNull()
  })
})
