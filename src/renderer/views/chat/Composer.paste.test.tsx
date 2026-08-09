import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, waitFor } from '@testing-library/react'
import { Composer } from './Composer'
import type { Attachment, ProviderInfo } from '@shared/types'
import { PASTE_OFFLOAD_THRESHOLD } from './largePaste'

// 大段粘贴 → 转文件附件那条路。阈值本轮从 10000 降到 2000,这条路的触发频率涨了约 5 倍,
// 所以「存盘期间用户接着打字」不再是理论情形。
const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'opus' }] },
]
const BIG = 'x'.repeat(PASTE_OFFLOAD_THRESHOLD + 10)
const ATT: Attachment = { name: 'pasted-1.txt', path: '/tmp/pasted-1.txt', size: 2010 }

beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn() } })

function setup(onPaste: (f: { name: string; dataBase64: string }) => Promise<Attachment | null>) {
  const { container } = render(
    <Composer providers={providers} disabled={false} onSend={() => {}} onPaste={onPaste} />,
  )
  const ta = container.querySelector('textarea') as HTMLTextAreaElement
  return { ta }
}

function pasteBig(ta: HTMLTextAreaElement) {
  fireEvent.paste(ta, { clipboardData: { getData: () => BIG, files: [] } })
}

describe('Composer 大段粘贴转附件', () => {
  it('存盘期间用户继续打的字不会被回滚(用最新正文插占位符,不是陈旧闭包)', async () => {
    let resolvePaste!: (a: Attachment | null) => void
    const onPaste = vi.fn(() => new Promise<Attachment | null>(r => { resolvePaste = r }))
    const { ta } = setup(onPaste)

    fireEvent.change(ta, { target: { value: '先看这个报错' } })
    ta.selectionStart = ta.selectionEnd = 6
    pasteBig(ta)
    expect(onPaste).toHaveBeenCalled()

    // 存盘还没回来,用户接着往后打字
    fireEvent.change(ta, { target: { value: '先看这个报错，顺便帮我看下配置' } })

    await act(async () => { resolvePaste(ATT); await Promise.resolve() })

    // 等待期间敲的「，顺便帮我看下配置」必须还在(陈旧闭包会把它整段回滚掉),
    // 占位符插在粘贴那一刻的光标处。
    expect(ta.value).toBe('先看这个报错 [pasted-1.txt] ，顺便帮我看下配置')
  })

  it('等待期间在插入点【之前】改了字 → 占位符退到末尾,一个字都不丢', async () => {
    let resolvePaste!: (a: Attachment | null) => void
    const onPaste = vi.fn(() => new Promise<Attachment | null>(r => { resolvePaste = r }))
    const { ta } = setup(onPaste)

    fireEvent.change(ta, { target: { value: 'abc' } })
    ta.selectionStart = ta.selectionEnd = 3
    pasteBig(ta)
    // 光标跳回开头插了两个字 → 旧下标 3 已经指向别的位置
    fireEvent.change(ta, { target: { value: 'XYabc' } })

    await act(async () => { resolvePaste(ATT); await Promise.resolve() })

    expect(ta.value).toBe('XYabc [pasted-1.txt]')
  })

  it('立刻回来(用户没插手)时占位符就在光标处,选中的那段被替换掉', async () => {
    const onPaste = vi.fn(async () => ATT)
    const { ta } = setup(onPaste)

    fireEvent.change(ta, { target: { value: '保留XXXX保留' } })
    ta.selectionStart = 2
    ta.selectionEnd = 6
    await act(async () => { pasteBig(ta); await Promise.resolve() })

    expect(ta.value).toBe('保留 [pasted-1.txt] 保留')
  })

  it('★ 存盘失败(onPaste 返回 null)时把原文插回正文 —— 内容绝不能凭空消失', async () => {
    const onPaste = vi.fn(async () => null)
    const { ta } = setup(onPaste)

    fireEvent.change(ta, { target: { value: '前' } })
    ta.selectionStart = ta.selectionEnd = 1
    await act(async () => { pasteBig(ta); await Promise.resolve() })

    // preventDefault 已经把原生粘贴吃掉了,不补的话这里会是「前」——用户粘的两千字没了。
    expect(ta.value).toBe('前' + BIG)
    expect(ta.value).toContain(BIG)
  })

  it('★ 存盘 IPC reject(盘满/无权限)时也把原文插回正文 —— 跟返回 null 走同一条兜底,内容不会凭空消失', async () => {
    const onPaste = vi.fn(() => Promise.reject(new Error('ENOSPC: no space left on device')))
    const { ta } = setup(onPaste)

    fireEvent.change(ta, { target: { value: '前' } })
    ta.selectionStart = ta.selectionEnd = 1
    await act(async () => { pasteBig(ta); await Promise.resolve() })

    // preventDefault 已经吃掉了原生粘贴;若 reject 没被接住,这里会停在「前」——两千多字凭空消失。
    expect(ta.value).toBe('前' + BIG)
    expect(ta.value).toContain(BIG)
  })

  it('小段粘贴照旧走原生行为,不转文件也不动正文', async () => {
    const onPaste = vi.fn(async () => ATT)
    const { ta } = setup(onPaste)
    fireEvent.change(ta, { target: { value: 'hi' } })
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: { getData: () => 'short', files: [] } })
      await Promise.resolve()
    })
    expect(onPaste).not.toHaveBeenCalled()
    expect(ta.value).toBe('hi')
  })
})

// ---- 图片/文件粘贴 ----------------------------------------------------------
// 大文本粘贴一直会在正文留 [文件名] 占位(不留就分不清三个附件各指哪句话),但文件粘贴走的是另一条
// 分支,只 push 附件、从不插占位 —— 用户粘三张图后完全不知道哪张对应哪句话。这组测试守住两条路同形。

function fileOf(name: string, type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}
// FileReader.onload 走的是宏任务,冲微任务(await Promise.resolve())冲不掉它 —— 必须等真实的 tick。
function pasteFiles(ta: HTMLTextAreaElement, files: File[]) {
  fireEvent.paste(ta, { clipboardData: { getData: () => '', files } })
}

describe('Composer 图片粘贴', () => {
  it('粘一张图:正文留下占位符,chip 也在', async () => {
    const onPaste = vi.fn(async (f: { name: string }) => ({ name: f.name, path: `/tmp/${f.name}`, size: 3 }))
    const { ta } = setup(onPaste as never)

    fireEvent.change(ta, { target: { value: '首页图要换' } })
    ta.selectionStart = ta.selectionEnd = 5
    pasteFiles(ta, [fileOf('image.png')])
    await waitFor(() => expect(onPaste).toHaveBeenCalled())

    // 剪贴板通用名被改成 img-时分秒
    const name = (onPaste.mock.calls[0][0] as { name: string }).name
    expect(name).toMatch(/^img-\d{6}\.png$/)
    await waitFor(() => expect(ta.value).toBe(`首页图要换 [${name}]`))
  })

  it('★ 粘三张图 → 三个不同占位符,顺序与 chip 一致(这正是「不知道图是哪句话的」那个 bug)', async () => {
    // 主进程遇到重名会改名(见 uniqueAttachmentName),这里模拟它:第二、三次带 -2/-3 回来。
    let n = 0
    const onPaste = vi.fn(async (f: { name: string }) => {
      n++
      const name = n === 1 ? f.name : f.name.replace(/\.png$/, `-${n}.png`)
      return { name, path: `/tmp/${name}`, size: 3 }
    })
    const { ta } = setup(onPaste as never)

    pasteFiles(ta, [fileOf('image.png'), fileOf('image.png'), fileOf('image.png')])
    await waitFor(() => expect(onPaste).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(ta.value).not.toBe(''))

    const names = onPaste.mock.results.map(r => (r.value as Promise<{ name: string }>))
    const resolved = await Promise.all(names)
    expect(new Set(resolved.map(a => a.name)).size).toBe(3)
    for (const a of resolved) expect(ta.value).toContain(`[${a.name}]`)
    // 占位符顺序 = 粘贴顺序
    const idx = resolved.map(a => ta.value.indexOf(a.name))
    expect(idx).toEqual([...idx].sort((x, y) => x - y))
  })

  it('★ 占位符用主进程返回的名字,不是本地生成的 —— 主进程可能因重名改过名', async () => {
    const onPaste = vi.fn(async () => ({ name: 'img-210455-2.png', path: '/tmp/x.png', size: 3 }))
    const { ta } = setup(onPaste as never)
    pasteFiles(ta, [fileOf('image.png')])
    await waitFor(() => expect(ta.value).toBe('[img-210455-2.png]'))
  })

  it('用户自己起名的文件原样保留,不被改成 img-时分秒', async () => {
    const onPaste = vi.fn(async (f: { name: string }) => ({ name: f.name, path: `/tmp/${f.name}`, size: 3 }))
    const { ta } = setup(onPaste as never)
    pasteFiles(ta, [fileOf('hook.jpg', 'image/jpeg')])
    await waitFor(() => expect(ta.value).toBe('[hook.jpg]'))
    expect((onPaste.mock.calls[0][0] as { name: string }).name).toBe('hook.jpg')
  })

  it('存盘失败(返回 null)时不插占位符 —— 没有附件的占位符是在骗 agent', async () => {
    const onPaste = vi.fn(async () => null)
    const { ta } = setup(onPaste as never)
    fireEvent.change(ta, { target: { value: '正文' } })
    pasteFiles(ta, [fileOf('image.png')])
    await waitFor(() => expect(onPaste).toHaveBeenCalled())
    expect(ta.value).toBe('正文')
  })

  it('图片 chip 显示缩略图,非图片附件仍是通用文件图标', async () => {
    const onPaste = vi.fn(async (f: { name: string }) => ({ name: f.name, path: `/tmp/${f.name}`, size: 3 }))
    const { container } = render(
      <Composer providers={providers} disabled={false} onSend={() => {}} onPaste={onPaste as never} />,
    )
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    pasteFiles(ta, [fileOf('image.png'), fileOf('notes.txt', 'text/plain')])
    await waitFor(() => expect(container.querySelectorAll('.attach-chip').length).toBe(2))
    expect(container.querySelectorAll('.attach-thumb').length).toBe(1)
  })
})
