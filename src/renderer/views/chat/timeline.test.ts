import { describe, it, expect } from 'vitest'
import { buildTimeline } from './timeline'
import type { PlanReq } from './timeline'
import type { ChatMessage, PendingAction, ChatConfirm } from '@shared/types'

const msg = (id: string, ts: string): ChatMessage => ({ id, who: 'ai', text: id, ts })
const aiMsg = (id: string, ts: string, provider?: string): ChatMessage => ({ id, who: 'ai', text: id, ts, provider })
const userMsg = (id: string, ts: string): ChatMessage => ({ id, who: 'user', text: id, ts })
const pend = (id: string, ts?: string): PendingAction =>
  ({ id, kind: 'input', agentId: 'a', agentName: 'A', wsName: 'w', title: 'q', ts } as PendingAction)
const plan = (id: string, ts: string): PlanReq => ({ id, approach: 'a', stages: [], allProjects: [], task: 't', ts })

describe('buildTimeline', () => {
  it('按 ts 把卡片插进消息之间', () => {
    const messages = [msg('m1', '2026-07-01T00:00:00.000Z'), msg('m2', '2026-07-01T00:00:02.000Z')]
    const pending = [pend('p1', '2026-07-01T00:00:01.000Z')]
    const tl = buildTimeline(messages, pending, [], [])
    expect(tl.map(e => e.kind)).toEqual(['message', 'pending', 'message'])
    const first = tl[0]
    if (first.kind === 'message') expect(first.index).toBe(0)
  })

  it('流式中途产生的卡片排在流式助手消息之后', () => {
    const messages = [msg('s', '')] // 流式助手消息,ts 未定
    const pending = [pend('p1', '2026-07-01T00:00:01.000Z')]
    const tl = buildTimeline(messages, pending, [], [])
    expect(tl.map(e => e.kind)).toEqual(['message', 'pending'])
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

  // 空 ts('')= 尚未定时的在途流式消息。它排在触发它的用户消息之后(沿用前一条真实消息的时间键),
  // 而不是被顶到 +Infinity。遗留时钟制 ts 同样沿用前值留在原位。
  it('区分空 ts(流式,承接前值)与遗留时钟制 ts(原位)', () => {
    const messages = [msg('old', '09:58:01'), msg('u', '2026-07-01T12:00:00.000Z'), msg('stream', '')]
    const pending = [pend('p1', '2026-07-01T12:00:03.000Z')]
    const tl = buildTimeline(messages, pending, [], [])
    // old 原位在最前;流式 stream 承接 u 的时间键紧随其后;pending 卡按真实 ts(12:00:03)落在最后
    expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind)).toEqual(['old', 'u', 'stream', 'pending'])
  })

  // 回归(方案审批看不到按钮):forge_propose_plan 由主代理在流式中途调用,turn 阻塞在审批、done 未触发,
  // 故该助手消息 ts 一直是 ''。带「批准/拒绝」按钮的方案卡片必须排在这条流式消息*之后*(下方),否则会被
  // 顶到长方案消息上方、随自动滚动落到视口之外,用户只看到右侧无按钮的只读摘要而误以为交互卡片丢失。
  it('流式中途提交的方案卡片排在流式助手消息之后', () => {
    const messages = [
      msg('u', '2026-07-01T12:00:00.000Z'), // 用户指令
      msg('ai', ''),                        // 主代理流式回复(仍在输出,阻塞在审批)
    ]
    const plans = [plan('pl', '2026-07-01T12:00:10.000Z')] // 稍后产生的方案卡片
    const tl = buildTimeline(messages, [], [], plans)
    expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind)).toEqual(['u', 'ai', 'plan'])
  })

  // P1-3: launch-gate 卡片按 ts 与消息/其他卡片归并,只携带 id(实际 config/frozen 由渲染方按 id 查)。
  it('launch-gate 按 ts 归并进时间线', () => {
    const messages = [msg('m1', '2026-07-01T00:00:00.000Z'), msg('m2', '2026-07-01T00:00:03.000Z')]
    const launchGates = [{ id: 'lg1', ts: Date.parse('2026-07-01T00:00:01.000Z') }]
    const tl = buildTimeline(messages, [], [], [], launchGates)
    expect(tl.map(e => e.kind)).toEqual(['message', 'launch-gate', 'message'])
    const gate = tl.find(e => e.kind === 'launch-gate')
    expect(gate && gate.kind === 'launch-gate' && gate.id).toBe('lg1')
  })

  // P1-5: a persisted frozen launch-gate rides on a synthetic ChatMessage (blank text, `launchGate`
  // field) purely so it survives reload/session-switch — it must NOT also render as a plain-text
  // 'message' entry (the caller reconstructs its own 'launch-gate' entry for it from the same message).
  it('携带 launchGate 字段的消息不产生 message 条目(由调用方按 id 重建 launch-gate 条目)', () => {
    const messages = [
      msg('m1', '2026-07-01T00:00:00.000Z'),
      { id: 'lg1', who: 'ai' as const, text: '', ts: '2026-07-01T00:00:01.000Z', launchGate: { workflowName: 'wf', projects: [], supplement: '', decidedAt: 1, seed: '' } },
      msg('m2', '2026-07-01T00:00:03.000Z'),
    ]
    const launchGates = [{ id: 'lg1', ts: Date.parse('2026-07-01T00:00:01.000Z') }]
    const tl = buildTimeline(messages, [], [], [], launchGates)
    expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind)).toEqual(['m1', 'launch-gate', 'm2'])
  })

  // Task 19: 会话内切换 provider 时插入分割线。A→A→B→B 只在第一条 B 之前插一条,两条 A 之间不插,
  // 第二条 B 之前也不插(同 provider 连续)。
  describe('provider-switch 分割线', () => {
    it('A→A→B→B 只在第一条 B 前插一条分割线', () => {
      const messages = [
        aiMsg('a1', '2026-07-01T12:00:00.000Z', 'claude'),
        aiMsg('a2', '2026-07-01T12:00:01.000Z', 'claude'),
        aiMsg('b1', '2026-07-01T12:00:02.000Z', 'codex'),
        aiMsg('b2', '2026-07-01T12:00:03.000Z', 'codex'),
      ]
      const tl = buildTimeline(messages, [], [], [])
      expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind))
        .toEqual(['a1', 'a2', 'provider-switch', 'b1', 'b2'])
      const div = tl.find(e => e.kind === 'provider-switch')
      expect(div && div.kind === 'provider-switch' && { from: div.from, to: div.to })
        .toEqual({ from: 'claude', to: 'codex' })
    })

    it('第一条 ai 消息(无「上一条」)不插分割线', () => {
      const messages = [aiMsg('a1', '2026-07-01T12:00:00.000Z', 'claude')]
      const tl = buildTimeline(messages, [], [], [])
      expect(tl.map(e => e.kind)).toEqual(['message'])
    })

    it('user 消息穿插不影响 ai→ai 切换判定', () => {
      const messages = [
        aiMsg('a1', '2026-07-01T12:00:00.000Z', 'claude'),
        userMsg('u1', '2026-07-01T12:00:01.000Z'),
        aiMsg('b1', '2026-07-01T12:00:02.000Z', 'codex'),
      ]
      const tl = buildTimeline(messages, [], [], [])
      expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind))
        .toEqual(['a1', 'u1', 'provider-switch', 'b1'])
    })

    it('无 provider 的旧消息(user 或缺字段的 ai)不触发误插,也不残留旧 provider 状态', () => {
      const messages = [
        aiMsg('old', '2026-07-01T12:00:00.000Z'),          // 旧会话:无 provider 字段
        aiMsg('a1', '2026-07-01T12:00:01.000Z', 'claude'),  // 与「上一条」比较,上一条无 provider → 不插
        aiMsg('a2', '2026-07-01T12:00:02.000Z', 'claude'),  // 与 a1 同 provider → 不插
      ]
      const tl = buildTimeline(messages, [], [], [])
      expect(tl.map(e => e.kind)).toEqual(['message', 'message', 'message'])
    })

    // 回归(切模型丢分割线):一条无 provider 的「系统」note 或在途流式占位夹在 codex 末条与切换总结之间时,
    // prevAiProvider 若被重置为 undefined,总结上方的分割线就消失。改为「粘滞」——无 provider 的 ai 消息
    // 不清空上一已知 provider——使真实切换的分割线在有 note 穿插时依然稳定出现。
    it('无 provider 的系统 note 穿插在真实切换之间,分割线仍出现', () => {
      const messages = [
        aiMsg('codex1', '2026-07-01T12:00:00.000Z', 'codex'), // codex 的回复
        aiMsg('sysnote', '2026-07-01T12:00:01.000Z'),         // 系统 note:无 provider
        aiMsg('summary', '2026-07-01T12:00:02.000Z', 'claude'), // 切换后的上下文总结(新 provider)
      ]
      const tl = buildTimeline(messages, [], [], [])
      expect(tl.map(e => e.kind === 'message' ? e.msg.id : e.kind))
        .toEqual(['codex1', 'sysnote', 'provider-switch', 'summary'])
      const div = tl.find(e => e.kind === 'provider-switch')
      expect(div && div.kind === 'provider-switch' && { from: div.from, to: div.to })
        .toEqual({ from: 'codex', to: 'claude' })
    })
  })
})
