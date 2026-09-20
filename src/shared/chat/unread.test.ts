import { describe, it, expect } from 'vitest'
import { markUnread, clearUnread, isSessionUnread, isViewingSession, workspaceHasUnread } from './unread'

const viewing = (wsPath: string, sessionId: string) => ({ wsPath, sessionId })

describe('unread session tracking', () => {
  it('marks a finished session unread when the user is elsewhere', () => {
    const s = markUnread(new Set(), '/w/a', 's1', viewing('/w/b', 's9'))
    expect(isSessionUnread(s, '/w/a', 's1')).toBe(true)
  })

  it('does NOT mark unread when the user is already viewing that session', () => {
    const s = markUnread(new Set(), '/w/a', 's1', viewing('/w/a', 's1'))
    expect(isSessionUnread(s, '/w/a', 's1')).toBe(false)
  })

  it('marks unread when in the same workspace but a different session', () => {
    const s = markUnread(new Set(), '/w/a', 's1', viewing('/w/a', 's2'))
    expect(isSessionUnread(s, '/w/a', 's1')).toBe(true)
  })

  it('workspaceHasUnread is true if any of its sessions is unread', () => {
    const s = markUnread(new Set(), '/w/a', 's1', viewing('/w/b', 's9'))
    expect(workspaceHasUnread(s, '/w/a')).toBe(true)
    expect(workspaceHasUnread(s, '/w/b')).toBe(false)
  })

  it('clearing a session removes only that session', () => {
    let s = markUnread(new Set(), '/w/a', 's1', viewing('/w/b', 's9'))
    s = markUnread(s, '/w/a', 's2', viewing('/w/b', 's9'))
    s = clearUnread(s, '/w/a', 's1')
    expect(isSessionUnread(s, '/w/a', 's1')).toBe(false)
    expect(isSessionUnread(s, '/w/a', 's2')).toBe(true)
    expect(workspaceHasUnread(s, '/w/a')).toBe(true)
  })

  it('does not confuse workspaces whose paths share a prefix', () => {
    const s = markUnread(new Set(), '/w/app', 's1', viewing('/x', 'z'))
    expect(workspaceHasUnread(s, '/w/ap')).toBe(false)
  })
})

// 「此刻屏幕上是不是正是这条」现在有**两个**用处:markUnread 用它跳过标记,两端的 hook 用它
// 决定要不要广播 chat:mark-seen(一轮在你开着页面时跑完,本机不标未读,但必须告诉别的设备)。
// 两处共用一份,是为了不让「你在看」这件事在两个地方给出两个答案。
describe('isViewingSession', () => {
  it('两个字段都对上才算「正在看」', () => {
    expect(isViewingSession(viewing('/w/a', 's1'), '/w/a', 's1')).toBe(true)
  })
  it('同一个区、另一条会话 → 不算', () => {
    expect(isViewingSession(viewing('/w/a', 's2'), '/w/a', 's1')).toBe(false)
  })
  it('同一个会话 id、另一个区 → 不算(sessionId 在不同区里会重名)', () => {
    expect(isViewingSession(viewing('/w/b', 's1'), '/w/a', 's1')).toBe(false)
  })
  it('首页(两个空串)→ 不算在看任何东西', () => {
    expect(isViewingSession(viewing('', ''), '/w/a', 's1')).toBe(false)
  })
})
