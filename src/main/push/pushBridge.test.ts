import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPushBridge, DEDUPE_MS, ANDROID_CHANNEL, type PushBridge, type PushCfg } from './pushBridge'
import { attentionOf, ATTENTION_WINDOW_MS, type Presence } from '@shared/push/attention'
import type { ExpoMessage, SendResult } from './expoPush'
import type { PushDevice } from './pushStore'

const NOW = 1_700_000_000_000
const dev = (token: string): PushDevice => ({ token, label: token, platform: 'ios', registeredAt: 0, lastSeenAt: 0 })
const OK: SendResult = { sent: 1, failed: 0, dropTokens: [], errors: [] }

type H = {
  bridge: PushBridge
  sent: ExpoMessage[][]
  dropped: string[][]
  cfg: PushCfg
  now: { v: number }
  devices: PushDevice[]
  result: { v: SendResult }
}

function harness(over: Partial<{ cfg: PushCfg; devices: PushDevice[] }> = {}): H {
  const sent: ExpoMessage[][] = []
  const dropped: string[][] = []
  const cfg: PushCfg = over.cfg ?? { enabled: true, gate: true, done: true }
  const now = { v: NOW }
  const devices = over.devices ?? [dev('ExponentPushToken[a]')]
  const result = { v: OK }
  const bridge = createPushBridge({
    cfg: () => cfg,
    devices: () => devices,
    send: async (m) => { sent.push(m); return result.v },
    dropTokens: (t) => { dropped.push([...t]) },
    workspaceName: (p) => (p === '/ws' ? 'my-app' : ''),
    now: () => now.v,
  })
  return { bridge, sent, dropped, cfg, now, devices, result }
}

const gateEvt = (over: Record<string, unknown> = {}) => ({
  workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'c1', ...over,
})

// send() 是 fire-and-forget,断言前让微任务队列跑完。
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('pushBridge · 四路门信号', () => {
  it('权限门 → 一条推送', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]![0]!.title).toBe('my-app · 需要你确认')
    expect(h.sent[0]![0]!.to).toBe('ExponentPushToken[a]')
    expect(h.sent[0]![0]!.channelId).toBe(ANDROID_CHANNEL)
  })

  it('代理提问 → 一条推送', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt({ type: 'ask-request', id: 'a1' }))
    await flush()
    expect(h.sent[0]![0]!.title).toContain('代理在问你')
  })

  it('跑完了 → 一条推送', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    await flush()
    expect(h.sent[0]![0]!.title).toContain('跑完了')
  })

  it('工作流门 → 一条推送,且 sessionId 是 null 不是 undefined', async () => {
    const h = harness()
    h.bridge.observe('run2:event', { workspacePath: '/ws', event: { id: 'g1', kind: 'gate' } })
    await flush()
    expect(h.sent[0]![0]!.title).toContain('工作流卡在门上')
    expect(h.sent[0]![0]!.data!.sessionId).toBeNull()
  })

  it('工作流泳道的四种问题都算「要你拿主意」', async () => {
    for (const kind of ['question', 'auth', 'doubt', 'failure']) {
      const h = harness()
      h.bridge.observe('run2:event', { workspacePath: '/ws', event: { id: `x-${kind}`, kind } })
      await flush()
      expect(h.sent, kind).toHaveLength(1)
    }
  })

  it('答完门(resolved)不推,进阶段/日志也不推', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt({ type: 'confirm-resolved' }))
    h.bridge.observe('chat:event', gateEvt({ type: 'ask-resolved' }))
    h.bridge.observe('chat:event', gateEvt({ type: 'delta' }))
    h.bridge.observe('run2:event', { workspacePath: '/ws', event: { id: 'z', kind: 'answer' } })
    h.bridge.observe('run2:update', { workspacePath: '/ws', state: { status: 'running' } })
    h.bridge.observe('run2:log', { workspacePath: '/ws' })
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('没有工作区路径的事件不推(推了也无处可跳)', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt({ workspacePath: '' }))
    h.bridge.observe('chat:event', gateEvt({ workspacePath: undefined, id: 'c2' }))
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('★畸形 payload 不许把广播总线带崩', async () => {
    const h = harness()
    for (const bad of [null, undefined, 0, 'x', [], { event: null }])
      expect(() => { h.bridge.observe('chat:event', bad); h.bridge.observe('run2:event', bad) }).not.toThrow()
    await flush()
    expect(h.sent).toHaveLength(0)
  })
})

describe('pushBridge · 开关', () => {
  it('总开关关掉时一条都不发', async () => {
    const h = harness({ cfg: { enabled: false, gate: true, done: true } })
    h.bridge.observe('chat:event', gateEvt())
    h.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('门的开关和「跑完了」的开关各管各的', async () => {
    const h = harness({ cfg: { enabled: true, gate: true, done: false } })
    h.bridge.observe('chat:event', gateEvt())
    h.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]![0]!.title).toContain('需要你确认')

    const h2 = harness({ cfg: { enabled: true, gate: false, done: true } })
    h2.bridge.observe('chat:event', gateEvt())
    h2.bridge.observe('run2:event', { workspacePath: '/ws', event: { id: 'g1', kind: 'gate' } })
    h2.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    await flush()
    expect(h2.sent).toHaveLength(1)
    expect(h2.sent[0]![0]!.title).toContain('跑完了')
  })

  it('一台设备都没登记时不联网', async () => {
    const h = harness({ devices: [] })
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(0)
  })
})

describe('pushBridge · 在场判定', () => {
  const P = (over: Partial<Presence>): Presence => ({ visible: true, at: { workspacePath: '/ws', sessionId: 's1' }, reportedAt: NOW, ...over })

  it('★人正看着这条会话 → 不推', async () => {
    const h = harness()
    h.bridge.setPresence('ExponentPushToken[a]', P({}))
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('★app 开着但在看别的 → 也不推(那条由手机自己弹本地通知)', async () => {
    const h = harness()
    h.bridge.setPresence('ExponentPushToken[a]', P({ at: { workspacePath: '/other' } }))
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(0)
  })

  it('★app 在后台 → 推', async () => {
    const h = harness()
    h.bridge.setPresence('ExponentPushToken[a]', P({ visible: false }))
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('★在场上报过期 → 推(手机被挂起时没机会说一声「我走了」)', async () => {
    const h = harness()
    h.bridge.setPresence('ExponentPushToken[a]', P({}))
    h.now.v = NOW + ATTENTION_WINDOW_MS + 1
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('多台设备各算各的:在看的那台不推,揣兜里的那台推', async () => {
    const h = harness({ devices: [dev('ExponentPushToken[a]'), dev('ExponentPushToken[b]')] })
    h.bridge.setPresence('ExponentPushToken[a]', P({}))
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.map((m) => m.to)).toEqual(['ExponentPushToken[b]'])
  })

  it('clearPresence 之后又算不在场了', async () => {
    const h = harness()
    h.bridge.setPresence('ExponentPushToken[a]', P({}))
    h.bridge.clearPresence('ExponentPushToken[a]')
    expect(h.bridge.presenceOf('ExponentPushToken[a]')).toBeNull()
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('★本地通知和远程推送互斥 —— 同一件事不可能两边都弹', () => {
    // 这条钉的是整套设计赖以成立的性质:手机只在 inapp 弹,daemon 只在 away 发。
    const target = { workspacePath: '/ws', sessionId: 's1' }
    const cases: Array<Presence | null> = [
      null,
      P({}),
      P({ visible: false }),
      P({ at: { workspacePath: '/other' } }),
      P({ at: null }),
      P({ reportedAt: NOW - ATTENTION_WINDOW_MS - 1 }),
    ]
    for (const p of cases) {
      const a = attentionOf(p, target, NOW)
      const phoneWouldNotify = a === 'inapp'
      const daemonWouldPush = a === 'away'
      expect(phoneWouldNotify && daemonWouldPush).toBe(false)
    }
  })
})

describe('pushBridge · 去重', () => {
  it('★同一道门重复广播只推一次', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt())
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('不同的门各推各的', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt({ id: 'c1' }))
    h.bridge.observe('chat:event', gateEvt({ id: 'c2' }))
    await flush()
    expect(h.sent).toHaveLength(2)
  })

  it('同一条会话短时间内连着跑完两轮只推一次', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    h.now.v = NOW + DEDUPE_MS - 1
    h.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('过了去重窗口就又能推了', async () => {
    const h = harness()
    h.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    h.now.v = NOW + DEDUPE_MS
    h.bridge.observe('chat:event', gateEvt({ type: 'done', id: undefined }))
    await flush()
    expect(h.sent).toHaveLength(2)
  })

  it('★去重表不会无限长(常年不关的 daemon 上那就是内存泄漏)', async () => {
    const h = harness()
    for (let i = 0; i < 2000; i++) h.bridge.observe('chat:event', gateEvt({ id: `c${i}` }))
    await flush()
    // 最早那批被挤出去之后又能推 —— 这既证明有上限,也证明淘汰的是最早的那些
    h.bridge.observe('chat:event', gateEvt({ id: 'c0' }))
    await flush()
    expect(h.sent).toHaveLength(2001)
  })
})

describe('pushBridge · 死令牌与测试推送', () => {
  it('Expo 说令牌死了就摘掉', async () => {
    const h = harness()
    h.result.v = { sent: 0, failed: 1, dropTokens: ['ExponentPushToken[a]'], errors: [] }
    h.bridge.observe('chat:event', gateEvt())
    await flush()
    expect(h.dropped).toEqual([['ExponentPushToken[a]']])
  })

  it('★发送抛异常时不往外冒(它坐在广播回调上)', async () => {
    const logs: string[] = []
    const bridge = createPushBridge({
      cfg: () => ({ enabled: true, gate: true, done: true }),
      devices: () => [dev('ExponentPushToken[a]')],
      send: async () => { throw new Error('炸了') },
      dropTokens: () => {},
      workspaceName: () => 'w',
      now: () => NOW,
      onLog: (m) => logs.push(m),
    })
    expect(() => bridge.observe('chat:event', gateEvt())).not.toThrow()
    await flush()
    expect(logs.join()).toContain('炸了')
  })

  it('★测试推送绕开在场判定和开关 —— 否则测出来永远是「没反应」', async () => {
    const h = harness({ cfg: { enabled: false, gate: false, done: false } })
    h.bridge.setPresence('ExponentPushToken[a]', { visible: true, at: null, reportedAt: NOW })
    const r = await h.bridge.sendTest()
    expect(h.sent).toHaveLength(1)
    expect(r.sent).toBe(1)
  })

  it('一台设备都没有时,测试推送给一句人话而不是假装成功', async () => {
    const h = harness({ devices: [] })
    const r = await h.bridge.sendTest()
    expect(h.sent).toHaveLength(0)
    expect(r.errors[0]).toContain('还没有手机登记过推送')
  })
})
