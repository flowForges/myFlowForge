import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import { markUnread } from '../state/unread'
import type { ChatSession } from '@shared/types'

// 侧栏两处「时间 / 未读」的渲染契约。两者都不是新功能,但都只在 Sidebar 内部有断言 —— 数据是怎么送到这里
// 的(见 useSessionsMulti / useUnread)之前没有覆盖,恰恰是出问题的那一段。

const wsId = '/ws'
const sessions: ChatSession[] = [
  { id: 's1', title: '会话一', mode: 'chat', createdAt: 0 },
  { id: 's2', title: '会话二', mode: 'chat', createdAt: 0 },
]

const renderSidebar = (opts: { sessions: ChatSession[]; unread?: Set<string>; expanded?: boolean }) =>
  render(
    <Sidebar
      groups={[{ key: 'g', label: '最近', items: [{ id: wsId, name: '工作区', sub: '', status: 'wait' }] }]}
      activeId={wsId}
      onSelect={() => {}}
      onNew={() => {}}
      collapsed={false}
      sessions={opts.sessions}
      activeSessionId="s1"
      onSwitchSession={() => {}}
      onCloseSession={() => {}}
      onRenameSession={() => {}}
      onNewSession={() => {}}
      expandedIds={new Set(opts.expanded === false ? [] : [wsId])}
      sessionsByWs={{ [wsId]: opts.sessions }}
      unread={opts.unread}
    />
  )

// 用 markUnread 现造集合,而不是手写 `${ws}${分隔符}${sid}` —— key 的分隔符是 NUL,手写极易写成空格,
// 那样测试失败的是测试自己而不是被测代码(第一版就踩了这个)。
const unreadOf = (sessionId: string): Set<string> =>
  markUnread(new Set(), wsId, sessionId, { wsPath: '', sessionId: '' })

describe('侧栏未读圆点', () => {
  it('展开时,未读的那个会话带圆点,其它不带', () => {
    const { container } = renderSidebar({ sessions, unread: unreadOf('s2') })
    const rows = container.querySelectorAll('.ws-sess')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.ws-unread')).toBeNull()
    expect(rows[1].querySelector('.ws-unread')).toBeTruthy()
  })
  it('收起时,未读上浮成工作区级圆点', () => {
    const { container } = renderSidebar({ sessions, unread: unreadOf('s2'), expanded: false })
    expect(container.querySelector('.ws-unread')).toBeTruthy()
  })
  it('没有未读时不画圆点', () => {
    const { container } = renderSidebar({ sessions, unread: new Set() })
    expect(container.querySelector('.ws-unread')).toBeNull()
  })
})

describe('侧栏会话时间', () => {
  const timeOf = (c: HTMLElement, i: number): string =>
    c.querySelectorAll('.ws-sess')[i].querySelector('.ws-sess-time')?.textContent ?? ''

  it('★ 有 lastMessageAt 时显示它,而不是创建时间', () => {
    const dayAgo = Date.now() - 26 * 3600_000
    const justNow = Date.now() - 30_000
    const { container } = renderSidebar({
      sessions: [{ id: 's1', title: '会话一', mode: 'chat', createdAt: dayAgo, lastMessageAt: justNow }],
    })
    // 创建于一天多前、但刚说过话 → 应显示「刚刚」这一档,而不是「1 天前」。
    expect(timeOf(container, 0)).not.toContain('天')
  })

  it('没有 lastMessageAt 才回落创建时间', () => {
    const dayAgo = Date.now() - 26 * 3600_000
    const { container } = renderSidebar({
      sessions: [{ id: 's1', title: '会话一', mode: 'chat', createdAt: dayAgo }],
    })
    expect(timeOf(container, 0)).toContain('天')
  })
})
