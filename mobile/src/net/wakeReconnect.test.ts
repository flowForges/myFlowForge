import { describe, it, expect } from 'vitest'
import type { HostState } from './hostClient'
import { shouldDropOnBackground, shouldReconnectOnWake } from './wakeReconnect'

const S = {
  connecting: { status: 'connecting', attempt: 1 } as HostState,
  ready: { status: 'ready', version: '1', methods: new Set<string>() } as HostState,
  retrying: { status: 'retrying', attempt: 3, error: 'x', nextInMs: 8000 } as HostState,
  failed: { status: 'failed', error: 'x' } as HostState,
  closed: { status: 'closed' } as HostState,
}

describe('回到前台要不要重连', () => {
  it('已经连着 → 不动', () => {
    expect(shouldReconnectOnWake(S.ready)).toBe(false)
  })

  it('没选主机 → 不动', () => {
    expect(shouldReconnectOnWake(null)).toBe(false)
  })

  it('★★failed 也要重连 —— 这正是「必须手点一次」的成因', () => {
    // hostClient 的 fail() 是刻意不自动重试的(别用退避把同一个错刷一整晚),
    // 但那条规矩针对的是「服务器有问题」。刚唤醒是一个全新的事实,之前的失败
    // 发生在没有网络的挂起态里,不该继续算数。
    expect(shouldReconnectOnWake(S.failed)).toBe(true)
  })

  it('★retrying 要重连,而不是等那个退避定时器', () => {
    // 那个定时器的间隔是按失败次数算的,和「刚刚醒来」毫无关系。
    expect(shouldReconnectOnWake(S.retrying)).toBe(true)
  })

  it('★★connecting 也要重连 —— 挂起期间发出的那次连接是具死的', () => {
    // 它不会自己失败(没有网络栈给它报错),就那么挂着,界面上永远停在「连接中…」。
    expect(shouldReconnectOnWake(S.connecting)).toBe(true)
  })

  it('closed 要重连', () => {
    expect(shouldReconnectOnWake(S.closed)).toBe(true)
  })
})

describe('进后台要不要主动断开', () => {
  it('★连着才断 —— 为的是让中转当场释放房间,不是省电', () => {
    expect(shouldDropOnBackground(S.ready)).toBe(true)
  })

  it('★★没连上就别断 —— 会把一次正在进行的重连打掉', () => {
    for (const s of [S.connecting, S.retrying, S.failed, S.closed, null]) {
      expect(shouldDropOnBackground(s), JSON.stringify(s)).toBe(false)
    }
  })
})
