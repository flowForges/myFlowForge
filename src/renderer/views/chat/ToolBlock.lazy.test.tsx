import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { ToolBlock } from './ToolBlock'
import { ToolOutputCtx } from './toolOutput'
import type { ToolActivity } from '@shared/types'

// 2026-10-03:打开会话慢的另一半 —— 实测用户那个 1.2MB 的真会话里 **90% 的字节是工具输出**,
// 而这些卡默认是折叠的,下载下来只为了藏起来。现在大段输出不跟着历史下发(`outputOmitted`),
// 点开那一行时才单独去取。手机端 2026-09-04 就是这么做的,电脑端当初特意没动。
const inline: ToolActivity = { id: 't1', title: '调用 Read a.ts', status: 'ok', output: '短输出' }
const omitted: ToolActivity = { id: 't2', title: '调用 Bash: npm test', status: 'ok', outputOmitted: true, outputLines: 5291 }

const click = (el: HTMLElement) => act(async () => { fireEvent.click(el) })

const withCtx = (load: (m: string, t: string) => Promise<string>, tools: ToolActivity[] = [omitted]) =>
  render(
    <ToolOutputCtx.Provider value={{ load }}>
      <ToolBlock tools={tools} stateKey="m1" messageId="m1" />
    </ToolOutputCtx.Provider>,
  )

describe('ToolBlock — 大段工具输出按需取', () => {
  it('没被省略的输出照旧内联显示,不去取', async () => {
    const load = vi.fn()
    withCtx(load, [inline])
    await click(screen.getByRole('button', { name: /调用 Read a.ts/ }))
    expect(screen.getByText('短输出')).toBeTruthy()
    expect(load).not.toHaveBeenCalled()
  })

  it('★被省略的那条仍然点得开(不能是灰的),点开后把全文取回来显示', async () => {
    const load = vi.fn().mockResolvedValue('第一行\n第二行')
    withCtx(load)
    const head = screen.getByRole('button', { name: /调用 Bash/ })
    expect((head as HTMLButtonElement).disabled).toBe(false)
    await click(head)
    await waitFor(() => expect(screen.getByText(/第一行/)).toBeTruthy())
    expect(load).toHaveBeenCalledWith('m1', 't2')
  })

  it('取的过程中说一声,不要空着一片让人以为没输出', async () => {
    let release: (v: string) => void = () => {}
    const load = vi.fn(() => new Promise<string>(r => { release = r }))
    withCtx(load)
    await click(screen.getByRole('button', { name: /调用 Bash/ }))
    expect(screen.getByText(/正在取/)).toBeTruthy()
    release('好了')
    await waitFor(() => expect(screen.getByText('好了')).toBeTruthy())
  })

  it('★取失败要**说出来**并且能重试 —— 不能静默空白(那和「这条没有输出」长得一样)', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('第二次成功了')
    withCtx(load)
    const head = screen.getByRole('button', { name: /调用 Bash/ })
    await click(head)
    await waitFor(() => expect(screen.getByText(/没取到/)).toBeTruthy())
    await click(screen.getByRole('button', { name: /重试/ }))
    await waitFor(() => expect(screen.getByText('第二次成功了')).toBeTruthy())
  })

  it('折叠再展开不会重复去取(取回来的留着)', async () => {
    const load = vi.fn().mockResolvedValue('只取一次')
    withCtx(load)
    const head = screen.getByRole('button', { name: /调用 Bash/ })
    await click(head)
    await waitFor(() => expect(screen.getByText('只取一次')).toBeTruthy())
    await click(head)   // 收起
    await click(head)   // 再展开
    await waitFor(() => expect(screen.getByText('只取一次')).toBeTruthy())
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('★没有 ctx(测试/别的面板)时说明情况,而不是装作这条没有输出', async () => {
    render(<ToolBlock tools={[omitted]} stateKey="m1" messageId="m1" />)
    const head = screen.getByRole('button', { name: /调用 Bash/ })
    expect((head as HTMLButtonElement).disabled).toBe(false)
    await click(head)
    expect(screen.getByText(/取不到/)).toBeTruthy()
  })

  it('取回来是空字符串:说「没有输出」,不要显示成一直在取', async () => {
    const load = vi.fn().mockResolvedValue('')
    withCtx(load)
    await click(screen.getByRole('button', { name: /调用 Bash/ }))
    await waitFor(() => expect(screen.getByText(/没有输出/)).toBeTruthy())
  })

  it('★展开着的那一行后来变成「省略」(收尾那条带着大段输出)→ 自己去取,不能停在「正在取…」', async () => {
    const load = vi.fn().mockResolvedValue('收尾的全文')
    const running: ToolActivity = { id: 't3', title: '调用 Bash: make', status: 'run', output: '前几行' }
    const ui = (tool: ToolActivity) => (
      <ToolOutputCtx.Provider value={{ load }}>
        <ToolBlock tools={[tool]} stateKey="m3" messageId="m3" />
      </ToolOutputCtx.Provider>
    )
    const { rerender } = render(ui(running))
    await click(screen.getByRole('button', { name: /调用 Bash: make/ }))
    expect(screen.getByText('前几行')).toBeTruthy()
    await act(async () => { rerender(ui({ id: 't3', title: '调用 Bash: make', status: 'ok', outputOmitted: true, outputLines: 9000 })) })
    await waitFor(() => expect(screen.getByText('收尾的全文')).toBeTruthy())
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith('m3', 't3')
  })
})
