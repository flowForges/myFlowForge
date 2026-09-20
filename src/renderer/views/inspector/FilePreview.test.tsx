import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { FilePreview } from './FilePreview'

beforeEach(() => {
  ;(window as any).forge = {
    gitDiff: vi.fn(async () => [
      { kind: 'ctx', ln: 1, text: 'a' },
      { kind: 'add', ln: 2, text: 'B' },
      { kind: 'del', ln: 2, text: 'b' }
    ]),
    gitFile: vi.fn(async () => ({ text: 'const x = 1\nconst y = 2', lang: 'ts' }))
  }
})

describe('FilePreview', () => {
  it('shows the diff by default and switches to full text', async () => {
    const onClose = vi.fn()
    render(<FilePreview open cwd="/w" file="src/a.ts" type="M" onClose={onClose} />)
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('B')).toBeInTheDocument())
    expect((window as any).forge.gitDiff).toHaveBeenCalledWith('/w', 'src/a.ts')
    fireEvent.click(screen.getByText('全文'))
    await waitFor(() => expect((window as any).forge.gitFile).toHaveBeenCalledWith('/w', 'src/a.ts'))
    fireEvent.click(screen.getByTitle('返回'))
    expect(onClose).toHaveBeenCalled()
  })
  it('renders a .md file as formatted markdown in full mode', async () => {
    ;(window as any).forge.gitFile = vi.fn(async () => ({ text: '# Title', lang: 'markdown' }))
    const { container } = render(
      <FilePreview open cwd="/w" file="docs/readme.md" type="M" onClose={() => {}} />
    )
    fireEvent.click(screen.getByText('全文'))
    await waitFor(() => expect(container.querySelector('.pv-md h1')).toBeInTheDocument())
    expect(container.querySelector('.pv-md h1')?.textContent).toBe('Title')
    // markdown path should NOT render the raw '#' as code-line text
    expect(screen.queryByText('# Title')).not.toBeInTheDocument()
  })
  it('opens directly in full markdown when initialMode="full" (design doc open)', async () => {
    ;(window as any).forge.gitFile = vi.fn(async () => ({ text: '# 技术方案', lang: 'markdown' }))
    const { container } = render(
      <FilePreview open cwd="/w" file="docs/plan.md" type="M" initialMode="full" onClose={() => {}} />
    )
    // No click on 全文 needed — content renders formatted immediately.
    await waitFor(() => expect(container.querySelector('.pv-md h1')?.textContent).toBe('技术方案'))
    expect((window as any).forge.gitFile).toHaveBeenCalledWith('/w', 'docs/plan.md')
  })
  it('renders nothing interactive when closed', () => {
    const { container } = render(<FilePreview open={false} cwd="/w" file="" type="M" onClose={() => {}} />)
    const el = container.querySelector('.preview')
    expect(el?.className.includes('on')).toBe(false)
  })
})

describe('FilePreview — .html 与图片', () => {
  it('.html 给「用浏览器打开」,并把 cwd 一起交给主进程校验', async () => {
    ;(window as any).forge.gitFile = vi.fn(async () => ({ text: '<h1>x</h1>', lang: 'html' }))
    ;(window as any).forge.openFilePath = vi.fn(async () => ({ ok: true }))
    render(<FilePreview open cwd="/w" file="out/index.html" type="A" onClose={() => {}} />)
    fireEvent.click(screen.getByText('用浏览器打开'))
    expect((window as any).forge.openFilePath).toHaveBeenCalledWith(['/w'], 'out/index.html')
  })
  it('非 html 不给这个按钮', () => {
    render(<FilePreview open cwd="/w" file="src/a.ts" type="M" onClose={() => {}} />)
    expect(screen.queryByText('用浏览器打开')).not.toBeInTheDocument()
  })
  it('图片点击开灯箱', async () => {
    ;(window as any).forge.imageFile = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAA' }))
    const { container } = render(<FilePreview open cwd="/w" file="docs/shot.png" type="A" onClose={() => {}} />)
    await waitFor(() => expect(container.querySelector('.pv-img')).toBeInTheDocument())
    fireEvent.click(container.querySelector('.pv-img')!)
    expect(document.body.querySelector('.lightbox-img')?.getAttribute('src')).toBe('data:image/png;base64,AAA')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.body.querySelector('.lightbox')).toBeNull()
  })
})


describe('复制整份文件', () => {
  const clip = () => {
    const writeText = vi.fn(async (_t: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }

  it('点一下把这个文件的全部内容放进剪贴板', async () => {
    const writeText = clip()
    render(<FilePreview open cwd="/w" file="src/a.ts" type="M" onClose={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByTitle('复制这个文件的全部内容')) })
    expect(writeText).toHaveBeenCalledWith('const x = 1\nconst y = 2')
    expect(screen.getByText('已复制')).toBeTruthy()
  })

  it('★★Diff 模式下复制的也是**整份文件**,不是带 +/- 的那一屏', async () => {
    // 用户要的是「复制当前文件内的内容」。一份带 diff 标记的文本粘到哪儿都是坏的:
    // 粘进编辑器编译不过,粘给模型全是噪音。
    const writeText = clip()
    ;(window as any).forge.gitDiff = vi.fn(async () => [
      { kind: 'del', text: '-const x = 0', ln: 1 },
      { kind: 'add', text: '+const x = 1', ln: 1 },
    ])
    render(<FilePreview open cwd="/w" file="src/a.ts" type="M" onClose={() => {}} initialMode="diff" />)
    await act(async () => { fireEvent.click(screen.getByTitle('复制这个文件的全部内容')) })
    const copied: string = writeText.mock.calls[0]![0]
    expect(copied).toBe('const x = 1\nconst y = 2')
    expect(copied).not.toContain('+const')
    expect(copied).not.toContain('-const')
  })

  it('★剪贴板不可用时说出来,不是点了没反应', async () => {
    // 静默失败会让人以为按钮坏了,然后反复点。
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => { throw new Error('denied') }) }, configurable: true,
    })
    render(<FilePreview open cwd="/w" file="src/a.ts" type="M" onClose={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByTitle('复制这个文件的全部内容')) })
    expect(screen.getByText('复制失败')).toBeTruthy()
  })

  it('图片没有这颗按钮 —— 复制一张图的「内容」没有意义', async () => {
    ;(window as any).forge.imageFile = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AA' }))
    render(<FilePreview open cwd="/w" file="a.png" type="A" onClose={() => {}} />)
    expect(screen.queryByTitle('复制这个文件的全部内容')).toBeNull()
  })
})
