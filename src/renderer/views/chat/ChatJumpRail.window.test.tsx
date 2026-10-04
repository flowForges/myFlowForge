import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { createRef } from 'react'
import { ChatJumpRail } from './ChatJumpRail'
import type { ChatMessage } from '@shared/types'

// 2026-10-03:当前这条对话改成了「只渲染最近 N 条」(timelineWindow)。被窗口收起来的消息
// **没有对应的 DOM**,而轨道是靠 `[data-user-msg="<index>"]` 找元素滚动的 —— 还给它画锚点的话,
// 点下去什么也不会发生。静默失灵比「这里暂时没有锚点」更糟,所以轨道必须跟着窗口走。
const mk = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => ({
  id: `m${i}`, who: i % 2 === 0 ? 'user' : 'ai', text: `第 ${i} 条`, ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
})) as ChatMessage[]

const dots = (c: HTMLElement) => c.querySelectorAll('.chat-jump-rail button, .chat-jump-rail [role="button"]')

describe('ChatJumpRail — 跟着当前对话的渲染窗口走', () => {
  it('不给 fromIndex 时行为不变(全部用户消息都有锚点)', () => {
    const { container } = render(<ChatJumpRail messages={mk(10)} scrollRef={createRef<HTMLDivElement>()} />)
    expect(dots(container).length).toBe(5)   // 10 条里 5 条是用户消息
  })

  it('★给了 fromIndex:比它更早的用户消息不再画锚点', () => {
    const { container } = render(<ChatJumpRail messages={mk(10)} scrollRef={createRef<HTMLDivElement>()} fromIndex={6} />)
    expect(dots(container).length).toBe(2)   // 只剩 index 6、8 两条
  })

  it('fromIndex 把锚点压到 1 个以下时轨道整体关掉,不留半个空轨道', () => {
    const { container } = render(<ChatJumpRail messages={mk(10)} scrollRef={createRef<HTMLDivElement>()} fromIndex={9} />)
    expect(container.querySelector('.chat-jump-rail.on')).toBeNull()
  })
})
