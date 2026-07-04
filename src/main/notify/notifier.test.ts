import { describe, it, expect } from 'vitest'
import { shouldNotify, buildNotification, type NotifyCfg } from './notifier'

const cfg = (over: Partial<NotifyCfg> = {}): NotifyCfg =>
  ({ enabled: true, confirm: true, input: true, done: false, ...over })

describe('shouldNotify', () => {
  it('never fires while the app window is focused (you are already looking)', () => {
    expect(shouldNotify('confirm', cfg(), true)).toBe(false)
  })
  it('fires for an enabled type when unfocused', () => {
    expect(shouldNotify('confirm', cfg(), false)).toBe(true)
  })
  it('is suppressed by the master switch', () => {
    expect(shouldNotify('confirm', cfg({ enabled: false }), false)).toBe(false)
  })
  it('respects the per-type switch (done off by default)', () => {
    expect(shouldNotify('done', cfg(), false)).toBe(false)
    expect(shouldNotify('done', cfg({ done: true }), false)).toBe(true)
  })
})

describe('buildNotification', () => {
  it('titles by workspace + kind and carries the route', () => {
    const n = buildNotification({
      type: 'confirm', workspaceName: 'blog', workspacePath: '/w/blog', sessionId: 's1',
      text: '是否允许写入 src/index.ts?',
    })
    expect(n.title).toBe('blog · 需要确认')
    expect(n.body).toBe('是否允许写入 src/index.ts?')
    expect(n.route).toEqual({ workspacePath: '/w/blog', sessionId: 's1' })
  })
  it('uses the plain kind label when no workspace name', () => {
    const n = buildNotification({ type: 'input', workspaceName: '', workspacePath: '/w', text: '请输入分支名' })
    expect(n.title).toBe('需要输入')
  })
  it('collapses whitespace and truncates a long body', () => {
    const n = buildNotification({
      type: 'done', workspaceName: 'x', workspacePath: '/w',
      text: '行一\n\n  行二   有很多空白\t结束' + ' 尾'.repeat(200),
    })
    expect(n.body).not.toContain('\n')
    expect(n.body.length).toBeLessThanOrEqual(181) // 180 + 省略号
    expect(n.body.endsWith('…')).toBe(true)
  })
  it('falls back to a default body when text is empty', () => {
    const n = buildNotification({ type: 'done', workspaceName: 'x', workspacePath: '/w', text: '   ' })
    expect(n.body.length).toBeGreaterThan(0)
  })
})
