import { describe, it, expect } from 'vitest'
import { codexCompactionPhase } from './codex'
import { adaptCodexEvent } from './codexEventAdapter'

/**
 * 自动压缩上下文要一分多钟,而这段时间 codex 一个 token 都不吐 —— 界面上只有「主代理思考中…」
 * 和一个越走越大的秒数,和卡死长得一模一样。用户 2026-09-08 原话:
 * 「模型在进行压缩,咱们也看不到自动压缩过程」。
 *
 * 报文形状取自 codex-cli 0.153.4 自己的 schema(`codex app-server generate-json-schema`):
 *   · v2 thread item:`ContextCompactionThreadItem` = { id, type: "contextCompaction" },
 *     走 item/started → item/completed 一对;
 *   · 同一份 schema 里还并存蛇形的 `context_compaction`(response item),exec 那条 JSONL 用它;
 *   · `thread/compacted` 通知已被标 Deprecated,但老版本 codex 只发这个。
 */
describe('codexCompactionPhase', () => {
  it('★★item.started + contextCompaction ⇒ 进入「压缩中」', () => {
    expect(codexCompactionPhase({ type: 'item.started', item: { id: 'c1', type: 'contextCompaction' } })).toBe('compacting')
  })

  it('★item.completed ⇒ 回到「在想」—— 压缩完这一轮还要接着跑,不是轮次结束', () => {
    expect(codexCompactionPhase({ type: 'item.completed', item: { id: 'c1', type: 'contextCompaction' } })).toBe('thinking')
  })

  it('★蛇形拼写(exec 那条 JSONL)同样要认 —— 两个名字在 codex 自己的 schema 里同时存在', () => {
    expect(codexCompactionPhase({ type: 'item.started', item: { id: 'c1', type: 'context_compaction' } })).toBe('compacting')
    expect(codexCompactionPhase({ type: 'item.completed', item: { id: 'c1', type: 'context_compaction' } })).toBe('thinking')
  })

  it('老通道 thread.compacted ⇒ 回到「在想」(它只报压缩完了,没有开始事件)', () => {
    expect(codexCompactionPhase({ type: 'thread.compacted' })).toBe('thinking')
  })

  it('★别的 item 一律不动阶段 —— 误报会让每次 shell 调用都显示成「压缩中」', () => {
    for (const t of ['commandExecution', 'command_execution', 'agentMessage', 'reasoning', 'fileChange']) {
      expect(codexCompactionPhase({ type: 'item.started', item: { id: 'x', type: t } }), t).toBeNull()
      expect(codexCompactionPhase({ type: 'item.completed', item: { id: 'x', type: t } }), t).toBeNull()
    }
    expect(codexCompactionPhase(null)).toBeNull()
    expect(codexCompactionPhase({ type: 'item.started' })).toBeNull()
    expect(codexCompactionPhase({ msg: { type: 'agent_message_delta', delta: 'hi' } })).toBeNull()
  })
})

describe('adaptCodexEvent:app-server 那条路也要看得见压缩', () => {
  it('★★item/started 带 contextCompaction 透过适配器后仍然认得出 —— 适配器只改已知类型的拼写', () => {
    const ev = adaptCodexEvent({ method: 'item/started', params: { item: { id: 'c1', type: 'contextCompaction' } } })
    expect(codexCompactionPhase(ev)).toBe('compacting')
  })

  it('★老的 thread/compacted 通知要被转成 exec 那边同名的形状,否则 app-server 这条路认不出来', () => {
    const ev = adaptCodexEvent({ method: 'thread/compacted', params: { threadId: 't1', turnId: 'u1' } })
    expect(codexCompactionPhase(ev)).toBe('thinking')
  })
})
