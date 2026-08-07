import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
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
