// src/renderer/views/chat/ChatJumpRail.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ChatJumpRail } from './ChatJumpRail'
import { railCapacity } from './jumpRailLayout'
import { fmtMsgTime } from '@shared/relTime'
import type { ChatMessage } from '@shared/types'

// A minimal stand-in for the .chat-scroll element. jsdom has no layout, so we
// fabricate geometry + a querySelector that returns nodes with offsetTop.
function fakeScroll(targets: Record<string, { offsetTop: number; node: HTMLElement }>) {
  return {
    scrollTop: 0,
    scrollHeight: 2000,
    clientHeight: 800,
    scrollTo: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: (sel: string) => {
      const m = sel.match(/data-user-msg="(\d+)"/)
      const hit = m ? targets[m[1]] : undefined
      if (!hit) return null
      // emulate offsetTop (read-only in real DOM) on the returned node
      Object.defineProperty(hit.node, 'offsetTop', { value: hit.offsetTop, configurable: true })
      return hit.node
    },
  } as unknown as HTMLDivElement
}

const twoUsers: ChatMessage[] = [
  { id: 'a', who: 'user', text: '  第一条   需求  ', ts: '2026-06-28T09:10:00.000Z' },
  { id: 'b', who: 'ai', text: '好的', ts: '2026-06-28T09:10:05.000Z' },
  { id: 'c', who: 'user', text: '再加个功能', ts: '2026-06-28T09:11:00.000Z' },
]

describe('ChatJumpRail', () => {
  it('hides the rail (no .on, no dots) with one or zero user messages', () => {
    const ref = { current: fakeScroll({}) }
    const { container } = render(<ChatJumpRail messages={[twoUsers[0], twoUsers[1]]} scrollRef={ref as any} />)
    const rail = container.querySelector('.chat-jump-rail')!
    expect(rail.classList.contains('on')).toBe(false)
    expect(container.querySelectorAll('.chat-jump-dot').length).toBe(0)
  })

  it('renders one dot per user message with collapsed/normalized preview + HH:MM label', () => {
    const ref = { current: fakeScroll({}) }
    const { container } = render(<ChatJumpRail messages={twoUsers} scrollRef={ref as any} />)
    const rail = container.querySelector('.chat-jump-rail')!
    expect(rail.classList.contains('on')).toBe(true)
    const dots = container.querySelectorAll('.chat-jump-dot')
    expect(dots.length).toBe(2)
    expect(Array.from(dots).map(d => d.getAttribute('data-jump-msg'))).toEqual(['0', '2'])
    // whitespace collapsed in preview text
    expect(dots[0].querySelector('.jp-t')!.textContent).toBe('第一条 需求')
    // label uses fmtMsgTime (HH:MM for same-day)
    expect(dots[0].querySelector('.jp-k')!.textContent).toBe(fmtMsgTime(twoUsers[0].ts!, Date.now()))
  })

  it('truncates preview text to 90 chars with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const msgs: ChatMessage[] = [
      { id: 'a', who: 'user', text: long, ts: '2026-06-28T09:10:00.000Z' },
      { id: 'b', who: 'user', text: 'y', ts: '2026-06-28T09:11:00.000Z' },
    ]
    const ref = { current: fakeScroll({}) }
    const { container } = render(<ChatJumpRail messages={msgs} scrollRef={ref as any} />)
    const t = container.querySelector('.jp-t')!.textContent!
    expect(t.endsWith('…')).toBe(true)
    expect(t.length).toBe(91) // 90 chars + ellipsis
  })

  it('click scrolls to the target user message and flashes it', () => {
    const node = document.createElement('div')
    const ref = { current: fakeScroll({ '2': { offsetTop: 640, node } }) }
    const { container } = render(<ChatJumpRail messages={twoUsers} scrollRef={ref as any} />)
    const secondDot = container.querySelectorAll('.chat-jump-dot')[1]
    fireEvent.click(secondDot)
    expect((ref.current as any).scrollTo).toHaveBeenCalledWith({ top: 622, behavior: 'smooth' }) // 640-18
    expect(node.classList.contains('jump-flash')).toBe(true)
  })
})

describe('ChatJumpRail · 对话很多时合并锚点', () => {
  const many = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `u${i}`, who: 'user' as const, text: `第 ${i + 1} 条需求`, ts: '2026-08-31T09:10:00.000Z',
    }))

  const targetsFor = (msgs: ChatMessage[]) =>
    Object.fromEntries(msgs.map((_, i) => [String(i), { offsetTop: i * 400, node: document.createElement('div') }]))

  it('★★300 条对话时锚点数被封顶 —— 否则轨道 3000px 高,超出屏幕的那些根本点不到', () => {
    const msgs = many(300)
    // jsdom 里 offsetParent 是 null,所以回落到 clientHeight=800 那条路。
    // ★用同一个函数算期望值,不写死数字 —— 写死的话改了容量公式这条会假红,
    //  而它真正要钉的是「有没有封顶」,不是「封在几」。
    const { container } = render(<ChatJumpRail messages={msgs} scrollRef={{ current: fakeScroll(targetsFor(msgs)) }} />)
    const dots = container.querySelectorAll('.chat-jump-dot')
    expect(dots.length).toBe(railCapacity(800))
    expect(dots.length).toBeLessThan(300)
  })

  it('★条数没超上限时严格一条一个,和以前一模一样', () => {
    const msgs = many(20)
    const { container } = render(<ChatJumpRail messages={msgs} scrollRef={{ current: fakeScroll(targetsFor(msgs)) }} />)
    expect(container.querySelectorAll('.chat-jump-dot')).toHaveLength(20)
    // 单条的组不显示「N 条」—— 多一个「1 条」是纯噪音。
    // ★只看标签那一段(.jp-k):正文里本来就有「第 1 条需求」,拿整段 textContent 判会误报。
    const heads = [...container.querySelectorAll('.jp-k')].map(e => e.textContent ?? '')
    expect(heads.some(h => h.includes('条'))).toBe(false)
  })

  it('合并之后每个锚点标明它盖了几条,而且仍然指得回原消息', () => {
    const msgs = many(300)
    const { container } = render(<ChatJumpRail messages={msgs} scrollRef={{ current: fakeScroll(targetsFor(msgs)) }} />)
    const heads = [...container.querySelectorAll('.jp-k')].map(e => e.textContent ?? '')
    expect(heads.some(h => /· \d+ 条$/.test(h))).toBe(true)
    // 第一个锚点仍然指向第 0 条(组首),点它能跳
    expect(container.querySelector('.chat-jump-dot')?.getAttribute('data-jump-msg')).toBe('0')
  })

  it('★条数超上限时,每一条仍然被某个锚点覆盖(无障碍标签把区间说清楚)', () => {
    const msgs = many(300)
    const { container } = render(<ChatJumpRail messages={msgs} scrollRef={{ current: fakeScroll(targetsFor(msgs)) }} />)
    const labels = [...container.querySelectorAll('.chat-jump-dot')].map(d => d.getAttribute('aria-label') ?? '')
    // 第一组从第 1 条起
    expect(labels[0]).toMatch(/^跳到第 1 /)
    // 最后一组盖到第 300 条
    expect(labels[labels.length - 1]).toMatch(/300 条用户输入$/)
  })
})
