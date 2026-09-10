import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Markdown, MdImageBaseCtx } from './markdown'
import { OpenFileCtx } from './openFile'

/**
 * ★★用户 2026-09-10 报的:「对话里模型输出的图展示不出来」。
 *
 * 现象是正文里出现一个 `🖼 alt` 占位符。根因不在渲染,在于**对话气泡从来没拿到过 base** ——
 * `MdImageBaseCtx` 全项目只有 FilePreview 传,于是 `MdImage` 里 `!base` 直接 setErr。
 * 而模型跑完命令生成图表,写的正是本地路径。
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo='
let imageFile: ReturnType<typeof vi.fn>

beforeEach(() => {
  imageFile = vi.fn().mockResolvedValue({ dataUrl: PNG })
  ;(globalThis as unknown as { window: { forge: unknown } }).window.forge = { imageFile } as never
})

const inChat = (text: string, bases = ['/ws/wt', '/ws']) =>
  render(
    <OpenFileCtx.Provider value={{ bases, open: async () => 'ok' }}>
      <Markdown text={text} />
    </OpenFileCtx.Provider>,
  )

describe('对话气泡里的 markdown 图片', () => {
  it('★★相对路径的本地图现在能显示(修复前是 🖼 占位符)', async () => {
    const { container } = inChat('看这张 ![流程图](./out/chart.png)')
    await waitFor(() => expect(container.querySelector('img.md-img')).toBeTruthy())
    expect(container.querySelector('img.md-img')?.getAttribute('src')).toBe(PNG)
    expect(container.querySelector('.md-img-err')).toBeNull()
  })

  it('★★绝对路径也能显示 —— 模型跑完命令写的就是绝对路径', async () => {
    const { container } = inChat('![截图](/ws/wt/out/shot.png)')
    await waitFor(() => expect(container.querySelector('img.md-img')).toBeTruthy())
  })

  it('★把会话的 bases 原样交给主进程(越界判断在那边做,渲染层不自己拼路径)', async () => {
    inChat('![x](./a.png)', ['/ws/wt', '/ws'])
    await waitFor(() => expect(imageFile).toHaveBeenCalled())
    expect(imageFile.mock.calls[0][0]).toEqual(['/ws/wt', '/ws'])
    expect(imageFile.mock.calls[0][1]).toBe('./a.png')
  })

  it('主进程说读不了 → 退回占位符,并把原因带在 title 上', async () => {
    imageFile.mockResolvedValue({ error: '不在工作区内' })
    const { container } = inChat('![x](../../etc/passwd.png)')
    await waitFor(() => expect(container.querySelector('.md-img-err')).toBeTruthy())
    expect(container.querySelector('img.md-img')).toBeNull()
  })

  it('http/data/forge- 三种照旧直接加载,不走 IPC', async () => {
    const { container } = inChat('![a](https://x/a.png) ![b](data:image/png;base64,AA)')
    expect(container.querySelectorAll('img.md-img').length).toBe(2)
    expect(imageFile).not.toHaveBeenCalled()
  })

  it('没有任何 context 时(别的面板/纯渲染)保持占位符,零回归', async () => {
    const { container } = render(<Markdown text={'![x](./a.png)'} />)
    await waitFor(() => expect(container.querySelector('.md-img-err')).toBeTruthy())
    expect(imageFile).not.toHaveBeenCalled()
  })

  it('文档预览优先用它自己那份 base(相对图按文档所在目录解析),不被会话 bases 顶掉', async () => {
    render(
      <OpenFileCtx.Provider value={{ bases: ['/ws'], open: async () => 'ok' }}>
        <MdImageBaseCtx.Provider value={'/ws/docs'}>
          <Markdown text={'![x](./fig.png)'} />
        </MdImageBaseCtx.Provider>
      </OpenFileCtx.Provider>,
    )
    await waitFor(() => expect(imageFile).toHaveBeenCalled())
    expect(imageFile.mock.calls[0][0]).toEqual(['/ws/docs'])
  })

  it('alt 里的中文原样落在占位符和 img 的 alt 上', async () => {
    const { container } = inChat('![架构图](./a.png)')
    await waitFor(() => expect(container.querySelector('img.md-img')).toBeTruthy())
    expect(screen.getByAltText('架构图')).toBeTruthy()
  })
})
