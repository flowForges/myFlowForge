import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'

// 2026-10-06 用户报:输入框里引入的图片一多,附件区把输入框整个盖住,图也看不全(截图里 20 来张
// 32 位哈希名的 jpg 一行一个排下去,输入框被顶出视口)。修法:图片附件改成缩略图格子,附件区封顶可滚动。
const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
]

const imageFile = vi.fn(async (_bases: string[], href: string) => ({ dataUrl: `data:image/png;base64,${href}` }))

function setup(atts: { name: string; path: string; size: number }[]) {
  ;(window as any).forge = { openFiles: vi.fn(async () => atts), savePaste: vi.fn(), imageFile }
  const r = render(<Composer providers={providers} disabled={false} onSend={vi.fn()} />)
  return r
}

async function attach(container: HTMLElement) {
  await act(async () => { fireEvent.click(container.querySelector('#attachBtn') as HTMLElement) })
}

beforeEach(() => { imageFile.mockClear() })

describe('输入框附件区 —— 图片多了也不能盖住输入框', () => {
  it('图片附件渲染成缩略图格子,非图片仍是文件 chip', async () => {
    const { container } = setup([
      { name: 'b5be7e0c32ef178597a845d2106aeb46.jpg', path: '/Users/me/Pictures/b5be7e0c32ef178597a845d2106aeb46.jpg', size: 150_000 },
      { name: 'notes.txt', path: '/Users/me/notes.txt', size: 900 },
    ])
    await attach(container)
    await waitFor(() => expect(container.querySelectorAll('.attach-chip').length).toBe(2))
    const tiles = container.querySelectorAll('.attach-chip.is-image')
    expect(tiles.length).toBe(1)
    // 名字仍在 DOM 里(屏幕阅读器、悬停 title),只是不占一整行
    expect(tiles[0].textContent).toContain('b5be7e0c32ef178597a845d2106aeb46.jpg')
    expect(tiles[0].getAttribute('title')).toContain('b5be7e0c32ef178597a845d2106aeb46.jpg')
  })

  it('★「附加文件」或从访达拖进来的图片(只有路径、没有字节)也要真的显示出图来', async () => {
    const { container } = setup([{ name: 'a.png', path: '/Users/me/Desktop/a.png', size: 120_000 }])
    await attach(container)
    // 按附件自己所在目录读:bases 本来就由渲染端给,这样不比现在多开任何读文件能力
    await waitFor(() => expect(imageFile).toHaveBeenCalledWith(['/Users/me/Desktop'], 'a.png'))
    await waitFor(() => expect(container.querySelector('.attach-chip.is-image img.attach-thumb')).toBeTruthy())
  })

  it('★大图不自动读 —— 20 张 20MB 的照片全变成 data URL 会把内存吃爆,显示占位格即可', async () => {
    const { container } = setup([{ name: 'huge.jpg', path: '/Users/me/huge.jpg', size: 20_000_000 }])
    await attach(container)
    await waitFor(() => expect(container.querySelector('.attach-chip.is-image')).toBeTruthy())
    expect(imageFile).not.toHaveBeenCalled()
    expect(container.querySelector('.attach-chip.is-image img')).toBeNull()
  })

  it('格子上的移除按钮能把那张图删掉', async () => {
    const { container } = setup([
      { name: 'a.png', path: '/x/a.png', size: 10 },
      { name: 'b.png', path: '/x/b.png', size: 10 },
    ])
    await attach(container)
    await waitFor(() => expect(container.querySelectorAll('.attach-chip.is-image').length).toBe(2))
    const btn = container.querySelector('.attach-chip.is-image button[title^="移除"]') as HTMLElement
    fireEvent.click(btn)
    expect(container.querySelectorAll('.attach-chip.is-image').length).toBe(1)
  })

  it('读图失败时退回占位格,不报错也不留空', async () => {
    imageFile.mockResolvedValueOnce({ error: '读取失败' } as never)
    const { container } = setup([{ name: 'gone.png', path: '/x/gone.png', size: 10 }])
    await attach(container)
    await waitFor(() => expect(imageFile).toHaveBeenCalled())
    expect(container.querySelector('.attach-chip.is-image')).toBeTruthy()
    expect(container.querySelector('.attach-chip.is-image img')).toBeNull()
  })
})
