import { describe, it, expect, vi } from 'vitest'
import { createGateNotifier } from './notifyBridge'
import type { BuiltNotification } from './notifier'
import type { NotifyCfg } from './notifier'

const ALL_ON: NotifyCfg = { enabled: true, confirm: true, input: true, done: true }

function harness(over: { cfg?: NotifyCfg; focused?: boolean } = {}) {
  const fired: BuiltNotification[] = []
  const observe = createGateNotifier({
    getCfg: () => over.cfg ?? ALL_ON,
    isFocused: () => over.focused ?? false,
    notify: (n) => fired.push(n),
    workspaceName: (p) => (p === '/ws' ? 'my-app' : ''),
  })
  return { observe, fired }
}

const confirmReq = (over: Record<string, unknown> = {}) => ({
  workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'c1', title: '要删掉 build/ 吗', ...over,
})

describe('createGateNotifier · 活着的那四路信号', () => {
  it('★权限门弹一条 —— 这条以前从来没弹过(老版本挂在已删掉的 pending:add 上)', () => {
    const h = harness()
    h.observe('chat:event', confirmReq())
    expect(h.fired).toHaveLength(1)
    expect(h.fired[0]!.title).toBe('my-app · 需要确认')
    expect(h.fired[0]!.body).toContain('要删掉 build/ 吗')
    expect(h.fired[0]!.route).toEqual({ workspacePath: '/ws', sessionId: 's1' })
  })

  it('权限门带位置时正文带上位置', () => {
    const h = harness()
    h.observe('chat:event', confirmReq({ where: '/repo/src' }))
    expect(h.fired[0]!.body).toContain('/repo/src')
  })

  it('代理提问归「需要输入」那一档', () => {
    const h = harness()
    h.observe('chat:event', confirmReq({ type: 'ask-request', id: 'a1', title: '用哪个端口?' }))
    expect(h.fired[0]!.title).toBe('my-app · 需要输入')
  })

  it('工作流阶段门归「需要确认」', () => {
    const h = harness()
    h.observe('run2:event', { workspacePath: '/ws', event: { id: 'g1', kind: 'gate', stageName: '技术方案' } })
    expect(h.fired[0]!.title).toBe('my-app · 需要确认')
    expect(h.fired[0]!.body).toContain('技术方案')
  })

  it('工作流泳道的四种问题都归「需要输入」', () => {
    for (const kind of ['question', 'auth', 'doubt', 'failure']) {
      const h = harness()
      h.observe('run2:event', { workspacePath: '/ws', event: { id: `x-${kind}`, kind, title: '要你拿主意' } })
      expect(h.fired, kind).toHaveLength(1)
      expect(h.fired[0]!.title).toBe('my-app · 需要输入')
    }
  })

  it('★不管 done —— index.ts 里已经有人接了,两边都接就会每次回复弹两条', () => {
    const h = harness()
    h.observe('chat:event', { workspacePath: '/ws', sessionId: 's1', type: 'done' })
    expect(h.fired).toHaveLength(0)
  })

  it('别的事件一概不弹', () => {
    const h = harness()
    h.observe('chat:event', confirmReq({ type: 'delta' }))
    h.observe('run2:event', { workspacePath: '/ws', event: { id: 'z', kind: 'answer' } })
    h.observe('run2:update', { workspacePath: '/ws', state: { status: 'running' } })
    h.observe('settings:changed', {})
    expect(h.fired).toHaveLength(0)
  })
})

describe('createGateNotifier · 开关和焦点', () => {
  it('app 在前台时不弹(你已经看见那道门了)', () => {
    const h = harness({ focused: true })
    h.observe('chat:event', confirmReq())
    expect(h.fired).toHaveLength(0)
  })

  it('总开关关掉时不弹', () => {
    const h = harness({ cfg: { ...ALL_ON, enabled: false } })
    h.observe('chat:event', confirmReq())
    expect(h.fired).toHaveLength(0)
  })

  it('★两个开关各管各的 —— 这正是以前那两个摆设开关', () => {
    const noConfirm = harness({ cfg: { ...ALL_ON, confirm: false } })
    noConfirm.observe('chat:event', confirmReq())
    noConfirm.observe('chat:event', confirmReq({ type: 'ask-request', id: 'a1' }))
    expect(noConfirm.fired).toHaveLength(1)
    expect(noConfirm.fired[0]!.title).toContain('需要输入')

    const noInput = harness({ cfg: { ...ALL_ON, input: false } })
    noInput.observe('chat:event', confirmReq())
    noInput.observe('chat:event', confirmReq({ type: 'ask-request', id: 'a1' }))
    expect(noInput.fired).toHaveLength(1)
    expect(noInput.fired[0]!.title).toContain('需要确认')
  })
})

describe('createGateNotifier · 去重与健壮性', () => {
  it('同一道门重复广播只弹一次', () => {
    const h = harness()
    h.observe('chat:event', confirmReq())
    h.observe('chat:event', confirmReq())
    expect(h.fired).toHaveLength(1)
  })

  it('答完之后同一个 id 又能弹(门可以再升起来)', () => {
    const h = harness()
    h.observe('chat:event', confirmReq())
    h.observe('chat:event', { workspacePath: '/ws', type: 'confirm-resolved', id: 'c1' })
    h.observe('chat:event', confirmReq())
    expect(h.fired).toHaveLength(2)
  })

  it('没有工作区路径的事件不弹(点开也无处可跳)', () => {
    const h = harness()
    h.observe('chat:event', confirmReq({ workspacePath: '' }))
    expect(h.fired).toHaveLength(0)
  })

  it('拿不到工作区名时只显示类别,不留一个悬空的分隔点', () => {
    const h = harness()
    h.observe('chat:event', confirmReq({ workspacePath: '/unknown' }))
    expect(h.fired[0]!.title).toBe('需要确认')
  })

  it('★畸形 payload 不许把广播总线带崩', () => {
    const h = harness()
    for (const bad of [null, undefined, 0, 'x', [], { event: null }, { event: 1 }])
      expect(() => { h.observe('chat:event', bad); h.observe('run2:event', bad) }).not.toThrow()
    expect(h.fired).toHaveLength(0)
  })

  it('★去重表不会无限长', () => {
    const h = harness()
    for (let i = 0; i < 2000; i++) h.observe('chat:event', confirmReq({ id: `c${i}` }))
    h.observe('chat:event', confirmReq({ id: 'c0' }))
    expect(h.fired).toHaveLength(2001)
  })
})
