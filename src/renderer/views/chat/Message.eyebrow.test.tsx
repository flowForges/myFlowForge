import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Message } from './Message'

/**
 * 「回答」这枚标记什么时候该在。
 *
 * ★★结论落地之后它就是纯噪音:一条消息读完了,再挂一枚 accent 色 + 底色 + 边框 + 药丸圆角 +
 *  两条动画的标签,只为了说「下面是回答」—— 而这件事**位置已经说清楚了**(过程在轨道里,
 *  正文从轨道外重新起头)。它是 2026-09-07 那张截图里最抢眼的东西之一,而它一个字的信息量都没有。
 * ★生成中**要留**:那时它说的是「还在写」,是真信息。但降成一行 10px 的灰字 + 一个脉冲点,
 *  不再是一枚发光药丸。
 */
const ai = (over: Record<string, unknown> = {}) =>
  ({ id: 'a', who: 'ai', text: '结论是这样。', ...over }) as never

describe('「回答」标记', () => {
  it('★结论落地后整枚消失 —— 一个像素都不占', () => {
    const { container } = render(<Message msg={ai()} streaming={false} />)
    // ★三条都要断:老药丸、老文案、**以及新的那一行**。只断前两条的话,把渲染条件从
    //  `showAnswer && streaming` 放宽回 `showAnswer`,测试照样全绿(变异验证时真的漏过一次)——
    //  因为新的一行写的是「回答中」,既不叫 .ans-eyebrow 也不叫「回答」。
    expect(container.querySelector('.ans-live'), '静止的消息上还挂着状态行').toBeNull()
    expect(screen.queryByText('回答')).toBeNull()
    expect(screen.queryByText('回答中')).toBeNull()
    expect(container.querySelector('.ans-eyebrow')).toBeNull()
  })

  it('★生成中还在,因为那时它说的是「还在写」', () => {
    render(<Message msg={ai()} streaming />)
    expect(screen.getByText('回答中')).toBeInTheDocument()
  })

  it('★生成中那一枚不再是药丸 —— 换成安静的一行', () => {
    const { container } = render(<Message msg={ai()} streaming />)
    expect(container.querySelector('.ans-eyebrow'), '还是老药丸').toBeNull()
    expect(container.querySelector('.ans-live')).toBeTruthy()
  })

  it('正文和光标不受影响', () => {
    const { container } = render(<Message msg={ai()} streaming />)
    expect(container.querySelector('.msg-body.ans')).toBeTruthy()
    expect(container.querySelector('.msg-body .pending')).toBeTruthy()
  })
})
