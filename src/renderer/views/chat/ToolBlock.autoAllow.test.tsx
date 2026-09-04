import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolBlock } from './ToolBlock'
import type { ToolActivity } from '@shared/types'

/**
 * 「这次是自动放行的」这枚标记,必须长在**工具卡那一行**上。
 *
 * ★★它以前是对话流里一条独立消息(`who:'ai'` + 「系统」头像 +「回答」标签),于是长得和模型的
 *  回答一模一样,还夹在工具卡和真正的回答中间。用户原话:「bash 的结果应该在 bash 的那个折叠里,
 *  不应该出现在 LLM 输出的内容界面啊」。
 */

const tool = (over: Partial<ToolActivity> = {}): ToolActivity =>
  ({ id: 't1', title: '调用 Bash', status: 'ok', output: 'ok', ...over })

const rowOf = (c: HTMLElement, id: string) =>
  [...c.querySelectorAll('.tool-row')].find(r => r.querySelector('.tool-title')?.textContent?.includes(id))!

describe('工具卡上的「自动放行」标记', () => {
  it('自动放行的那次带标记', () => {
    const { container } = render(<ToolBlock tools={[tool({ autoAllowed: true })]} />)
    expect(container.querySelector('.tool-auto')).toBeTruthy()
  })

  it('★没自动放行(门真弹过、人点的允许)就没有标记 —— 否则等于谎报「这条没问过你」', () => {
    const { container } = render(<ToolBlock tools={[tool()]} />)
    expect(container.querySelector('.tool-auto')).toBeNull()
  })

  it('★★一轮里混着的时候,只标该标的那几行', () => {
    const { container } = render(<ToolBlock tools={[
      tool({ id: 'a', title: '调用 Bash 甲', autoAllowed: true }),
      tool({ id: 'b', title: '调用 Bash 乙' }),
      tool({ id: 'c', title: '调用 Bash 丙', autoAllowed: true }),
    ]} />)
    expect(rowOf(container, '甲').querySelector('.tool-auto')).toBeTruthy()
    expect(rowOf(container, '乙').querySelector('.tool-auto')).toBeNull()
    expect(rowOf(container, '丙').querySelector('.tool-auto')).toBeTruthy()
  })

  it('★标记说得清是什么意思 —— 一个光秃秃的盾牌没人看得懂', () => {
    const { container } = render(<ToolBlock tools={[tool({ autoAllowed: true })]} />)
    const title = container.querySelector('.tool-auto')!.getAttribute('title') ?? ''
    expect(title).toContain('完全访问')
    expect(title).toContain('自动放行')
  })

  it('★它在标题那一行里,不是另起一行 —— 另起一行就又变成「一句话」了', () => {
    const { container } = render(<ToolBlock tools={[tool({ autoAllowed: true })]} />)
    expect(container.querySelector('.tool-head .tool-auto')).toBeTruthy()
  })

  it('展开仍然是工具自己的输出,标记不掺进去', () => {
    render(<ToolBlock tools={[tool({ autoAllowed: true, output: '一行输出' })]} />)
    // 折叠状态下输出不渲染;这里只确认标记没被塞进 output
    expect(screen.queryByText(/🛡/)).toBeTruthy()
    expect(screen.queryByText('一行输出')).toBeNull()
  })
})
