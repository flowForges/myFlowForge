import { describe, it, expect } from 'vitest'
import { sanitize, notifFromLifecycle } from './notifications'

describe('notification sanitize', () => {
  it('strips tags/entities so agent-supplied names cannot inject HTML', () => {
    expect(sanitize('<img src=x onerror=alert(1)>开发代理')).toBe('开发代理')
    expect(sanitize('a<b>&"\'')).toBe('a&amp;&quot;&#39;')
  })
})

describe('notifFromLifecycle', () => {
  it('stalled -> warn notif, sanitized agent name, unread', () => {
    const n = notifFromLifecycle({ kind: 'stalled', agentName: '<img src=x onerror=alert(1)>dev', wsName: 'ws', silentMs: 90_000 })
    expect(n.ic).toBe('warn')
    expect(n.unread).toBe(true)
    expect(n.t).not.toContain('<img')
    expect(n.t).not.toContain('onerror')
    expect(n.t).toContain('dev')
  })

  it('run-done -> ok notif; failed -> warn; awaiting -> warn', () => {
    expect(notifFromLifecycle({ kind: 'run-done', agentName: 'x', wsName: 'ws' }).ic).toBe('ok')
    expect(notifFromLifecycle({ kind: 'failed', agentName: 'x', wsName: 'ws' }).ic).toBe('warn')
    expect(notifFromLifecycle({ kind: 'awaiting', agentName: 'x', wsName: 'ws' }).ic).toBe('warn')
  })

  it('carries jump-to-source route (wsPath/wsName) onto the notif', () => {
    const n = notifFromLifecycle({ kind: 'run-done', agentName: 'x', wsName: 'blog', wsPath: '/w/blog' })
    expect(n.wsPath).toBe('/w/blog')
    expect(n.wsName).toBe('blog')
  })
})
