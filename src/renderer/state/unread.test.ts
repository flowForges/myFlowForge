import { describe, it, expect } from 'vitest'
import { markUnread, clearUnread, isSessionUnread, workspaceHasUnread } from './unread'

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
