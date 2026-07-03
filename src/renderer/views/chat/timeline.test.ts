import { describe, it, expect } from 'vitest'
import { buildTimeline } from './timeline'
import type { ChatMessage, PendingAction, ChatConfirm } from '@shared/types'

const msg = (id: string, ts: string): ChatMessage => ({ id, who: 'ai', text: id, ts })
const pend = (id: string, ts?: string): PendingAction =>
  ({ id, kind: 'input', agentId: 'a', agentName: 'A', wsName: 'w', title: 'q', ts } as PendingAction)

describe('buildTimeline', () => {
  it('按 ts 把卡片插进消息之间', () => {
    const messages = [msg('m1', '2026-07-01T00:00:00.000Z'), msg('m2', '2026-07-01T00:00:02.000Z')]
    const pending = [pend('p1', '2026-07-01T00:00:01.000Z')]
    const tl = buildTimeline(messages, pending, [], [])
    expect(tl.map(e => e.kind)).toEqual(['message', 'pending', 'message'])
    const first = tl[0]
    if (first.kind === 'message') expect(first.index).toBe(0)
  })

  it('空 ts 的流式消息排到末尾,有 ts 的卡片排它前面', () => {
    const messages = [msg('s', '')] // 流式助手消息,ts 未定
    const pending = [pend('p1', '2026-07-01T00:00:01.000Z')]
    const tl = buildTimeline(messages, pending, [], [])
    expect(tl.map(e => e.kind)).toEqual(['pending', 'message'])
  })

  it('保留消息原始 index 供 <Message> 使用', () => {
    const messages = [msg('m1', '2026-07-01T00:00:00.000Z'), msg('m2', '2026-07-01T00:00:05.000Z')]
    const confirms: ChatConfirm[] = [{ id: 'c1', title: 't', ts: '2026-07-01T00:00:01.000Z' }]
    const tl = buildTimeline(messages, [], confirms, [])
    const m2 = tl.find(e => e.kind === 'message' && e.msg.id === 'm2')
    expect(m2 && m2.kind === 'message' && m2.index).toBe(1)
  })

  // 回归:旧会话消息用时钟制 ts("09:58:01",Date.parse 得 NaN)。之前 key() 把它们统一当 +Infinity 顶到
  // 末尾,导致本轮带真实 ISO ts 的回复反而排到它们上方、滚动到底部看不见("有思考没结果")。消息在数组里
  // 已按时序追加,必须保持原始相对顺序,新回复落在最后。
  it('遗留时钟制 ts 的历史消息保持原始顺序,新回复排在末尾', () => {
    const messages = [
      msg('old1', '09:58:01'),
      msg('old2', '10:01:00'),
      msg('u', '2026-07-01T12:00:00.000Z'),
      msg('ai', '2026-07-01T12:00:05.000Z'),
    ]
    const tl = buildTimeline(messages, [], [], [])
    expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind)).toEqual(['old1', 'old2', 'u', 'ai'])
  })

  // 空 ts('')= 尚未定时的在途流式消息,应始终在最底部;非空但不可解析的时钟制 ts 不同,须留在原位。
  it('区分空 ts(流式,置底)与遗留时钟制 ts(原位)', () => {
    const messages = [msg('old', '09:58:01'), msg('u', '2026-07-01T12:00:00.000Z'), msg('stream', '')]
    const pending = [pend('p1', '2026-07-01T12:00:03.000Z')]
    const tl = buildTimeline(messages, pending, [], [])
    // old 原位在最前;pending 卡按真实 ts 落在 u 之后;流式 stream 永远最后
    expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind)).toEqual(['old', 'u', 'pending', 'stream'])
  })
})
