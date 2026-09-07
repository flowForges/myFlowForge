import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { Composer } from './Composer'
import { installDropGuard } from '../../shell/dropGuard'
import type { Attachment, ProviderInfo } from '@shared/types'

/**
 * 把文件从访达拖进输入框。用户原话:「我将文件 拖拽到 输入框,应该跟粘贴或者上传一样,
 * 就被当前输入框引用」。
 *
 * ★所以对齐的是**「上传」**那条路(附加文件按钮):`{name, path, size}` 直接引用原文件,
 *  不复制、不经 IPC 搬字节 —— 拖一个 2G 的录屏进来不该把 app 卡死。
 * ★★但从**网页里**拖出来的图片没有本机路径(它只是内存里的一段字节)。这一类必须回落到
 *  「粘贴」那条路(存进 .forge/attachments)。两种来源长得一模一样,分不清就会静默丢文件。
 * ★Electron 42 起 `File.path` 已经没了,真路径只能问 preload 的 `filePath()`(webUtils)——
 *  这也是 PetPane 那个「把 Codex 宠物文件夹拖到这里」至今拖了没反应的原因。
 */
const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'opus' }] },
]

/** 一个「来自访达」的文件:preload 问得出本机路径。 */
function realFile(name: string, path: string, size = 1234) {
  const f = new File(['x'], name)
  Object.defineProperty(f, 'size', { value: size })
  ;(f as unknown as { __path: string }).__path = path
  return f
}
/** 一个「从网页里拖出来」的文件:没有本机路径。 */
function webFile(name: string, type = 'image/png') {
  return new File(['bytes'], name, { type })
}

const SAVED: Attachment = { name: 'img-101112.png', path: '/ws/.forge/attachments/img-101112.png', size: 5 }

let onPaste: ReturnType<typeof vi.fn>
beforeEach(() => {
  onPaste = vi.fn(async () => SAVED)
  ;(window as any).forge = {
    openFiles: vi.fn(async () => []),
    filePath: vi.fn((f: File) => (f as unknown as { __path?: string }).__path ?? ''),
  }
})

function setup(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const { container } = render(
    <Composer providers={providers} disabled={false} onSend={() => {}} onPaste={onPaste as never} {...props} />,
  )
  return {
    box: container.querySelector('.composer') as HTMLElement,
    ta: container.querySelector('textarea') as HTMLTextAreaElement,
    chips: () => [...container.querySelectorAll('.attach-chip')].map(c => c.textContent ?? ''),
    container,
  }
}

const fileDrop = (el: HTMLElement, files: File[]) =>
  fireEvent.drop(el, { dataTransfer: { files, types: ['Files'] } })
const fileDragOver = (el: HTMLElement, dropEffect = 'copy') => {
  const dt = { files: [], types: ['Files'], dropEffect }
  fireEvent.dragOver(el, { dataTransfer: dt })
  return dt
}

describe('拖文件进输入框', () => {
  it('★访达来的文件直接按原路径引用 —— 和「附加文件」按钮一模一样,不复制一份', async () => {
    const { box, chips } = setup()
    fileDrop(box, [realFile('design.pdf', '/Users/me/design.pdf', 2048)])
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(chips()[0]).toContain('design.pdf')
    expect(onPaste, '走了搬字节那条路 —— 大文件会把 app 卡死').not.toHaveBeenCalled()
  })

  it('拖一把文件进来,一个不落、顺序不乱', async () => {
    const { box, chips } = setup()
    fileDrop(box, [realFile('a.log', '/tmp/a.log'), realFile('b.log', '/tmp/b.log'), realFile('c.log', '/tmp/c.log')])
    await waitFor(() => expect(chips()).toHaveLength(3))
    expect(chips().map(c => c.split(' ')[0])).toEqual(['a.log', 'b.log', 'c.log'])
  })

  it('★★从网页里拖出来的图没有本机路径 → 回落到粘贴那条路存盘,不能静默丢掉', async () => {
    const { box, chips } = setup()
    fileDrop(box, [webFile('image.png')])
    await waitFor(() => expect(onPaste).toHaveBeenCalledTimes(1))
    expect(chips()[0]).toContain('img-')
  })

  it('★两种来源混在一次拖拽里 —— 各走各的路,两个都得在', async () => {
    const { box, chips } = setup()
    fileDrop(box, [realFile('real.txt', '/tmp/real.txt'), webFile('image.png')])
    await waitFor(() => expect(chips()).toHaveLength(2))
    expect(chips().join(' ')).toContain('real.txt')
    expect(onPaste).toHaveBeenCalledTimes(1)
  })

  it('★★drop 必须 preventDefault —— 不拦,Electron 会把整窗导航到 file://', () => {
    const { box } = setup()
    expect(fileDrop(box, [realFile('a.txt', '/tmp/a.txt')])).toBe(false)   // false = 被 preventDefault 了
  })

  it('★dragover 也要拦并且报 copy —— 不拦的话浏览器压根不会派发 drop', () => {
    const { box } = setup()
    expect(fileDragOver(box).dropEffect).toBe('copy')
  })

  it('拖进来时输入框亮起,松手/拖走之后灭掉', async () => {
    const { box, container } = setup()
    fireEvent.dragEnter(box, { dataTransfer: { files: [], types: ['Files'] } })
    expect(container.querySelector('.composer.dropping')).toBeTruthy()
    fileDrop(box, [realFile('a.txt', '/tmp/a.txt')])
    await waitFor(() => expect(container.querySelector('.composer.dropping')).toBeNull())
  })

  it('拖走(dragleave)也要灭掉,不能一直亮着', () => {
    const { box, container } = setup()
    fireEvent.dragEnter(box, { dataTransfer: { files: [], types: ['Files'] } })
    fireEvent.dragLeave(box, { dataTransfer: { files: [], types: ['Files'] } })
    expect(container.querySelector('.composer.dropping')).toBeNull()
  })

  it('★拖文字不接管 —— 那是原生的「拖一段话进输入框」,接管了反而弄坏它', () => {
    const { ta } = setup()
    const e = fireEvent.dragOver(ta, { dataTransfer: { files: [], types: ['text/plain'], dropEffect: 'copy' } })
    expect(e).toBe(true)   // true = 没被 preventDefault
  })

  it('★只读 / 归档的会话不收附件,但**照样要拦住导航**', async () => {
    for (const props of [{ readOnly: true }, { archived: true }]) {
      const { box, chips } = setup(props)
      expect(fileDrop(box, [realFile('a.txt', '/tmp/a.txt')]), '没拦住 → 白屏').toBe(false)
      await Promise.resolve()
      expect(chips()).toHaveLength(0)
      expect(fileDragOver(box).dropEffect, '光标该显示「不能放」').toBe('none')
    }
  })

  it('★★窗口兜底装上之后,输入框上仍然显示「可以放」—— 兜底会把 dropEffect 抹成 none,所以这里必须 stopPropagation', () => {
    const off = installDropGuard()
    try {
      const { box } = setup()
      expect(fileDragOver(box).dropEffect).toBe('copy')
    } finally { off() }
  })

  it('★拖过输入框里的子元素不能把高亮弄灭 —— enter/leave 是配对来的,只看 leave 就会一路闪', () => {
    const { box, ta, container } = setup()
    const dt = { dataTransfer: { files: [], types: ['Files'] } }
    fireEvent.dragEnter(box, dt)
    fireEvent.dragEnter(ta, dt)     // 从框飘到里面的 textarea 上
    fireEvent.dragLeave(box, dt)    // 浏览器此时给 box 发的 leave
    expect(container.querySelector('.composer.dropping'), '还悬在框里就灭了').toBeTruthy()
  })

  it('preload 没有 filePath(旧客户端 / 手机)也不能炸,退回存盘那条路', async () => {
    ;(window as any).forge.filePath = undefined
    const { box, chips } = setup()
    fileDrop(box, [realFile('a.png', '/tmp/a.png')])
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(onPaste).toHaveBeenCalledTimes(1)
  })
})
