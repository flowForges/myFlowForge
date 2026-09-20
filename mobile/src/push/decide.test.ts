import { describe, it, expect } from 'vitest'
import {
  localNotificationFor, shouldReportPresence, parseLocalPushPrefs,
  DEFAULT_LOCAL_PUSH, PRESENCE_HEARTBEAT_MS, type LocalPushPrefs,
} from './decide'
import type { Presence } from '../../../src/shared/push/attention'
import { ATTENTION_WINDOW_MS } from '../../../src/shared/push/attention'

const NOW = 1_700_000_000_000
const ALL: LocalPushPrefs = { enabled: true, gate: true, done: true }
const P = (over: Partial<Presence> = {}): Presence =>
  ({ visible: true, at: { workspacePath: '/ws', sessionId: 's1' }, reportedAt: NOW, ...over })

const decide = (channel: string, payload: unknown, over: Partial<{ presence: Presence | null; prefs: LocalPushPrefs }> = {}) =>
  localNotificationFor(channel, payload, {
    presence: over.presence === undefined ? P({ at: { workspacePath: '/other' } }) : over.presence,
    prefs: over.prefs ?? ALL,
    workspaceName: (p) => (p === '/ws' ? 'my-app' : ''),
    now: NOW,
  })

const gate = { workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'c1' }

describe('localNotificationFor', () => {
  it('★app 开着但停在别的会话 → 弹(那道门在另一块屏上,你看不见)', () => {
    const m = decide('chat:event', gate)
    expect(m?.title).toBe('my-app · 需要你确认')
    expect(m?.body).not.toContain('c1')
  })

  it('★正看着那条会话 → 不弹', () => {
    expect(decide('chat:event', gate, { presence: P() })).toBeNull()
  })

  it('★app 在后台 → 不弹(那一档归远程推送,弹了就是两条)', () => {
    expect(decide('chat:event', gate, { presence: P({ visible: false }) })).toBeNull()
  })

  it('★在场信息过期 → 不弹(同上,那一档已经交给远程推送了)', () => {
    expect(decide('chat:event', gate, { presence: P({ reportedAt: NOW - ATTENTION_WINDOW_MS - 1 }) })).toBeNull()
  })

  it('从没上报过在场 → 不弹', () => {
    expect(decide('chat:event', gate, { presence: null })).toBeNull()
  })

  it('总开关关掉 → 什么都不弹', () => {
    expect(decide('chat:event', gate, { prefs: { enabled: false, gate: true, done: true } })).toBeNull()
  })

  it('门和「跑完了」两个开关各管各的', () => {
    const done = { workspacePath: '/ws', sessionId: 's1', type: 'done' }
    expect(decide('chat:event', gate, { prefs: { enabled: true, gate: false, done: true } })).toBeNull()
    expect(decide('chat:event', done, { prefs: { enabled: true, gate: false, done: true } })?.title).toContain('跑完了')
    expect(decide('chat:event', done, { prefs: { enabled: true, gate: true, done: false } })).toBeNull()
  })

  it('工作流的门也弹,而且它是工作区级的', () => {
    const m = decide('run2:event', { workspacePath: '/ws', event: { id: 'g1', kind: 'gate' } })
    expect(m?.data.sessionId).toBeNull()
  })

  it('★停在那个工作区的某条会话里时,工作区级的门照样要弹', () => {
    // 工作流的门在「执行」那一屏,你在对话屏上看不见它。
    const m = decide('run2:event', { workspacePath: '/ws', event: { id: 'g1', kind: 'gate' } }, { presence: P() })
    expect(m).not.toBeNull()
  })

  it('不该提醒的事件一概不弹', () => {
    expect(decide('chat:event', { workspacePath: '/ws', type: 'delta' })).toBeNull()
    expect(decide('run2:update', { workspacePath: '/ws' })).toBeNull()
    expect(decide('chat:event', null)).toBeNull()
  })
})

describe('parseLocalPushPrefs', () => {
  it('认不出来就用默认', () => {
    expect(parseLocalPushPrefs(null)).toEqual(DEFAULT_LOCAL_PUSH)
    expect(parseLocalPushPrefs('x')).toEqual(DEFAULT_LOCAL_PUSH)
    expect(parseLocalPushPrefs([])).toEqual(DEFAULT_LOCAL_PUSH)
  })
  it('逐字段兜底,一个坏的不该把另一个拖下水', () => {
    expect(parseLocalPushPrefs({ enabled: false, gate: '是' })).toEqual({ enabled: false, gate: true, done: false })
  })
})

describe('shouldReportPresence', () => {
  it('第一次一定发', () => {
    expect(shouldReportPresence(null, P())).toBe(true)
  })
  it('前后台变了立刻发', () => {
    expect(shouldReportPresence(P(), P({ visible: false }))).toBe(true)
  })
  it('换了会话立刻发', () => {
    expect(shouldReportPresence(P(), P({ at: { workspacePath: '/ws', sessionId: 's2' } }))).toBe(true)
    expect(shouldReportPresence(P(), P({ at: null }))).toBe(true)
    expect(shouldReportPresence(P({ at: null }), P())).toBe(true)
  })
  it('★什么都没变时不发 —— 否则每次渲染都是一次网络往返', () => {
    expect(shouldReportPresence(P(), P({ reportedAt: NOW + 1 }))).toBe(false)
  })
  it('★但要定期续期,不然 180 秒后会被当成「不在」然后挨一条推送', () => {
    expect(shouldReportPresence(P(), P({ reportedAt: NOW + PRESENCE_HEARTBEAT_MS }))).toBe(true)
    expect(shouldReportPresence(P(), P({ reportedAt: NOW + PRESENCE_HEARTBEAT_MS - 1 }))).toBe(false)
  })
  it('★心跳周期必须短于过期窗口,否则每一轮都会掉出去一次', () => {
    expect(PRESENCE_HEARTBEAT_MS).toBeLessThan(ATTENTION_WINDOW_MS)
  })
})
